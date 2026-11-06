// ipc.js — IPC single source of truth for the miner service harness (R0/R1).
// ===========================================================================
// Every GlobalVars key + every wire envelope shape used across the three plain-JS
// jsMacros Services (bridge.js / main.js / worker.js) is defined HERE, once.
// Those Services are isolated eval scopes with no shared module system, so each
// eval-includes this file (the same trick main.js uses for ext.js and worker.js
// uses for the bundle) and reads the global it publishes:
//
//   var IPC = (function () { ... eval(Files.readString("ipc.js")) ... return globalThis.__MC_IPC; })();
//
// MIRROR: src/core/ipc/ipc.ts is the R2 (TS worker bundle) copy. The two are kept in
// lockstep by test-ts/ipc-contract.test.ts (drift fails `bun run check`).
//
// Authored ES5-ish (var/function, no let/const/arrow) to match the other Service
// files and stay conservative on the GraalJS runtime.
// ===========================================================================
"use strict";
(function () {
    var KEYS = {
        // bridge.* — TCP transport (bridge.js)
        bridge: {
            alive:    "mc_bridge_alive",
            seq:      "mc_bridge_seq",
            cmdCount: "mc_bridge_cmd_count",
            cmdPfx:   "mc_bridge_cmd_",   // + <N>   (queued request line)
            respPfx:  "mc_bridge_resp_",  // + <id>  (response line)
            host:     "mc_bridge_host",
            port:     "mc_bridge_port"    // runtime port override (else bridge_port.txt / 55544)
        },
        // worker.* — container<->worker command + heartbeat + manifest
        worker: {
            cmd:     "mc_worker_cmd",
            cmdFlag: "mc_worker_cmd_flag",
            alive:   "mc_worker_alive",
            aliveTs: "mc_worker_alive_ts",
            status:  "mc_worker_status",
            lastCmd: "mc_worker_last_cmd",
            resp:    "mc_worker_resp",     // worker→container ack {id,ok,type,result} — correlation by id
            cmds:    "mc_worker_cmds",     // bundle's self-described command manifest (JSON)
            build:   "mc_worker_build",    // bundle build stamp: {rev, time} (JSON)
            fatal:   "mc_worker_fatal",    // {owner,phase,tick,error} (JSON): tick CoreFatalError (halt) or bundle load failure
            tickPace: "mc_worker_tick_pace", // {lastMs,maxMs,slow,missed} (JSON): the worker's paceTick stats (below)
            wantSprint: "mc_want_sprint"   // worker→main: desired sprint flag ("1"/"0"); main.js applies it
            // ON THE MAIN THREAD (the worker can't — setSprinting off-thread races the render FOV read →
            // CME crash). mc_world_sig in reverse; see main.js's sprint applier.
        },
        // main.* — container heartbeat + boot build stamp {rev, time} (JSON; rev = a
        // cheap content hash of main.js stamped at boot, for stale-vs-disk detection)
        main: {
            alive: "mc_main_alive",
            build: "mc_main_build",
            srgOk: "mc_main_srg_ok",       // "1" all required SRG names resolved | "0" rot or non-SRG runtime | "unknown" map absent
            srgMissing: "mc_main_srg_missing" // JSON { tokens:[…], members:[…], runtime:{ok,mcClass,reason} } — the loud boot diagnosis
        },
        // events.* — bounded pull event ring (producer wired in stage 6; schema here)
        events: {
            seq:     "mc_events_seq",     // monotonic cursor (int) — "latest seq"
            head:    "mc_events_head",    // ring write index (int)
            size:    "mc_events_size",    // ring capacity (int, == RING_SIZE)
            slotPfx: "mc_events_slot_"    // + <0..size-1>  (JSON Event string)
        },
        // world.* — shared world-model file (unified in stage 5) + the live world
        // signature published by main.js. The worker Service thread can't call
        // FWorld.getDimension/getWorldIdentifier ("Message not supported" — those are
        // pinned to main.js's thread), so main.js (which CAN) publishes "<wid>|<dim>"
        // here every tick and the worker mirrors it for the bundle's world.signature().
        // items = same story for dropped-item ENTITIES (ItemEntityHelper methods are
        // render-thread-pinned → world.items() failed on the worker → loot never fired):
        // main.js publishes a JSON snapshot of nearby drops, worker mirrors for the facade.
        world: { file: "mc_world.json", sig: "mc_world_sig", items: "mc_items", mobs: "mc_mobs", peers: "mc_peers", frames: "mc_frames", assignment: "mc_assignment" }
    };

    var RING_SIZE = 256; // bounded ring; a few minutes of notable events

    // --- composite key helpers (replace inline string concatenation) ---
    function bridgeCmd(n)   { return KEYS.bridge.cmdPfx + n; }
    function bridgeResp(id) { return KEYS.bridge.respPfx + id; }
    function eventSlot(i)   { return KEYS.events.slotPfx + i; }

    // --- envelope factories (unified wire shapes) ---
    // NB stage 1: NO `t` field yet (kept byte-identical to today's responses);
    // `t` is added in stage 6 alongside the manifest-contract changes.
    function now() { return Date.now(); }

    // Request { id, type, ...params }
    function req(id, type, params) {
        var o = { id: id, type: type };
        if (params) { for (var k in params) if (params.hasOwnProperty(k)) o[k] = params[k]; }
        return o;
    }
    // Response with a `data` payload: { ok, type, id, data? }
    function ok(id, type, data) {
        var o = { ok: true, type: type, id: id };
        if (data !== undefined) o.data = data;
        return o;
    }
    // Response with flat fields spread at top level: { ok, type, id, ...fields }
    function okFlat(id, type, fields) {
        var o = { ok: true, type: type, id: id };
        if (fields) { for (var k in fields) if (fields.hasOwnProperty(k)) o[k] = fields[k]; }
        return o;
    }
    // Error response: { ok:false, type, id, error, ...extra? }
    function err(id, type, error, extra) {
        var o = { ok: false, type: type, id: id, error: error };
        if (extra) { for (var k in extra) if (extra.hasOwnProperty(k)) o[k] = extra[k]; }
        return o;
    }
    // Event { seq, kind, t, ...fields }  (events DO carry t — they are new in stage 6)
    function evt(seq, kind, fields) {
        var o = { seq: seq, kind: kind, t: now() };
        if (fields) { for (var k in fields) if (fields.hasOwnProperty(k)) o[k] = fields[k]; }
        return o;
    }

    // --- event ring (GlobalVars-backed, bounded, cursor = seq) ---
    // Producer (worker/R2) appends; consumer (main/R0 poll_events) reads + filters.
    function ringInit(GV) {
        try {
            if ((GV.getInt(KEYS.events.size) || 0) <= 0) {
                GV.putInt(KEYS.events.size, RING_SIZE);
                GV.putInt(KEYS.events.head, 0);
                GV.putInt(KEYS.events.seq, 0);
            }
        } catch (_) {}
    }
    function ringAppend(GV, kind, fields) {
        var size = GV.getInt(KEYS.events.size) || RING_SIZE;
        var head = GV.getInt(KEYS.events.head) || 0;
        var seq = (GV.getInt(KEYS.events.seq) || 0) + 1;
        GV.putString(eventSlot(head), JSON.stringify(evt(seq, kind, fields)));
        GV.putInt(KEYS.events.head, (head + 1) % size);
        GV.putInt(KEYS.events.seq, seq);
        return seq;
    }
    function ringSince(GV, since) {
        var floor = since || 0;
        var size = GV.getInt(KEYS.events.size) || RING_SIZE;
        var out = [];
        for (var i = 0; i < size; i++) {
            var raw = GV.getString(eventSlot(i));
            if (!raw) continue;
            try { var e = JSON.parse(raw); if (e && e.seq > floor) out.push(e); } catch (_) {}
        }
        out.sort(function (a, b) { return a.seq - b.seq; });
        return out;
    }

    // --- Tick pacing (shared by bridge.js / main.js / worker.js) ---
    // jsMacros 1.9 runs a plain `JsMacros.on("Tick", cb)` listener on a NEW pool thread for every
    // tick (FJsMacros$1.trigger → JsMacrosThreadPool.runTask; Tick is not a joinable event). That
    // thread then waits for the script's single GraalJS context. So while one tick body runs long,
    // every later tick parks one more thread behind it: a 4-minute worker tick parked 4538 threads and
    // the client died with "unable to create native thread". A busy flag inside the body cannot help:
    // the body only runs AFTER the thread exists and holds the context.
    // paceTick registers ONE `JsMacros.once("Tick", cb)` (FJsMacros$2.trigger removes the listener
    // BEFORE it starts the task) and re-arms it when the body returns. While a body runs, no Tick
    // listener exists, so no thread is created; the ticks fired meanwhile are dropped, not queued.
    // The body itself is unchanged: the same callback, on the same context, one tick at a time.
    //   jsm  — the JsMacros library (once/off); wrap — JavaWrapper.methodToJava
    //   body — the tick function. A throw still reaches jsMacros' error log, after the re-arm.
    // Returns {stop(), stats()}. stats() = {lastMs, maxMs, slow, missed}: slow counts bodies longer
    // than one tick (TICK_MS); missed estimates the ticks fired while they ran (floor(ms / TICK_MS)).
    var TICK_MS = 50;
    function paceTick(jsm, wrap, body) {
        var st = {listener: null, stopped: false, lastMs: 0, maxMs: 0, slow: 0, missed: 0};
        var cb = null;
        function arm() { st.listener = st.stopped ? null : jsm.once("Tick", cb); }
        function fire() {
            st.listener = null; // the once-listener removed itself before this task started
            if (st.stopped) return; // stop() ran while this task waited for the context
            var t0 = Date.now();
            try {
                body();
            } finally {
                var ms = Date.now() - t0;
                st.lastMs = ms;
                if (ms > st.maxMs) st.maxMs = ms;
                if (ms > TICK_MS) { st.slow++; st.missed += Math.floor(ms / TICK_MS); }
                arm();
            }
        }
        cb = wrap(fire);
        arm();
        return {
            stop: function () {
                st.stopped = true;
                if (st.listener) { try { jsm.off(st.listener); } catch (_) {} st.listener = null; }
            },
            stats: function () {
                return {lastMs: st.lastMs, maxMs: st.maxMs, slow: st.slow, missed: st.missed};
            }
        };
    }

    globalThis.__MC_IPC = {
        VERSION: 1,
        KEYS: KEYS,
        RING_SIZE: RING_SIZE,
        bridgeCmd: bridgeCmd, bridgeResp: bridgeResp, eventSlot: eventSlot,
        now: now, req: req, ok: ok, okFlat: okFlat, err: err, evt: evt,
        ringInit: ringInit, ringAppend: ringAppend, ringSince: ringSince,
        TICK_MS: TICK_MS, paceTick: paceTick
    };
})();
