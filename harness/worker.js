// worker.js — Generic bot worker (jsMacros SERVICE).
// Loads a compiled bundle, extracts Module interface, runs it tick-by-tick.
// Receives commands from container via GlobalVars (mc_worker_cmd).
// The bundle MUST export: globalThis.Module = {init, tick, command, stop}
// (A sloppy-mode `var Module = …` also works; a STRICT-mode one does not — strict eval code
// keeps its own variable scope, so the var never reaches this file. harness/bot_template.js.)
// A load failure is published to mc_worker_fatal + status "load_failed", so `get_state` and
// `diag` show WHY no module is loaded (the println below lands in no log file on Forge).
// ---------------------------------------------------------------------------
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

var TAG = "[WORKER]";
var ALIVE_KEY = IPC.KEYS.worker.alive;
var ALIVE_TS_KEY = IPC.KEYS.worker.aliveTs;
var STATUS_KEY = IPC.KEYS.worker.status;
var LAST_CMD_KEY = IPC.KEYS.worker.lastCmd;
var RESP_KEY = IPC.KEYS.worker.resp; // worker→container ack, correlation by cmd.id
var CMD_KEY = IPC.KEYS.worker.cmd;
var CMD_FLAG_KEY = IPC.KEYS.worker.cmdFlag;
var CMDS_KEY = IPC.KEYS.worker.cmds; // bundle's self-described command manifest (JSON)
var BUILD_KEY = IPC.KEYS.worker.build; // bundle build stamp {rev, time} (JSON)
var FATAL_KEY = IPC.KEYS.worker.fatal; // CoreFatalError detail {owner,phase,tick,error} (JSON)
var WORLD_SIG_KEY = IPC.KEYS.world.sig; // world signature published by main.js (this thread can't compute it)
var ITEMS_KEY = IPC.KEYS.world.items;   // nearby dropped-item snapshot published by main.js (render-thread-only read)
var MOBS_KEY = IPC.KEYS.world.mobs;     // nearby living-mob snapshot published by main.js (render-thread-only read)
var PEERS_KEY = IPC.KEYS.world.peers;   // nearby other-player snapshot published by main.js (follow mission feed)
var FRAMES_KEY = IPC.KEYS.world.frames; // nearby item-frame snapshot published by main.js (interact mission feed)
var ASSIGNMENT_KEY = IPC.KEYS.world.assignment; // fleet assignment pushed by the hub (fleet hub assignment)

// Per-tick GlobalVar→global mirrors main.js publishes (world sig + render-thread-pinned
// entity snapshots) for the bundle's facade. Table-driven — one row per feed:
//   [GlobalVar key, target global, truthyGuard?]
// The world-sig row uses a TRUTHY guard (an empty "" = "no world computed yet" → skip);
// the JSON-snapshot feeds use a !=null guard (an empty "[]" IS a valid published snapshot
// and must propagate). Preserve that per-feed distinction — it's load-bearing.
var TICK_MIRRORS = [
    [WORLD_SIG_KEY,  "__MC_WORLD_SIG",  true],
    [ITEMS_KEY,      "__MC_ITEMS",      false],
    [MOBS_KEY,       "__MC_MOBS",       false],
    [PEERS_KEY,      "__MC_PEERS",      false],
    [FRAMES_KEY,     "__MC_FRAMES",     false],
    [ASSIGNMENT_KEY, "__MC_ASSIGNMENT", false]
];
function mirrorGlobal(row) {
    try {
        var v = GlobalVars.getString(row[0]);
        if (row[2] ? v : (v !== null && v !== undefined)) globalThis[row[1]] = "" + v;
    } catch (_) {}
}

var RUNTIME_STATE = null;
var ACTIVE_MODULE = null;
var tickCount = 0;
var tickListener = null;
var chatListener = null;

function log(msg) {
    java.lang.System.out.println(TAG + " " + msg);
    try { Player.getPlayer().chat(TAG + " " + msg); } catch (_e) {}
}

var Files = Java.type("java.nio.file.Files");
var Paths = Java.type("java.nio.file.Paths");
var StandardCharsets = Java.type("java.nio.charset.StandardCharsets");

