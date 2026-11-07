// main.js — Container + Supervisor (jsMacros SERVICE). v3.0
// Owns: safeEval sandbox, module lifecycle, ServiceManager orchestration.
// Always-on. Reads mc_bridge_cmd_N, writes mc_bridge_resp_N.
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

// --- load pure harness core (sibling safe-io.js, eval-included; dispatch route + SRG
//     inversion/boot-check SSOT — mirror of src/shared/harness/*, drift-gated by a contract test) ---
var H = (function () {
    var F = Java.type("java.nio.file.Files");
    var P = Java.type("java.nio.file.Paths");
    var U = Java.type("java.nio.charset.StandardCharsets").UTF_8;
    var p;
    try { p = P.get(JsMacros.getConfig().macroFolder.toString()).resolve("safe-io.js"); }
    catch (_) { p = P.get("safe-io.js"); }
    if (!F.exists(p)) throw new Error("safe-io.js not found at " + p + " — deploy it (sync.py SERVICE_FILES)");
    eval(F.readString(p, U));
    return globalThis.__MC_HARNESS;
})();

// --- load shared world-model store (sibling world_store.js, eval-included) ---
var WS = (function () {
    var F = Java.type("java.nio.file.Files");
    var P = Java.type("java.nio.file.Paths");
    var U = Java.type("java.nio.charset.StandardCharsets").UTF_8;
    var p;
    try { p = P.get(JsMacros.getConfig().macroFolder.toString()).resolve("world_store.js"); }
    catch (_) { p = P.get("world_store.js"); }
    if (!F.exists(p)) throw new Error("world_store.js not found at " + p + " — deploy it (sync.py SERVICE_FILES)");
    eval(F.readString(p, U));
    return globalThis.__MC_WORLD_STORE;
})();

// --- load the "eyes & hands" screen primitives (sibling screen.js) — publishes the
//     __MC_SCREEN factory; merged into HANDLERS once SRG/writeResp exist (see below). ---
(function () {
    var F = Java.type("java.nio.file.Files");
    var P = Java.type("java.nio.file.Paths");
    var U = Java.type("java.nio.charset.StandardCharsets").UTF_8;
    var p;
    try { p = P.get(JsMacros.getConfig().macroFolder.toString()).resolve("screen.js"); }
    catch (_) { p = P.get("screen.js"); }
    if (!F.exists(p)) throw new Error("screen.js not found at " + p + " — deploy it (sync.py SERVICE_FILES)");
    eval(F.readString(p, U));
})();

var GV = GlobalVars;
var TAG = "[MAIN]";
var ALIVE_KEY = IPC.KEYS.main.alive;
var CNT_KEY = IPC.KEYS.bridge.cmdCount;
var CMD_PFX = IPC.KEYS.bridge.cmdPfx;
var RSP_PFX = IPC.KEYS.bridge.respPfx;
var WORKER_CMD_KEY = IPC.KEYS.worker.cmd;
var WORKER_CMD_FLAG = IPC.KEYS.worker.cmdFlag;
var WORKER_RESP_KEY = IPC.KEYS.worker.resp;
var WORKER_ACK_TICKS = 60; // ~3s @20tps — wait this long for the worker's correlated ack
var WORKER_ALIVE_KEY = IPC.KEYS.worker.alive;
var WORKER_TS_KEY = IPC.KEYS.worker.aliveTs;
var WORKER_STATUS_KEY = IPC.KEYS.worker.status;
var WORKER_BUILD_KEY = IPC.KEYS.worker.build;
var WORKER_FATAL_KEY = IPC.KEYS.worker.fatal;
var WORKER_PACE_KEY = IPC.KEYS.worker.tickPace;

// The worker's paceTick stats {lastMs,maxMs,slow,missed} (worker.js publishes them), or null.
function workerTickPace() {
    try { var s = GV.getString(WORKER_PACE_KEY); return s ? JSON.parse(s) : null; } catch (_) { return null; }
}
var STALL_THRESHOLD = 5;
// Movement-key dead-man: a worker tick that blocks (a synchronous replan, a long SCAN tick) leaves the
// keys its last drive pressed held, and the client walks the body with no worker veto running (RCA
// I-4: 25 s, off a 39-block rim). When the worker heartbeat (mc_worker_alive, bumped once per worker
// tick body) stands still for this many MAIN ticks (~0.5 s), main releases the movement, jump, sprint
// and sneak keys ONCE per stall, journals it, and counts the stall in diag.main.deadman. A healthy worker beats
// every tick, so this never fires against it; the worker re-presses what it wants on its next tick.
// Decision: H.deadman.step (safe-io.js; TS twin src/shared/harness/deadman.ts, contract-tested).
var DEADMAN_STALE_TICKS = 10;
var deadman = H.deadman.init();
var INSTANCE_ID = Date.now();

var SM = JsMacros.getServiceManager();
var tickCount = 0;
var tickListener = null;
var lastCmdCount = (function(){ try { return GV.getInt(CNT_KEY); } catch(_){ return 0; } })();
// Worker-bound commands awaiting a correlated ack: {id, type, deadline (tickCount)}.
// Drained each tick (drainPendingAcks) — we CAN'T block here (the bridge dispatch runs
// on the render-thread Tick listener), so the wait is spread across ticks.
var pendingAcks = [];
var activeModule = null;
var moduleState = null;
var moduleTickMs = 0;
var moduleSlowTicks = 0;
var lastSprintApplied = null; // last sprint flag we pushed onto the player (edge-trigger; see applySprint)

function log(msg) {
    java.lang.System.out.println(TAG + " " + msg);
    try { Player.getPlayer().chat(TAG + " " + msg); } catch (_e) {}
}

// The bundle's NDJSON journal: worker-bundle.ts makeSink always writes <user.dir>/config/jsMacros/
// Macros/miner.ndjson. The fallback to the macro folder is main's own: until the worker has written
// that file, get_logs reads and journalAppend writes <macroFolder>/miner.ndjson, so a DEADMAN
// journaled before the worker's first record lands there.
function journalPath() {
    var Files = Java.type("java.nio.file.Files");
    var Paths = Java.type("java.nio.file.Paths");
    var path = Paths.get(java.lang.System.getProperty("user.dir"), "config", "jsMacros", "Macros", "miner.ndjson");
    if (!Files.exists(path)) path = Paths.get(JsMacros.getConfig().macroFolder.toString(), "miner.ndjson");
    return path;
}

// Append one record to the journal, the way the bundle's sink does (FileWriter, append). For the
// few main.js events an operator must find with get_logs; log() reaches only stdout and chat.
function journalAppend(rec) {
    try {
        var BufferedWriter = Java.type("java.io.BufferedWriter");
        var FileWriter = Java.type("java.io.FileWriter");
        var w = new BufferedWriter(new FileWriter(journalPath().toString(), true));
        try { w.write(JSON.stringify(rec)); w.newLine(); } finally { w.close(); }
    } catch (e) {
        java.lang.System.out.println(TAG + " ERR journalAppend: " + (e.message || e));
    }
}

function safe(label, fn) {
    try { return fn(); }
    catch (e) {
        log("ERR " + label + ": " + (e.message || e));
        return null;
    }
}

function writeResp(id, obj) {
    try { GV.putString(RSP_PFX + id, JSON.stringify(obj)); }
    catch (e) { log("ERR writeResp id=" + id + ": " + (e.message || e)); }
}

// Response envelopes routed through the ipc.js factory SSOT (the wire-shape source of
// truth) so handlers stop hand-building {ok,type,id,…} literals. respFlat = flat fields
// spread; respData = a {data:…} payload; respErr = an error (+ optional extra fields).
function respFlat(id, type, fields) { writeResp(id, IPC.okFlat(id, type, fields)); }
function respData(id, type, data)   { writeResp(id, IPC.ok(id, type, data)); }
function respErr(id, type, error, extra) { writeResp(id, IPC.err(id, type, error, extra)); }

// ---------------------------------------------------------------------------
// SRG names + input constants — the SINGLE place raw Forge obfuscation names live.
// Vanilla/Forge internals aren't remapped by jsMacros, so the synthetic-input
// primitives (click/scroll/type/keypress) call these `m_…_` names by reflection.
// (jsMacros-wrapped APIs need NO SRG — only these raw GuiEventListener/Screen calls.)
// Re-derive any name by SIGNATURE on mappings.dev / Linkie under GuiEventListener:
//   mouseClicked(double,double,int) · mouseReleased(double,double,int)
//   mouseScrolled(double,double,double) [unique 3×double] · charTyped(char,int)
//   keyPressed(int,int,int) · keyReleased(int,int,int)
// or list live names with `introspect {target:"screen"}`. Shared with ext.js (it is
// eval'd in this scope by loadExt, so it references SRG/KEY directly).
var SRG = {
    mouseClicked:  "m_6375_", // Screen.mouseClicked(x,y,button)
    mouseReleased: "m_6348_", // Screen.mouseReleased(x,y,button)
    mouseScrolled: "m_6050_", // Screen.mouseScrolled(x,y,amount)
    charTyped:     "m_5534_", // Screen.charTyped(char,modifiers)
    keyPressed:    "m_7933_", // Screen.keyPressed(key,scancode,modifiers)
    keyReleased:   "m_7920_", // Screen.keyReleased(key,scancode,modifiers)
    // Entity.setSprinting(boolean) — the per-tick sprint applier (see the Tick handler).
    // Centralised here (the "single place raw SRG names live") instead of an inline token;
    // resolved off-thread would race the render FOV read, so it stays a main-thread call.
    setSprinting:  "m_6858_"   // LocalPlayer/Entity.setSprinting(sprinting)
};
var KEY = { ESCAPE: 256, ENTER: 257, BACKSPACE: 259 }; // GLFW key codes for keypress

