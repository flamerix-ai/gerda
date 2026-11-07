// bridge.js — TCP gateway (jsMacros SERVICE). v3.0
// Thin transport layer. No eval. No business logic.
// Reads JSON lines from TCP, queues to GlobalVars, forwards responses back.
// ---------------------------------------------------------------------------
"use strict";

JsMacros.assertEvent(event, "Service");

// --- load shared IPC SSOT (sibling ipc.js, eval-included; see ipc.js header) ---
var IPC = (function () {
    var F = Java.type("java.nio.file.Files");
    var P = Java.type("java.nio.file.Paths");
    var U = Java.type("java.nio.charset.StandardCharsets").UTF_8;
    var p;
    try { p = P.get(JsMacros.getConfig().macroFolder.toString()).resolve("ipc.js"); }
    catch (_) { p = P.get("ipc.js"); }
    if (!F.exists(p)) throw new Error("ipc.js not found at " + p + " — deploy it (sync.py SERVICE_FILES)");
    eval(F.readString(p, U));
    return globalThis.__MC_IPC;
})();

var GV = GlobalVars;
var TAG = "[BRIDGE]";
var ALIVE_KEY = IPC.KEYS.bridge.alive;
var SEQ_KEY = IPC.KEYS.bridge.seq;
var CNT_KEY = IPC.KEYS.bridge.cmdCount;
// Loopback-only by default: the MCP server and bridge_ctl run on the same host as
// the game, so there is no reason to expose the command socket on every interface.
// Override with the `mc_bridge_host` GlobalVar before start for a remote/WSL setup.
var DEFAULT_HOST = "127.0.0.1";
var HOST = (function () {
    try {
        var h = GlobalVars.getString(IPC.KEYS.bridge.host);
        return (h && h.length > 0) ? h : DEFAULT_HOST;
    } catch (_) { return DEFAULT_HOST; }
})();
// Per-instance port so N bots co-locate on one host (fleet coordination). Resolution order:
//   1) `mc_bridge_port` GlobalVar (runtime override, set before a (re)start)
//   2) `bridge_port.txt` in the macroFolder (the per-instance file sync.py drops)
//   3) 55544 (the historical default — single-bot setups keep this unchanged)
var DEFAULT_PORT = 55544;
var PORT = (function () {
    try {
        var gp = GlobalVars.getInt(IPC.KEYS.bridge.port);
        if (gp && gp > 0 && gp < 65536) return gp;
    } catch (_) {}
    try {
        var Files = Java.type("java.nio.file.Files");
        var Paths = Java.type("java.nio.file.Paths");
        var UTF8 = Java.type("java.nio.charset.StandardCharsets").UTF_8;
        var fp = Paths.get(JsMacros.getConfig().macroFolder.toString()).resolve("bridge_port.txt");
        if (Files.exists(fp)) {
            var n = parseInt(("" + Files.readString(fp, UTF8)).trim(), 10);
            if (n > 0 && n < 65536) return n;
        }
    } catch (_) {}
    return DEFAULT_PORT;
})();

var ServerSocketChannel = Java.type("java.nio.channels.ServerSocketChannel");
var StandardCharsets = Java.type("java.nio.charset.StandardCharsets");
var ByteBuffer = Java.type("java.nio.ByteBuffer");

var serverChan = null;
var clientChan = null;
var readBuf = "";
var awaitingId = null;
var tickListener = null;
var tickCount = 0;

// ── main-service supervision (defense in depth, layer C) ────────────────────
// If a long render-thread op trips jsMacros' EventLockWatchdog it KILLS main.js's
// Tick listener for good — main goes deaf (this bridge still pings, but every queued
// command times out) and previously only a manual restart (or a full game reload)
// recovered it. The bridge is the STABLE outer layer (its per-tick work is trivial,
// so it's ~never killed) and is the right place to supervise the container it fronts.
// It watches main's heartbeat and CLEANLY restarts main on a STALL — distinguishing a
// stall (heartbeat frozen at nonzero) from an intentional stop (heartbeat 0), so it
// won't resurrect a deliberately-halted main.
var SM = JsMacros.getServiceManager();
var MAIN_ALIVE_KEY = IPC.KEYS.main.alive;
var MAIN_STALL_TICKS = 100; // ~5s with no main heartbeat = main's Tick listener is dead
var MAIN_RESTART_COOLDOWN = 600; // ~30s between restart attempts (avoid a restart loop)
var _mainLastAlive = -1;
var _mainStaleSince = 0; // bridge tickCount when main's heartbeat last advanced
var _mainLastRestart = -1000000;