// Publish WHY the bundle did not load, in the same {owner,phase,tick,error,time} shape a tick
// fatal uses, so get_state.worker.fatal / diag.worker.fatal name the cause. Without this a load
// error was a println only: on Forge it reached no log file, and the bridge reported a running
// worker with fatal:null while every command answered "no module loaded" (docs/PORTABILITY.md).
function publishLoadFailure(path, error) {
    var fatal = {owner: "worker", phase: "loadBundle", tick: tickCount, path: String(path),
                 error: String(error), time: (Date.now() / 1000) >> 0};
    try { GlobalVars.putString(FATAL_KEY, JSON.stringify(fatal)); } catch (_) {}
    try { GlobalVars.putString(STATUS_KEY, "load_failed"); } catch (_) {}
}

function loadBundle(path) {
    try {
        var p = Paths.get(path);
        if (!Files.exists(p)) {
            var macroDir = Paths.get(JsMacros.getConfig().macroFolder.toString());
            p = macroDir.resolve(path);
        }
        if (!Files.exists(p)) {
            log("ERR bundle not found: " + path);
            publishLoadFailure(path, "bundle not found: " + p + " (deploy one: ./gerda sync)");
            return false;
        }
        var code = Files.readString(p, StandardCharsets.UTF_8);
        globalThis.Module = undefined; // a bundle that exports nothing must not inherit a stale Module
        eval(code);
        if (typeof Module === "undefined" || typeof Module.init !== "function" || typeof Module.tick !== "function") {
            log("ERR bundle missing Module interface (init, tick required)");
            publishLoadFailure(p, "bundle has no Module with init()+tick() — assign globalThis.Module " +
                "(a strict-mode `var Module` stays inside eval)");
            return false;
        }
        ACTIVE_MODULE = Module;
        // Fresh load clears any prior fatal so a successful reload un-sticks the bot.
        try { GlobalVars.putString(FATAL_KEY, ""); } catch (_) {}
        RUNTIME_STATE = ACTIVE_MODULE.init();
        // Publish the bundle's command manifest so the container's `describe` can
        // merge it live (the worker's command set changes when the bundle reloads).
        try {
            if (typeof ACTIVE_MODULE.describe === "function") {
                GlobalVars.putString(CMDS_KEY, JSON.stringify(ACTIVE_MODULE.describe()));
            }
        } catch (_) {}
        try {
            if (typeof ACTIVE_MODULE.build === "function") {
                GlobalVars.putString(BUILD_KEY, JSON.stringify(ACTIVE_MODULE.build()));
            }
        } catch (_) {}
        log("Bundle loaded: " + p + " (" + code.length + " chars), module=" + (ACTIVE_MODULE.name || "unnamed"));
        return true;
    } catch (e) {
        log("ERR loadBundle: " + (e.message || e));
        publishLoadFailure(path, "loadBundle: " + (e.message || e));
        ACTIVE_MODULE = null;
        RUNTIME_STATE = null;
        return false;
    }
}

// Default bundle
var bundleLoaded = loadBundle("__gerda_bot.bundle.js");
if (!bundleLoaded) {
    log("WARN: no default bundle, waiting for load command");
}

// Seed the bounded event ring (idempotent — only initialises cursor/head/size if
// unset). The worker is the ring PRODUCER (drains the bundle each tick below);
// main.js poll_events is the consumer. See ipc.js §event ring.
try { IPC.ringInit(GlobalVars); } catch (_) {}

// ── Command processor ─────────────────────────────────────────────────────
// Writes a correlated ack to RESP_KEY ({id, ok, type, result?}) so the container's
// _passthrough can return a REAL response (recognized? faulted to ERROR?) keyed by
// the command id — replacing the old fire-and-forget "dispatched to service".
function ack(cmd, ok, result, error) {
    if (cmd.id === undefined || cmd.id === null) return; // un-correlated (internal) cmd
    var resp = {id: cmd.id, ok: ok, type: cmd.type};
    if (result !== undefined && result !== null) resp.result = result;
    if (error) resp.error = error;
    try { GlobalVars.putString(RESP_KEY, JSON.stringify(resp)); } catch (_) {}
}