// ---------------------------------------------------------------------------
// Reloadable extension layer (ext.js) — mod-API plugins (EMI/prospector/FTB/…).
// main.js is the STABLE supervisor; ext.js is the HOT layer. ext code calls the
// global register(name, fn, meta); dispatch() routes EXT[type] after HANDLERS and
// before the worker passthrough; describe merges EXT metas. `reload_ext` re-evals
// the file with NO main.js reload — so new mod commands ship via sync + reload_ext.
// ---------------------------------------------------------------------------
var EXT = {};            // name -> {fn(req,id), meta}
var EXT_FILE = "ext.js"; // resolved against the jsMacros macro folder
var _XFiles = Java.type("java.nio.file.Files");
var _XPaths = Java.type("java.nio.file.Paths");
var _XCharset = Java.type("java.nio.charset.StandardCharsets").UTF_8;

function register(name, fn, meta) {
    EXT[name] = {fn: fn, meta: meta || {where: "ext", desc: name, params: []}};
}

function _extPath() {
    // Macros are deployed next to main.js in <gamedir>/config/jsMacros/Macros.
    try {
        var dir = JsMacros.getConfig().macroFolder; // java.io.File
        var p = _XPaths.get(dir.toString()).resolve(EXT_FILE);
        if (_XFiles.exists(p)) return p;
    } catch (_) {}
    var rel = _XPaths.get(EXT_FILE); // fallback: cwd (gamedir)
    return rel;
}

// Cheap deploy-drift signal: a stable content hash of a deployed Service file. The
// running services stamp their boot hash into GlobalVars; `diag` re-hashes the file
// on disk NOW and compares → a mismatch means "you've redeployed but not reloaded"
// (the exact blind spot that forces guesswork). Not crypto — a 32-bit FNV-ish hash,
// good enough to detect any edit. Returns "<len>:<hex>" or null if unreadable.
function _macroFile(name) {
    try {
        var dir = JsMacros.getConfig().macroFolder;
        var p = _XPaths.get(dir.toString()).resolve(name);
        if (_XFiles.exists(p)) return p;
    } catch (_) {}
    return _XPaths.get(name);
}
function _hashFile(path) {
    try {
        if (!_XFiles.exists(path)) return null;
        var s = _XFiles.readString(path, _XCharset);
        var h = 2166136261;
        for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = (h * 16777619) >>> 0; }
        return s.length + ":" + ("00000000" + h.toString(16)).slice(-8);
    } catch (_) { return null; }
}

var MAIN_REV = _hashFile(_macroFile("main.js"));
var EXT_REV = null; // set on each successful loadExt

function loadExt(opts) {
    opts = opts || {};
    var prev = EXT; // rollback target
    try {
        var code = opts.code;
        var src = "inline";
        if (!code) {
            var p = opts.path ? _XPaths.get(opts.path) : _extPath();
            if (!_XFiles.exists(p)) return {ok: false, error: "ext file not found: " + p};
            code = _XFiles.readString(p, _XCharset);
            src = "" + p;
        }
        EXT = {}; // fresh registry so removed/renamed commands disappear (not additive)
        eval(code); // privileged: ext.js IIFE runs and calls register(...) into EXT
        EXT_REV = _hashFile(_extPath());
        return {ok: true, source: src, registered: Object.keys(EXT)};
    } catch (e) {
        EXT = prev; // keep the previously-working command set on failure
        return {ok: false, error: "loadExt failed: " + (e.message || e)};
    }
}

// ---------------------------------------------------------------------------
// World-scoped knowledge (mc_world.json) — the unified store (stage 5). Schema:
//   { version:1, worlds: { "<sig>": {waypoints,resources,stats,updatedAt} } }
// The worker (R2) owns waypoints/stats; the prospector (ext.js) owns resources.
// Here (R0) we only READ for poll/knowledge and offer a manual merge `knowledge_set`
// — each writer read-modify-writes preserving the OTHER sections (no cross-proc lock,
// writes are infrequent). The file lives next to the Service files (macroFolder), the
// SAME path the bundle pins (user.dir/config/jsMacros/Macros/mc_world.json).
// worldSignature mirrors src/core/runtime/jsmacros/world.ts: "<world/server id>|<dimension>".
// All five live in the shared world_store.js (eval-included above) — aliased here so
// existing call sites read naturally and ext.js shares the SAME implementation.
// ---------------------------------------------------------------------------
var worldSignature = WS.signature;
var readWorldModel = WS.read;
var worldSection = WS.section;
// (writeWorldModel is not aliased here — every RMW writer goes through WS.update now.)

