// safe-io.js — pure harness-core SSOT twin for the plain-JS services (R0/R1).
// ===========================================================================
// The plain-JS supervisor (main.js) and ext plugin layer (ext.js) share two pieces of
// PURE logic that are easy to get subtly wrong and expensive when they rot: the bridge
// dispatch ROUTING decision (HANDLERS → EXT → worker passthrough) and the SRG name
// INVERSION + boot self-check (srg_names.json → `srg(class,member)`; the silent-`undefined`
// rot that "cost hours" per CLAUDE.md). Both are data transforms with NO jsMacros/Java at
// module scope, so — exactly like ipc.js — this file eval-includes cleanly, publishes a
// global, and is drift-gated against a TESTED TypeScript SSOT.
//
// MIRROR: src/shared/harness/{dispatch,srg-index,srg-required,srg-runtime,world-cas,deadman}.ts is the R2 (TS) copy and the SSOT.
// test-ts/harness-contract.test.ts eval-loads THIS file and asserts route/srg/SRG_REQUIRED
// parity, so a divergence fails `bun run check` before it can ship (no divergent copy — the
// contract test makes the two impossible to disagree). The Java file-IO (reading srg_names.json,
// the worldModel RMW) stays in main.js/ext.js/world_store.js; only the transforms live here.
//
// Authored ES5-ish (var/function) to match the other Service files / GraalJS.
// ===========================================================================
"use strict";
(function () {
    // ---- dispatch routing (mirror of src/shared/harness/dispatch.ts) --------------
    function route(type, hasHandler, hasExt) {
        if (type && hasHandler) return "handler";
        if (type && hasExt) return "ext";
        return "passthrough";
    }

    // ---- SRG name inversion (mirror of src/shared/harness/srg-index.ts) ------------
    function buildSrgIndex(map) {
        var out = {};
        function add(key, srg) {
            var a = out[key]; if (!a) { a = []; out[key] = a; }
            if (a.indexOf(srg) < 0) a.push(srg);
        }
        if (map) {
            for (var srg in map) {
                if (!Object.prototype.hasOwnProperty.call(map, srg)) continue;
                var v = map[srg];
                if (typeof v !== "string") continue;
                var h = v.indexOf("#"); if (h < 0) continue;
                var fqcn = v.substring(0, h);
                var member = v.substring(h + 1);
                var pa = member.indexOf("("); if (pa >= 0) member = member.substring(0, pa);
                var simple = fqcn.substring(fqcn.lastIndexOf(".") + 1);
                add(fqcn + "#" + member, srg);
                add(simple + "#" + member, srg);
            }
        }
        return out;
    }
    function srgLookupAll(index, cls, member) {
        var a = index[cls + "#" + member];
        return a ? a.slice() : [];
    }
    function srgLookup(index, cls, member) {
        var a = index[cls + "#" + member];
        if (!a || !a.length) throw new Error("srg: no SRG name for " + cls + "#" + member +
            " (check spelling / regenerate srg_names.json; inherited members live on the declaring class)");
        return a[0];
    }
    function findMissingSrg(index, required) {
        var misses = [];
        for (var i = 0; i < required.length; i++) {
            var r = required[i];
            var a = index[r.cls + "#" + r.member];
            var got = (a && a.length) ? a[0] : undefined;
            if (got === undefined) {
                misses.push({cls: r.cls, member: r.member, reason: "unresolved", expect: r.expect});
            } else if (r.expect !== undefined && got !== r.expect) {
                misses.push({cls: r.cls, member: r.member, reason: "mismatch", expect: r.expect, got: got});
            }
        }
        return misses;
    }
    function findMissingTokens(map, tokens) {
        if (!map) return [];
        var out = [];
        for (var i = 0; i < tokens.length; i++) if (!(tokens[i] in map)) out.push(tokens[i]);
        return out;
    }

    // ---- required SRG dependency set (mirror of src/shared/harness/srg-required.ts) ----
    // Kept in lockstep with main.js's hardcoded SRG map + the bundle's SRG map
    // (src/core/runtime/jsmacros/srg.ts) + the ext.js srg() call sites; the contract test forces it.
    var HARNESS_SRG_TOKENS = ["m_6375_","m_6348_","m_6050_","m_5534_","m_7933_","m_7920_","m_6858_"];
    var BUNDLE_SRG_TOKENS = ["m_7702_","m_8055_","m_9236_","m_7583_","m_20096_","m_6135_","m_21205_","m_41671_","m_146922_","m_146926_"];
    var REQUIRED_SRG_TOKENS = HARNESS_SRG_TOKENS.concat(BUNDLE_SRG_TOKENS);
    var REQUIRED_SRG_MEMBERS = [
        {cls: "LocalPlayer", member: "respawn"},
        {cls: "CompoundTag", member: "contains"},
        {cls: "CompoundTag", member: "getCompound"},
        {cls: "ItemStack", member: "isDamageableItem"},
        {cls: "ItemStack", member: "getDamageValue"},
        {cls: "ItemStack", member: "getMaxDamage"},
        {cls: "ItemStack", member: "getTag"},
        {cls: "Minecraft", member: "getInstance"},
        {cls: "Minecraft", member: "level"},
        {cls: "RenderChunkRegion", member: "getBlockState"},
        {cls: "RenderChunkRegion", member: "getBlockEntity"},
        {cls: "TagKey", member: "location"}
    ];

    // ---- runtime SRG verdict (mirror of src/shared/harness/srg-runtime.ts) ------------
    // Asks the RUNNING game, not srg_names.json: Fabric intermediary class names, or no SRG steer
    // method on Entity → "0". main.js gathers the probe by reflection only (offline-safe).
    var SRG_RUNTIME_PROBE = {cls: "net.minecraft.world.entity.Entity", member: "m_146922_", mojang: "setYRot"};
    var SRG_UNSUPPORTED = "the GUI hands (click x/y, scroll, type, keypress) and Gerda Bot movement need Forge SRG names — see docs/PORTABILITY.md";
    function srgRuntimeVerdict(p) {
        if (p.mcClass !== null && p.mcClass !== undefined && p.mcClass.indexOf("net.minecraft.class_") === 0) {
            return {ok: "0", reason: "Fabric/intermediary runtime (Minecraft class is " + p.mcClass + "); " + SRG_UNSUPPORTED};
        }
        if (p.srgMember === false) {
            return {ok: "0", reason: "not a Forge SRG runtime: " + SRG_RUNTIME_PROBE.cls + " has no " +
                SRG_RUNTIME_PROBE.member + " (" + SRG_RUNTIME_PROBE.mojang + "); " + SRG_UNSUPPORTED};
        }
        if (p.mcClass === null || p.mcClass === undefined || p.srgMember === null || p.srgMember === undefined) {
            return {ok: "unknown", reason: "runtime probe failed (no class name or reflection error)"};
        }
        return {ok: "1", reason: "Forge SRG runtime (" + SRG_RUNTIME_PROBE.member + " present)"};
    }

    // The ONE boot log line for both halves (mirror of srg-runtime.ts srgBootLine): main.js used to
    // log them separately, so Fabric printed "SRG boot-check PASS" and then "!!! … FAIL".
    // map = {ok, required:{tokens,members} (counts), missing:{tokens,members} (lists)}.
    function srgBootLine(map, runtime) {
        var table = map.ok === "1"
            ? "srg_names.json resolved " + map.required.tokens + " tokens + " + map.required.members + " members"
            : map.ok === "0"
                ? "pack rot: " + map.missing.tokens.length + " token(s) + " + map.missing.members.length +
                  " member(s) unresolved — regenerate srg_names.json (scripts/dev/srg.py --export); missing=" +
                  JSON.stringify(map.missing)
                : "srg_names.json not deployed (run scripts/dev/srg.py --export + sync)";
        if (runtime.ok === "0") return "!!! SRG boot-check FAIL — " + runtime.reason + "; " + table;
        var probe = runtime.ok === "1" ? runtime.reason : "runtime probe inconclusive — " + runtime.reason;
        if (map.ok === "0") return "!!! SRG boot-check FAIL — " + table + "; " + probe;
        if (map.ok === "unknown") return "SRG boot-check SKIPPED — " + table + "; " + probe;
        return "SRG boot-check PASS — " + table + "; " + probe;
    }

    // ---- world-model compare-and-swap (mirror of src/shared/harness/world-cas.ts) --
    // The pure RMW-with-retry loop that serializes the multi-writer mc_world.json (main.js thread +
    // ext plugins + the worker bundle thread). `store` = {read()->{seq,value}, commit(value,nextSeq,
    // expectedSeq)->bool}; the Java atomic-rename IO lives in world_store.js. `mutate` is re-applied
    // over a FRESH read on every conflict so a concurrent writer's update survives too.
    function casUpdate(store, mutate, maxAttempts) {
        var max = (typeof maxAttempts === "number" && maxAttempts > 0) ? maxAttempts : 8;
        for (var attempt = 1; attempt <= max; attempt++) {
            var r = store.read();
            var next = mutate(r.value);
            if (store.commit(next, r.seq + 1, r.seq)) return {committed: true, attempts: attempt, forced: false};
        }
        var f = store.read();
        store.commit(mutate(f.value), f.seq + 1, null); // force one last re-merged write (no worse than LWW)
        return {committed: false, attempts: max, forced: true};
    }

    // ---- movement-key dead-man (mirror of src/shared/harness/deadman.ts) ----------
    // main.js asks once per main tick: has the worker heartbeat (mc_worker_alive, bumped at the start
    // of every worker tick body) stood still for staleTicks main ticks? If so it releases KEYS once per
    // stall. beat 0 = no worker running → never release (a human may hold the keys). See deadman.ts.
    var DEADMAN_KEYS = ["key.forward", "key.back", "key.left", "key.right", "key.jump", "key.sprint", "key.sneak"];
    function deadmanInit() {
        return {beat: null, beatTick: 0, tripped: false, stalls: 0, stallTick: -1};
    }
    function deadmanStep(st, beat, tick, staleTicks) {
        if (beat !== st.beat) {
            return {state: {beat: beat, beatTick: tick, tripped: false, stalls: st.stalls, stallTick: st.stallTick},
                    release: false, stale: false};
        }
        var stale = beat > 0 && tick - st.beatTick >= staleTicks;
        if (!stale || st.tripped) return {state: st, release: false, stale: stale};
        return {state: {beat: st.beat, beatTick: st.beatTick, tripped: true, stalls: st.stalls + 1, stallTick: tick},
                release: true, stale: stale};
    }

    globalThis.__MC_HARNESS = {
        route: route,
        cas: {update: casUpdate},
        deadman: {KEYS: DEADMAN_KEYS, init: deadmanInit, step: deadmanStep},
        srg: {
            buildIndex: buildSrgIndex,
            lookup: srgLookup,
            lookupAll: srgLookupAll,
            findMissing: findMissingSrg,
            findMissingTokens: findMissingTokens,
            runtimeVerdict: srgRuntimeVerdict,
            bootLine: srgBootLine
        },
        SRG_RUNTIME_PROBE: SRG_RUNTIME_PROBE,
        SRG_REQUIRED: {
            tokens: REQUIRED_SRG_TOKENS,
            members: REQUIRED_SRG_MEMBERS
        }
    };
})();