function processCommand(cmd) {
    try { GlobalVars.putString(LAST_CMD_KEY, JSON.stringify({type: cmd.type, ts: (Date.now() / 1000) >> 0})); } catch (_) {}
    if (!ACTIVE_MODULE) {
        log("WARN no module loaded, ignoring cmd: " + cmd.type);
        ack(cmd, false, null, "no module loaded");
        return;
    }
    try {
        if (typeof ACTIVE_MODULE.command === "function") {
            RUNTIME_STATE = ACTIVE_MODULE.command(RUNTIME_STATE, cmd);
            log("CMD " + cmd.type + " processed (module)");
            if (cmd.type === "pause") { try { GlobalVars.putString(STATUS_KEY, "paused"); } catch (_) {} }
            if (cmd.type === "resume") { try { GlobalVars.putString(STATUS_KEY, "running"); } catch (_) {} }
            var result = null;
            try { if (typeof ACTIVE_MODULE.lastResult === "function") result = ACTIVE_MODULE.lastResult(); } catch (_) {}
            // ok comes from the kernel outcome when present (recognized + not faulted); a
            // missing/odd outcome still acks ok:true (the command ran without throwing).
            ack(cmd, result ? !!result.ok : true, result, result && result.error);
        } else {
            log("WARN module has no command handler, ignoring: " + cmd.type);
            ack(cmd, false, null, "module has no command handler");
        }
    } catch (e) {
        log("ERR command: " + (e.message || e));
        ack(cmd, false, null, (e.message || String(e)));
    }
}

// ── Tick ──────────────────────────────────────────────────────────────────
// Paced, not JsMacros.on: a slow tick must not park one jsMacros thread per game tick behind it
// (IPC.paceTick in ipc.js). The pace stats go to mc_worker_tick_pace for get_state / diag.
var lastPaceSlow = -1;
function publishPace() {
    var s = tickListener.stats();
    if (s.slow === lastPaceSlow) return; // only a new slow tick changes the published numbers
    lastPaceSlow = s.slow;
    try { GlobalVars.putString(IPC.KEYS.worker.tickPace, JSON.stringify(s)); } catch (_) {}
}
tickListener = IPC.paceTick(JsMacros, JavaWrapper.methodToJava, function () {
    publishPace();
    tickCount++;
    try { GlobalVars.putInt(ALIVE_KEY, tickCount); } catch (_) {}
    try { GlobalVars.putInt(ALIVE_TS_KEY, (Date.now() / 1000) >> 0); } catch (_) {}
    // Mirror the world signature (main.js's thread computes it; the worker Service thread
    // can't call FWorld.getDimension/getWorldIdentifier) + the render-thread-pinned entity
    // snapshots (items/mobs/peers/frames) + the hub fleet assignment into the globals the
    // bundle's facade reads. Table-driven above (TICK_MIRRORS) — one loop, per-feed guard.
    for (var mi = 0; mi < TICK_MIRRORS.length; mi++) mirrorGlobal(TICK_MIRRORS[mi]);
    if (tickCount === 1 && ACTIVE_MODULE) { // a failed load keeps its "load_failed" status
        try { GlobalVars.putString(STATUS_KEY, "running"); } catch (_) {}
    }

    // Poll commands from container
    var flag = 0;
    try { flag = GlobalVars.getInt(CMD_FLAG_KEY) || 0; } catch (_) {}
    if (flag > 0) {
        var raw = null;
        try { raw = GlobalVars.getString(CMD_KEY); } catch (_) {}
        if (raw) {
            try { processCommand(JSON.parse(raw)); }
            catch (e) { log("ERR bad cmd JSON: " + e.message); }
        }
        try { GlobalVars.putInt(CMD_FLAG_KEY, 0); } catch (_) {}
    }

    // Tick module if loaded. With the reliability paradigm the kernel handles mission
    // faults internally (→ ERROR phase); the ONLY thing that escapes Module.tick is a
    // CoreFatalError (an unrecoverable core/kernel/reflex contract violation). So any
    // throw here is FATAL: publish the detail + "fatal" status (surfaced in get_state)
    // and HALT the worker rather than limp on a corrupt state.
    if (ACTIVE_MODULE && RUNTIME_STATE !== null) {
        try {
            RUNTIME_STATE = ACTIVE_MODULE.tick(RUNTIME_STATE);
        } catch (e) {
            var detail = (e && e.detail) ? e.detail : {};
            var fatal = {
                owner: detail.owner || "unknown",
                phase: detail.phase || "?",
                tick:  detail.tick || tickCount,
                error: (e && (e.message || String(e))) || "unknown",
                time:  (Date.now() / 1000) >> 0
            };
            log("FATAL tick [" + fatal.owner + "@" + fatal.phase + "]: " + fatal.error + " — HALTING worker");
            try { GlobalVars.putString(FATAL_KEY, JSON.stringify(fatal)); } catch (_) {}
            try { GlobalVars.putString(STATUS_KEY, "fatal"); } catch (_) {}
            if (typeof ACTIVE_MODULE.stop === "function") {
                try { ACTIVE_MODULE.stop(RUNTIME_STATE); } catch (_) {}
            }
            ACTIVE_MODULE = null;
            RUNTIME_STATE = null;
        }
    }

    // Drain the bundle's event buffer into the cross-process ring (consumer =
    // main.js poll_events). Own try/catch so a ring write can never break the
    // tick or trip the FATAL unload above. The bundle stays facade-only — the
    // Service owns the GlobalVars write (Module.drainEvents → IPC.ringAppend).
    if (ACTIVE_MODULE && typeof ACTIVE_MODULE.drainEvents === "function") {
        try {
            var evs = ACTIVE_MODULE.drainEvents();
            if (evs && evs.length) {
                for (var ei = 0; ei < evs.length; ei++) {
                    IPC.ringAppend(GlobalVars, evs[ei].kind, evs[ei].fields);
                }
            }
        } catch (_re) {}
    }
});