function superviseMain() {
    var a = 0;
    try { a = GV.getInt(MAIN_ALIVE_KEY) || 0; } catch (_) { return; }
    if (a !== _mainLastAlive) { _mainLastAlive = a; _mainStaleSince = tickCount; return; }
    if (a === 0) return; // cleanly stopped (not a stall) — don't resurrect
    if (tickCount - _mainStaleSince < MAIN_STALL_TICKS) return;
    if (tickCount - _mainLastRestart < MAIN_RESTART_COOLDOWN) return;
    _mainLastRestart = tickCount;
    _mainStaleSince = tickCount; // give the restart time before judging it stale again
    blog("main heartbeat stalled ~" + MAIN_STALL_TICKS + "t — clean restart (watchdog self-heal)");
    // Clean stop -> start (not restartService) to fully tear down whatever the watchdog
    // kill left behind. On a background thread so the sleep never blocks the bridge tick.
    new java.lang.Thread(JavaWrapper.methodToJava(function () {
        try {
            if (SM.isRunning("main")) SM.stopService("main");
            java.lang.Thread.sleep(400);
            SM.startService("main");
            blog("main restarted");
        } catch (e) { blog("ERR restart main: " + (e.message || e)); }
    })).start();
}

function blog(msg) {
    java.lang.System.out.println(TAG + " " + msg);
}

// ── stable-layer escape hatch + diagnostics ─────────────────────────────────
// These are answered ENTIRELY by the bridge (never queued to main), so they work
// even when main is stale/deaf/missing a handler — exactly the failure mode that
// otherwise forces a manual jsMacros-GUI reload. restart_service breaks the
// "main is stale so jeval is dark so I can't restart main headlessly" chicken-and-egg.
function gvInt(k) { try { var v = GV.getInt(k); return (v === null || v === undefined) ? null : v; } catch (_) { return null; } }
function gvStr(k) { try { var s = GV.getString(k); return s ? s : null; } catch (_) { return null; } }
function svcRunning(name) { try { return SM.isRunning(name); } catch (_) { return null; } }

function restartServiceAsync(name, id) {
    blog("restart_service '" + name + "' (stable-layer escape hatch)");
    // Respond first (the restart is async and a 'bridge' restart would drop this socket).
    _writeJson(IPC.okFlat(id, "restart_service", { service: name, dispatched: true }));
    new java.lang.Thread(JavaWrapper.methodToJava(function () {
        try {
            if (SM.isRunning(name)) { SM.stopService(name); java.lang.Thread.sleep(500); }
            SM.startService(name);
            blog("restart_service '" + name + "' done");
        } catch (e) { blog("ERR restart_service " + name + ": " + (e.message || e)); }
    })).start();
}

function bridgeDiag() {
    function age(tsKey) { var t = gvInt(tsKey); if (t === null || t === 0) return null; return ((Date.now() / 1000) >> 0) - t; }
    return {
        bridge: { tick: tickCount, host: HOST, port: PORT, version: "3.1" },
        services: {
            main:   { running: svcRunning("main"),   alive: gvInt(MAIN_ALIVE_KEY) },
            worker: { running: svcRunning("worker"), alive: gvInt(IPC.KEYS.worker.alive), ageSec: age(IPC.KEYS.worker.aliveTs) },
            bridge: { running: svcRunning("bridge") }
        },
        revs: {
            main:   gvStr(IPC.KEYS.main.build),
            worker: gvStr(IPC.KEYS.worker.build)
        }
    };
}

function _writeJson(obj) {
    if (clientChan === null) return;
    try {
        var line = JSON.stringify(obj) + "\n";
        var buf = StandardCharsets.UTF_8.encode(line);
        clientChan.write(buf);
    } catch (e) {
        blog("Write error: " + (e.message || e));
    }
}

function bridgeCleanup() {
    try { if (clientChan !== null) clientChan.close(); } catch (_) {}
    try { if (serverChan !== null) serverChan.close(); } catch (_) {}
    clientChan = null;
    serverChan = null;
    if (tickListener) {
        tickListener.stop();
        tickListener = null;
    }
    GV.putInt(ALIVE_KEY, 0);
    blog("Cleaned up");
}

