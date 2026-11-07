// probe_runtime.js — STANDALONE runtime/API verification probe (no bot needed).
// ----------------------------------------------------------------------------
// Run directly from the jsMacros GUI (or bind to a key). Does NOT touch the
// bridge/main/worker services or the mining bundle. Verifies the runtime assumptions
// the kernel is built on against the ACTUAL installed runtime:
//   - JS engine (GraalJS?) + ECMAScript level
//   - modern-language features (let/const/class/arrow/async/Map/Set/...) via eval
//   - require() availability
//   - jsMacros API surface we plan to rely on (InteractionManager async break,
//     Inventory container clicks, World entity/block scans, events, FS, Baritone)
//
// Output: prints a report to chat (Chat.log) AND writes it to
//   <Macros>/probe_runtime_report.txt
//
// ES5-clean on purpose: feature detection uses eval() of strings so this file
// parses and runs even on a hypothetical ES5 engine — that's the whole point.
// ----------------------------------------------------------------------------

(function () {
    var lines = [];
    var counts = { PASS: 0, WARN: 0, FAIL: 0, INFO: 0 };

    function rec(sev, label, detail) {
        if (counts[sev] === undefined) counts[sev] = 0;
        counts[sev]++;
        var line = pad(sev, 4) + " | " + label + (detail ? "  —  " + detail : "");
        lines.push(line);
    }
    function pad(s, n) { s = String(s); while (s.length < n) s += " "; return s; }
    function info(label, detail) { rec("INFO", label, detail); }

    // typeof-on-a-path check: returns true if obj && typeof obj[name] === 'function'
    function hasFn(obj, name) {
        try { return !!obj && typeof obj[name] === "function"; } catch (e) { return false; }
    }
    function apiCheck(cat, obj, name, optional) {
        var ok = hasFn(obj, name);
        rec(ok ? "PASS" : (optional ? "WARN" : "FAIL"), cat + "." + name, ok ? "present" : "MISSING");
        return ok;
    }
    // eval a snippet; PASS if it runs without throwing.
    function evalSupports(label, code) {
        var ok = false, err = "";
        try { (0, eval)(code); ok = true; } catch (e) { err = String(e); }
        rec(ok ? "PASS" : "FAIL", "es:" + label, ok ? "supported" : ("unsupported (" + err + ")"));
        return ok;
    }

    // ---- 1. Engine identification -----------------------------------------
    lines.push("== ENGINE ==");
    try {
        if (typeof Graal !== "undefined") {
            rec("PASS", "engine", "GraalJS detected");
            try { info("Graal.versionGraalVM", String(Graal.versionGraalVM)); } catch (e) {}
            try { info("Graal.versionECMAScript", String(Graal.versionECMAScript)); } catch (e) {}
            try { info("Graal.language", String(Graal.language)); } catch (e) {}
            try { info("Graal.isGraalRuntime", String(Graal.isGraalRuntime())); } catch (e) {}
        } else {
            rec("WARN", "engine", "no 'Graal' global — Nashorn or other engine? (this would invalidate the TS plan)");
        }
    } catch (e) { rec("FAIL", "engine", String(e)); }

    // ---- 2. Language features (via eval, so source stays ES5-clean) --------
    lines.push("== LANGUAGE (ES) ==");
    evalSupports("let/const",     "let _a=1; const _b=2; _a+_b");
    evalSupports("arrow",         "var f=(x)=>x*2; f(2)");
    evalSupports("class",         "class C{ m(){return 1} } new C().m()");
    evalSupports("template",      "var x=5; `v=${x}`");
    evalSupports("destructuring", "var {a=1}= {}; var [b]=[2]; a+b");
    evalSupports("default+rest",  "function g(a, ...r){return a+r.length} g(1,2,3)");
    evalSupports("spread",        "Math.max(...[1,2,3])");
    evalSupports("for-of",        "var s=0; for (var v of [1,2,3]) s+=v; s");
    evalSupports("Map/Set",       "new Map([['k',1]]).get('k') + new Set([1,1]).size");
    evalSupports("Promise",       "typeof Promise.resolve(1).then");
    evalSupports("async/await",   "(async function(){ return await Promise.resolve(1); })");
    evalSupports("Object.assign", "Object.assign({}, {a:1}).a");

    // ---- 3. Modules -------------------------------------------------------
    lines.push("== MODULES ==");
    rec(typeof require === "function" ? "PASS" : "WARN", "require()",
        typeof require === "function" ? "present (CommonJS cross-file modules work)"
                                      : "no global require — check js.commonjs-require / use bundler");

    // ---- 4. Core API shape ------------------------------------------------
    lines.push("== CORE API ==");
    apiCheck("Player", typeof Player !== "undefined" ? Player : null, "getPlayer");
    apiCheck("Player", typeof Player !== "undefined" ? Player : null, "openInventory");
    apiCheck("World",  typeof World !== "undefined" ? World : null, "getBlock");
    apiCheck("World",  typeof World !== "undefined" ? World : null, "getEntities");
    apiCheck("World",  typeof World !== "undefined" ? World : null, "findBlocksMatching", true);
    apiCheck("Chat",   typeof Chat !== "undefined" ? Chat : null, "say");
    apiCheck("Chat",   typeof Chat !== "undefined" ? Chat : null, "log");
    apiCheck("KeyBind",typeof KeyBind !== "undefined" ? KeyBind : null, "keyBind");
    apiCheck("Client", typeof Client !== "undefined" ? Client : null, "waitTick", true);
    apiCheck("FS",     typeof FS !== "undefined" ? FS : null, "open", true);

    // ---- 5. InteractionManager (mining core — vision wants async break) ----
    lines.push("== INTERACTION MANAGER ==");
    try {
        var im = (typeof Player !== "undefined" && Player.getInteractionManager) ? Player.getInteractionManager() : null;
        if (!im) {
            rec("WARN", "InteractionManager", "unavailable (not in world?) — re-run in-game");
        } else {
            apiCheck("IM", im, "attack");
            apiCheck("IM", im, "breakBlock");
            apiCheck("IM", im, "breakBlockAsync", true);   // vision: replaces held-key hack
            apiCheck("IM", im, "setTarget");
            apiCheck("IM", im, "cancelBreakBlock", true);
        }
    } catch (e) { rec("FAIL", "InteractionManager", String(e)); }

    // ---- 6. Inventory / container (chest + craft automation feasibility) ---
    lines.push("== INVENTORY / CONTAINER ==");
    apiCheck("Inventory", typeof Inventory !== "undefined" ? Inventory : null, "create", true);
    try {
        var inv = (typeof Player !== "undefined" && Player.openInventory) ? Player.openInventory() : null;
        if (!inv) {
            rec("WARN", "Inventory instance", "Player.openInventory() null — re-run in-game");
        } else {
            apiCheck("inv", inv, "getMap");      // named slot regions (container/hotbar/main)
            apiCheck("inv", inv, "getSlots");
            apiCheck("inv", inv, "getSlot");
            apiCheck("inv", inv, "click");
            apiCheck("inv", inv, "quick", true); // shift-click quick-move = chest deposit
            apiCheck("inv", inv, "swap", true);
            apiCheck("inv", inv, "dropSlot", true);
            apiCheck("inv", inv, "setSelectedHotbarSlotIndex");
            try { info("inv.getMap() regions", JSON.stringify(Object.keys(inv.getMap()))); } catch (e) {}
        }
    } catch (e) { rec("FAIL", "Inventory instance", String(e)); }

    // ---- 7. Events / IPC / threading (vision: custom events, async wrappers)
    lines.push("== EVENTS / IPC ==");
    apiCheck("JsMacros", typeof JsMacros !== "undefined" ? JsMacros : null, "on");
    apiCheck("JsMacros", typeof JsMacros !== "undefined" ? JsMacros : null, "off");
    apiCheck("JsMacros", typeof JsMacros !== "undefined" ? JsMacros : null, "once", true);
    apiCheck("JsMacros", typeof JsMacros !== "undefined" ? JsMacros : null, "waitForEvent", true);
    apiCheck("JsMacros", typeof JsMacros !== "undefined" ? JsMacros : null, "createCustomEvent", true);
    apiCheck("JavaWrapper", typeof JavaWrapper !== "undefined" ? JavaWrapper : null, "methodToJava");
    apiCheck("JavaWrapper", typeof JavaWrapper !== "undefined" ? JavaWrapper : null, "methodToJavaAsync", true);
    apiCheck("GlobalVars", typeof GlobalVars !== "undefined" ? GlobalVars : null, "putString");
    apiCheck("GlobalVars", typeof GlobalVars !== "undefined" ? GlobalVars : null, "incrementAndGetInt", true);
    apiCheck("GlobalVars", typeof GlobalVars !== "undefined" ? GlobalVars : null, "toggleBoolean", true);

    // ---- 8. Baritone (path driver) ----------------------------------------
    lines.push("== BARITONE ==");
    try {
        Java.type("baritone.api.BaritoneAPI");
        rec("PASS", "Baritone API", "baritone.api.BaritoneAPI reachable via Java.type (typed driver possible)");
    } catch (e) {
        rec("WARN", "Baritone API", "not reachable via Java.type — fall back to chat-command driver");
    }

    // ---- Summary + emit ---------------------------------------------------
    var header = "===== RUNTIME PROBE =====  PASS=" + counts.PASS +
                 " WARN=" + counts.WARN + " FAIL=" + counts.FAIL;
    var report = header + "\n" + lines.join("\n") + "\n=========================";
    var reportLines = report.split("\n");

    // Channel 1 (primary, greppable): System.out → captured into latest.log as [STDOUT].
    // Each line tagged [PROBE] so it's trivial to grep out of the modpack noise.
    try {
        for (var i = 0; i < reportLines.length; i++) {
            java.lang.System.out.println("[PROBE] " + reportLines[i]);
        }
    } catch (e) {}

    // Channel 2: Log4j logger named PROBE → also lands in latest.log.
    try {
        var logger = Java.type("org.apache.logging.log4j.LogManager").getLogger("PROBE");
        for (var j = 0; j < reportLines.length; j++) { logger.info(String(reportLines[j])); }
    } catch (e) {}

    // Channel 3 (file): proven approach from log_file.js — FileWriter off user.dir.
    var wrotePath = null;
    try {
        var System = Java.type("java.lang.System");
        var base = System.getProperty("user.dir");
        var path = base + "/config/jsMacros/Macros/probe_runtime_report.txt";
        var FileWriter = Java.type("java.io.FileWriter");
        var BufferedWriter = Java.type("java.io.BufferedWriter");
        var w = new BufferedWriter(new FileWriter(path, false));
        try { w.write(report); w.newLine(); } finally { w.close(); }
        wrotePath = path;
        java.lang.System.out.println("[PROBE] report file: " + path);
    } catch (e) {
        java.lang.System.out.println("[PROBE] file write failed: " + e);
    }

    // Channel 4 (chat): ONE summary line only — no spam.
    try {
        Chat.log("[PROBE] " + header + (wrotePath ? "  → " + wrotePath : "") +
                 "  (full report in latest.log, grep [PROBE])");
    } catch (e) {}
})();
