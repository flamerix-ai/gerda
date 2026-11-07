// world_store.js — shared world-model (mc_world.json) access for the plain-JS services.
// ===========================================================================
// main.js (R0 supervisor) and ext.js (R1 prospector/markers/journeymap) both
// read-modify-write the unified world model. This was duplicated verbatim in each;
// it now lives HERE once, eval-included like ipc.js, publishing globalThis.__MC_WORLD_STORE.
//
// Schema (mirror of src/shared/domain/world-model.ts):
//   { version:1, worlds: { "<sig>": {waypoints,resources,stats,updatedAt} } }
// The worker (R2 bundle) owns waypoints/stats; the prospector (ext.js) owns resources.
// Each writer read-modify-writes ONLY its own section so the others survive (no
// cross-proc lock; writes are infrequent). The file is resolved in the macroFolder —
// the SAME path the bundle pins (user.dir/config/jsMacros/Macros/mc_world.json).
//
// worldSignature() needs FWorld.getDimension/getWorldIdentifier, which only work on
// main.js's thread — that's fine, the only callers are main.js + ext.js (ext runs in
// main's scope). The worker reads main.js's published signature instead (see worker.js).
//
// Authored ES5-ish (var/function) to match the other Service files / GraalJS.
// ===========================================================================
"use strict";
(function () {
    var Files = Java.type("java.nio.file.Files");
    var Paths = Java.type("java.nio.file.Paths");
    // The Charset INSTANCE, not the class — readString/writeString(Path,Charset) reject
    // the class with "no applicable overload found" (this exact bug broke the bundle's read).
    var UTF8 = Java.type("java.nio.charset.StandardCharsets").UTF_8;
    var StandardCopyOption = Java.type("java.nio.file.StandardCopyOption");
    var WORLD_FILE = "mc_world.json";

    function worldSignature() {
        var dim = "overworld", wid = "local";
        try { if (typeof World.getDimension === "function") dim = "" + World.getDimension(); } catch (_) {}
        try { if (typeof World.getWorldIdentifier === "function") wid = "" + World.getWorldIdentifier(); } catch (_) {}
        return wid + "|" + dim;
    }

    function worldPath() {
        try { return Paths.get(JsMacros.getConfig().macroFolder.toString()).resolve(WORLD_FILE); }
        catch (_) { return Paths.get(WORLD_FILE); }
    }

    function readWorldModel() {
        try {
            var p = worldPath();
            if (!Files.exists(p)) return {version: 1, worlds: {}};
            var m = JSON.parse(Files.readString(p, UTF8));
            if (!m || typeof m !== "object") return {version: 1, worlds: {}};
            if (!m.worlds || typeof m.worlds !== "object") m.worlds = {};
            return m;
        } catch (_) { return {version: 1, worlds: {}}; }
    }

    // ATOMIC write: stage to <path>.tmp then ATOMIC_MOVE over the target, so a concurrent reader (the
    // worker bundle thread, another ext write, the host seeder) never scrapes a half-written file
    // (multi-writer compare-and-swap). Same mechanism as the TS runtime's fs.writeAtomic.
    function writeWorldModel(m) {
        try {
            var dst = worldPath();
            var tmp = Paths.get(dst.toString() + ".tmp");
            Files.writeString(tmp, JSON.stringify(m), UTF8);
            Files.move(tmp, dst, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            return true;
        } catch (_) { return false; }
    }

    // Read the current model plus its monotonic CAS seq (0 when absent/unstamped) — the read half of the
    // compare-and-swap store the RMW runs through.
    function readModelSeq() {
        var m = readWorldModel();
        return {seq: (typeof m.seq === "number") ? m.seq : 0, value: m};
    }

    function worldSection(m, sig) {
        var s = m.worlds[sig];
        if (!s || typeof s !== "object") s = {};
        if (!s.waypoints) s.waypoints = [];
        if (!s.resources) s.resources = [];
        if (!s.storages) s.storages = []; // storage-network registry (scan/add own it; worker reads)
        if (!s.stats) s.stats = {dumps: 0, veinsFound: 0, boots: 0};
        if (typeof s.updatedAt !== "number") s.updatedAt = 0;
        return s;
    }

    // Transactional read-modify-write for ONE world section — the SSOT for the per-writer ceremony
    // (read → section → mutate → stamp updatedAt+version → write) that main.js knowledge_set and ext.js
    // appendMarkers/mergeStorages/storage_remove each inlined. The mutator receives (section, model) and
    // mutates the section in place (return value ignored); updatedAt + version stamping and the
    // m.worlds[sig] re-attach happen here. Returns {wrote, section}.
    //
    // The write goes through the harness compare-and-swap: mc_world.json is RMW'd by this
    // (main.js) thread AND the worker bundle thread, so a naive last-writer-wins loses updates. cas.update
    // re-reads + RE-RUNS the whole mutation on a seq conflict, so a concurrent write survives; the seq is
    // bumped on commit and the file replaced atomically. mutate() operates on the WHOLE model (seq is
    // model-level) and the resulting section is captured for the response.
    function updateWorldSection(sig, mutator) {
        var CAS = globalThis.__MC_HARNESS.cas;
        var captured = null, lastWrote = false;
        var store = {
            read: readModelSeq,
            commit: function (model, nextSeq, expectedSeq) {
                // CAS check: if the caller asked to only-write-when-unchanged, re-read the on-disk seq and
                // bail on a conflict (cas.update will re-read + re-mutate). null expectedSeq = force.
                if (expectedSeq !== null && readModelSeq().seq !== expectedSeq) return false;
                model.seq = nextSeq;
                lastWrote = writeWorldModel(model);
                return lastWrote;
            }
        };
        var res = CAS.update(store, function (m) {
            if (!m.worlds || typeof m.worlds !== "object") m.worlds = {};
            if (typeof m.version !== "number") m.version = 1;
            var s = worldSection(m, sig);
            mutator(s, m);
            s.updatedAt = (Date.now() / 1000) >> 0;
            m.worlds[sig] = s;
            captured = s;
            return m;
        });
        return { wrote: (res.committed || res.forced) && lastWrote, section: captured };
    }

    globalThis.__MC_WORLD_STORE = {
        FILE: WORLD_FILE,
        signature: worldSignature,
        path: worldPath,
        read: readWorldModel,
        write: writeWorldModel,
        section: worldSection,
        update: updateWorldSection
    };
})();