// ── Chat listener (optional, routed to module if it has onChat) ───────────
try {
    chatListener = JsMacros.on("RecvMessage", JavaWrapper.methodToJava(function (ev) {
        // Same guard pair as the tick path above: a RecvMessage can land in the window between
        // the module being assigned and its state existing (or right after a fatal unload), and
        // onChat(null, ev) would hand the bundle a null state.
        if (ACTIVE_MODULE && RUNTIME_STATE !== null && typeof ACTIVE_MODULE.onChat === "function") {
            try {
                RUNTIME_STATE = ACTIVE_MODULE.onChat(RUNTIME_STATE, ev);
            } catch (e) {
                log("ERR onChat: " + e.message);
            }
        }
    }));
} catch (e) {
    log("WARN chat listener unavailable: " + e.message);
}

// ── Cleanup ───────────────────────────────────────────────────────────────
event.stopListener = JavaWrapper.methodToJava(function () {
    if (tickListener) { tickListener.stop(); tickListener = null; }
    if (chatListener) { JsMacros.off(chatListener); chatListener = null; }
    if (ACTIVE_MODULE && typeof ACTIVE_MODULE.stop === "function") {
        try { ACTIVE_MODULE.stop(RUNTIME_STATE); } catch (_) {}
    }
    ACTIVE_MODULE = null;
    RUNTIME_STATE = null;
    try { GlobalVars.putInt(ALIVE_KEY, 0); } catch (_) {}
    try { GlobalVars.putInt(ALIVE_TS_KEY, 0); } catch (_) {}
    try { GlobalVars.putString(STATUS_KEY, "stopped"); } catch (_) {}
    try { GlobalVars.putString(CMDS_KEY, ""); } catch (_) {}
    try { GlobalVars.putString(BUILD_KEY, ""); } catch (_) {}
    log("Stopped");
});

log("Worker ready. Loaded: " + (ACTIVE_MODULE ? ACTIVE_MODULE.name : "none"));
