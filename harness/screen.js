// screen.js — "eyes & hands" container primitives (screenshot, read/click/scroll/type
// /keypress, introspect) for the miner bridge. Split out of main.js to keep the
// supervisor lean; still CONTAINER-scoped (full jsMacros/render-thread access), NOT a
// reloadable ext plugin — these are stable infra, eval-included by main.js like ipc.js
// /world_store.js. They drive the REAL vanilla Screen via Forge SRG names (the mapped
// names don't exist at runtime) so they reach mod GUIs (FTB Quests) with no OS cursor.
//
// main.js calls __MC_SCREEN({writeResp, SRG}) after those are defined and merges the
// returned map into HANDLERS. jsMacros globals (Hud/Client/Player/KeyBind/JsMacros/
// JavaWrapper/Java/java) are service-scope globals, available here without injection.
//
// Authored ES5-ish (var/function) to match the other Service files / GraalJS.
// ===========================================================================
"use strict";
globalThis.__MC_SCREEN = function (deps) {
    var writeResp = deps.writeResp;
    var SRG = deps.SRG; // Forge SRG method names for the raw Screen calls
    var IPC = deps.IPC; // ipc.js envelope factory SSOT (okFlat/ok/err)
    // Envelope helpers routed through the ipc.js factories (same wire shape, one home):
    // respFlat = flat fields; respData = {data:…}; respErr = error (+ optional extra).
    function respFlat(id, type, fields) { writeResp(id, IPC.okFlat(id, type, fields)); }
    function respData(id, type, data)   { writeResp(id, IPC.ok(id, type, data)); }
    function respErr(id, type, error, extra) { writeResp(id, IPC.err(id, type, error, extra)); }
    // The raw-SRG hands exist only on a Forge-SRG runtime. Check the members on the live screen
    // BEFORE scheduling: on Fabric they are absent, and the render-thread call used to fail unseen
    // after an ok "scheduled" reply (docs/PORTABILITY.md). A property read, no call.
    function srgHandsMissing(screen, names) {
        for (var i = 0; i < names.length; i++) {
            var token = SRG[names[i]];
            if (typeof screen[token] !== "function") {
                return "this runtime has no " + token + " (Screen." + names[i] + ") — not Forge SRG " +
                    "(Fabric/NeoForge?); `click {i}` / `click {text}` and `key` still work (docs/PORTABILITY.md)";
            }
        }
        return null;
    }

    var S = {
        _screenshotDir: function () {
            var Paths = Java.type("java.nio.file.Paths");
            var base = java.lang.System.getProperty("user.dir");
            return Paths.get(base, "screenshots");
        },
        _newestPng: function () {
            var Files = Java.type("java.nio.file.Files");
            var dir = S._screenshotDir();
            if (!Files.exists(dir)) return null;
            var best = null, bestT = -1;
            var ds = Files.newDirectoryStream(dir, "*.png");
            try {
                var it = ds.iterator();
                while (it.hasNext()) {
                    var p = it.next();
                    var t = Files.getLastModifiedTime(p).toMillis();
                    if (t > bestT) { bestT = t; best = p; }
                }
            } finally { ds.close(); }
            return best ? {path: best.toString(), mtime: bestT} : null;
        },

        // Diagnostic: dump jsMacros library / open-screen method names so we can find the
        // right mapped API on Forge (raw reflection hits SRG names).
        introspect: function (req, id) {
            function methods(obj) {
                try {
                    var ms = obj.getClass().getMethods();
                    var out = [];
                    for (var i = 0; i < ms.length; i++) {
                        var nm = ms[i].getName();
                        if (out.indexOf(nm) < 0) out.push(nm);
                    }
                    out.sort();
                    return out;
                } catch (e) { return ["ERR:" + (e.message || e)]; }
            }
            var filter = req.filter || null;
            function maybe(list) {
                if (!filter) return list;
                var out = [];
                for (var i = 0; i < list.length; i++) {
                    if (list[i].toLowerCase().indexOf(filter.toLowerCase()) >= 0) out.push(list[i]);
                }
                return out;
            }
            var res = {ok: true, type: "introspect", id: id};
            if (req.target === "screen") {
                try {
                    var sc = Hud.getOpenScreen();
                    if (!sc) { res.screen = null; writeResp(id, res); return; }
                    res.screen = maybe(methods(sc));
                    try {
                        var bs = sc.getButtonWidgets ? sc.getButtonWidgets() : null;
                        if (bs && (bs.size ? bs.size() : bs.length) > 0) {
                            var b0 = bs.get ? bs.get(0) : bs[0];
                            res.button = maybe(methods(b0));
                        }
                    } catch (e) { res.button = "ERR:" + (e.message || e); }
                } catch (e) { res.screen = "ERR:" + (e.message || e); }
                writeResp(id, res);
                return;
            }
            try { res.Hud = maybe(methods(Hud)); } catch (e) { res.Hud = "ERR"; }
            try { res.Client = maybe(methods(Client)); } catch (e) { res.Client = "ERR"; }
            try { res.JsMacros = maybe(methods(JsMacros)); } catch (e) { res.JsMacros = "ERR"; }
            try { res.KeyBind = maybe(methods(KeyBind)); } catch (e) { res.KeyBind = "ERR"; }
            writeResp(id, res);
        },

        screenshot: function (_req, id) {
            try {
                // Native jsMacros capture: FPlayer.takeScreenshot(folder, file, cb) wraps
                // vanilla Screenshot.grab(mc.getFramebuffer()) — no SRG, no keybind (the
                // F2-keybind press never produced a file here). `folder` is resolved
                // relative to config/jsMacros/Macros AND vanilla grab() appends its own
                // "screenshots" segment, so climb exactly to the game dir ("../../..") to
                // land in <gamedir>/screenshots/. Capture+encode run on the render/io
                // thread, hence the main-thread hop and the fixed (overwritten) filename.
                var name = (_req && _req.name) ? String(_req.name) : "ai_shot.png";
                Client.runOnMainThread(JavaWrapper.methodToJava(function () {
                    try {
                        Player.takeScreenshot("../../..", name,
                            JavaWrapper.methodToJava(function (_txt) {}));
                    } catch (e) {
                        java.lang.System.out.println("[MAIN] screenshot grab err: " + (e.message || e));
                    }
                }));
                writeResp(id, {
                    ok: true, type: "screenshot", id: id, triggered: true, file: name,
                    dir: S._screenshotDir().toString()
                });
            } catch (e) {
                respErr(id, "screenshot", "screenshot failed: " + (e.message || e));
            }
        },

        latest_screenshot: function (_req, id) {
            try {
                var n = S._newestPng();
                if (!n) { respErr(id, "latest_screenshot", "no screenshots found"); return; }
                respFlat(id, "latest_screenshot", {path: n.path, mtime: n.mtime});
            } catch (e) {
                respErr(id, "latest_screenshot", "latest_screenshot failed: " + (e.message || e));
            }
        },

        // Press (and release) a named keybind, e.g. "key.inventory", "key.drop",
        // "key.screenshot". hold=true leaves it held (release with a hold=false call).
        key: function (req, id) {
            var name = req.key;
            if (!name) { respErr(id, "key", "missing 'key'"); return; }
            try {
                if (req.hold === true) {
                    KeyBind.keyBind(name, true);
                } else if (req.release === true) {
                    KeyBind.keyBind(name, false);
                } else {
                    KeyBind.keyBind(name, true);
                    KeyBind.keyBind(name, false);
                }
                respFlat(id, "key", {key: name});
            } catch (e) {
                respErr(id, "key", "key failed: " + (e.message || e));
            }
        },

        // Scroll the open screen at GUI coords (x,y). amount: +up / -down (notches).
        // Real Screen.mouseScrolled (SRG.mouseScrolled) — drives FTB panels, item lists, etc.
        scroll: function (req, id) {
            try {
                var screen = Hud.getOpenScreen();
                if (!screen) { respErr(id, "scroll", "no open screen"); return; }
                var noSrg = srgHandsMissing(screen, ["mouseScrolled"]);
                if (noSrg) { respErr(id, "scroll", noSrg); return; }
                var x =(typeof req.x === "number") ? req.x : 320;
                var y = (typeof req.y === "number") ? req.y : 180;
                var amt = (typeof req.amount === "number") ? req.amount : -3;
                Client.runOnMainThread(JavaWrapper.methodToJava(function () { screen[SRG.mouseScrolled](x, y, amt); }));
                respFlat(id, "scroll", {x: x, y: y, amount: amt});
            } catch (e) {
                respErr(id, "scroll", "scroll failed: " + (e.message || e));
            }
        },

        // Type text into the focused widget (e.g. a JEI/REI search box). Real
        // Screen.charTyped (SRG.charTyped) per character — the widget must already be
        // focused (click it first). For Enter/Backspace/Esc use `keypress`.
        type: function (req, id) {
            try {
                var screen = Hud.getOpenScreen();
                if (!screen) { respErr(id, "type", "no open screen"); return; }
                var noSrg = srgHandsMissing(screen, ["charTyped"]);
                if (noSrg) { respErr(id, "type", noSrg); return; }
                var text = (req.text != null) ? String(req.text) : "";
                Client.runOnMainThread(JavaWrapper.methodToJava(function () {
                    for (var i = 0; i < text.length; i++) { screen[SRG.charTyped](text.charCodeAt(i), 0); }
                }));
                respFlat(id, "type", {len: text.length});
            } catch (e) {
                respErr(id, "type", "type failed: " + (e.message || e));
            }
        },

        // Send a raw GLFW key to the open screen (keyPressed+keyReleased, SRG.keyPressed/
        // keyReleased). Common codes: Enter=257, Backspace=259, Escape=256 (see KEY),
        // Tab=258, arrows 262-265. Use for confirming/clearing a typed field.
        keypress: function (req, id) {
            try {
                var screen = Hud.getOpenScreen();
                if (!screen) { respErr(id, "keypress", "no open screen"); return; }
                var noSrg = srgHandsMissing(screen, ["keyPressed"]);
                if (noSrg) { respErr(id, "keypress", noSrg); return; }
                var code = (typeof req.code === "number") ? req.code : 0;
                var sc = (typeof req.scancode === "number") ? req.scancode : 0;
                var mods = (typeof req.mods === "number") ? req.mods : 0;
                Client.runOnMainThread(JavaWrapper.methodToJava(function () {
                    screen[SRG.keyPressed](code, sc, mods);
                    if (typeof screen[SRG.keyReleased] === "function") screen[SRG.keyReleased](code, sc, mods);
                }));
                respFlat(id, "keypress", {code: code});
            } catch (e) {
                respErr(id, "keypress", "keypress failed: " + (e.message || e));
            }
        },

        // Read the currently open screen semantically: title + button widgets (text,
        // position, enabled). Returns open:false when no screen is up (in-world).
        read_screen: function (_req, id) {
            function txt(o) {
                if (o === null || o === undefined) return null;
                try { if (typeof o.getString === "function") return o.getString(); } catch (_) {}
                try { return String(o); } catch (_) { return null; }
            }
            try {
                var screen = null;
                try { screen = Hud.getOpenScreen(); } catch (_) {}
                if (!screen) { respFlat(id, "read_screen", {open: false}); return; }

                var title = null;
                try { title = txt(typeof screen.getTitleText === "function" ? screen.getTitleText() : null); } catch (_) {}

                var buttons = [];
                try {
                    var bs = (typeof screen.getButtonWidgets === "function") ? screen.getButtonWidgets() : null;
                    if (bs) {
                        var n = (typeof bs.size === "function") ? bs.size() : bs.length;
                        for (var i = 0; i < n; i++) {
                            var b = (typeof bs.get === "function") ? bs.get(i) : bs[i];
                            var label = null;
                            // jsMacros button widgets expose getLabel() (a TextHelper).
                            try { label = txt(typeof b.getLabel === "function" ? b.getLabel() : null); } catch (_) {}
                            var entry = {i: i, text: label};
                            try { entry.x = (typeof b.getX === "function") ? b.getX() : null; } catch (_) {}
                            try { entry.y = (typeof b.getY === "function") ? b.getY() : null; } catch (_) {}
                            try { entry.w = (typeof b.getWidth === "function") ? b.getWidth() : null; } catch (_) {}
                            try { entry.h = (typeof b.getHeight === "function") ? b.getHeight() : null; } catch (_) {}
                            try { entry.active = (typeof b.getActive === "function") ? b.getActive() : null; } catch (_) {}
                            buttons.push(entry);
                        }
                    }
                } catch (_) {}

                respFlat(id, "read_screen", {open: true, title: title, buttons: buttons});
            } catch (e) {
                respErr(id, "read_screen", "read_screen failed: " + (e.message || e));
            }
        },

        // Click a button on the open screen: by index (i), by label substring (text),
        // or a raw mouse click at screen coords (x,y). Semantic (i/text) is robust;
        // x/y is the fallback for custom-rendered widgets.
        click: function (req, id) {
            try {
                var screen = Hud.getOpenScreen();
                if (!screen) { respErr(id, "click", "no open screen"); return; }

                // Resolve the action synchronously (reads are fine off-thread), then run
                // the actual click on the render thread — some screens touch RenderSystem.
                var action = null, resp = null;
                if (typeof req.x === "number" && typeof req.y === "number") {
                    var noSrg = srgHandsMissing(screen, ["mouseClicked", "mouseReleased"]);
                    if (noSrg) { respErr(id, "click", noSrg); return; }
                    var bx = req.x, by = req.y, mb = (typeof req.button === "number") ? req.button : 0;
                    // Call the REAL vanilla Screen.mouseClicked/Released (NOT jsmacros_*,
                    // which only drives jsMacros' own overlay and never reaches the mod
                    // GUI). FTB's ScreenWrapper.mouseClicked updates hover from the passed
                    // x,y before dispatching, so this works without moving the OS cursor.
                    // Forge SRG-obfuscates the method at runtime → call by SRG name
                    // (SRG.mouseClicked / SRG.mouseReleased — the mapped names don't exist).
                    action = function () {
                        screen[SRG.mouseClicked](bx, by, mb);
                        screen[SRG.mouseReleased](bx, by, mb);
                    };
                    resp = {mode: "xy", x: bx, y: by};
                } else {
                    var bs = (typeof screen.getButtonWidgets === "function") ? screen.getButtonWidgets() : null;
                    if (!bs) { respErr(id, "click", "screen has no button widgets"); return; }
                    var n = (typeof bs.size === "function") ? bs.size() : bs.length;
                    var target = null, label = null;
                    if (typeof req.i === "number") {
                        if (req.i < 0 || req.i >= n) { respErr(id, "click", "index out of range (0.." + (n - 1) + ")"); return; }
                        target = (typeof bs.get === "function") ? bs.get(req.i) : bs[req.i];
                    } else if (typeof req.text === "string") {
                        var want = req.text.toLowerCase();
                        for (var i = 0; i < n; i++) {
                            var b = (typeof bs.get === "function") ? bs.get(i) : bs[i];
                            var l = null;
                            try { l = (typeof b.getLabel === "function" && b.getLabel()) ? b.getLabel().getString() : null; } catch (_) {}
                            if (l && l.toLowerCase().indexOf(want) >= 0) { target = b; label = l; break; }
                        }
                        if (!target) { respErr(id, "click", "no button matching '" + req.text + "'"); return; }
                    } else {
                        respErr(id, "click", "need i, text, or x+y");
                        return;
                    }
                    var tgt = target;
                    action = function () { tgt.click(); };
                    resp = {mode: (label ? "text" : "index"), label: label};
                }
                Client.runOnMainThread(JavaWrapper.methodToJava(action));
                resp.ok = true; resp.type = "click"; resp.id = id; resp.scheduled = true;
                writeResp(id, resp);
            } catch (e) {
                respErr(id, "click", "click failed: " + (e.message || e));
            }
        },

        close_screen: function (_req, id) {
            try {
                var screen = Hud.getOpenScreen();
                if (!screen) { respFlat(id, "close_screen", {wasOpen: false}); return; }
                // close() rebuilds the screen → must run on the render thread.
                Client.runOnMainThread(JavaWrapper.methodToJava(function () {
                    try { screen.close(); } catch (_) {}
                }));
                respFlat(id, "close_screen", {wasOpen: true, scheduled: true});
            } catch (e) {
                respErr(id, "close_screen", "close failed: " + (e.message || e));
            }
        }
    };

    return S;
};