// --- Open server socket ---
try {
    serverChan = ServerSocketChannel.open();
    serverChan.configureBlocking(false);
    serverChan.socket().bind(new java.net.InetSocketAddress(HOST, PORT));
    blog("Listening on " + HOST + ":" + PORT);
} catch (e) {
    blog("FATAL: cannot bind: " + (e.message || e));
    throw e;
}

GV.putInt(ALIVE_KEY, 1);

// --- Tick handler ---
// Paced, not JsMacros.on: a slow tick must not park one jsMacros thread per game tick behind it
// (IPC.paceTick in ipc.js).
tickListener = IPC.paceTick(JsMacros, JavaWrapper.methodToJava, function () {
    tickCount++;
    GV.putInt(ALIVE_KEY, tickCount);

    // Self-heal a watchdog-killed (deaf) main container.
    superviseMain();

    // Accept
    if (clientChan === null && serverChan !== null) {
        try {
            var nc = serverChan.accept();
            if (nc !== null) {
                nc.configureBlocking(false);
                clientChan = nc;
                readBuf = "";
                awaitingId = null;
                blog("Client connected");
            }
        } catch (e) {
            blog("Accept error: " + (e.message || e));
        }
    }

    // Read
    if (clientChan !== null) {
        var buf = ByteBuffer.allocate(2048);
        var n;
        try { n = clientChan.read(buf); } catch (e) { n = -1; }
        if (n > 0) {
            buf.flip();
            readBuf += StandardCharsets.UTF_8.decode(buf).toString();
            // A well-behaved client sends newline-framed JSON; if a line never
            // terminates, drop the buffer rather than growing it without bound. The cap is
            // 256KB so a large inbound payload (a `load` with the full ~130KB bundle, or a
            // big `jeval`/`eval` body) isn't silently truncated at the old 64KB ceiling.
            if (readBuf.length > 262144) {
                blog("readBuf overflow (" + readBuf.length + "), resetting");
                readBuf = "";
            }
            var nl;
            while ((nl = readBuf.indexOf("\n")) >= 0) {
                var line = readBuf.substring(0, nl).trim();
                readBuf = readBuf.substring(nl + 1);
                if (line.length === 0) continue;

                var id = -1;
                var type = null;
                var p;
                try {
                    p = JSON.parse(line);
                    id = (typeof p.id === "number") ? p.id : -1;
                    type = p.type;
                } catch (_) { p = null; }

                if (id < 0) {
                    id = (GV.getInt(SEQ_KEY) || 0) + 1;
                    GV.putInt(SEQ_KEY, id);
                    if (p) { p.id = id; line = JSON.stringify(p); }
                    else { line = JSON.stringify({id: id, type: type || "unknown"}); }
                }

                // Bridge-level ping
                if (type === "ping") {
                    _writeJson(IPC.ok(id, "ping", "pong"));
                } else if (type === "restart_service") {
                    restartServiceAsync((p && p.name) ? String(p.name) : "main", id);
                } else if (type === "bridge_diag") {
                    _writeJson(IPC.okFlat(id, "bridge_diag", bridgeDiag()));
                } else {
                    // Queue for main.js container
                    var count = GV.getInt(CNT_KEY) || 0;
                    GV.putString(IPC.bridgeCmd(count), line);
                    GV.putInt(CNT_KEY, count + 1);
                    awaitingId = id;
                    blog("Queued id=" + id + " type=" + type);
                }
            }
        } else if (n === -1) {
            try { clientChan.close(); } catch (_) {}
            clientChan = null;
            awaitingId = null;
            blog("Client disconnected");
        }
    }

    // Forward response from main.js to TCP client
    if (awaitingId !== null && clientChan !== null) {
        var respKey = IPC.bridgeResp(awaitingId);
        var respStr = GV.getString(respKey);
        if (respStr !== null) {
            GV.remove(respKey);
            try { _writeJson(JSON.parse(respStr)); } catch (_) {}
            blog("Forwarded resp id=" + awaitingId);
            awaitingId = null;
        }
    }
});

event.stopListener = JavaWrapper.methodToJava(function () {
    bridgeCleanup();
    blog("Stopped by user");
});

blog("Service started v3.1");