// ---------------------------------------------------------------------------
// Sandbox eval
// ---------------------------------------------------------------------------
var BANNED_PATTERNS = /(while\s*\(|for\s*\(\s*;*\s*;|do\s*\{|\bjava\b|\bRuntime\b|\bProcessBuilder\b|\bexec\s*\()/i;
var MAX_CODE_LEN = 256000;

function safeEval(code) {
    if (!code || code.length > MAX_CODE_LEN) {
        return {ok: false, error: "code empty or exceeds " + MAX_CODE_LEN + " chars"};
    }
    if (BANNED_PATTERNS.test(code)) {
        return {ok: false, error: "SECURITY: forbidden pattern detected"};
    }
    try {
        var fn = new Function("_ctx", "var java=undefined, JsMacros=undefined, event=undefined; with(_ctx){return(" + code + ");}");
        var result = fn({
            World: World, Player: Player,
            GlobalVars: GlobalVars, Math: Math, JSON: JSON,
            String: String, Number: Number, Date: Date,
            console: {log: function(m){log("[EVAL] " + m);}}
        });
        return {ok: true, data: _serialize(result)};
    } catch (e) {
        return {ok: false, error: (e.message || String(e))};
    }
}

// ---------------------------------------------------------------------------
// jeval game-safety pre-flight (defense in depth, layer B).
// jeval runs PRIVILEGED code on the service thread, and the Tick event is JOINED —
// the game thread waits for it. So a blocking call freezes the game; >500ms trips
// jsMacros' EventLockWatchdog which KILLS main's Tick listener (main goes deaf), and
// a multi-second freeze desyncs the integrated server → the WORLD UNLOADS. We reject
// the patterns that block a thread the game waits on:
//   1. blocking (sleep / infinite loop) INSIDE runOnMainThread(...) — that callback
//      runs ON the render thread, so it freezes the game DIRECTLY.
//   2. an infinite loop anywhere — blocks the calling thread + trips the watchdog.
//   3. Thread.sleep that is NOT inside a spawned `new Thread(...)` — i.e. a sleep on
//      the joined Tick. (Sleeping inside a background thread you start is fine — that's
//      the documented reload_main bootstrap pattern.)
// (jsMacros' EventLockWatchdog kills a handler blocked >500ms and can drop the world.)
var _LOOP_RE = /while\s*\(\s*(?:true|1)\s*\)|for\s*\(\s*;\s*;/;
var _SLEEP_RE = /Thread\s*\.\s*sleep/;

// Extract each call's balanced-paren argument substring for calls matching `re` (which
// must end at the opening "("). Lets us inspect what's INSIDE runOnMainThread / new Thread.
function _argBlocks(code, re) {
    var out = [], m;
    re.lastIndex = 0;
    while ((m = re.exec(code)) !== null) {
        var depth = 1, j = re.lastIndex;
        for (; j < code.length && depth > 0; j++) {
            var c = code.charAt(j);
            if (c === "(") depth++;
            else if (c === ")") depth--;
        }
        out.push(code.slice(re.lastIndex, j - 1));
        re.lastIndex = j;
    }
    return out;
}

// Returns a rejection reason if `code` would block a game-joined thread, else null.
function jevalRisk(code) {
    var onMain = _argBlocks(code, /runOnMainThread\s*\(/g);
    for (var i = 0; i < onMain.length; i++) {
        if (_SLEEP_RE.test(onMain[i]) || _LOOP_RE.test(onMain[i])) {
            return "blocking (Thread.sleep / infinite loop) INSIDE runOnMainThread — that callback runs ON the render thread and FREEZES the game. Do the wait off the main thread (a new java.lang.Thread, or drive it across ticks).";
        }
    }
    if (_LOOP_RE.test(code)) {
        return "infinite loop blocks the thread and trips the watchdog — bound the loop or drive work across ticks.";
    }
    // Strip every `new Thread(...)` body, then any remaining Thread.sleep is on the
    // calling (joined Tick) thread → would freeze the game and can unload the world.
    var stripped = code, threads = _argBlocks(code, /new\s+(?:java\.lang\.)?Thread\s*\(/g);
    for (var t = 0; t < threads.length; t++) stripped = stripped.split(threads[t]).join("");
    if (_SLEEP_RE.test(stripped)) {
        return "Thread.sleep on the calling thread freezes the joined Tick (kills main / can unload the world). Put the sleep inside a new java.lang.Thread(...), or drive timed work across ticks.";
    }
    return null;
}

function _serialize(v) {
    if (v === undefined || v === null) return null;
    if (typeof v === "function") return "[function]";
    if (typeof v === "object") {
        try { return JSON.parse(JSON.stringify(v)); }
        catch (_e) {
            var keys = [];
            for (var k in v) { try { keys.push(k); } catch (_e2) {} }
            return {__type: typeof v, keys: keys};
        }
    }
    return v;
}

// ---------------------------------------------------------------------------
// Module lifecycle (passive module via load)
// ---------------------------------------------------------------------------
function loadModule(code) {
    if (!code) return {ok: false, error: "missing code"};
    if (BANNED_PATTERNS.test(code)) {
        return {ok: false, error: "SECURITY: forbidden pattern"};
    }
    if (activeModule) {
        safe("unload", function () { activeModule.stop(moduleState); });
        activeModule = null;
        moduleState = null;
    }
    try {
        var fn = new Function("_ctx", "var java=undefined, JsMacros=undefined, event=undefined; with(_ctx){" + code + "; return (typeof Module !== 'undefined' ? Module : null);}");
        var mod = fn({
            World: World, Player: Player,
            GlobalVars: GlobalVars, Math: Math, JSON: JSON,
            String: String, Number: Number, Date: Date,
            console: {log: function(m){log("[MODULE] " + m);}}
        });
        if (!mod || typeof mod.init !== "function" || typeof mod.tick !== "function") {
            return {ok: false, error: "Module missing required methods: init(), tick()"};
        }
        activeModule = mod;
        moduleState = mod.init();
        return {ok: true, data: {name: mod.name || "unnamed", state: _serialize(moduleState)}};
    } catch (e) {
        activeModule = null;
        moduleState = null;
        return {ok: false, error: (e.message || String(e))};
    }
}

function unloadModule() {
    if (activeModule && typeof activeModule.stop === "function") {
        try { activeModule.stop(moduleState); } catch (_) {}
    }
    activeModule = null;
    moduleState = null;
    return {ok: true};
}

// ---------------------------------------------------------------------------
// ServiceManager lifecycle (managed service via start/stop)
// ---------------------------------------------------------------------------
var managedServiceName = null;
var _lastStartMs = {};
// One-shot latch: auto-start the worker (IDLE) the first time the world is loaded, so the
// kernel (missions + ALL reflexes, incl. survival) is always ticking. Without it a freshly
// launched / never-`start`ed bot has ZERO safety (no worker tick = no reflex → it drowns/dies
// parked). One-shot, NOT keep-alive, so a deliberate `halt`/`stop` stays down.
var workerAutoStarted = false;

function startManaged(name) {
    if (!name) return {ok: false, error: "missing service name"};
    try {
        if (SM.isRunning(name)) {
            managedServiceName = name;
            return {ok: true, data: "already running"};
        }
        var alive = 0;
        try { alive = GlobalVars.getInt(WORKER_ALIVE_KEY); } catch (_) {}
        if (alive > 0) {
            managedServiceName = name;
            return {ok: true, data: "alive heartbeat detected"};
        }
        if (_lastStartMs[name] && (Date.now() - _lastStartMs[name]) < 2000) {
            return {ok: true, data: "throttled"};
        }
        _lastStartMs[name] = Date.now();
        try { SM.registerService(name, name + ".js"); }
        catch (regErr) { log("WARN registerService: " + regErr.message); }
        try {
            SM.startService(name);
            managedServiceName = name;
            log("Started managed service: " + name);
            return {ok: true, data: "started " + name};
        } catch (startErr) {
            log("ERR startService(" + name + "): " + startErr.message);
            return {ok: false, error: "startService failed: " + startErr.message};
        }
    } catch (e) {
        log("ERR startManaged(" + name + "): " + e.message);
        return {ok: false, error: "start failed: " + e.message};
    }
}

function stopManaged(hard) {
    if (!managedServiceName) return {ok: false, error: "no managed service"};
    try {
        if (!hard) {
            GV.putString(WORKER_CMD_KEY, JSON.stringify({type: "halt"}));
            GV.putInt(WORKER_CMD_FLAG, (Date.now() / 1000) >> 0);
        }
        if (SM.isRunning(managedServiceName)) {
            SM.stopService(managedServiceName);
        }

        var n = managedServiceName;
        managedServiceName = null;
        try { delete _lastStartMs[n]; } catch (_) {}
        try { GV.putInt(WORKER_ALIVE_KEY, 0); } catch (_) {}
        try { GV.putInt(WORKER_TS_KEY, 0); } catch (_) {}
        try { GV.putString(WORKER_STATUS_KEY, "stopped"); } catch (_) {}
        return {ok: true, data: (hard ? "halted " : "stopped ") + n};
    } catch (e) {
        return {ok: false, error: "stop failed: " + (e.message || e)};
    }
}

// Registered service names as a JS array of strings. getServices() returns a Java Set<String>.
function _serviceNames() {
    var arr = SM.getServices().toArray();
    var out = [];
    for (var i = 0; i < arr.length; i++) out.push(String(arr[i]));
    return out;
}

function managedStatus() {
    if (!managedServiceName) return {loaded: false};
    var running = false;
    try { running = SM.isRunning(managedServiceName); } catch (_) {}
    return {loaded: true, name: managedServiceName, running: running};
}

// ---------------------------------------------------------------------------
// META command manifest — ONLY the supervisor/diagnostic/primitive commands the
// container handles directly. Game-logic commands live in the WORKER bundle and
// are reported by it (GlobalVars mc_worker_cmds), then merged here by `describe`.
// So the full API is: static meta (this) + the running bundle's live command set
// → the manifest tracks bundle reloads with no edit to this file or the MCP.
// ---------------------------------------------------------------------------
var META_COMMANDS = {
    // --- diagnostics / state ---
    ping:        {where: "bridge", desc: "connectivity test → pong, answered by bridge.js itself", params: []},
    diag:        {where: "container", desc: "one-call topology/health: live handlers+ext, worker heartbeat age, per-file deploy drift (bootRev vs disk). Main-local — works when the worker is dead", params: []},
    bridge_diag: {where: "bridge", desc: "stable-layer health answered by bridge.js itself (service running-states + heartbeats + revs); works even when main is deaf/stale", params: []},
    restart_service: {where: "bridge", desc: "restart a jsMacros service via ServiceManager, bypassing main — recovers a stale/deaf main that can't restart itself", params: [{name: "name", type: "string", required: false, desc: "service: main|worker|bridge (default main)"}]},
    status:      {where: "container", desc: "container + module status", params: []},
    services:    {where: "container", desc: "list registered jsMacros services", params: []},
    get_state:   {where: "container", desc: "pos/health/dim/tool/worker snapshot", params: []},
    scan:        {where: "container", desc: "read-only ore scan around player", params: [{name: "radius", type: "int", required: false}, {name: "scan_y_range", type: "int", required: false}]},
    inventory:   {where: "container", desc: "FULL carry inventory: per-slot list + per-id totals (carry), hotbar detail, ore/tool summary", params: []},
    get_logs:    {where: "container", desc: "tail the NDJSON journal", params: [{name: "n", type: "int", required: false, desc: "lines, default 100 max 500"}]},
    describe:    {where: "container", desc: "this manifest — meta + live worker commands", params: []},
    introspect:  {where: "container", desc: "dump jsMacros method names (debug)", params: [{name: "filter", type: "string", required: false}, {name: "target", type: "string", required: false, desc: "'screen' to dump open-screen/button methods"}]},
    // --- AI hands & eyes (generic game-UI primitives) ---
    screenshot:  {where: "container", desc: "native in-game screenshot (jsMacros Player.takeScreenshot → screenshots/ai_shot.png; works unfocused while rendering)", params: [{name: "name", type: "string", required: false, desc: "filename (default ai_shot.png)"}]},
    latest_screenshot: {where: "container", desc: "path+mtime of newest screenshot PNG", params: []},
    read_screen: {where: "container", desc: "open GUI: title + button widgets (text/pos/active)", params: []},
    click:       {where: "container", desc: "click: real Screen.mouseClicked at GUI coords (x,y = screenshot-pixel/guiScale; drives FTB/custom GUIs), or a button by i/text", params: [{name: "i", type: "int", required: false, desc: "button index"}, {name: "text", type: "string", required: false, desc: "label substring"}, {name: "x", type: "int", required: false, desc: "GUI x = pixel/guiScale"}, {name: "y", type: "int", required: false, desc: "GUI y = pixel/guiScale"}, {name: "button", type: "int", required: false, desc: "0=left 1=right"}]},
    scroll:      {where: "container", desc: "scroll the open screen at (x,y); amount +up/-down notches", params: [{name: "x", type: "int", required: false}, {name: "y", type: "int", required: false}, {name: "amount", type: "int", required: false, desc: "default -3 (down)"}]},
    type:        {where: "container", desc: "type text into the focused widget (click a search box first)", params: [{name: "text", type: "string", required: true}]},
    keypress:    {where: "container", desc: "raw GLFW key to the screen (Enter=257 Backspace=259 Esc=256)", params: [{name: "code", type: "int", required: true}, {name: "scancode", type: "int", required: false}, {name: "mods", type: "int", required: false}]},
    // --- mod-API commands (emi_search/emi_recipe/emi_uses, prospect, markers, …)
    //     live in ext.js and self-describe via register() metas, merged below. ---
    reload_ext:  {where: "container", desc: "re-eval ext.js (reloadable mod-API plugins: EMI/prospector/FTB) WITHOUT reloading main.js — ship new mod commands via sync + this", params: [{name: "path", type: "string", required: false, desc: "override ext file path"}, {name: "code", type: "string", required: false, desc: "inline ext code instead of the file"}]},
    reload_main: {where: "container", desc: "restart the main supervisor service itself (re-reads main.js from disk; headless GUI-free reload). Use after editing main.js; ext.js uses reload_ext", params: [{name: "delay", type: "int", required: false, desc: "ms before restart, default 1000 (lets the response flush first)"}]},
    chat:        {where: "container", desc: "send any text/command to chat — drive mod & Baritone commands (/home, /sethome, /back, /warp, /tp, #goto …) via one generic passthrough", params: [{name: "message", type: "string", required: true}]},
    close_screen: {where: "container", desc: "close the open GUI screen", params: []},
    key:         {where: "container", desc: "press a named keybind", params: [{name: "key", type: "string", required: true, desc: "e.g. key.inventory, key.drop"}, {name: "hold", type: "bool", required: false}, {name: "release", type: "bool", required: false}]},
    goto:        {where: "container", desc: "raw Baritone #goto x y z (movement primitive)", params: [{name: "x", type: "int", required: true}, {name: "y", type: "int", required: true}, {name: "z", type: "int", required: true}]},
    // --- knowledge + events (world-scoped store mc_world.json + pull event ring) ---
    poll_events: {where: "container", desc: "drain the bounded event ring since a cursor → {events, seq}; pass the returned seq next time", params: [{name: "since", type: "int", required: false, desc: "last seq seen (0/omitted = all currently buffered)"}]},
    knowledge:   {where: "container", desc: "read world-scoped knowledge (waypoints/resources/stats) for the current or a given world signature", params: [{name: "sig", type: "string", required: false, desc: "world signature; default = current world"}, {name: "all", type: "bool", required: false, desc: "return every world section + the signature list"}]},
    knowledge_set: {where: "container", desc: "merge waypoints/resources/stats into world-scoped knowledge (read-modify-write; other worlds + unspecified sections untouched)", params: [{name: "sig", type: "string", required: false}, {name: "waypoints", type: "array", required: false}, {name: "resources", type: "array", required: false}, {name: "stats", type: "object", required: false}]},
    // --- worker lifecycle (meta: manage the bundle, not the game) ---
    start:       {where: "container", desc: "start the worker service (loads bundle)", params: [{name: "name", type: "string", required: false}]},
    stop:        {where: "container", desc: "graceful stop of the worker", params: []},
    halt:        {where: "container", desc: "hard stop + #stop Baritone", params: []},
    reload_worker: {where: "container", desc: "idempotent worker reload = halt+start as ONE off-thread command (never deaf-locks main like a blocking halt can). Prefer this over manual halt→start; scripts/ops/reload_worker.py drives it", params: [{name: "name", type: "string", required: false}, {name: "delay", type: "int", required: false, desc: "ms between stop and start, default 1500"}]},
    eval:        {where: "container", desc: "sandboxed JS eval (World/Player only)", params: [{name: "code", type: "string", required: true}]},
    jeval:       {where: "container", desc: "PRIVILEGED raw eval — full jsMacros/Java scope (Java.type, Client, mod APIs); loopback only", params: [{name: "code", type: "string", required: true}]},
    load:        {where: "container", desc: "load a passive module (runs in parallel)", params: [{name: "code", type: "string", required: true}]}
};

var WORKER_CMDS_KEY = IPC.KEYS.worker.cmds;

// Live manifest = meta (above) + the running bundle's self-reported commands.
// Meta wins on name clashes (e.g. start/halt are container lifecycle, not the
// worker's FSM commands of the same name).
function buildManifest() {
    var out = {};
    var k;
    var worker = null;
    try {
        var raw = GV.getString(WORKER_CMDS_KEY);
        if (raw) worker = JSON.parse(raw);
    } catch (_) { worker = null; }
    if (worker) {
        for (k in worker) { if (worker.hasOwnProperty(k)) out[k] = worker[k]; }
    }
    for (k in EXT) { if (EXT.hasOwnProperty(k)) out[k] = EXT[k].meta; }
    for (k in META_COMMANDS) { if (META_COMMANDS.hasOwnProperty(k)) out[k] = META_COMMANDS[k]; }
    return out;
}

// EMI (emi_*), GTCEu prospector (prospect) and the ore-marker cache (markers)
// moved to the reloadable ext.js plugin layer — see loadExt()/reload_ext above.

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
var HANDLERS = {
    describe: function (_req, id) {
        respFlat(id, "describe", {commands: buildManifest()});
    },

    // One-call topology/health snapshot answered ENTIRELY by main (never dispatched to
    // the worker), so it works when the worker is dead/orphaned/stale — the failure mode
    // that otherwise collapses every probe into one ambiguous "worker did not ack". Reports:
    // which handlers + ext plugins are live, the worker heartbeat age, and per-file DEPLOY
    // DRIFT (bootRev vs the current on-disk hash → "redeployed but not reloaded").
    diag: function (_req, id) {
        var workerAlive = 0, workerTs = 0, workerStatus = null, workerBuild = null, workerFatal = null;
        try { workerAlive = GV.getInt(WORKER_ALIVE_KEY) || 0; } catch (_) {}
        try { workerTs = GV.getInt(WORKER_TS_KEY) || 0; } catch (_) {}
        try { workerStatus = GV.getString(WORKER_STATUS_KEY) || null; } catch (_) {}
        try { var wb = GV.getString(WORKER_BUILD_KEY); if (wb) workerBuild = JSON.parse(wb); } catch (_) {}
        try { var wf = GV.getString(WORKER_FATAL_KEY); if (wf) workerFatal = JSON.parse(wf); } catch (_) {}
        var nowSec = (Date.now() / 1000) >> 0;
        var workerAgeSec = workerTs > 0 ? (nowSec - workerTs) : null;
        var mainDisk = _hashFile(_macroFile("main.js"));
        var extDisk = _hashFile(_extPath());
        writeResp(id, {
            ok: true, type: "diag", id: id,
            main: {
                bootRev: MAIN_REV, diskRev: mainDisk, stale: (MAIN_REV !== mainDisk),
                ticks: tickCount, instance: INSTANCE_ID, ipcVersion: IPC.VERSION,
                tickPace: tickListener ? tickListener.stats() : null,
                // Movement-key dead-man: stalls = worker stalls ≥ staleTicks (each released the keys,
                // held or not); stalledTicks = main ticks since the worker heartbeat last moved.
                deadman: {staleTicks: DEADMAN_STALE_TICKS, stalls: deadman.stalls, lastStallTick: deadman.stallTick,
                          stalledTicks: tickCount - deadman.beatTick, tripped: deadman.tripped},
                handlers: Object.keys(HANDLERS),
                // SRG boot self-check: "1" all required SRG names resolved,
                // "0" pack rot (missing lists the unresolved) OR not a Forge-SRG runtime (runtime.reason:
                // Fabric / Mojang-named), "unknown" srg_names.json absent.
                srgCheck: (typeof SRG_CHECK !== "undefined") ? SRG_CHECK : {ok: "unknown", tokens: [], members: []}
            },
            ext: {
                bootRev: EXT_REV, diskRev: extDisk, stale: (EXT_REV !== extDisk),
                registered: Object.keys(EXT)
            },
            worker: {
                running: managedStatus().running, alive: workerAlive, ageSec: workerAgeSec,
                stalled: workerAlive > 0 && workerAgeSec !== null && workerAgeSec > STALL_THRESHOLD,
                status: workerStatus, build: workerBuild, fatal: workerFatal, tickPace: workerTickPace(),
                module: activeModule ? (activeModule.name || "unnamed") : null,
                phase: moduleState ? (moduleState.phase || null) : null
            }
        });
    },

    status: function (_req, id) {
        var modStatus = activeModule ? {
            name: activeModule.name || "unnamed",
            stateKeys: moduleState ? Object.keys(moduleState) : []
        } : null;
        var svcStatus = managedStatus();
        // The worker's own word on its bundle: a load failure leaves module null and the service
        // "loaded", so without this `status` (the first thing a newcomer runs) looked healthy.
        var wStatus = null, wFatal = null;
        try { wStatus = GV.getString(WORKER_STATUS_KEY) || null; } catch (_) {}
        try { var wfs = GV.getString(WORKER_FATAL_KEY); if (wfs) wFatal = JSON.parse(wfs); } catch (_) {}
        var rawServices = [];
        try { rawServices = _serviceNames(); } catch (e) { rawServices = ["ERR " + (e.message || e)]; }
        writeResp(id, {
            ok: true, type: "status", id: id,
            container: {ticks: tickCount, instance: INSTANCE_ID},
            module: modStatus,
            service: svcStatus,
            worker: {status: wStatus, fatal: wFatal},
            rawServices: rawServices
        });
    },
    // jsMacros 1.9 ServiceManager.getServices() is a Set<String> of NAMES (javap-verified on
    // jsmacros-1.20.1-1.9.2-forge), not a Map: the old `.keySet()` threw, the catch swallowed it,
    // and `services` answered [] while main/bridge/worker ran (D-7). A real failure now errors.
    services: function (_req, id) {
        try {
            var names = _serviceNames();
            var services = [];
            for (var i = 0; i < names.length; i++) {
                services.push({name: names[i], running: SM.isRunning(names[i]), enabled: SM.isEnabled(names[i])});
            }
            respFlat(id, "services", {services: services});
        } catch (e) {
            respErr(id, "services", "ServiceManager read failed: " + (e.message || e));
        }
    },

    eval: function (req, id) {
        var r = safeEval(req.code);
        r.id = id; r.type = "eval";
        writeResp(id, r);
    },

    // PRIVILEGED raw eval — full jsMacros/Java scope (Java.type, Client, JsMacros,
    // World, Player, the mod APIs). The sandboxed `eval` deliberately can't reach
    // these; `jeval` is the explicit escape hatch for driving mod Java APIs (FTB
    // Quests, EMI, GTCEu). Safe ONLY because the bridge is loopback-only and main.js
    // already runs with full access — this exposes that intentionally, it does NOT
    // weaken `eval`. Runs on the service thread; for GUI/GL wrap in
    // Client.runOnMainThread yourself (note: that's fire-and-forget, no return value).
    jeval: function (req, id) {
        try {
            var code = req.code;
            if (!code) { respErr(id, "jeval", "missing code"); return; }
            var risk = jevalRisk(code);
            if (risk) { respErr(id, "jeval", "jeval rejected (game-safety): " + risk); return; }
            var result = eval(code);
            respFlat(id, "jeval", {data: _serialize(result)});
        } catch (e) {
            respErr(id, "jeval", (e.message || String(e)));
        }
    },

    load: function (req, id) {
        var r = loadModule(req.code);
        r.id = id; r.type = "load";
        writeResp(id, r);
    },

    // Hot-reload the ext.js plugin layer (mod-API commands: EMI/prospector/FTB).
    // Re-evals the deployed ext.js (or inline `code`) → its register() calls
    // rebuild the EXT registry → dispatch + describe pick up the new commands.
    // No main.js service reload. This is the iteration loop for mod commands.
    reload_ext: function (req, id) {
        var r = loadExt({path: req.path, code: req.code});
        r.id = id; r.type = "reload_ext";
        writeResp(id, r);
    },

    // Restart THIS supervisor service (re-reads main.js from disk) — the headless,
    // GUI-free equivalent of toggling main in the jsMacros Services screen. The
    // restart is deferred on a background thread so this response flushes to the
    // bridge BEFORE the service dies. Use ONLY after editing main.js itself; ext.js
    // changes use reload_ext (no main restart). Worker keeps running across it.
    reload_main: function (req, id) {
        var delay = (typeof req.delay === "number" && req.delay >= 0) ? req.delay : 1000;
        respFlat(id, "reload_main", {note: "restarting main in " + delay + "ms (re-reads main.js from disk)"});
        try {
            var r = JavaWrapper.methodToJava(function () {
                try { java.lang.Thread.sleep(delay); } catch (e) {}
                try { SM.restartService("main"); }
                catch (e) { log("reload_main restart err: " + (e.message || e)); }
            });
            new java.lang.Thread(r).start();
        } catch (e) {
            log("reload_main schedule err: " + (e.message || e));
        }
    },

    // Idempotent worker reload = halt+start as ONE command, run on a BACKGROUND thread after the
    // response is flushed — so the host never has to send two racing commands and never blind-retries.
    // WHY this exists: `halt` calls SM.stopService() SYNCHRONOUSLY on main's Tick thread; if the worker
    // is stuck (e.g. a stale LocalPlayer ref after a respawn — "Player Clone: 1"), stopService BLOCKS,
    // main's Tick dispatch blocks, and the whole bridge goes DEAF (this deaf-locked bot_1 on a bare
    // `halt`, id=156 queued-never-acked). Doing the stop/sleep/start off-thread (same pattern as
    // reload_main) keeps main's Tick alive no matter how slow the service cycle is. Prefer this over
    // manual halt→start from the host; scripts/ops/reload_worker.py drives it.
    reload_worker: function (req, id) {
        var name = req.name || "worker";
        var delay = (typeof req.delay === "number" && req.delay >= 0) ? req.delay : 1500;
        // Flush FIRST — never let the (possibly blocking) stop wedge the bridge waiting on us.
        respFlat(id, "reload_worker", {note: "reloading worker (halt+start) off-thread, ~" + delay + "ms"});
        try {
            var r = JavaWrapper.methodToJava(function () {
                try { if (activeModule) { unloadModule(); } } catch (e) { log("reload_worker unload err: " + (e.message || e)); }
                try { stopManaged(true); } catch (e) { log("reload_worker stop err: " + (e.message || e)); }
                try { java.lang.Thread.sleep(delay); } catch (e) {}
                try { startManaged(name); } catch (e) { log("reload_worker start err: " + (e.message || e)); }
            });
            new java.lang.Thread(r).start();
        } catch (e) {
            log("reload_worker schedule err: " + (e.message || e));
        }
    },

    // Generic chat passthrough — send ANY text or command to chat. This is how we
    // drive mod & Baritone commands (/home, /sethome, /back, /warp, /tp, #goto …)
    // WITHOUT baking a bespoke handler per command. The mods own the behaviour;
    // main.js just relays. (Loopback bridge only.)
    chat: function (req, id) {
        try {
            var msg = (req.message != null) ? String(req.message) : (req.text != null ? String(req.text) : "");
            if (!msg) { respErr(id, "chat", "missing 'message'"); return; }
            Chat.say(msg);
            respFlat(id, "chat", {sent: msg});
        } catch (e) {
            respErr(id, "chat", "chat failed: " + (e.message || e));
        }
    },


    start: function (req, id) {
        var r = startManaged(req.name || "worker");
        r.id = id; r.type = "start";
        writeResp(id, r);
    },

    stop: function (_req, id) {
        if (activeModule) {
            var r = unloadModule();
            r.id = id; r.type = "stop";
            writeResp(id, r);
            return;
        }
        var r = stopManaged(false);
        r.id = id; r.type = "stop";
        writeResp(id, r);
    },

    halt: function (_req, id) {
        if (activeModule) {
            unloadModule();
        }
        var r = stopManaged(true);
        r.id = id; r.type = "halt";
        writeResp(id, r);
    },

    // Forward to the worker and wait (across ticks, non-blocking) for its correlated ack.
    // We stamp the bridge id INTO the command so the worker echoes it back on RESP_KEY;
    // drainPendingAcks (in the Tick handler) matches by id and flushes the real response.
    // If the worker never acks within WORKER_ACK_TICKS, we report it (dispatched, unconfirmed).
    _passthrough: function (req, id) {
        try {
            req.id = id;
            GV.putString(WORKER_CMD_KEY, JSON.stringify(req));
            GV.putInt(WORKER_CMD_FLAG, (Date.now() / 1000) >> 0);
            pendingAcks.push({id: id, type: req.type, deadline: tickCount + WORKER_ACK_TICKS});
        } catch (e) {
            writeResp(id, {ok: false, error: "dispatch failed: " + (e.message || e), id: id, type: req.type});
        }
    },

    goto: function (req, id) {
        try {
            Chat.say("#goto " + req.x + " " + req.y + " " + req.z);
            writeResp(id, {
                ok: true, type: "goto", id: id,
                target: {x: req.x, y: req.y, z: req.z},
                note: "sent to Baritone"
            });
        } catch (e) {
            writeResp(id, {
                ok: false, type: "goto", id: id,
                error: "goto failed: " + (e.message || e)
            });
        }
    },

    // Drain the bounded pull event ring (producer = worker.js, which appends the
    // bundle's drained events each tick). The caller passes the last `seq` it saw;
    // we return everything newer plus the current head seq to pass back next time.
    poll_events: function (req, id) {
        try {
            var since = (typeof req.since === "number") ? req.since : 0;
            var events = IPC.ringSince(GV, since);
            var seq = 0;
            try { seq = GV.getInt(IPC.KEYS.events.seq) || 0; } catch (_) {}
            respFlat(id, "poll_events", {since: since, seq: seq, count: events.length, events: events});
        } catch (e) {
            respErr(id, "poll_events", "poll_events failed: " + (e.message || e));
        }
    },

    // Read the world-scoped knowledge for the current (or a given) world. `all:true`
    // returns the whole model + signature list (useful to see which worlds are known).
    knowledge: function (req, id) {
        try {
            var m = readWorldModel();
            var sig = (req.sig != null) ? String(req.sig) : worldSignature();
            if (req.all === true) {
                respFlat(id, "knowledge", {sig: sig, worlds: Object.keys(m.worlds), model: m});
                return;
            }
            respFlat(id, "knowledge", {sig: sig, world: worldSection(m, sig)});
        } catch (e) {
            respErr(id, "knowledge", "knowledge failed: " + (e.message || e));
        }
    },

    // Manual merge into a world's section. Only the provided fields are replaced; the
    // others (and every other world) are preserved (read-modify-write). Mirrors how the
    // worker/prospector each touch only their own section without a cross-proc lock.
    knowledge_set: function (req, id) {
        try {
            var sig = (req.sig != null) ? String(req.sig) : worldSignature();
            var r = WS.update(sig, function (section) {
                if (req.waypoints !== undefined) section.waypoints = req.waypoints;
                if (req.resources !== undefined) section.resources = req.resources;
                if (req.stats !== undefined) section.stats = req.stats;
            });
            writeResp(id, {ok: r.wrote, type: "knowledge_set", id: id, sig: sig, world: r.section});
        } catch (e) {
            respErr(id, "knowledge_set", "knowledge_set failed: " + (e.message || e));
        }
    },

    get_state: function (_req, id) {
        var pos = null, health = null, dim = null;
        try {
            var p = Player.getPlayer();
            pos = {x: p.getX(), y: p.getY(), z: p.getZ()};
            health = p.getHealth();
            dim = World.getDimension();
        } catch (_) {}
        var toolId = null, toolDmg = null, toolMax = null;
        try {
            var inv = Player.openInventory();
            var sel = inv.getSelectedHotbarSlotIndex();
            var hand = inv.getSlot(36 + sel);
            if (hand && !hand.isEmpty()) {
                toolId = hand.getItemId();
                toolDmg = hand.getDamage();
                toolMax = hand.getMaxDamage();
            }
        } catch (_) {}
        var aliveVal = 0, aliveTs = 0, status = null, build = null, fatal = null;
        try { aliveVal = GV.getInt(WORKER_ALIVE_KEY) || 0; } catch (_) {}
        try { aliveTs = GV.getInt(WORKER_TS_KEY) || 0; } catch (_) {}
        try { status = GV.getString(WORKER_STATUS_KEY) || null; } catch (_) {}
        try { var bs = GV.getString(WORKER_BUILD_KEY); if (bs) build = JSON.parse(bs); } catch (_) {}
        try { var fs = GV.getString(WORKER_FATAL_KEY); if (fs) fatal = JSON.parse(fs); } catch (_) {}
        var now = (Date.now() / 1000) >> 0;
        var stalled = aliveVal > 0 && aliveTs > 0 && (now - aliveTs) > STALL_THRESHOLD;
        writeResp(id, {
            ok: true, type: "get_state", id: id,
            phase: moduleState ? (moduleState.phase || null) : null,
            running: moduleState ? (moduleState.running || false) : false,
            targetOre: moduleState ? (moduleState.targetOre || null) : null,
            miningOrigin: moduleState ? (moduleState.miningOrigin || null) : null,
            scanCycleCount: moduleState ? (moduleState.scanCycleCount || 0) : 0,
            position: pos,
            health: health,
            dimension: dim,
            tool: toolId ? {id: toolId, damage: toolDmg, maxDamage: toolMax} : null,
            container: {ticks: tickCount, instance: INSTANCE_ID},
            managedService: managedStatus(),
            worker: {alive: aliveVal, aliveTs: aliveTs, status: status, stalled: stalled, build: build, fatal: fatal,
                     tickPace: workerTickPace()}
        });
    },
    scan: function (req, id) {
        var radius = req.radius || 12;
        var scanYRange = req.scan_y_range || 4;
        var pos = null;
        try {
            var p = Player.getPlayer();
            pos = {x: p.getX(), y: p.getY(), z: p.getZ()};
        } catch (_) {}
        if (!pos) {
            writeResp(id, {ok: false, error: "cannot read player pos", type: "scan", id: id});
            return;
        }
        var found = [];
        try {
            for (var xi = -radius; xi <= radius; xi++) {
                for (var yi = -scanYRange; yi <= scanYRange; yi++) {
                    for (var zi = -radius; zi <= radius; zi++) {
                        var bx = Math.floor(pos.x) + xi;
                        var by = Math.floor(pos.y) + yi;
                        var bz = Math.floor(pos.z) + zi;
                        var block = World.getBlock(bx, by, bz);
                        var bid = block ? block.getId() : null;
                        if (bid && bid.indexOf("_ore") >= 0 && bid !== "minecraft:air") {
                            found.push({x: bx, y: by, z: bz, id: bid});
                        }
                    }
                }
            }
        } catch (e) {
            writeResp(id, {ok: false, error: "scan error: " + (e.message || e), type: "scan", id: id});
            return;
        }
        found.sort(function (a, b) {
            var da = Math.abs(a.x - pos.x) + Math.abs(a.y - pos.y) + Math.abs(a.z - pos.z);
            var db = Math.abs(b.x - pos.x) + Math.abs(b.y - pos.y) + Math.abs(b.z - pos.z);
            return da - db;
        });
        writeResp(id, {
            ok: true, type: "scan", id: id,
            playerPos: {x: pos.x, y: pos.y, z: pos.z},
            count: found.length,
            ores: found.slice(0, 50),
            radius: radius
        });
    },

    get_logs: function (req, id) {
        // Tail the NDJSON journal the bundle's Logger writes (worker-bundle.ts
        // makeSink → user.dir/config/jsMacros/Macros/miner.ndjson). Works whether
        // the module runs in the worker service or passively here, since both
        // append to the same file. Read-all + slice: a debug affordance, called
        // rarely, not per tick.
        var n = (typeof req.n === "number" && req.n > 0) ? Math.min(req.n, 500) : 100;
        try {
            var Files = Java.type("java.nio.file.Files");
            var path = journalPath();
            var logs = [];
            if (Files.exists(path)) {
                // Single-arg overload reads UTF-8; passing the StandardCharsets
                // class (not a Charset instance) fails GraalJS overload resolution.
                var all = Files.readAllLines(path);
                var total = all.size();
                var start = Math.max(0, total - n);
                for (var i = start; i < total; i++) {
                    var ln = all.get(i);
                    if (!ln || ln.length === 0) continue;
                    try { logs.push(JSON.parse(ln)); }
                    catch (_) { logs.push({raw: ln}); }
                }
            }
            respFlat(id, "get_logs", {count: logs.length, logs: logs});
        } catch (e) {
            respErr(id, "get_logs", "get_logs failed: " + (e.message || e));
        }
    },

    inventory: function (_req, id) {
        var hotbar = [];
        var usedSlots = 0;
        var oreCount = 0;
        var toolDurability = null;
        try {
            var inv = Player.openInventory();
            var slots = inv.getSlots(["hotbar"]);
            var all = inv.getSlots(["main", "hotbar"]);
            for (var i = 0; i < slots.length; i++) {
                var s = inv.getSlot(slots[i]);
                var entry = {slot: slots[i] - 36, id: null, count: 0, damage: 0, maxDamage: 0};
                if (s && !s.isEmpty()) {
                    entry.id = s.getItemId();
                    entry.count = s.getCount();
                    entry.damage = s.getDamage();
                    entry.maxDamage = s.getMaxDamage();
                    if (entry.id && entry.id.indexOf("_ore") >= 0) oreCount += entry.count;
                    var toolPat = entry.id ? (entry.id.indexOf("pickaxe") >= 0 || entry.id.indexOf("hammer") >= 0 || entry.id.indexOf("drill") >= 0) : false;
                    if (toolPat && !toolDurability) {
                        var pct = entry.maxDamage > 0 ? Math.round((1 - entry.damage / entry.maxDamage) * 100) : 100;
                        toolDurability = {id: entry.id, pct: pct};
                    }
                }
                hotbar.push(entry);
            }
            // The FULL carry inventory (main + hotbar), not just the hotbar — this command
            // reporting only 9 slots misled fleet ops twice ("bag empty" while 36/36 full):
            // every occupied slot itemized + per-id totals.
            var slotsAll = [];
            var carry = {};
            for (var j = 0; j < all.length; j++) {
                var s2 = inv.getSlot(all[j]);
                if (s2 && !s2.isEmpty()) {
                    usedSlots++;
                    var iid = s2.getItemId();
                    var cnt = s2.getCount();
                    slotsAll.push({slot: all[j], id: iid, count: cnt, damage: s2.getDamage(), maxDamage: s2.getMaxDamage()});
                    carry[iid] = (carry[iid] || 0) + cnt;
                    if (iid && iid.indexOf("_ore") >= 0 && all[j] < 36) oreCount += cnt;
                }
            }
            var fullness = all.length > 0 ? usedSlots / all.length : 0;
            writeResp(id, {
                ok: true,
                type: "inventory",
                id: id,
                hotbar: hotbar,
                slots: slotsAll,
                carry: carry,
                fullnessPct: Math.round(fullness * 100),
                usedSlots: usedSlots,
                totalSlots: all.length,
                oreCount: oreCount,
                toolDurability: toolDurability
            });
        } catch (e) {
            writeResp(id, {ok: false, error: "inventory read error: " + (e.message || e), type: "inventory", id: id});
        }
    }

};

// Merge the "eyes & hands" screen primitives (screenshot/read_screen/click/scroll/type/
// keypress/introspect/close_screen) from the sibling screen.js — split out to keep the
// supervisor lean. They stay CONTAINER handlers (full render-thread access); their help
// metadata lives in META_COMMANDS above. SRG+writeResp are injected; jsMacros globals are
// resolved at call time.
(function () {
    var SCREEN = __MC_SCREEN({writeResp: writeResp, SRG: SRG, IPC: IPC});
    for (var k in SCREEN) if (Object.prototype.hasOwnProperty.call(SCREEN, k)) HANDLERS[k] = SCREEN[k];
})();

// Flush any worker-bound commands whose ack has arrived (correlation by id) or timed
// out. Called once per tick — the render thread must not block, so the wait is polled.
function drainPendingAcks() {
    if (pendingAcks.length === 0) return;
    var resp = null;
    var raw = null;
    try { raw = GV.getString(WORKER_RESP_KEY); } catch (_) {}
    if (raw) { try { resp = JSON.parse(raw); } catch (_) { resp = null; } }
    var keep = [];
    for (var i = 0; i < pendingAcks.length; i++) {
        var p = pendingAcks[i];
        if (resp && resp.id === p.id) {
            // Real worker ack — relay it verbatim (already carries ok/type/result/error).
            resp.id = p.id;
            writeResp(p.id, resp);
        } else if (tickCount >= p.deadline) {
            writeResp(p.id, {ok: false, type: p.type, id: p.id,
                error: "worker did not ack within " + WORKER_ACK_TICKS + " ticks (dispatched, unconfirmed)"});
        } else {
            keep.push(p);
        }
    }
    pendingAcks = keep;
}

function dispatch(req, id) {
    // Every handler call is guarded HERE so a throw can never escape into the Tick
    // command loop (which would drop the rest of the batch / risk the listener). This is
    // the single crash boundary — individual handlers may still try/catch for tailored
    // error messages, but they no longer HAVE to. Mirrors the EXT branch.
    try {
        // Routing decision is the pure harness SSOT (H.route, mirror of src/shared/harness/dispatch.ts):
        // HANDLERS shadow EXT shadow the worker passthrough. The INVOCATION stays here (Java scope).
        var where = H.route(req.type, !!(req.type && HANDLERS[req.type]), !!(req.type && EXT[req.type]));
        if (where === "handler") {
            HANDLERS[req.type](req, id);
        } else if (where === "ext") {
            // reloadable ext.js plugin (EMI/prospector/FTB/…) — hot layer, no main reload
            EXT[req.type].fn(req, id);
        } else {
            HANDLERS._passthrough(req, id);
        }
    } catch (e) {
        respErr(id, req.type || "?", "handler '" + (req.type || "?") + "' failed: " + (e.message || e));
    }
}

// Publish a JSON snapshot of nearby dropped-item entities for the worker. The worker
// Service thread can't invoke ItemEntityHelper methods ("Message not supported" — they're
// pinned to the render thread, same as FWorld.getDimension), so World.getEntities("item")
// is unusable there and the bundle's world.items() (loot's input) always failed. main.js
// (on the render thread) CAN read them, so it snapshots {x,y,z,id,count} within ITEMS_RADIUS
// of the player into IPC.KEYS.world.items; worker.js mirrors it into globalThis.__MC_ITEMS.
var ITEMS_KEY = IPC.KEYS.world.items;
var ITEMS_RADIUS = 24;       // only publish drops within this many blocks (caps the per-tick work)
var ITEMS_EVERY = 10;        // throttle: republish every N ticks (loot reads every 40, so ample)
// Shared skeleton for the four render-thread entity snapshots (items/mobs/peers/frames):
// read the player, iterate World.getEntities (optionally the typed query), map each entity
// via selectFn (returns the row object, or null to skip — the per-feed radius²/type/health
// filter lives THERE), JSON-publish. The null-player + throw guards both fall back to "[]"
// so a mid-read failure never leaves a stale snapshot. Per-feed filter/map is preserved
// verbatim inside each selectFn — only the skeleton is shared.
function publishEntities(key, query, selectFn) {
    var out = [];
    try {
        var p = Player.getPlayer();
        if (!p) { GV.putString(key, "[]"); return; }
        var px = p.getX(), py = p.getY(), pz = p.getZ();
        var ents = query ? World.getEntities(query) : World.getEntities();
        for (var i = 0; i < ents.size(); i++) {
            var row = selectFn(ents.get(i), px, py, pz, p);
            if (row) out.push(row);
        }
        GV.putString(key, JSON.stringify(out));
    } catch (_) { try { GV.putString(key, "[]"); } catch (_e2) {} }
}

function publishItems() {
    publishEntities(ITEMS_KEY, "item", function (e, px, py, pz) {
        var ex = e.getX(), ey = e.getY(), ez = e.getZ();
        var dx = ex - px, dy = ey - py, dz = ez - pz;
        if (dx * dx + dy * dy + dz * dz > ITEMS_RADIUS * ITEMS_RADIUS) return null;
        var id = "unknown", count = 1;
        try { var st = e.getContainedItemStack(); if (st) { id = "" + st.getItemId(); count = st.getCount(); } } catch (_e) {}
        return { x: ex, y: ey, z: ez, id: id, count: count };
    });
}

// Publish a JSON snapshot of nearby LIVING entities (mobs) for the worker's hunt mission.
// Same render-thread pinning as items — World.getEntities() + EntityHelper reads work here
// (main.js's thread) but not on the worker Service thread, so we snapshot {type,uuid,x,y,z,
// health} within MOBS_RADIUS into IPC.KEYS.world.mobs; worker.js mirrors it into
// globalThis.__MC_MOBS, and the bundle's world.mobs() reads that. A non-living entity (item,
// xp orb, arrow) has no getHealth() → it throws → we skip it, so the snapshot is mobs only;
// the player is excluded by type. (Derived from the publishItems pattern; getUUID/getHealth/
// getType/getPos verified live on a LivingEntityHelper.)
var MOBS_KEY = IPC.KEYS.world.mobs;
var MOBS_RADIUS = 32;        // chase reach — wider than items (24); caps per-tick iteration cost
var MOBS_EVERY = 5;          // republish every N ticks: ~1.25-block staleness for a walking mob
function publishMobs() {
    publishEntities(MOBS_KEY, null, function (e, px, py, pz) {
        var type = "" + e.getType();
        if (type.indexOf("player") >= 0 || type.indexOf("item") >= 0) return null;
        var health;
        try { health = e.getHealth(); } catch (_h) { return null; } // non-living → skip
        if (typeof health !== "number" || health <= 0) return null;
        var ex = e.getX(), ey = e.getY(), ez = e.getZ();
        var dx = ex - px, dy = ey - py, dz = ez - pz;
        if (dx * dx + dy * dy + dz * dz > MOBS_RADIUS * MOBS_RADIUS) return null;
        var uuid = "";
        try { uuid = "" + e.getUUID(); } catch (_u) {}
        return { type: type, uuid: uuid, x: ex, y: ey, z: ez, health: health };
    });
}

// Publish a JSON snapshot of nearby OTHER players (peers — humans + other fleet bots) for the
// worker's follow mission + future peer-as-obstacle (fleet coordination). publishMobs EXCLUDES players,
// so peers are their own feed. Same render-thread pinning as mobs (player EntityHelper reads work
// on main.js's thread, not the worker's) → snapshot {name,uuid,x,y,z,health} within PEERS_RADIUS
// into IPC.KEYS.world.peers; worker.js mirrors it into globalThis.__MC_PEERS; world.peers() reads
// that. SELF is excluded by uuid. (Derived from the publishMobs pattern; getName().getString()
// for the username, getUUID for identity.)
var PEERS_KEY = IPC.KEYS.world.peers;
var PEERS_RADIUS = 48;       // follow leash — wider than mobs (32): the leader can range ahead
var PEERS_EVERY = 5;         // republish every N ticks (~1.25-block staleness for a walking peer)
function publishPeers() {
    var selfU = null; // resolved once (lazily) from the player passed into selectFn
    publishEntities(PEERS_KEY, null, function (e, px, py, pz, p) {
        if (selfU === null) { selfU = ""; try { selfU = "" + p.getUUID(); } catch (_su) {} }
        var type = "" + e.getType();
        if (type.indexOf("player") < 0) return null;      // peers = players only
        var uuid = ""; try { uuid = "" + e.getUUID(); } catch (_u) {}
        if (uuid !== "" && uuid === selfU) return null;    // exclude ourselves
        var ex = e.getX(), ey = e.getY(), ez = e.getZ();
        var dx = ex - px, dy = ey - py, dz = ez - pz;
        if (dx * dx + dy * dy + dz * dz > PEERS_RADIUS * PEERS_RADIUS) return null;
        var name = "";
        try { var nm = e.getName(); name = (nm && nm.getString) ? "" + nm.getString() : "" + nm; } catch (_n) {}
        var health = 20;
        try { var h = e.getHealth(); if (typeof h === "number") health = h; } catch (_h) {}
        return { name: name, uuid: uuid, x: ex, y: ey, z: ez, health: health };
    });
}

// Publish a JSON snapshot of nearby ITEM-FRAME entities (item_frame / glow_item_frame) for the
// worker's interact mission (frame profile). Frames are decoration entities — neither living
// (publishMobs skips them: no getHealth) nor items nor players — and entity reads are pinned to
// this thread like the rest, so they get their own feed: {type,uuid,x,y,z} within FRAMES_RADIUS
// into IPC.KEYS.world.frames; worker.js mirrors it into globalThis.__MC_FRAMES; the bundle's
// world.frames() reads that, and interact.useOnEntity(uuid) right-clicks the resolved frame
// (attack(entity)-mirror — uuid resolve + InteractionManager calls are NOT pinned).
var FRAMES_KEY = IPC.KEYS.world.frames;
var FRAMES_RADIUS = 16;      // interact reach is ~2.5; 16 gives the mission planning margin
var FRAMES_EVERY = 10;       // frames don't move — a slow republish is plenty
function publishFrames() {
    publishEntities(FRAMES_KEY, null, function (e, px, py, pz) {
        var type = "" + e.getType();
        if (type.indexOf("item_frame") < 0) return null;   // item_frame + glow_item_frame
        var ex = e.getX(), ey = e.getY(), ez = e.getZ();
        var dx = ex - px, dy = ey - py, dz = ez - pz;
        if (dx * dx + dy * dy + dz * dz > FRAMES_RADIUS * FRAMES_RADIUS) return null;
        var uuid = "";
        try { uuid = "" + e.getUUID(); } catch (_u) {}
        if (!uuid) return null;                             // no identity → can't be targeted
        return { type: type, uuid: uuid, x: ex, y: ey, z: ez };
    });
}

// ---------------------------------------------------------------------------
// Tick handler
// ---------------------------------------------------------------------------
// Paced, not JsMacros.on: a slow tick (a long jeval, a big dispatch) must not park one jsMacros
// thread per game tick behind it (IPC.paceTick in ipc.js). diag.main.tickPace shows the stats.
tickListener = IPC.paceTick(JsMacros, JavaWrapper.methodToJava, function () {
    tickCount++;
    GV.putInt(ALIVE_KEY, tickCount);

    // Publish the world signature for the worker. The worker Service thread CAN'T call
    // FWorld.getDimension/getWorldIdentifier, but main.js's thread can — so the bundle's
    // world.signature() (→ WORLD_SCOPE → all persistence) reads this mirror instead.
    try { GV.putString(IPC.KEYS.world.sig, worldSignature()); } catch (_) {}

    // Movement-key dead-man (DEADMAN_STALE_TICKS above). Runs on main's own tick thread: KeyBind is
    // the same primitive the bundle's keys facade and the `key` handler use — no runOnMainThread.
    var dmBeat = 0;
    try { dmBeat = GV.getInt(WORKER_ALIVE_KEY) || 0; } catch (_dm) {}
    var dm = H.deadman.step(deadman, dmBeat, tickCount, DEADMAN_STALE_TICKS);
    deadman = dm.state;
    if (dm.release) {
        for (var dk = 0; dk < H.deadman.KEYS.length; dk++) {
            try { KeyBind.keyBind(H.deadman.KEYS[dk], false); } catch (_dk) {}
        }
        // A stall, not a saved walk-off: main cannot see which keys the worker held, so the
        // release may have let go of nothing. The journal line is what get_logs shows. Its `tick`
        // is the worker heartbeat, the worker's tick count: every other journal record runs on the
        // worker clock (navbench takes the highest as its baseline). Main's own count is mainTick.
        log("DEADMAN worker heartbeat still for " + DEADMAN_STALE_TICKS +
            " ticks — released movement keys (stall #" + deadman.stalls + ")");
        journalAppend({tick: dmBeat, level: "WARN", event: "DEADMAN",
                       fields: {by: "main.js", mainTick: tickCount, stalls: deadman.stalls}});
    }

    // Apply the worker's DESIRED sprint flag on THIS (main/render) thread — the mirror of the
    // world-sig bridge. The worker can't call LivingEntity.setSprinting itself: it mutates the
    // player's speed-attribute modifier map off-thread, racing the render FOV read → CME crash that
    // drops the bot off the server (see ipc wantSprint). It publishes intent
    // ("1"/"0"). While it wants sprint we RE-ASSERT setSprinting(true) EVERY tick — vanilla's aiStep
    // clears sprint each tick when it sees no forward impulse (synthetic keybind input doesn't satisfy
    // it), so a one-shot set decays to walk speed; re-asserting overrides that. This is safe ONLY
    // because it's on the main thread (serialized with the render FOV read — no concurrent mutation).
    // The STOP ("0") is edge-triggered so an idle bot doesn't churn the map needlessly.
    try {
        var ws = GV.getString(IPC.KEYS.worker.wantSprint);
        // A dead/halted worker can leave a stale "1" → don't force-sprint an idle player forever.
        // Treat a worker heartbeat older than 3s as "no sprint" (release once, then leave it).
        var wts = 0; try { wts = GV.getInt(WORKER_TS_KEY); } catch (_w) {}
        var workerFresh = wts > 0 && (((Date.now() / 1000) >> 0) - wts) <= 3;
        // A dead-man stall (dm.stale) ends the forced sprint too: re-asserting it every tick would
        // keep the body sprinting through the very freeze the key release is for.
        if (ws === "1" && workerFresh && !dm.stale) {
            var sp = Player.getPlayer();
            if (sp) { sp.getRaw()[SRG.setSprinting](true); lastSprintApplied = "1"; }
        } else if (lastSprintApplied === "1") {
            // want cleared OR worker went stale while we were forcing sprint → release it once.
            var sp0 = Player.getPlayer();
            if (sp0) { sp0.getRaw()[SRG.setSprinting](false); lastSprintApplied = "0"; }
        }
    } catch (_) {}

    // Publish nearby dropped-item entities for the worker's loot guard (render-thread-only read).
    if (tickCount % ITEMS_EVERY === 0) publishItems();

    // Publish nearby living mobs for the worker's hunt mission (same render-thread pinning).
    if (tickCount % MOBS_EVERY === 0) publishMobs();

    // Publish nearby OTHER players (peers) for the worker's follow mission (same pinning).
    if (tickCount % PEERS_EVERY === 0) publishPeers();

    // Publish nearby item-frame entities for the worker's interact mission (same pinning).
    if (tickCount % FRAMES_EVERY === 0) publishFrames();

    // Clear stale worker heartbeat on first tick to prevent false-positive
    if (tickCount === 1) {
        try { GV.putInt(WORKER_ALIVE_KEY, 0); } catch (_) {}
    }

    // One-shot: auto-start the worker in IDLE once the world is loaded (player present), so the
    // kernel is always ticking and survival reflexes protect even a parked/un-`start`ed bot.
    // startManaged is idempotent+throttled (no-op if already running); autoStartMission=null →
    // boots IDLE (no auto-mining). Retries each tick until it takes, then latches forever so a
    // later manual `halt`/`stop` is respected (not resurrected).
    if (!workerAutoStarted) {
        var _pl = null;
        try { _pl = Player.getPlayer(); } catch (_) {}
        if (_pl) {
            var _asr = safe("autoStartWorker", function () { return startManaged("worker"); });
            if (_asr && _asr.ok) {
                workerAutoStarted = true;
                log("worker auto-started (IDLE) on world load: " + (_asr.data || "ok"));
            }
        }
    }

    // Read bridge command queue. Each cmd key is consumed exactly once and then
    // removed so the GlobalVars store doesn't accumulate mc_bridge_cmd_N keys for
    // the whole session (the counter keeps advancing; only the payloads are freed).
    var cnt = 0;
    try { cnt = GV.getInt(CNT_KEY); } catch (_e) {}
    if (cnt > lastCmdCount) {
        for (var i = lastCmdCount; i < cnt; i++) {
            var raw = null;
            try { raw = GV.getString(CMD_PFX + i); } catch (_e) {}
            try { GV.remove(CMD_PFX + i); } catch (_e) {}
            if (!raw) continue;
            var req = null;
            try { req = JSON.parse(raw); } catch (e) {
                log("ERR bad JSON cmd_" + i + ": " + e.message);
                continue;
            }
            dispatch(req, req.id !== undefined ? req.id : i);
        }
        lastCmdCount = cnt;
    }

    // Flush worker-bound commands whose correlated ack arrived (or timed out).
    drainPendingAcks();

    // Passive module tick
    if (activeModule && moduleState !== null) {
        var t0 = java.lang.System.nanoTime();
        try {
            moduleState = activeModule.tick(moduleState);
        } catch (e) {
            log("ERR module.tick: " + (e.message || e) + " — unloading");
            unloadModule();
        }
        var ms = (java.lang.System.nanoTime() - t0) / 1e6;
        moduleTickMs = ms;
        if (ms > 50) {
            moduleSlowTicks++;
            if (moduleSlowTicks >= 3) {
                log("WARN module slow " + ms.toFixed(1) + "ms for 3 ticks — consider halt");
            }
        } else {
            moduleSlowTicks = 0;
        }
    }
});

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
event.stopListener = JavaWrapper.methodToJava(function () {
    if (tickListener) { tickListener.stop(); tickListener = null; }
    unloadModule();
    if (managedServiceName) {
        try { SM.stopService(managedServiceName); } catch (_) {}
    }
    GV.putInt(ALIVE_KEY, 0);
    log("Stopped.");
});

// Seed the bounded event ring (idempotent) so poll_events has a valid cursor even
// before the worker boots. The worker is the producer; this is the consumer side.
try { IPC.ringInit(GV); } catch (_) {}

// Publish the boot build stamp (rev = content hash of the running main.js) so `diag`
// and the bridge's bridge_diag can flag "deployed-but-not-reloaded" drift.
try { GV.putString(IPC.KEYS.main.build, JSON.stringify({rev: MAIN_REV, time: INSTANCE_ID})); } catch (_) {}

// Auto-load the reloadable mod-API plugin layer (ext.js) on startup. Failures are
// non-fatal — the supervisor still runs; fix ext.js and call `reload_ext`.
(function () {
    var r = safe("loadExt(startup)", function () { return loadExt({}); });
    if (r && r.ok) log("ext.js loaded: " + r.registered.join(", "));
    else log("ext.js NOT loaded: " + (r && r.error ? r.error : "unknown") + " (call reload_ext after fixing)");
})();

// ---------------------------------------------------------------------------
// SRG boot self-check — fail LOUD on silent runtime rot. The real
// killer is not a raw token in SOURCE (the defensive checker catches that) but a
// valid-LOOKING SRG name that resolves to `undefined` after a pack bump, since
// `undefined != null` is false and every probe then silently LIES (CLAUDE.md's SRG
// warning; this exact class cost hours). So at boot, resolve EVERY SRG name the code
// depends on (H.SRG_REQUIRED: the hardcoded token maps + the ext.js srg() call sites)
// against the live srg_names.json and SCREAM if any is missing — turning silent
// mid-run rot into an instant boot diagnosis. We do NOT throw (that would deaf-lock the
// whole bridge); instead we log loudly + publish a distinct bridge-visible status
// (mc_main_srg_ok / mc_main_srg_missing, surfaced in `diag`). srg_names.json ABSENT is
// "unknown" (not a scream) — the map is an optional deploy artifact.
var SRG_CHECK = {ok: "unknown", tokens: [], members: []};
(function () {
    var map = null;
    safe("srg_boot_check(read)", function () {
        var F = Java.type("java.nio.file.Files");
        var P = Java.type("java.nio.file.Paths");
        var U = Java.type("java.nio.charset.StandardCharsets").UTF_8;
        var p = P.get(JsMacros.getConfig().macroFolder.toString()).resolve("srg_names.json");
        if (F.exists(p)) map = JSON.parse(F.readString(p, U));
        return null;
    });
    // Table half: the code's SRG names vs srg_names.json. Logged together with the runtime half
    // below, as ONE verdict line (H.srg.bootLine) — two lines printed PASS then FAIL on Fabric.
    if (!map) {
        SRG_CHECK = {ok: "unknown", tokens: [], members: []};
    } else {
        var missTokens = H.srg.findMissingTokens(map, H.SRG_REQUIRED.tokens);
        var index = H.srg.buildIndex(map);
        var missMembers = H.srg.findMissing(index, H.SRG_REQUIRED.members);
        // "0" = rot: this bot's raw-vanilla calls (eyes/hands, respawn, NBT, block scan) WILL
        // silently no-op mid-run. Regenerate srg_names.json for the current pack.
        SRG_CHECK = (missTokens.length === 0 && missMembers.length === 0)
            ? {ok: "1", tokens: [], members: []}
            : {ok: "0", tokens: missTokens, members: missMembers};
    }
    var mapResult = {
        ok: SRG_CHECK.ok,
        required: {tokens: H.SRG_REQUIRED.tokens.length, members: H.SRG_REQUIRED.members.length},
        missing: {tokens: SRG_CHECK.tokens, members: SRG_CHECK.members}
    };
    // RUNTIME half: srg_names.json ships with the repo, so the map check above passes on ANY game —
    // it said ok on Fabric (D-13). Ask the running game too, by REFLECTION ONLY on this service
    // thread (a class name + getMethod; no game method is ever called — CLAUDE.md § SRG names):
    // Fabric's intermediary Minecraft class, or an Entity without the bot's SRG steer method,
    // turns the check to "0" with a reason. Pure verdict: safe-io.js srg.runtimeVerdict.
    var probe = {mcClass: null, srgMember: null};
    safe("srg_boot_check(runtime class)", function () {
        probe.mcClass = String(Client.getMinecraft().getClass().getName());
        return null;
    });
    safe("srg_boot_check(runtime member)", function () {
        var P = H.SRG_RUNTIME_PROBE;
        var entity = null;
        try { entity = Java.type(P.cls); } catch (_noClass) { probe.srgMember = false; return null; }
        try {
            entity.class.getMethod(P.member, Java.type("java.lang.Float").TYPE);
            probe.srgMember = true;
        } catch (_noMethod) { probe.srgMember = false; }
        return null;
    });
    var runtime = H.srg.runtimeVerdict(probe);
    SRG_CHECK.runtime = {ok: runtime.ok, mcClass: probe.mcClass, reason: runtime.reason};
    if (runtime.ok === "0") SRG_CHECK.ok = "0";
    log(H.srg.bootLine(mapResult, runtime));
    safe("srg_boot_check(publish)", function () {
        GV.putString(IPC.KEYS.main.srgOk, SRG_CHECK.ok);
        GV.putString(IPC.KEYS.main.srgMissing,
            JSON.stringify({tokens: SRG_CHECK.tokens, members: SRG_CHECK.members, runtime: SRG_CHECK.runtime}));
        return null;
    });
})();

log("Container started v3.0 instance=" + INSTANCE_ID);
