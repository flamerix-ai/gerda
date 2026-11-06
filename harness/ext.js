// ext.js — RELOADABLE mod-API plugins for the miner bridge.
// ===========================================================================
// Loaded by main.js at startup AND on the `reload_ext` bridge command
// (privileged eval, full Java/jsMacros scope). To add or change a mod-interaction
// command: edit THIS file → `./gerda sync` → call `reload_ext` — NO main.js
// service reload needed (main.js is the stable supervisor; this is the hot layer).
//
// Each plugin registers via:  register(name, fn(req, id), meta)
//   - meta = {where:"ext", desc:"…", params:[{name,type,required,desc}, …]}
//   - respond with writeResp(id, {ok, type:name, id, …})
// Globals available (main.js scope): Java, World, Player, Hud, Chat, Client,
//   KeyBind, JavaWrapper, GlobalVars, writeResp, register, Math, JSON,
//   SRG (Forge SRG method names) + KEY (GLFW key codes) — the SSOT in main.js.
//
// The whole file is one IIFE so helper functions stay private and the registered
// handler closures capture them; re-running (reload_ext) replaces them cleanly.
// ===========================================================================
(function () {
    // ---- shared: world-scoped knowledge store (mc_world.json) --------------
    // The prospector owns the `resources` section per world signature; the worker
    // (R2) owns waypoints/stats. Read-modify-write touches ONLY our section so the
    // worker's writes survive (no cross-proc lock; writes are infrequent). The file
    // is resolved in the macroFolder — the SAME path main.js + the bundle pin
    // (user.dir/config/jsMacros/Macros/mc_world.json). See src/shared/domain/world-model.ts.
    var Files = Java.type("java.nio.file.Files");
    var Paths = Java.type("java.nio.file.Paths");
    var UTF8 = Java.type("java.nio.charset.StandardCharsets").UTF_8; // the Charset instance, NOT the class (writeString rejects the class)

    // World-model access is the shared world_store.js (main.js eval-includes it before
    // loading us), aliased here so the plugin bodies read naturally and main.js + ext.js
    // share ONE implementation (no drift between the two read-modify-writers).
    var WS = globalThis.__MC_WORLD_STORE;
    if (!WS) throw new Error("__MC_WORLD_STORE missing — main.js must eval-include world_store.js before ext.js");
    var worldSignature = WS.signature;
    var readWorldModel = WS.read;
    var worldSection = WS.section;
    // (writeWorldModel is not aliased — the RMW writers go through WS.update; read-only
    //  callers use readWorldModel + worldSection.)

    // ---- SRG→Mojang name annotation (for reflect) -------------------------
    // Forge runs SRG method/field names (m_7583_, f_92095_). srg_names.json is a flat
    // SRG→"Class#member" map exported offline by scripts/dev/srg.py from the launcher's
    // mapping files; reflect uses it to print the human name next to each m_…_. Lazy +
    // cached in IIFE scope (read+parse measured ~66ms one-time, well under the 500ms
    // render-thread watchdog). Deploy with `just sync` (sync.py ships it). Regenerate:
    //   python3 scripts/dev/srg.py --export harness/srg_names.json
    var _SRG_NAMES; // undefined=unloaded, null=unavailable, else the map
    function srgNames() {
        if (_SRG_NAMES !== undefined) return _SRG_NAMES;
        _SRG_NAMES = null;
        try {
            var p = Paths.get(JsMacros.getConfig().macroFolder.toString()).resolve("srg_names.json");
            if (Files.exists(p)) _SRG_NAMES = JSON.parse(Files.readString(p, UTF8));
        } catch (e) {}
        return _SRG_NAMES;
    }
    function mojOf(map, srg) {
        // value is "Class#member(paramNames)" (methods) or "Class#field"; keep the
        // member + Parchment param names so reflect shows runtime TYPES + these NAMES,
        // e.g. m_150399_(int,int,…):void →clicked(slotId, button, clickType, player).
        if (!map) return null;
        var v = map[srg]; if (!v) return null;
        var h = v.indexOf("#"); return (h >= 0) ? v.substring(h + 1) : v;
    }

    // ---- Mojang→SRG forward lookup (for jeval ergonomics) -----------------
    // Inverts srg_names.json so jeval can call raw vanilla methods by their Mojang name
    // instead of pasting magic SRG tokens: `raw[srg("LocalPlayer","respawn")]()` rather
    // than `raw.m_7583_()` (which silently rots on a version bump). The INVERSION + the
    // fail-loud lookup are the pure harness SSOT (globalThis.__MC_HARNESS.srg, mirror of
    // src/shared/harness/srg-index.ts — TESTED); only the Java file-read of srg_names.json stays
    // here. Keyed by both "SimpleClass#member" and "FQCN#member"; overloads collapse to the
    // first SRG. Exposed as the GLOBAL `srg`/`srgAll` so jeval (same JS context) sees them
    // after reload_ext. The index is lazy + IIFE-cached (built once from the parsed map).
    var _SRG_FWD; // undefined=unbuilt, else the built index from H.srg.buildIndex
    function srgFwd() {
        if (_SRG_FWD !== undefined) return _SRG_FWD;
        _SRG_FWD = globalThis.__MC_HARNESS.srg.buildIndex(srgNames());
        return _SRG_FWD;
    }
    // srgAll("LocalPlayer","respawn") → ["m_7583_"]; srg(...) → first (throws if unknown).
    globalThis.srgAll = function (cls, member) {
        return globalThis.__MC_HARNESS.srg.lookupAll(srgFwd(), cls, member);
    };
    globalThis.srg = function (cls, member) {
        return globalThis.__MC_HARNESS.srg.lookup(srgFwd(), cls, member);
    };

    // ---- response envelopes routed through the ipc.js factory SSOT -----------
    // respFlat = flat fields spread at top level ({ok,type,id,...fields}); respData =
    // a {data:…} payload; respErr = an error (+ optional extra fields). These wrap the
    // ipc.js factories (globalThis.__MC_IPC, the wire-shape SSOT) so plugins stop
    // hand-building {ok:…,type:…,id:…} literals. Same bytes, one definition.
    var IPC = globalThis.__MC_IPC;
    function respFlat(id, type, fields) { writeResp(id, IPC.okFlat(id, type, fields)); }
    function respData(id, type, data)   { writeResp(id, IPC.ok(id, type, data)); }
    function respErr(id, type, error, extra) { writeResp(id, IPC.err(id, type, error, extra)); }

    // ---- defineCmd: register a plugin whose body is the HAPPY PATH only -----
    // ~30 plugins repeated the identical try/catch tail: `catch(e){ writeResp(id,
    // {ok:false, type:"NAME", id, error:"NAME failed: "+(e.message||e)}) }`. defineCmd
    // wraps fn in exactly that, auto-stamping type:name + the "<name> failed:" envelope,
    // so plugin bodies shrink to the success path. The arg order mirrors register(name,
    // fn, meta) on purpose — migration is a minimal in-place edit (no meta move). Plugins
    // whose error handling is NON-standard stay on raw register(): prospector_status
    // (bare `""+e.message` catch), the emi_recipe/emi_uses delegators
    // (emiShow owns their catch), and warp/sethome/go_base/spawn/rtp (no try/catch — a
    // throw there falls through to dispatch()'s outer guard, unchanged).
    function defineCmd(name, fn, meta) {
        register(name, function (req, id) {
            try { fn(req, id); }
            catch (e) { respErr(id, name, name + " failed: " + (e.message || e)); }
        }, meta);
    }

    // ========================================================================
    // EMI — native Java API (classes NOT SRG-remapped on Forge → real names).
    //   emi_search: EmiApi.setSearchText + EmiSearch.update kick an async daemon
    //     search; results land in the static EmiSearch.stacks a few ticks later.
    //   emi_recipe/uses: EmiApi.displayRecipes/displayUses open a Screen (main
    //     thread). Item id → EmiStack via jsMacros ItemStackHelper (SRG-free).
    // ========================================================================
    function emiShow(req, id, uses) {
        var type = uses ? "emi_uses" : "emi_recipe";
        try {
            var item = (req.item != null) ? String(req.item) : "";
            if (!item) { respErr(id, type, "item required"); return; }
            var EmiApi = Java.type("dev.emi.emi.api.EmiApi");
            var EmiStack = Java.type("dev.emi.emi.api.stack.EmiStack");
            var ItemStackHelper = Java.type("xyz.wagyourtail.jsmacros.client.api.helpers.inventory.ItemStackHelper");
            var raw = new ItemStackHelper(item, 1).getRaw();
            var stack = EmiStack.of(raw);
            Client.runOnMainThread(JavaWrapper.methodToJava(function () {
                if (uses) EmiApi.displayUses(stack); else EmiApi.displayRecipes(stack);
            }));
            respFlat(id, type, {item: item, opened: true});
        } catch (e) {
            respErr(id, type, type + " failed: " + (e.message || e));
        }
    }

    // EMI searches on its own thread (EmiSearch.search → new searchThread; SearchWorker.run sets a
    // NEW compiledQuery, then apply() publishes `stacks` and nulls searchThread — javap of
    // emi-1.1.22+1.20.1+forge). The old fixed 8-tick wait read `stacks` before a slow search
    // landed and returned the unfiltered index as ok:true. So: wait until THIS search's query is
    // compiled (compiledQuery changed) and applied (searchThread null), up to EMI_SETTLE_TICKS
    // (under bridge.js's 100-tick main-stall watchdog: this waits on main's dispatch), else fail.
    var EMI_SETTLE_TICKS = 40;
    defineCmd("emi_search", function (req, id) {
            var text = (req.text != null) ? String(req.text) : "";
            var limit = (typeof req.limit === "number") ? req.limit : 60;
            var EmiApi = Java.type("dev.emi.emi.api.EmiApi");
            var EmiSearch = Java.type("dev.emi.emi.search.EmiSearch");
            var before = EmiSearch.compiledQuery;
            Client.runOnMainThread(JavaWrapper.methodToJava(function () {
                EmiApi.setSearchText(text);
                EmiSearch.update();
            }));
            var settled = false;
            for (var t = 0; t < EMI_SETTLE_TICKS && !settled; t++) {
                try { Client.waitTick(1); } catch (_) {}
                settled = EmiSearch.compiledQuery !== before && EmiSearch.searchThread == null;
            }
            if (!settled) {
                respErr(id, "emi_search", "EMI search for '" + text + "' did not finish within " +
                    EMI_SETTLE_TICKS + " ticks (a slow client?) — no results rather than the unfiltered list; retry",
                    {text: text});
                return;
            }
            var out = [];
            try {
                var results = EmiSearch.stacks;
                var n = Math.min(results.size(), limit);
                for (var i = 0; i < n; i++) {
                    var stacks = results.get(i).getEmiStacks();
                    if (stacks.size() > 0) out.push("" + stacks.get(0).getId());
                }
            } catch (_e2) {}
            respFlat(id, "emi_search", {text: text, count: out.length, results: out});
    }, {where: "ext", desc: "EMI item search (headless): set search text → return matching item ids as data", params: [{name: "text", type: "string", required: true}, {name: "limit", type: "int", required: false}]});

    register("emi_recipe", function (req, id) { emiShow(req, id, false); },
        {where: "ext", desc: "EMI: open recipe GUI for what CRAFTS this item", params: [{name: "item", type: "string", required: true}]});
    register("emi_uses", function (req, id) { emiShow(req, id, true); },
        {where: "ext", desc: "EMI: open recipe GUI for where this item is USED", params: [{name: "item", type: "string", required: true}]});

    // ========================================================================
    // GTCEu prospector + ore markers. Reflection map (so nobody re-derives it):
    //  gtceu:prospector.hv opens a LowDragLib ModularUI; Hud.getOpenScreen()
    //  returns the RAW container (.getRaw() THROWS). screen.modularUI.mainGroup
    //  .widgets.get(0) == ProspectingMapWidget. Private fields (getDeclaredField
    //  +setAccessible): Set items = "material_gtceu:<name>" keys; ProspectingTexture
    //  texture -> Object[][][] data (per-cell vein grid). texture.playerXGui/
    //  playerYGui = player's CELL; grid is player-centred, ~1 block-column/cell →
    //  worldX = playerBlockX+(i-playerXGui), worldZ = playerBlockZ+(j-playerYGui),
    //  surface-projected X/Z (ore is underground). Scan is async: items.size()
    //  grows ~1s then holds (packetQueue/chunkIndex/scanTick are NOT done-signals).
    //  Open via KeyBind key.use; close via Escape SRG.keyPressed(KEY.ESCAPE).
    // ========================================================================
    var PROSPECT_ORE_GROUPS = {
        iron: ["iron", "pyrite", "hematite", "goethite", "yellow_limonite", "magnetite", "banded_iron"],
        copper: ["copper", "chalcopyrite", "malachite", "tetrahedrite"],
        coal: ["coal", "lignite"],
        tin: ["cassiterite", "cassiterite_sand"],
        redstone: ["redstone", "cinnabar"],
        diamond: ["diamond"],
        gold: ["gold"],
        silver: ["galena", "silver"],
        lead: ["galena", "lead"]
    };
    function fldOf(o, n) { var f = o.getClass().getDeclaredField(n); f.setAccessible(true); return f.get(o); }
    function prospectorWidget() {
        var s = Hud.getOpenScreen();
        if (!s || ("" + s.getClass().getName()).indexOf("ModularUI") < 0) return null;
        try { return s.modularUI.mainGroup.widgets.get(0); } catch (e) { return null; }
    }
    function appendMarkers(result) {
        var px = result.player[0], pz = result.player[2];
        var count = -1;
        var r = WS.update(worldSignature(), function (section) {
            var resources = section.resources;
            for (var ore in result.veins) {
                var v = result.veins[ore]; if (!v) continue;
                var dup = false;
                for (var m = 0; m < resources.length; m++) {
                    var e = resources[m];
                    if (e.kind === ore && Math.abs(e.x - v.x) <= 8 && Math.abs(e.z - v.z) <= 8) {
                        dup = true;
                        // Heal an old marker that predates footprint recording.
                        if (!e.bbox && v.bbox) e.bbox = v.bbox;
                        break;
                    }
                }
                // ResourceMarker shape (src/shared/domain/world-model.ts): {kind,x,z,bbox,...extra}.
                if (!dup) resources.push({kind: ore, x: v.x, z: v.z, cells: v.cells, bbox: v.bbox, from: [px, pz]});
            }
            section.resources = resources;
            count = resources.length;
        });
        return r.wrote ? count : -1;
    }
    function extractProspect(w, want) {
        var p = Player.getPlayer();
        var px = Math.floor(p.getX()), py = Math.floor(p.getY()), pz = Math.floor(p.getZ());
        var resources = [];
        var its = fldOf(w, "items").iterator();
        while (its.hasNext()) resources.push("" + its.next());
        var tex = fldOf(w, "texture");
        var data = fldOf(tex, "data");
        var gx = fldOf(tex, "playerXGui"), gy = fldOf(tex, "playerYGui");
        var wantList = null;
        if (want) wantList = (typeof want === "string") ? want.split(",") : want;
        var best = {}, cnt = {}, box = {}, g;
        for (g in PROSPECT_ORE_GROUPS) { best[g] = null; cnt[g] = 0; box[g] = null; }
        var nx = data.length, nz = data[0].length;
        for (var i = 0; i < nx; i++) for (var j = 0; j < nz; j++) {
            var cell = data[i][j]; if (!cell) continue;
            var names = {};
            for (var k = 0; k < cell.length; k++) {
                if (cell[k] != null) { var s = "" + cell[k]; var ci = s.indexOf(":"); names[ci >= 0 ? s.substring(ci + 1) : s] = 1; }
            }
            var wx = px + (i - gx), wz = pz + (j - gy), d = Math.abs(i - gx) + Math.abs(j - gy);
            for (g in PROSPECT_ORE_GROUPS) {
                var arr = PROSPECT_ORE_GROUPS[g];
                for (var a = 0; a < arr.length; a++) {
                    if (names[arr[a]]) {
                        cnt[g]++;
                        if (best[g] == null || d < best[g][2]) best[g] = [wx, wz, d];
                        // Footprint bbox [minX,minZ,maxX,maxZ] over this group's grid columns.
                        if (box[g] == null) box[g] = [wx, wz, wx, wz];
                        else { if (wx < box[g][0]) box[g][0] = wx; if (wz < box[g][1]) box[g][1] = wz; if (wx > box[g][2]) box[g][2] = wx; if (wz > box[g][3]) box[g][3] = wz; }
                        break;
                    }
                }
            }
        }
        var veins = {};
        for (g in PROSPECT_ORE_GROUPS) {
            if (wantList && wantList.indexOf(g) < 0) continue;
            veins[g] = best[g] ? {x: best[g][0], z: best[g][1], dist: best[g][2], cells: cnt[g], bbox: box[g]} : null;
        }
        var radius = 0; try { radius = fldOf(w, "chunkRadius"); } catch (e) {}
        return {ok: true, player: [px, py, pz], radius: radius, resources: resources, veins: veins};
    }
    // prospectorEnergy — read the hotbar GTCEu prospector's stored charge via GTCapabilityHelper
    // (same reflection as doProspect's energy guard, factored out). Returns {found, charge, max, pct}
    // where pct is 0..100 (-1 if unreadable). The proactive "is it about to die?" read so the AI can
    // charge it in a Turbo Charger (EU) BEFORE a discharged prospector silently fails to open.
    function prospectorEnergy() {
        var inv = Player.openInventory();
        var pStack = null, hot = -1;
        for (var sl = 36; sl <= 44; sl++) {
            var it = null; try { it = inv.getSlot(sl); } catch (e) {}
            if (it && ("" + it.getItemId()).indexOf("prospector") >= 0) { hot = sl - 36; pStack = it; break; }
        }
        if (!pStack) return {found: false};
        try {
            var GTH = Java.type("com.gregtechceu.gtceu.api.capability.GTCapabilityHelper");
            var ei = GTH.getElectricItem(pStack.getRaw());
            if (!ei) return {found: true, slot: hot, charge: -1, max: -1, pct: -1};
            var c = ei.getCharge(), m = ei.getMaxCharge();
            var pct = (m > 0) ? Math.round((c / m) * 100) : -1;
            return {found: true, slot: hot, charge: "" + c, max: "" + m, pct: pct};
        } catch (e) { return {found: true, slot: hot, charge: -1, max: -1, pct: -1, error: "" + (e.message || e)}; }
    }
    function doProspect(opts) {
        opts = opts || {};
        var w = prospectorWidget();
        if (!w) {
            // A blocking screen (DeathScreen / pause / inventory) swallows the right-click, so the
            // prospector GUI never opens — and the old "held item not a prospector?" message was
            // misleading. Detect it and say what's actually wrong (e.g. respawn first).
            try {
                var os = Hud.getOpenScreen();
                if (os) {
                    var osn = "" + os.getClass().getSimpleName();
                    return {ok: false, error: "a screen is open (" + osn + ") — close it / respawn before prospecting", screen: osn};
                }
            } catch (e) {}
            // Without GregTech CEu there is no prospector to hold: say that, not "no prospector in
            // hotbar", which reads as "go get one" (docs/PORTABILITY.md).
            try { Java.type("com.gregtechceu.gtceu.api.capability.GTCapabilityHelper"); }
            catch (e) { return {ok: false, error: "prospect needs GregTech CEu: " + (e.message || e)}; }
            var inv = Player.openInventory();
            var hot = -1, pStack = null;
            for (var sl = 36; sl <= 44; sl++) {
                var it = null; try { it = inv.getSlot(sl); } catch (e) {}
                if (it && ("" + it.getItemId()).indexOf("prospector") >= 0) { hot = sl - 36; pStack = it; break; }
            }
            if (hot < 0) return {ok: false, error: "no gtceu prospector in hotbar (slots 1-9)"};
            // Energy check FIRST — a discharged GTCEu prospector silently fails to open its GUI
            // (in-world "Not Enough Energy!"), which used to surface as a confusing "GUI did not
            // open". Report it clearly so the caller can recharge it (Turbo Charger, EU).
            try {
                var GTH = Java.type("com.gregtechceu.gtceu.api.capability.GTCapabilityHelper");
                var ei = GTH.getElectricItem(pStack.getRaw());
                if (ei && ei.getCharge() <= 0) {
                    return {ok: false, error: "prospector out of energy — recharge it",
                            charge: "" + ei.getCharge(), max: "" + ei.getMaxCharge()};
                }
            } catch (e) { /* not an electric item / API moved — fall through, GUI attempt still runs */ }
            // Select the prospector via the inventory API, NOT a synthetic `key.hotbar.N` press —
            // the keybind press is unreliable (doesn't always switch the held slot), which then
            // right-clicks the WRONG item and "fails to open". setSelectedHotbarSlotIndex is direct.
            try { inv.setSelectedHotbarSlotIndex(hot); } catch (e) {
                try { KeyBind.keyBind("key.hotbar." + (hot + 1), true); KeyBind.keyBind("key.hotbar." + (hot + 1), false); } catch (e2) {}
            }
            Client.waitTick(2);
            try { KeyBind.keyBind("key.use", true); } catch (e) {}
            Client.waitTick(2);
            try { KeyBind.keyBind("key.use", false); } catch (e) {}
            Client.waitTick(4);
            w = prospectorWidget();
            if (!w) return {ok: false, error: "prospector GUI did not open (held item not a prospector?)"};
        }
        var prev = -1, stable = 0, tries = 0;
        while (tries < 16 && stable < 2) {
            var n = 0; try { n = fldOf(w, "items").size(); } catch (e) {}
            if (n > 0 && n === prev) stable++; else stable = 0;
            prev = n;
            Client.waitTick(5);
            tries++;
            var w2 = prospectorWidget(); if (w2) w = w2;
        }
        var result = extractProspect(w, opts.want);
        result.markers = appendMarkers(result);
        // Proactive low-energy alert: surface the prospector's charge on EVERY successful scan, and
        // warn (response flag + chat) when it's getting low, so the operator charges it in a Turbo
        // Charger (EU) before it dies mid-loop. NOT a cheat refill — charging is the player's job.
        try {
            var en = prospectorEnergy();
            if (en && en.found && typeof en.pct === "number" && en.pct >= 0) {
                result.energyPct = en.pct;
                var lowAt = (typeof opts.lowPct === "number") ? opts.lowPct : 15;
                if (en.pct <= lowAt) {
                    result.low = true;
                    try { Chat.log("[miner] prospector LOW on energy (" + en.pct + "%) — charge it in a Turbo Charger (EU)"); } catch (e3) {}
                }
            }
        } catch (e2) {}
        if (!opts.keep_open) {
            Client.runOnMainThread(JavaWrapper.methodToJava(function () {
                try { var s = Hud.getOpenScreen(); if (s) { s[SRG.keyPressed](KEY.ESCAPE, 0, 0); if (typeof s[SRG.keyReleased] === "function") s[SRG.keyReleased](KEY.ESCAPE, 0, 0); } } catch (e) {}
            }));
        }
        return result;
    }

    defineCmd("prospect", function (req, id) {
            var r = doProspect({want: req.want, keep_open: req.keep_open === true});
            r.id = id; r.type = "prospect";
            writeResp(id, r);
    }, {where: "ext", desc: "run HV prospector: hold→scan→wait→extract veins as data→cache→close; returns resources + nearest vein per ore", params: [{name: "want", type: "string", required: false}, {name: "keep_open", type: "bool", required: false}]});

    // prospector_status — read-only proactive energy check (no GUI, no scan): returns the hotbar
    // prospector's stored charge/max + pct, so the AI/operator can recharge (Turbo Charger, EU) BEFORE a
    // discharged prospector silently fails to open. `low` flags pct ≤ threshold (default 15).
    register("prospector_status", function (req, id) {
        try {
            var en = prospectorEnergy();
            var lowAt = (typeof req.lowPct === "number") ? req.lowPct : 15;
            var low = en.found && typeof en.pct === "number" && en.pct >= 0 && en.pct <= lowAt;
            writeResp(id, {ok: true, type: "prospector_status", id: id, found: en.found === true,
                           charge: en.charge, max: en.max, pct: (typeof en.pct === "number" ? en.pct : -1),
                           low: low, slot: (typeof en.slot === "number" ? en.slot : -1)});
        } catch (e) {
            respErr(id, "prospector_status", "" + (e.message || e));
        }
    }, {where: "ext", desc: "read-only: hotbar prospector stored energy (charge/max/pct + low flag) — recharge before it dies", params: [{name: "lowPct", type: "int", required: false, desc: "low-energy threshold %, default 15"}]});

    // ========================================================================
    // tool_info — decode the held (or a hotbar slot's) tool/item NBT into readable
    // STATE + PROPERTIES, so the bot can reason about its tool the way it reads the
    // prospector's energy. GTCEu stows tool data in two NBT compounds:
    //   GT.Tool       — the immutable build (MaxDamage, HarvestLevel, ToolSpeed,
    //                   AttackDamage/Speed, enchant defaults)
    //   GT.Behaviours — per-stack behaviour config; the AoE keys live HERE
    //                   (MaxAoEColumn/Row/Layer + AoEColumn/Row/Layer). A bare
    //                   `/give` leaves this EMPTY → AoE [0,0,0] → 1-block breaks
    //                   (the diamond_mining_hammer gotcha).
    // Durability = vanilla getDamageValue/getMaxDamage; AoE = ToolHelper; energy
    // (electric drills/prospector) = GTCapabilityHelper.getElectricItem (charge/max/tier).
    // ========================================================================
    function aoeTriple(a) { return a ? [a.column, a.row, a.layer] : null; }
    function aoeShape(a) { // column/row/layer → human WxHxD (3x3 column = col1,row1,layer0)
        if (!a) return null;
        return (2 * a.column + 1) + "x" + (2 * a.row + 1) + "x" + (a.layer + 1);
    }
    function subTagString(tag, key) {
        try { if (tag && tag[srg("CompoundTag", "contains")](key)) return "" + tag[srg("CompoundTag", "getCompound")](key); } catch (e) {}
        return null;
    }
    function readToolState(raw) {
        var out = { item: "unknown" };
        try { out.item = "" + (new (Java.type("xyz.wagyourtail.jsmacros.client.api.helpers.inventory.ItemStackHelper"))(raw)).getItemId(); } catch (e) {}
        // durability (vanilla — works for any damageable item, GTCEu or not)
        try {
            if (raw[srg("ItemStack", "isDamageableItem")]()) {
                var dmg = raw[srg("ItemStack", "getDamageValue")]();
                var max = raw[srg("ItemStack", "getMaxDamage")]();
                out.durability = { damage: dmg, max: max, remaining: max - dmg, pct: max > 0 ? Math.round((max - dmg) / max * 1000) / 10 : null };
            } else { out.durability = null; }
        } catch (e) { out.durability = null; }
        // AoE (GTCEu tools only — reads the GT.Behaviours NBT; [0,0,0] = uninitialised/no AoE)
        try {
            var TH = Java.type("com.gregtechceu.gtceu.api.item.tool.ToolHelper");
            var cur = TH.getAoEDefinition(raw), mx = TH.getMaxAoEDefinition(raw);
            out.aoe = { current: aoeTriple(cur), max: aoeTriple(mx), shape: aoeShape(cur) };
        } catch (e) { out.aoe = null; }
        // electric charge (drills, prospector, … — null for a plain durability tool like the hammer)
        try {
            var GTH = Java.type("com.gregtechceu.gtceu.api.capability.GTCapabilityHelper");
            var ei = GTH.getElectricItem(raw);
            if (ei) {
                out.electric = { charge: "" + ei.getCharge(), maxCharge: "" + ei.getMaxCharge() };
                try { out.electric.tier = ei.getTier(); } catch (e2) {}
            } else { out.electric = null; }
        } catch (e) { out.electric = null; }
        // raw GTCEu compounds (the build stats + behaviour config), as readable strings
        try {
            var tag = raw[srg("ItemStack", "getTag")]();
            out.gtTool = subTagString(tag, "GT.Tool");
            out.gtBehaviours = subTagString(tag, "GT.Behaviours");
            out.nbt = tag ? "" + tag : null;
        } catch (e) { out.gtTool = out.gtBehaviours = out.nbt = null; }
        return out;
    }
    defineCmd("tool_info", function (req, id) {
            var inv = Player.openInventory();
            var hot = (req.slot != null) ? (req.slot | 0) : inv.getSelectedHotbarSlotIndex();
            var it = inv.getSlot(36 + hot);
            if (!it || it.isEmpty()) { respErr(id, "tool_info", "hotbar slot " + hot + " is empty"); return; }
            var state = readToolState(it.getRaw());
            state.ok = true; state.type = "tool_info"; state.id = id; state.slot = hot;
            writeResp(id, state);
    }, { where: "ext", desc: "decode held/slot tool NBT → durability + AoE (GT.Behaviours) + GTCEu stats (GT.Tool) + electric charge", params: [{ name: "slot", type: "int", required: false, desc: "hotbar index 0-8 (default: held)" }] });

    defineCmd("markers", function (req, id) {
            var sig = (req.sig != null) ? String(req.sig) : worldSignature();
            var section = worldSection(readWorldModel(), sig);
            var src = section.resources || [];
            var p = Player.getPlayer();
            var px = Math.floor(p.getX()), pz = Math.floor(p.getZ());
            var veins = [];
            for (var m = 0; m < src.length; m++) {
                var v = src[m];
                veins.push({kind: v.kind, x: v.x, z: v.z, cells: v.cells, from: v.from,
                    dist: Math.abs(v.x - px) + Math.abs(v.z - pz)});
            }
            if (req.ore) veins = veins.filter(function (v) { return v.kind === req.ore; });
            veins.sort(function (a, b) { return a.dist - b.dist; });
            if (req.near) veins = veins.slice(0, (typeof req.near === "number") ? req.near : 5);
            respFlat(id, "markers", {sig: sig, count: veins.length, veins: veins});
    }, {where: "ext", desc: "query accumulated ore markers (mc_world.json resources, current world) sorted by distance", params: [{name: "ore", type: "string", required: false, desc: "vein/ore kind filter"}, {name: "near", type: "int", required: false}, {name: "sig", type: "string", required: false, desc: "world signature; default = current world"}]});

    // ---- assign / unassign: the coordinator hub pushes a fleet assignment -----
    // The hub (fleet hub assignment, scripts/ops/fleet_hub.py) is a bridge CLIENT; it deconflicts bots by
    // pushing each one an XZ region to mine + the regions peers have claimed. We write the
    // assignment JSON into the mc_assignment GlobalVar; worker.js mirrors it into
    // __MC_ASSIGNMENT and the bundle's world.assignment() reads it (mine scan filters ore by
    // it). Shape MUST match src/core/runtime/types.ts FleetAssignment: {allowed:Box|null, forbidden:[Box]}.
    var ASSIGN_KEY = (globalThis.__MC_IPC && __MC_IPC.KEYS.world.assignment) || "mc_assignment";
    var normBox = function (b) {
        if (b === null || b === undefined) return null;
        var n = ["minX", "maxX", "minZ", "maxZ"].map(function (k) { return Number(b[k]); });
        if (n.some(function (v) { return !isFinite(v); })) throw new Error("box needs numeric minX/maxX/minZ/maxZ");
        return { minX: Math.min(n[0], n[1]), maxX: Math.max(n[0], n[1]), minZ: Math.min(n[2], n[3]), maxZ: Math.max(n[2], n[3]) };
    };
    // A claimedVeins/hazards entry is an X/Z column (+ optional kind on a hazard). Drop anything
    // non-numeric instead of failing the whole assign — a partial fleet picture beats none.
    var normCol = function (c, withKind) {
        var x = Number(c && c.x), z = Number(c && c.z);
        if (!isFinite(x) || !isFinite(z)) return null;
        var o = { x: Math.floor(x), z: Math.floor(z) };
        if (withKind) o.kind = String((c && c.kind) || "unknown");
        return o;
    };
    defineCmd("assign", function (req, id) {
            var allowed = req.allowed === undefined ? null : normBox(req.allowed);
            var forbidden = (req.forbidden || []).map(normBox).filter(function (b) { return b !== null; });
            var asg = { allowed: allowed, forbidden: forbidden };
            // Fleet-coordination extras (optional — an old hub payload just omits them):
            // claimedVeins = vein columns peers hold a lease on (drill skips near them);
            // hazards = the fleet-union drowned/ravine columns (scan/drill skip like their own).
            var claims = (req.claimedVeins || []).map(function (c) { return normCol(c, false); }).filter(function (c) { return c !== null; });
            var hazards = (req.hazards || []).map(function (c) { return normCol(c, true); }).filter(function (c) { return c !== null; });
            if (claims.length) asg.claimedVeins = claims;
            if (hazards.length) asg.hazards = hazards;
            GlobalVars.putString(ASSIGN_KEY, JSON.stringify(asg));
            respFlat(id, "assign", {assignment: asg});
    }, {where: "ext", desc: "push a fleet assignment (hub→bot, fleet hub assignment): XZ region this bot may mine + peer-claimed regions/veins to avoid + fleet-shared hazards", params: [{name: "allowed", type: "object", required: false, desc: "{minX,maxX,minZ,maxZ} or null=whole world"}, {name: "forbidden", type: "array", required: false, desc: "[{minX,maxX,minZ,maxZ}, …] peer claims to avoid"}, {name: "claimedVeins", type: "array", required: false, desc: "[{x,z}, …] vein columns peers are drilling (drill skips near them)"}, {name: "hazards", type: "array", required: false, desc: "[{kind,x,z}, …] fleet-union hazard columns (treated like own recorded hazards)"}]});

    defineCmd("unassign", function (req, id) {
            GlobalVars.putString(ASSIGN_KEY, "");          // blank → world.assignment() reads null = mine anywhere
            globalThis.__MC_ASSIGNMENT = "";               // clear the live mirror too (don't wait a tick)
            respFlat(id, "unassign", {cleared: true});
    }, {where: "ext", desc: "clear this bot's fleet assignment (mine anywhere again)", params: []});

    // ---- drawer_deposit: slot-aware Functional Storage drawer deposit -----
    // Drawers have NO item-deposit GUI: depositing IS a USE interaction whose target
    // SLOT is chosen by where the player LOOKS — DrawerBlock.getHit() re-raycasts the
    // eye vector against per-slot sub-boxes (it IGNORES the passed hitVec), then
    // DrawerTile.onSlotActivated assigns an empty slot's type or merges into a matching
    // one. The insert is server-authoritative, so the verify-read must come a tick LATER
    // (a same-tick read sees stale client state — live-confirmed). We aim at each slot's
    // quadrant centre (lookAt) then interactBlock; the whole held stack goes in.
    //   Geometry derived from DrawerBlock.CACHED_SHAPES + getHit ordering (see
    //   decompiled/functionalstorage-*/…/block/DrawerBlock.java + tile/DrawerTile.java):
    //   X_1 = whole face (slot 0); X_2 = vertical split (slot 0 bottom, 1 top); X_4 = 2x2,
    //   index order bottom-A, bottom-B, top-A, top-B with the A/B horizontal halves keyed
    //   by subfacing. Client tile IItemHandler is synced (drawers replicate contents for
    //   the count label) so getStackInSlot reads the route targets. Main-inventory stacks
    //   are staged into a free hotbar slot (swapHotbar) since only the held stack deposits.
    //   Live-proven: empty-assign + occupied-merge + quadrant aim all work.
    function drawerFacing(stateStr) {
        var m = ("" + stateStr).match(/subfacing=(\w+)/);
        return m ? m[1] : "north";
    }
    function drawerLocalPoint(f, h, v) {
        // h = horizontal-in-face (X for N/S, Z for E/W), v = vertical (Y). 0.03/0.97 = the
        // shallow slot box on the subfacing face.
        if (f === "south") return { x: h, y: v, z: 0.97 };
        if (f === "west") return { x: 0.03, y: v, z: h };
        if (f === "east") return { x: 0.97, y: v, z: h };
        return { x: h, y: v, z: 0.03 }; // north (default)
    }
    function drawerQuadrants(nSlots, f) {
        if (nSlots <= 1) return [drawerLocalPoint(f, 0.5, 0.5)];
        if (nSlots === 2) return [drawerLocalPoint(f, 0.5, 0.25), drawerLocalPoint(f, 0.5, 0.75)];
        // X_4 horizontal split order (A,B) per facing — from DrawerBlock's X_4 static block.
        var ab = { south: [0.75, 0.25], north: [0.25, 0.75], east: [0.25, 0.75], west: [0.75, 0.25] }[f] || [0.25, 0.75];
        var A = ab[0], B = ab[1];
        return [drawerLocalPoint(f, A, 0.25), drawerLocalPoint(f, B, 0.25), drawerLocalPoint(f, A, 0.75), drawerLocalPoint(f, B, 0.75)];
    }
    function readDrawer(x, y, z) {
        // Raw vanilla reads resolve through the srg() SSOT (srg_names.json), NOT inline
        // m_…_/f_…_ tokens (those read as `undefined` on a pack bump — the SRG-rot trap).
        // Minecraft.getInstance().level → the ClientLevel that owns the drawer tile.
        // getBlockState/getBlockEntity share one SRG id across the block-getter hierarchy;
        // the map records that id under RenderChunkRegion, so we key srg() on that class.
        // Item-stack reads go through the jsMacros ItemStackHelper facade (isEmpty/getCount
        // — SRG-free), same helper already used for getItemId below.
        var Minecraft = Java.type("net.minecraft.client.Minecraft");
        var MC = Minecraft[srg("Minecraft", "getInstance")]();
        var lvl = MC[srg("Minecraft", "level")];
        var bp = new (Java.type("net.minecraft.core.BlockPos"))(x, y, z);
        var st = lvl[srg("RenderChunkRegion", "getBlockState")](bp);
        var be = lvl[srg("RenderChunkRegion", "getBlockEntity")](bp);
        if (!be || ("" + be.getClass().getName()).indexOf("DrawerTile") < 0) return null;
        var h = be.getStorage(); // DrawerTile.getStorage() → IItemHandler (mod method, real name)
        var n = h.getSlots();
        var ISH = Java.type("xyz.wagyourtail.jsmacros.client.api.helpers.inventory.ItemStackHelper");
        var contents = [];
        for (var i = 0; i < n; i++) {
            var ish = new ISH(h.getStackInSlot(i));
            contents.push(ish.isEmpty() ? null : { id: "" + ish.getItemId(), count: ish.getCount() });
        }
        var f = drawerFacing(st);
        var offs = drawerQuadrants(n, f);
        var points = [];
        for (var j = 0; j < n; j++) points.push({ x: x + offs[j].x, y: y + offs[j].y, z: z + offs[j].z });
        return { n: n, facing: f, contents: contents, points: points };
    }

    defineCmd("drawer_deposit", function (req, id) {
            var pos = req.pos;
            if (!pos || pos.length < 3) { respErr(id, "drawer_deposit", "pos [x,y,z] required"); return; }
            var bx = Math.floor(pos[0]), by = Math.floor(pos[1]), bz = Math.floor(pos[2]);
            var d = readDrawer(bx, by, bz);
            if (!d) { respErr(id, "drawer_deposit", "no drawer at " + bx + "," + by + "," + bz); return; }

            var white = null;
            if (req.items) {
                white = {};
                var arr = Array.isArray(req.items) ? req.items : ("" + req.items).split(",");
                for (var w = 0; w < arr.length; w++) { var t = ("" + arr[w]).trim(); if (t) white[t] = 1; }
            }
            var KEEP = null;
            if (req.keep) {
                KEEP = {};
                var ka = Array.isArray(req.keep) ? req.keep : ("" + req.keep).split(",");
                for (var k = 0; k < ka.length; k++) { var kk = ("" + ka[k]).trim(); if (kk) KEEP[kk] = 1; }
            }

            var inv = Player.openInventory();
            function slotId(n) { try { var s = inv.getSlot(n); return s && !s.isEmpty() ? ("" + s.getItemId()) : null; } catch (e) { return null; } }

            // Local copy of drawer slot types, mutated as we assign empties so two different
            // items in one pass don't both claim the same empty slot.
            var dtype = []; for (var c = 0; c < d.n; c++) dtype.push(d.contents[c] ? d.contents[c].id : null);
            function targetSlotFor(itemId) {
                for (var i = 0; i < d.n; i++) if (dtype[i] === itemId) return i;          // merge into a matching slot
                for (var i2 = 0; i2 < d.n; i2++) if (dtype[i2] === null) { dtype[i2] = itemId; return i2; } // assign an empty
                return -1;                                                                 // drawer full of other types
            }
            function wants(itemId) {
                if (!itemId) return false;
                if (white) return !!white[itemId];
                if (KEEP && KEEP[itemId]) return false;
                if (itemId.indexOf("prospector") >= 0) return false; // never dump the scanner
                return true;
            }
            function doDeposit(tgt) {
                var pt = d.points[tgt];
                Player.getPlayer().lookAt(pt.x, pt.y, pt.z);
                Client.waitTick(1); // flush rotation to the server before its use-raycast
                Player.getInteractionManager().interactBlock(bx, by, bz, d.facing, false);
                Client.waitTick(2); // let the deposit settle before the next select/swap
            }

            var deposited = [], skipped = [];
            // Phase A: hotbar slots (36..44 = held-selectable directly, no staging).
            for (var hb = 0; hb < 9; hb++) {
                var iid = slotId(36 + hb);
                if (!wants(iid)) continue;
                var tgt = targetSlotFor(iid);
                if (tgt < 0) { skipped.push({ item: iid, why: "drawer full" }); continue; }
                inv.setSelectedHotbarSlotIndex(hb);
                Client.waitTick(1);
                doDeposit(tgt);
                deposited.push({ item: iid, slot: tgt });
            }
            // Phase B: main inventory (9..35) — stage into a free hotbar slot, then deposit.
            for (var mn = 9; mn <= 35; mn++) {
                var iid2 = slotId(mn);
                if (!wants(iid2)) continue;
                var tgt2 = targetSlotFor(iid2);
                if (tgt2 < 0) { skipped.push({ item: iid2, why: "drawer full" }); continue; }
                var free = -1;
                for (var fh = 0; fh < 9; fh++) { if (!slotId(36 + fh)) { free = fh; break; } }
                if (free < 0) { skipped.push({ item: iid2, why: "no free hotbar slot to stage" }); continue; }
                inv.swapHotbar(mn, free);
                Client.waitTick(1);
                inv.setSelectedHotbarSlotIndex(free);
                Client.waitTick(1);
                doDeposit(tgt2);
                deposited.push({ item: iid2, slot: tgt2 });
            }
            Client.waitTick(2);
            var after = readDrawer(bx, by, bz);
            respFlat(id, "drawer_deposit", {drawer: { n: d.n, facing: d.facing }, deposited: deposited, skipped: skipped, slots: after ? after.contents : null});
    }, { where: "ext", desc: "slot-aware deposit of inventory items into a Functional Storage drawer (X_1/2/4): routes each item to its matching slot or an empty one via look-aim + use; main-inv stacks staged via hotbar; verify-read deferred a tick. items=whitelist, keep=blacklist", params: [
        { name: "pos", type: "array", required: true, desc: "[x,y,z] of the drawer block" },
        { name: "items", type: "array|string", required: false, desc: "only deposit these ids (whitelist)" },
        { name: "keep", type: "array|string", required: false, desc: "never deposit these ids (used when no whitelist)" }
    ] });

    // ---- interact_place: headless "right-click a held item onto a block face" -----
    // The primitive form of the interact mission (src/bot/missions/interact) — the AI drives placement
    // directly (no nav, no FSM), like drawer_deposit. Put an item into a frame, drop it onto a
    // display/pedestal/showcase, flip a lever. Same server-authoritative verify as the drawer: the
    // insert applies a tick LATER, so we read the held-item count before, use, wait, then re-read.
    // verify: "consumed" (frames/displays take one from the held stack — the reliable signal, no
    // block-entity read needed) | "none" (dispatch only — levers/buttons). Face defaults to the side
    // pointing at the player (the reachable face); override with `face`. Geometry mirrors
    // domain/interact.ts (faceTowardBot / faceCenterPoint) so the primitive and the mission agree.
    var IP_OFFS = {
        up: { x: 0.5, y: 1.0, z: 0.5 }, down: { x: 0.5, y: 0.0, z: 0.5 },
        north: { x: 0.5, y: 0.5, z: 0.0 }, south: { x: 0.5, y: 0.5, z: 1.0 },
        east: { x: 1.0, y: 0.5, z: 0.5 }, west: { x: 0.0, y: 0.5, z: 0.5 }
    };
    function ipFaceToward(bx, bz) {
        var p = Player.getPlayer();
        if (!p) return "north";
        var dx = p.getX() - (bx + 0.5), dz = p.getZ() - (bz + 0.5);
        if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return "up";
        if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0 ? "east" : "west";
        return dz >= 0 ? "south" : "north";
    }
    defineCmd("interact_place", function (req, id) {
            var pos = req.pos;
            if (!pos || pos.length < 3) { respErr(id, "interact_place", "pos [x,y,z] required"); return; }
            var bx = Math.floor(pos[0]), by = Math.floor(pos[1]), bz = Math.floor(pos[2]);
            var face = req.face ? ("" + req.face).toLowerCase() : ipFaceToward(bx, bz);
            if (!IP_OFFS[face]) { respErr(id, "interact_place", "bad face '" + face + "' (up/down/north/south/east/west)"); return; }
            var item = req.item ? ("" + req.item) : null;
            var verify = req.verify === "none" ? "none" : (req.verify === "consumed" ? "consumed" : (item ? "consumed" : "none"));

            var inv = Player.openInventory();
            function slotId(n) { try { var s = inv.getSlot(n); return s && !s.isEmpty() ? ("" + s.getItemId()) : null; } catch (e) { return null; } }
            function countId(target) { var c = 0; for (var i = 0; i <= 44; i++) { if (slotId(i) === target) { try { var s = inv.getSlot(i); c += s ? s.getCount() : 0; } catch (e) {} } } return c; }

            // Equip the item if requested (hotbar → select; main-inv → stage into a free/held hotbar slot).
            var placeId = item;
            if (item) {
                var held = 36 + inv.getSelectedHotbarSlotIndex();
                if (slotId(held) !== item) {
                    var src = -1;
                    for (var i = 0; i <= 44; i++) { if (slotId(i) === item) { src = i; break; } }
                    if (src < 0) { respErr(id, "interact_place", "no " + item + " in inventory"); return; }
                    if (src >= 36) { inv.setSelectedHotbarSlotIndex(src - 36); }
                    else {
                        var free = -1;
                        for (var fh = 0; fh < 9; fh++) { if (!slotId(36 + fh)) { free = fh; break; } }
                        if (free < 0) free = inv.getSelectedHotbarSlotIndex();
                        inv.swapHotbar(src, free);
                        inv.setSelectedHotbarSlotIndex(free);
                    }
                    Client.waitTick(1);
                }
            } else {
                placeId = slotId(36 + inv.getSelectedHotbarSlotIndex());
            }

            var before = (verify === "consumed" && placeId) ? countId(placeId) : 0;
            var pt = IP_OFFS[face];
            Player.getPlayer().lookAt(bx + pt.x, by + pt.y, bz + pt.z);
            Client.waitTick(1); // flush rotation to the server before its use-raycast
            Player.getInteractionManager().interactBlock(bx, by, bz, face, false);
            Client.waitTick(4); // let the interaction settle (server-authoritative) before verify

            var placed = true, after = before;
            if (verify === "consumed" && placeId) { after = countId(placeId); placed = after < before; }
            respFlat(id, "interact_place", {placed: placed, verify: verify, face: face, item: placeId, before: before, after: after});
    }, { where: "ext", desc: "right-click a held item onto a block face (item frame / display / pedestal / lever). Aims the face centre (default: side toward the player) + interactBlock; verify=consumed (a held stack dropped — frames/displays) or none (dispatch only). The headless primitive of the interact mission.", params: [
        { name: "pos", type: "array", required: true, desc: "[x,y,z] of the target block" },
        { name: "item", type: "string", required: false, desc: "item id to hold + place (default: keep held)" },
        { name: "face", type: "string", required: false, desc: "up/down/north/south/east/west (default: toward the player)" },
        { name: "verify", type: "string", required: false, desc: "consumed | none (default: consumed if item given, else none)" }
    ] });

    // ---- interact_entity: headless "right-click a held item onto an ENTITY" -----
    // The entity counterpart of interact_place — vanilla item frames (and armor stands etc.) are
    // ENTITIES, unreachable via interactBlock. ext runs in main.js's context where entity reads
    // are NOT pinned, so it can discover directly: target by uuid, or nearest type-matching
    // entity near pos (default type filter: item_frame). interactEntity(EntityHelper, offhand)
    // is the attack(entity) mirror — jar-confirmed 1.9.2 signature. Same deferred `consumed`
    // verify as interact_place (an empty frame absorbs 1 from the held stack).
    defineCmd("interact_entity", function (req, id) {
            // NB: req.type is the bridge ENVELOPE field (the command name) — the entity-type
            // filter must use its own key (`entity`), or it reads "interact_entity" itself.
            var typeFilter = req.entity ? ("" + req.entity) : "item_frame";
            var target = null;
            var ents = World.getEntities();
            if (req.uuid) {
                var want = "" + req.uuid;
                for (var i = 0; i < ents.size(); i++) {
                    var e = ents.get(i);
                    var u = ""; try { u = "" + e.getUUID(); } catch (_u) {}
                    if (u === want) { target = e; break; }
                }
                if (!target) { respErr(id, "interact_entity", "entity " + want + " not found"); return; }
            } else if (req.pos && req.pos.length >= 3) {
                var tx = req.pos[0] + 0.5, ty = req.pos[1] + 0.5, tz = req.pos[2] + 0.5;
                var bestD = (typeof req.radius === "number" ? req.radius : 2.0);
                for (var j = 0; j < ents.size(); j++) {
                    var e2 = ents.get(j);
                    var et = "" + e2.getType();
                    if (et.indexOf(typeFilter) < 0) continue;
                    var dx = e2.getX() - tx, dy = e2.getY() - ty, dz = e2.getZ() - tz;
                    var d = Math.sqrt(dx * dx + dy * dy + dz * dz);
                    if (d <= bestD) { bestD = d; target = e2; }
                }
                if (!target) { respErr(id, "interact_entity", "no '" + typeFilter + "' entity within " + (typeof req.radius === "number" ? req.radius : 2.0) + " of " + req.pos.join(",")); return; }
            } else {
                respErr(id, "interact_entity", "uuid or pos [x,y,z] required"); return;
            }

            var inv = Player.openInventory();
            function slotId(n) { try { var s = inv.getSlot(n); return s && !s.isEmpty() ? ("" + s.getItemId()) : null; } catch (e) { return null; } }
            function countId(t) { var c = 0; for (var i = 0; i <= 44; i++) { if (slotId(i) === t) { try { var s = inv.getSlot(i); c += s ? s.getCount() : 0; } catch (e) {} } } return c; }

            var item = req.item ? ("" + req.item) : null;
            var verify = req.verify === "none" ? "none" : (req.verify === "consumed" ? "consumed" : (item ? "consumed" : "none"));
            var placeId = item;
            if (item) {
                var held = 36 + inv.getSelectedHotbarSlotIndex();
                if (slotId(held) !== item) {
                    var src = -1;
                    for (var k = 0; k <= 44; k++) { if (slotId(k) === item) { src = k; break; } }
                    if (src < 0) { respErr(id, "interact_entity", "no " + item + " in inventory"); return; }
                    if (src >= 36) { inv.setSelectedHotbarSlotIndex(src - 36); }
                    else {
                        var free = -1;
                        for (var fh = 0; fh < 9; fh++) { if (!slotId(36 + fh)) { free = fh; break; } }
                        if (free < 0) free = inv.getSelectedHotbarSlotIndex();
                        inv.swapHotbar(src, free);
                        inv.setSelectedHotbarSlotIndex(free);
                    }
                    Client.waitTick(1);
                }
            } else {
                placeId = slotId(36 + inv.getSelectedHotbarSlotIndex());
            }

            var before = (verify === "consumed" && placeId) ? countId(placeId) : 0;
            Player.getPlayer().lookAt(target.getX(), target.getY() + 0.3, target.getZ());
            Client.waitTick(1); // flush rotation before the server-side interaction
            Player.getInteractionManager().interactEntity(target, false);
            Client.waitTick(4); // server-authoritative — settle before verify
            var placed = true, after = before;
            if (verify === "consumed" && placeId) { after = countId(placeId); placed = after < before; }
            var tu = ""; try { tu = "" + target.getUUID(); } catch (_tu) {}
            respFlat(id, "interact_entity", {placed: placed, verify: verify, item: placeId, uuid: tu, entity: "" + target.getType(), before: before, after: after});
    }, { where: "ext", desc: "right-click a held item onto an ENTITY (vanilla item frame / armor stand — unreachable via interact_place's block path). Target by uuid, or nearest type-matching entity near pos (type default item_frame). verify=consumed (held stack dropped) or none.", params: [
        { name: "uuid", type: "string", required: false, desc: "target entity uuid (wins over pos)" },
        { name: "pos", type: "array", required: false, desc: "[x,y,z] block cell — nearest matching entity within radius" },
        { name: "entity", type: "string", required: false, desc: "entity-type substring filter (default 'item_frame'; NOT `type` — that's the envelope field)" },
        { name: "radius", type: "number", required: false, desc: "pos search radius (default 2.0)" },
        { name: "item", type: "string", required: false, desc: "item id to hold + place (default: keep held)" },
        { name: "verify", type: "string", required: false, desc: "consumed | none (default: consumed if item given, else none)" }
    ] });

    // ---- storage-network discovery (the configured base registry) ---------
    // The kernel-native storage mission (src/bot/missions/storage) reads the `storages`
    // section of mc_world.json to smart-route deposits. THESE write it (hybrid: auto-scan +
    // manual add/remove). DRAWER contents are recorded live (readDrawer — client-synced);
    // chests/barrels record kind+pos only (their contents are server-only and never synced to a
    // headless client, so it cannot read them) — their recorded contents fill in as the bot
    // deposits / a future open-and-read. ext/scan owns this section; the worker reads it (read-only).
    function containerKindAt(bid) {
        if (bid.indexOf("chest") >= 0 && bid.indexOf("ender") < 0) return "chest";
        if (bid.indexOf("barrel") >= 0) return "barrel";
        return null; // drawers are detected via readDrawer (block-entity), not the id
    }
    function mergeStorages(found) {
        var added = 0, updated = 0, total = 0;
        var r = WS.update(worldSignature(), function (section) {
            var storages = section.storages || [];
            for (var f = 0; f < found.length; f++) {
                var e = found[f], idx = -1;
                for (var i = 0; i < storages.length; i++) {
                    if (storages[i].x === e.x && storages[i].y === e.y && storages[i].z === e.z) { idx = i; break; }
                }
                if (idx < 0) { storages.push(e); added++; continue; }
                var ex = storages[idx]; // keep an existing chest's recorded memory unless the scan has fresher
                var merged = { kind: e.kind, x: e.x, y: e.y, z: e.z };
                if (e.facing || ex.facing) merged.facing = e.facing || ex.facing;
                if (e.slots || ex.slots) merged.slots = e.slots || ex.slots;
                if (e.recorded !== undefined) merged.recorded = e.recorded;
                else if (ex.recorded !== undefined) merged.recorded = ex.recorded;
                // Preserve the loot-run looted ledger across re-scans — a roam-and-rescan must NOT
                // un-mark an already-looted (per-player) chest, or the bot re-loots it. (loot-run
                // writes looted/lootedTick on the worker side; the scanner only re-confirms the block.)
                if (ex.looted) { merged.looted = ex.looted; if (ex.lootedTick != null) merged.lootedTick = ex.lootedTick; }
                storages[idx] = merged; updated++;
            }
            section.storages = storages;
            total = storages.length;
        });
        return r.wrote ? { added: added, updated: updated, total: total } : null;
    }

    defineCmd("storage_scan", function (req, id) {
            var r = (typeof req.radius === "number") ? Math.min(16, Math.max(1, req.radius >> 0)) : 6;
            var hgt = (typeof req.height === "number") ? Math.min(8, Math.max(1, req.height >> 0)) : 4;
            var p = Player.getPlayer();
            var px = Math.floor(p.getX()), py = Math.floor(p.getY()), pz = Math.floor(p.getZ());
            var found = [];
            for (var dx = -r; dx <= r; dx++) for (var dz = -r; dz <= r; dz++) for (var dy = -hgt; dy <= hgt; dy++) {
                var x = px + dx, y = py + dy, z = pz + dz;
                var b = World.getBlock(x, y, z); if (!b) continue;
                var bid = "" + b.getId();
                var kind = null, entry = { x: x, y: y, z: z };
                if (bid.indexOf("functionalstorage") >= 0) {
                    var d = readDrawer(x, y, z);
                    if (d) { kind = "drawer"; entry.facing = d.facing; entry.slots = d.n; entry.recorded = d.contents; }
                }
                if (!kind) kind = containerKindAt(bid);
                if (!kind) continue;
                entry.kind = kind;
                found.push(entry);
            }
            var res = mergeStorages(found);
            writeResp(id, res
                ? { ok: true, type: "storage_scan", id: id, found: found.length, added: res.added, updated: res.updated, total: res.total, storages: found }
                : { ok: false, type: "storage_scan", id: id, error: "write failed", found: found.length });
    }, { where: "ext", desc: "scan a cube around the bot for containers (drawers/chests/barrels) and register them in mc_world.json storages (drawer contents recorded live). Hybrid discovery — pair with storage_add/storage_remove", params: [
        { name: "radius", type: "int", required: false, desc: "horizontal scan radius (default 6, max 16)" },
        { name: "height", type: "int", required: false, desc: "vertical scan range ± (default 4, max 8)" }
    ] });

    defineCmd("storage_add", function (req, id) {
            var pos = req.pos;
            if (!pos || pos.length < 3) { respErr(id, "storage_add", "pos [x,y,z] required"); return; }
            var x = Math.floor(pos[0]), y = Math.floor(pos[1]), z = Math.floor(pos[2]);
            var entry = { x: x, y: y, z: z, kind: req.kind ? ("" + req.kind) : null };
            var d = readDrawer(x, y, z);
            if (d) { entry.kind = "drawer"; entry.facing = d.facing; entry.slots = d.n; entry.recorded = d.contents; }
            else if (!entry.kind) { entry.kind = containerKindAt("" + (World.getBlock(x, y, z) ? World.getBlock(x, y, z).getId() : "")); }
            if (!entry.kind) { respErr(id, "storage_add", "not a known container at " + x + "," + y + "," + z + " — pass kind="); return; }
            if (req.facing) entry.facing = "" + req.facing;
            var res = mergeStorages([entry]);
            writeResp(id, res ? { ok: true, type: "storage_add", id: id, entry: entry, total: res.total } : { ok: false, type: "storage_add", id: id, error: "write failed" });
    }, { where: "ext", desc: "manually register one container in the storage network (auto-detects drawer kind/facing; pass kind/facing to override)", params: [
        { name: "pos", type: "array", required: true, desc: "[x,y,z] of the container block" },
        { name: "kind", type: "string", required: false, desc: "drawer|chest|barrel|container (auto for drawers)" },
        { name: "facing", type: "string", required: false, desc: "drawer face override: north|south|east|west" }
    ] });

    defineCmd("storage_remove", function (req, id) {
            var byAll = !!req.all, x, y, z;
            if (!byAll) {
                var pos = req.pos;
                if (!pos || pos.length < 3) { respErr(id, "storage_remove", "pos [x,y,z] or all=true required"); return; }
                x = Math.floor(pos[0]); y = Math.floor(pos[1]); z = Math.floor(pos[2]);
            }
            var removed = 0, total = 0;
            var r = WS.update(worldSignature(), function (section) {
                var storages = section.storages || [];
                if (byAll) { removed = storages.length; section.storages = []; total = 0; return; }
                var out = [];
                for (var i = 0; i < storages.length; i++) {
                    if (storages[i].x === x && storages[i].y === y && storages[i].z === z) removed++;
                    else out.push(storages[i]);
                }
                section.storages = out;
                total = out.length;
            });
            writeResp(id, r.wrote
                ? { ok: true, type: "storage_remove", id: id, removed: removed, total: total }
                : { ok: false, type: "storage_remove", id: id, error: "write failed" });
    }, { where: "ext", desc: "remove a container from the storage network by position (or all=true to clear the registry)", params: [
        { name: "pos", type: "array", required: false, desc: "[x,y,z] to remove" },
        { name: "all", type: "bool", required: false, desc: "clear the entire registry for this world" }
    ] });

    defineCmd("storage_list", function (req, id) {
            var section = worldSection(readWorldModel(), worldSignature());
            respFlat(id, "storage_list", {storages: section.storages || []});
    }, { where: "ext", desc: "list the registered storage-network containers for the current world", params: [] });

    // ---- grid: ASCII slice of the world (X-ray for the AI) ----------------
    // Dump a 2D block grid as TEXT so the bot/AI can "see" structure — shafts,
    // bridges, veins, terrain — as DATA instead of a murky screenshot, and reason
    // about it directly. Pure World.getBlock reads (no SRG). axis "xz" = top-down
    // (default), "xy"/"zy" = vertical profiles with high-Y on top (best for shafts /
    // bridges). air='.', any *_ore='O', the bot's cell(s)='@'; other ids get a
    // dynamic legend char. Bounded (radius ≤20) so the reply stays small.
    defineCmd("grid", function (req, id) {
            var p = Player.getPlayer();
            var bx = Math.floor(p.getX()), by = Math.floor(p.getY()), bz = Math.floor(p.getZ());
            var axis = (req.axis === "xy" || req.axis === "zy") ? req.axis : "xz";
            var r = (typeof req.radius === "number") ? Math.min(20, Math.max(1, req.radius)) : 8;
            var AIR = { "minecraft:air": 1, "minecraft:cave_air": 1, "minecraft:void_air": 1 };
            var legend = {}, used = {}, pool = "#%=+*XSTUVWYZabcdefghijkmnpqrstuvwz".split(""), pi = 0;
            var charFor = function (idStr, isBot) {
                if (isBot) return "@";
                if (AIR[idStr]) return ".";
                if (idStr.indexOf("ore") >= 0) return "O";
                if (used[idStr]) return used[idStr];
                var c = pool[pi++ % pool.length];
                used[idStr] = c; legend[c] = idStr;
                return c;
            };
            var rows = [], header = "", level;
            if (axis === "xz") {
                level = (typeof req.y === "number") ? req.y : by;
                for (var z = bz - r; z <= bz + r; z++) {
                    var line = "";
                    for (var x = bx - r; x <= bx + r; x++) {
                        var b = World.getBlock(x, level, z);
                        line += charFor(b ? b.getId() : "minecraft:air", x === bx && z === bz);
                    }
                    rows.push(line);
                }
                header = "xz top-down @ y=" + level + " | cols x " + (bx - r) + "→" + (bx + r) + " | rows z " + (bz - r) + "→" + (bz + r);
            } else {
                var ry = (typeof req.h === "number") ? Math.min(20, Math.max(1, req.h)) : r;
                level = (axis === "xy") ? ((typeof req.z === "number") ? req.z : bz)
                                        : ((typeof req.x === "number") ? req.x : bx);
                for (var y = by + ry; y >= by - ry; y--) {
                    var line2 = "";
                    for (var c2 = -r; c2 <= r; c2++) {
                        var X = (axis === "xy") ? (bx + c2) : level;
                        var Z = (axis === "xy") ? level : (bz + c2);
                        var b2 = World.getBlock(X, y, Z);
                        var botCol = (axis === "xy") ? (bx + c2 === bx) : (bz + c2 === bz);
                        line2 += charFor(b2 ? b2.getId() : "minecraft:air", botCol && (y === by || y === by + 1));
                    }
                    rows.push(line2);
                }
                header = axis + " profile @ " + (axis === "xy" ? "z=" : "x=") + level +
                    " | rows y " + (by + ry) + "→" + (by - ry) + " | cols " + (axis === "xy" ? "x" : "z") +
                    " " + (-r) + "→+" + r + " | bot@y" + by;
            }
            respFlat(id, "grid", {axis: axis, bot: [bx, by, bz], header: header, grid: rows, legend: legend});
    }, { where: "ext", desc: "ASCII block-slice of the world (X-ray): axis xz=top-down (default), xy/zy=vertical profile; air=. ore=O bot=@, dynamic legend for the rest", params: [
        { name: "axis", type: "string", required: false, desc: "xz (top-down, default) | xy | zy (vertical profiles)" },
        { name: "radius", type: "int", required: false, desc: "in-plane half-size (default 8, max 20)" },
        { name: "y", type: "int", required: false, desc: "xz: the Y level (default bot feet)" },
        { name: "z", type: "int", required: false, desc: "xy: the fixed Z (default bot)" },
        { name: "x", type: "int", required: false, desc: "zy: the fixed X (default bot)" },
        { name: "h", type: "int", required: false, desc: "vertical: Y half-height (default = radius)" }
    ] });

    // ---- FTB Essentials + fast teleport (mod-API primitives) -------------
    // FTB Essentials owns the commands (all enabled in this pack); these are thin TYPED,
    // documented wrappers over chat so the AI/bot gets validation + a real ack instead of
    // blind passthrough. tp_waypoint is the fast-travel win: skip a long Baritone walk and
    // land at a saved waypoint / nearest vein. NOTE: teleports are fire-and-forget (the
    // render-thread watchdog forbids waiting here) — they return the from/to so the caller
    // verifies the move (get_state position / facade_smoke), mirroring the kernel's
    // TELEPORT_NO_MOVE verify-convention.
    function ftbSay(cmd) { Chat.say(cmd); return cmd; }

    register("warp", function (req, id) {
        if (!req.name) { respErr(id, "warp", "missing 'name'"); return; }
        respFlat(id, "warp", {sent: ftbSay("/warp " + req.name)});
    }, {where: "ext", desc: "FTB Essentials /warp <name> — fast travel to a named warp", params: [{name: "name", type: "string", required: true}]});

    register("sethome", function (req, id) {
        respFlat(id, "sethome", {sent: ftbSay("/sethome" + (req.name ? (" " + req.name) : ""))});
    }, {where: "ext", desc: "FTB Essentials /sethome [name] — set a home at the current position", params: [{name: "name", type: "string", required: false}]});

    register("go_base", function (req, id) {
        var name = req.name ? String(req.name) : "base";
        writeResp(id, {ok: true, type: "go_base", id: id, name: name, sent: ftbSay("/home " + name),
            note: "fire-and-forget; verify move via get_state. Set the base first with sethome {name:'base'} while standing at it."});
    }, {where: "ext", desc: "FTB Essentials /home <name> — teleport to the bot's saved base home (default name 'base'). Fire-and-forget — verify the move.", params: [{name: "name", type: "string", required: false}]});

    register("spawn", function (req, id) {
        respFlat(id, "spawn", {sent: ftbSay("/spawn")});
    }, {where: "ext", desc: "FTB Essentials /spawn — teleport to world spawn", params: []});

    register("rtp", function (req, id) {
        respFlat(id, "rtp", {sent: ftbSay("/rtp")});
    }, {where: "ext", desc: "FTB Essentials /rtp — random teleport", params: []});

    // Resolve a teleport target {x,y,z,label} from: explicit coords | a named waypoint |
    // the nearest vein of an ore kind. Veins store only x/z → land at the player's current
    // Y (above the column; the bot digs down).
    function resolveTpTarget(req, p, section) {
        var py = Math.floor(p.getY());
        if (req.x != null && req.z != null) {
            return {x: Math.floor(req.x), y: (req.y != null ? Math.floor(req.y) : py), z: Math.floor(req.z), label: "coords"};
        }
        if (req.name) {
            var wps = section.waypoints || [];
            for (var i = 0; i < wps.length; i++) {
                if (wps[i].name === req.name) return {x: wps[i].x, y: wps[i].y, z: wps[i].z, label: "waypoint:" + req.name};
            }
            throw new Error("no waypoint named '" + req.name + "'");
        }
        var px = Math.floor(p.getX()), pz = Math.floor(p.getZ());
        var src = section.resources || [], best = null, bd = 1e9;
        for (var m = 0; m < src.length; m++) {
            var v = src[m];
            if (req.ore && v.kind !== req.ore) continue;
            var d = Math.abs(v.x - px) + Math.abs(v.z - pz);
            if (d < bd) { bd = d; best = v; }
        }
        if (!best) throw new Error("no vein" + (req.ore ? " of kind '" + req.ore + "'" : "") + " in the marker cache");
        return {x: best.x, y: py, z: best.z, label: "vein:" + best.kind};
    }

    defineCmd("tp_waypoint", function (req, id) {
            var p = Player.getPlayer();
            var section = worldSection(readWorldModel(), worldSignature());
            var from = [Math.floor(p.getX()), Math.floor(p.getY()), Math.floor(p.getZ())];
            var t = resolveTpTarget(req, p, section);
            Chat.say("/tp " + t.x + " " + t.y + " " + t.z);
            writeResp(id, {ok: true, type: "tp_waypoint", id: id, from: from, to: [t.x, t.y, t.z],
                label: t.label, note: "fire-and-forget; verify move via get_state / facade_smoke"});
    }, {where: "ext", desc: "fast-teleport: {x,z[,y]} coords | {name} waypoint | {ore} nearest vein (vanilla /tp; veins land at current Y). Fire-and-forget — verify the move.", params: [{name: "name", type: "string", required: false}, {name: "ore", type: "string", required: false}, {name: "x", type: "int", required: false}, {name: "y", type: "int", required: false}, {name: "z", type: "int", required: false}]});

    // ---- JourneyMap waypoint sync (make the bot's finds visible to the human) ----
    // Mirrors the bot's named waypoints + discovered veins from the world model into JM via
    // the NATIVE API (mkWaypoint + WaypointStore.add/save below) — live + persisted, no relog.
    // Idempotent: JM keys by id (its own name_x-y-z scheme), so re-syncing overwrites.
    // The jmWaypoint/jmDir helpers below build the equivalent on-disk JSON (icon + colorizedIcon
    // + iconColor + customIconColor are REQUIRED or the manager flickers) — kept for reference /
    // a file-based fallback, but the live path is the API.
    function jmDir() {
        var base = Java.type("java.lang.System").getProperty("user.dir");
        var sp = Paths.get(base, "journeymap", "data", "sp");
        if (!Files.exists(sp)) throw new Error("no JourneyMap sp data dir: " + sp);
        // Singleplayer save dir = the most-recently-modified child of .../sp/.
        var best = null, bestT = -1, it = Files.list(sp).iterator();
        while (it.hasNext()) {
            var d = it.next();
            if (!Files.isDirectory(d)) continue;
            var t = Files.getLastModifiedTime(d).toMillis();
            if (t > bestT) { bestT = t; best = d; }
        }
        if (!best) throw new Error("no save dir under " + sp);
        var wp = best.resolve("waypoints");
        Files.createDirectories(wp);
        return wp;
    }
    function jmColor(kind) {
        if (kind === "home") return [80, 200, 120];
        if (kind === "dump") return [120, 160, 255];
        if (kind === "vein" || kind === "ore") return [255, 200, 60];
        return [255, 255, 255];
    }
    // JM's own waypoint id/filename: name_x,y,z with runs of non-word/non-letter chars → "-"
    // (CommonConstants.getCSSSafeString, regex [^\w\p{L}]+; javap journeymap-5.10.3). Match it
    // so re-writes overwrite JM's file instead of duplicating — JM rebuilds the id from `name`
    // on save (dropping any prefix), so an old "miner_"-prefixed id would become a second copy.
    function jmId(name, x, y, z) {
        return (name + "_" + x + "," + y + "," + z).replace(/[^\w\p{L}]+/gu, "-");
    }
    function jmWaypoint(name, x, y, z, dim, kind) {
        var c = jmColor(kind);
        var argb = ((0xff << 24) | (c[0] << 16) | (c[1] << 8) | c[2]) | 0; // opaque ARGB, signed 32-bit
        return {
            id: jmId(name, x, y, z), name: name,
            icon: "journeymap:ui/img/waypoint-icon.png",
            colorizedIcon: "fake:color-" + argb + "-waypoint-icon.png", x: x, y: y, z: z,
            r: c[0], g: c[1], b: c[2], enable: true, type: "Normal", origin: "gerda-bot",
            dimensions: [dim], persistent: true, showDeviation: false,
            iconColor: -1, customIconColor: false
        };
    }
    // Live-reload JourneyMap's waypoint list from disk so bot-written waypoint files
    // show up WITHOUT a relog. JM only scans the waypoints folder at world load; reset()
    // invalidates its cache + re-reads the folder (when the waypoint manager is enabled).
    // Not SRG-remapped (real mod names). Derived via javap journeymap-1.20.1-5.10.3-forge:
    // WaypointStore.INSTANCE.reset() clears the cache and ends in load(). (= /jm wpreload.)
    function jmRefresh() {
        var WS = Java.type("journeymap.client.waypoint.WaypointStore").INSTANCE;
        WS.reset();
        return WS.getAll().size();
    }
    defineCmd("journeymap_sync", function (req, id) {
            var dim = "minecraft:overworld";
            try { dim = "" + World.getDimension(); } catch (_) {}
            var section = worldSection(readWorldModel(), worldSignature());
            var WS = wpStore(), written = 0; // native API: add()+save() = live + persisted
            var wps = section.waypoints || [];
            for (var i = 0; i < wps.length; i++) {
                var w = wps[i], nm = w.name || ("wp_" + w.x + "_" + w.z);
                var jw = mkWaypoint(nm, w.x, (w.y != null ? w.y : 64), w.z, dim, w.kind || "custom");
                WS.add(jw); WS.save(jw, true); written++;
            }
            var res = section.resources || [];
            for (var m = 0; m < res.length; m++) {
                var v = res[m], vn = (v.kind || "vein") + "_" + v.x + "_" + v.z;
                var vw = mkWaypoint(vn, v.x, 64, v.z, dim, "vein");
                WS.add(vw); WS.save(vw, true); written++;
            }
            writeResp(id, {ok: true, type: "journeymap_sync", id: id,
                written: written, waypoints: wps.length, veins: res.length, count: WS.getAll().size(),
                note: "synced live via the native API — visible on the map now"});
    }, {where: "ext", desc: "mirror the bot's waypoints + discovered veins into JourneyMap as visible waypoints (writes journeymap/data/sp/<save>/waypoints/<id>.json, JM's own id scheme) + live-refresh", params: []});

    defineCmd("jm_refresh", function (req, id) {
            writeResp(id, {ok: true, type: "jm_refresh", id: id, loaded: jmRefresh(),
                note: "JourneyMap waypoints reloaded from disk (no relog needed)"});
    }, {where: "ext", desc: "live-reload JourneyMap's waypoint list from disk (WaypointStore.reset) so bot-written waypoints appear without a relog", params: []});

    // ---- JourneyMap waypoints via the NATIVE API (no file write, no reload) ----
    // WaypointStore.add()/remove() mutate JM's live in-memory store + persist to disk, so the
    // change is visible IMMEDIATELY (vs journeymap_sync which writes files then reset()s). This
    // is the preferred path. Derived via javap journeymap-1.20.1-5.10.3-forge: ctor
    // Waypoint(String name, BlockPos, java.awt.Color, Waypoint$Type, String DIMENSION, boolean
    // persistent) — note arg 5 is the dimension, NOT origin (set origin via setOrigin). add()
    // caches by getId(); save(wp,true) flushes to disk; remove(wp,true) deletes. Not SRG.
    function wpStore() { return Java.type("journeymap.client.waypoint.WaypointStore").INSTANCE; }
    function mkWaypoint(name, x, y, z, dim, kind) {
        var WP = Java.type("journeymap.client.waypoint.Waypoint");
        var BlockPos = Java.type("net.minecraft.core.BlockPos");
        var Color = Java.type("java.awt.Color");
        var Type = Java.type("journeymap.client.waypoint.Waypoint$Type");
        var c = jmColor(kind);
        var w = new WP(name, new BlockPos(x, y, z), new Color(c[0], c[1], c[2]), Type.Normal, dim, true);
        try { w.setOrigin("gerda-bot"); } catch (e) {}
        return w;
    }
    defineCmd("wp_add", function (req, id) {
            var name = ("" + (req.name || "")).trim();
            if (!name) throw new Error("name required");
            if (req.x == null || req.z == null) throw new Error("x and z required");
            var x = Math.floor(req.x), z = Math.floor(req.z);
            var y = (req.y != null) ? Math.floor(req.y) : Math.floor(Player.getPlayer().getY());
            var dim = (req.dim != null) ? ("" + req.dim) : ("" + World.getDimension());
            var WS = wpStore(), w = mkWaypoint(name, x, y, z, dim, req.kind || "custom");
            WS.add(w); WS.save(w, true);
            writeResp(id, {ok: true, type: "wp_add", id: id, count: WS.getAll().size(),
                wp: {name: name, x: x, y: y, z: z, dim: dim, id: "" + w.getId()}, note: "added live (no relog)"});
    }, {where: "ext", desc: "add a JourneyMap waypoint live via the native API (WaypointStore.add) — visible immediately, no file/reload. dim defaults to current, y to player Y, kind sets color", params: [{name: "name", type: "string", required: true}, {name: "x", type: "int", required: true}, {name: "z", type: "int", required: true}, {name: "y", type: "int", required: false}, {name: "kind", type: "string", required: false}, {name: "dim", type: "string", required: false}]});

    defineCmd("wp_remove", function (req, id) {
            var name = ("" + (req.name || "")).trim();
            if (!name) throw new Error("name required");
            var WS = wpStore(), kill = [], it = WS.getAll().iterator();
            while (it.hasNext()) { var w = it.next(); if (("" + w.getName()) === name) kill.push(w); }
            for (var i = 0; i < kill.length; i++) WS.remove(kill[i], true);
            respFlat(id, "wp_remove", {removed: kill.length, count: WS.getAll().size()});
    }, {where: "ext", desc: "remove JourneyMap waypoint(s) by name via the native API (WaypointStore.remove) — immediate", params: [{name: "name", type: "string", required: true}]});

    defineCmd("wp_list", function (req, id) {
            var WS = wpStore(), out = [], it = WS.getAll().iterator();
            while (it.hasNext()) {
                var w = it.next();
                out.push({name: "" + w.getName(), x: w.getX(), y: w.getY(), z: w.getZ(),
                    dim: "" + w.getDimensions(), origin: "" + w.getOrigin()});
            }
            respFlat(id, "wp_list", {count: out.length, waypoints: out});
    }, {where: "ext", desc: "list JourneyMap waypoints live (from WaypointStore.getAll)", params: []});

    // ---- recipe: resolve a craft recipe as DATA via EMI -------------------
    // EMI sees the pack's actual recipes (Monifactory overrides included). Returns,
    // per matching recipe: the grid (row-major item ids, null = empty cell, EMI's
    // flattened display size), the cell count, the output stack, and (opt-in) ingredient
    // alternatives. The mission plane can't call the bridge, so the OFFLINE resolver
    // (scripts/dev/resolve_craft_chain.py) consumes this — recursing the craft DAG and
    // emitting the {grid, times}[] chain the craft mission accepts — instead of hardcoded
    // layouts. Pure registry reads (no GUI / main thread).
    defineCmd("recipe", function (req, id) {
            var item = (req.item != null) ? String(req.item) : "";
            if (!item) { respErr(id, "recipe", "item required"); return; }
            var limit = (typeof req.limit === "number") ? req.limit : 5;
            var craftOnly = req.craftOnly !== false; // default: only crafting-table recipes
            var wantAlts = req.alts === true;        // alts EXPLODE for wood recipes — opt-in + capped
            var ALT_CAP = 6;
            var EmiApi = Java.type("dev.emi.emi.api.EmiApi");
            var EmiStack = Java.type("dev.emi.emi.api.stack.EmiStack");
            var ItemStackHelper = Java.type("xyz.wagyourtail.jsmacros.client.api.helpers.inventory.ItemStackHelper");
            var stack = EmiStack.of(new ItemStackHelper(item, 1).getRaw());
            var list = EmiApi.getRecipeManager().getRecipesByOutput(stack);
            // EMI uses "minecraft:air" / "emi:empty" / "" for blank grid cells.
            function idOf(s) { try { var r = "" + s.getId(); return (r === "minecraft:air" || r === "emi:empty" || r === "") ? null : r; } catch (e) { return null; } }
            var out = [];
            for (var i = 0; i < list.size() && out.length < limit; i++) {
                var r = list.get(i);
                var cat = "";
                try { cat = "" + r.getCategory().getId(); } catch (e) {}
                if (craftOnly && cat.indexOf("crafting") < 0) continue;
                var inputs = r.getInputs(), grid = [], alts = [], cells = inputs.size();
                // Grid is too big for a 3×3 hand-craft (e.g. a machine recipe) — skip if craftOnly.
                if (craftOnly && cells > 9) continue;
                for (var k = 0; k < cells; k++) {
                    var ess = inputs.get(k).getEmiStacks();
                    var cell = null, opt = [];
                    for (var a = 0; a < ess.size(); a++) { var sid = idOf(ess.get(a)); if (sid) { opt.push(sid); if (opt.length >= ALT_CAP) break; } }
                    if (opt.length > 0) cell = opt[0];
                    grid.push(cell);
                    if (wantAlts) alts.push(opt);
                }
                var outId = item, outCount = 1;
                try { var os = r.getOutputs(); if (os.size() > 0) { var oid = idOf(os.get(0)); if (oid) outId = oid; outCount = Number(os.get(0).getAmount()) || 1; } } catch (e) {}
                var rec = {id: "" + r.getId(), category: cat, cells: cells, grid: grid, output: {id: outId, count: outCount}};
                if (wantAlts) rec.alts = alts;
                out.push(rec);
            }
            respFlat(id, "recipe", {item: item, count: out.length, recipes: out});
    }, {where: "ext", desc: "resolve craft recipe(s) for an item as DATA via EMI (grid + ingredients + output) — headless, pack-correct; feeds scripts/dev/resolve_craft_chain.py", params: [
        {name: "item", type: "string", required: true},
        {name: "limit", type: "int", required: false, desc: "max recipes (default 5)"},
        {name: "craftOnly", type: "bool", required: false, desc: "only crafting-table ≤3×3 recipes (default true)"},
        {name: "alts", type: "bool", required: false, desc: "include per-cell ingredient alternatives (capped; default false — they explode for wood)"}
    ]});

    // ---- read_chat: read recent received chat lines as data ----------------
    // For seeing in-game messages / errors over the bridge (e.g. via MCP, when host
    // log access isn't handy). Newest first. NB: MC's logs/latest.log ALSO captures
    // [CHAT] lines + WARN/ERROR host-side, which is usually the richer source.
    defineCmd("read_chat", function (req, id) {
            var n = (typeof req.lines === "number") ? req.lines : 20;
            var filter = req.filter ? String(req.filter).toLowerCase() : null;
            var lines = Chat.getHistory().getRecvLines();
            var out = [];
            for (var i = 0; i < lines.size() && out.length < n; i++) {
                var txt = "";
                try { txt = "" + lines.get(i).getText().getString(); } catch (e) { try { txt = "" + lines.get(i); } catch (_) {} }
                if (filter && txt.toLowerCase().indexOf(filter) < 0) continue;
                out.push(txt);
            }
            respFlat(id, "read_chat", {total: lines.size(), count: out.length, lines: out});
    }, {where: "ext", desc: "read recent received chat lines as data (newest first, optional substring filter)", params: [
        {name: "lines", type: "int", required: false, desc: "max lines (default 20)"},
        {name: "filter", type: "string", required: false, desc: "case-insensitive substring filter"}
    ]});

    // ---- reflect: generic API-exploration tool ----------------------------
    // Evaluate ANY expression and dump its runtime class — method signatures
    // (params + return types), public fields, optional name filter, and optional
    // recursion into member types. Generalizes the fixed `introspect` command:
    //   reflect {expr:"Player.openInventory()"}                  → all methods+fields
    //   reflect {expr:"Player.openInventory()", filter:"craft"}  → just craft* members
    //   reflect {expr:"Player.getPlayer()", depth:1}             → + member types one level deep
    //   reflect {expr:"Java.type('dev.emi.emi.api.recipe.EmiRecipe')"}  → a class's methods
    // `expr` runs in this plugin's scope (full Java/jsMacros: Java, World, Player, …).
    defineCmd("reflect", function (req, id) {
            var expr = req.expr;
            if (!expr) { respErr(id, "reflect", "missing expr"); return; }
            var filter = req.filter ? String(req.filter).toLowerCase() : null;
            var wantSig = req.sig !== false;       // default: include signatures
            var wantFields = req.fields !== false; // default: include public fields
            var wantMojang = req.mojang !== false; // default: annotate SRG names with Mojang names
            var srgMap = wantMojang ? srgNames() : null;
            var depth = (typeof req.depth === "number") ? Math.max(0, Math.min(2, req.depth)) : 0;

            function simple(t) { try { return t.getSimpleName(); } catch (e) { return "?"; } }
            function pass(name) { return !filter || name.toLowerCase().indexOf(filter) >= 0; }
            // Match the filter against the SRG name OR its Mojang annotation, so `filter:"Rot"`
            // finds m_146922_ →setYRot (not just clean-named members like kjs$setRotation).
            function passM(name, moj) {
                if (!filter) return true;
                if (name.toLowerCase().indexOf(filter) >= 0) return true;
                return !!(moj && String(moj).toLowerCase().indexOf(filter) >= 0);
            }
            // A Java type-wrapper (Java.type(...)) exposes `.class`; an instance has getClass().
            function classOf(v) {
                if (v === null || v === undefined) return null;
                try { if (v.class && v.class.getMethods) return v.class; } catch (e) {}
                try { if (v.getClass) return v.getClass(); } catch (e) {}
                return null;
            }

            var seen = {};
            function dump(cls, lvl, into) {
                if (!cls) return;
                var cn; try { cn = cls.getName(); } catch (e) { return; }
                if (seen[cn]) return;
                seen[cn] = true;
                var entry = {class: cn, methods: [], fields: []};
                var childTypes = [];
                try {
                    var ms = cls.getMethods(), mseen = {};
                    for (var i = 0; i < ms.length; i++) {
                        var m = ms[i], nm = m.getName();
                        var moj = mojOf(srgMap, nm);
                        if (!passM(nm, moj)) continue;
                        var sig;
                        if (wantSig) {
                            var ps = m.getParameterTypes(), pn = [];
                            for (var j = 0; j < ps.length; j++) pn.push(simple(ps[j]));
                            var rt = m.getReturnType();
                            sig = nm + "(" + pn.join(",") + "):" + simple(rt);
                            if (depth > lvl) childTypes.push(rt);
                        } else { sig = nm; }
                        if (moj) sig += " →" + moj;
                        if (!mseen[sig]) { mseen[sig] = true; entry.methods.push(sig); }
                    }
                    entry.methods.sort();
                    if (entry.methods.length > 400) entry.methods = entry.methods.slice(0, 400).concat(["…(truncated)"]);
                } catch (e) { entry.methods = ["ERR:" + (e.message || e)]; }
                if (wantFields) {
                    try {
                        var fs = cls.getFields();
                        for (var k = 0; k < fs.length; k++) {
                            var fn = fs[k].getName();
                            var fmoj = mojOf(srgMap, fn);
                            if (!passM(fn, fmoj)) continue;
                            var ft = fs[k].getType();
                            entry.fields.push(fn + ":" + simple(ft) + (fmoj ? " →" + fmoj : ""));
                            if (depth > lvl) childTypes.push(ft);
                        }
                        entry.fields.sort();
                    } catch (e) { entry.fields = ["ERR:" + (e.message || e)]; }
                }
                into.push(entry);
                if (depth > lvl) {
                    for (var c = 0; c < childTypes.length; c++) {
                        var ct = childTypes[c];
                        try {
                            if (ct.isPrimitive && ct.isPrimitive()) continue;
                            var ctn = ct.getName();
                            if (ctn.indexOf("java.") === 0 || ctn.indexOf("[") === 0) continue;
                            dump(ct, lvl + 1, into);
                        } catch (e) {}
                    }
                }
            }

            var v = eval(expr); // direct eval — sees Java/World/Player/… in this scope
            var cls = classOf(v);
            if (!cls) { respErr(id, "reflect", "expr did not yield a reflectable object/class", {value: String(v)}); return; }
            var out = [];
            dump(cls, 0, out);
            respFlat(id, "reflect", {target: out.length ? out[0].class : null, count: out.length, classes: out});
    }, {where: "ext", desc: "reflect any expression's runtime class — method signatures, fields, optional recursion (API-exploration tool, generalizes introspect)", params: [
        {name: "expr", type: "string", required: true, desc: "JS expr evaluated in ext scope, e.g. \"Player.openInventory()\""},
        {name: "filter", type: "string", required: false, desc: "case-insensitive substring filter on member names OR their Mojang annotation (e.g. \"Rot\" finds m_146922_ →setYRot)"},
        {name: "sig", type: "bool", required: false, desc: "include param/return signatures (default true)"},
        {name: "fields", type: "bool", required: false, desc: "include public fields (default true)"},
        {name: "mojang", type: "bool", required: false, desc: "annotate SRG names (m_…/f_…) with Mojang names via srg_names.json (default true)"},
        {name: "depth", type: "int", required: false, desc: "recurse into member types this many levels (0-2, default 0)"}
    ]});

    // ---- quests: read-only FTB Quests live status (objective-engine adapter) ----
    // The objective engine's FTB adapter merges this LIVE status with the offline
    // SNBT graph (chapters/*.snbt → items/counts/deps/titles); so this primitive
    // returns ONLY status — per-quest completion, dependency-readiness, unclaimed
    // rewards, and per-task type+completion. Pure client-side read (no render thread).
    //   quests {}                  → every chapter's quests
    //   quests {chapter:"genesis"} → one chapter (by filename)
    //   quests {quest:"66FC…"}     → one quest (16-hex id, case-insensitive)
    // FTB Quests (Forge 2001.4.x) classes are NOT SRG-remapped — real names. Surface
    // locked via `reflect` (docs/EXTENDING.md § SRG-mapping workflow): ClientQuestFile.INSTANCE.{getAllChapters,
    // selfTeamData}; Chapter.{getFilename,getQuests}; Quest/Task.{getCodeString,
    // getTasksAsList,getType().getTypeId()}; TeamData.{isCompleted(QuestObject),
    // areDependenciesComplete(Quest),hasUnclaimedRewards(UUID,QuestObject)}.
    // IDs come from getCodeString() (Java-side hex) — NEVER read the `long id` field
    // into JS (>2^53 loses precision). TaskType id = "ftbquests:item" → split ":".
    defineCmd("quests", function (req, id) {
            var CQF = Java.type("dev.ftb.mods.ftbquests.client.ClientQuestFile").INSTANCE;
            if (!CQF) { respErr(id, "quests", "ClientQuestFile not loaded (in a world?)"); return; }
            var td = CQF.selfTeamData;
            if (!td) { respErr(id, "quests", "no selfTeamData (quests not synced yet)"); return; }
            var uuid = null;
            try { uuid = java.util.UUID.fromString("" + Player.getPlayer().getUUID()); } catch (e) {}
            var wantChapter = req.chapter ? String(req.chapter).toLowerCase() : null;
            var wantQuest = req.quest ? String(req.quest).toUpperCase() : null;

            var quests = [], completed = [], available = [];
            var chapters = CQF.getAllChapters();
            for (var ci = 0; ci < chapters.size(); ci++) {
                var ch = chapters.get(ci);
                var fname = "" + ch.getFilename();
                if (wantChapter && fname.toLowerCase() !== wantChapter) continue;
                var qs = ch.getQuests();
                for (var qi = 0; qi < qs.size(); qi++) {
                    var q = qs.get(qi);
                    var qhex = ("" + q.getCodeString()).toUpperCase();
                    if (wantQuest && qhex !== wantQuest) continue;
                    var done = false, canStart = true, unclaimed = false;
                    try { done = !!td.isCompleted(q); } catch (e) {}
                    try { canStart = !!td.areDependenciesComplete(q); } catch (e) {}
                    if (uuid) { try { unclaimed = !!td.hasUnclaimedRewards(uuid, q); } catch (e) {} }
                    var tasks = [], tl = q.getTasksAsList();
                    for (var ti = 0; ti < tl.size(); ti++) {
                        var t = tl.get(ti), ttype = "?";
                        try { var rl = "" + t.getType().getTypeId(); ttype = rl.indexOf(":") >= 0 ? rl.split(":")[1] : rl; } catch (e) {}
                        var tdone = false; try { tdone = !!td.isCompleted(t); } catch (e) {}
                        tasks.push({id: ("" + t.getCodeString()).toUpperCase(), type: ttype, complete: tdone});
                    }
                    var title = ""; try { title = "" + q.getRawTitle(); } catch (e) {}
                    quests.push({id: qhex, chapter: fname, title: title, complete: done, can_start: canStart, unclaimed: unclaimed, tasks: tasks});
                    if (done) completed.push(qhex); else if (canStart) available.push(qhex);
                }
            }
            respFlat(id, "quests", {data: {count: quests.length, completed: completed, available: available, quests: quests}});
    }, {where: "ext", desc: "read-only FTB Quests live status (completion/deps/unclaimed per quest+task) — the objective engine's FTB status feed", params: [
        {name: "chapter", type: "string", required: false, desc: "filter by chapter filename (e.g. 'genesis')"},
        {name: "quest", type: "string", required: false, desc: "filter to one quest by 16-hex id (case-insensitive)"}
    ]});

    // ---- count_item: total of an item id across the WHOLE inventory ---------
    // The `inventory` summary lists only the hotbar; the acquisition layer needs the
    // full-bag total to decide have/mine/craft and to know when a gather step is done.
    // Read-only: iterates carry slots (9..44) via jsMacros' Inventory helper.
    defineCmd("count_item", function (req, id) {
            if (!req.item) { respErr(id, "count_item", "need 'item'"); return; }
            var want = String(req.item);
            var inv = Player.openInventory();
            var total = 0;
            for (var s = 9; s <= 44; s++) {
                var it = null; try { it = inv.getSlot(s); } catch (e) {}
                if (it && ("" + it.getItemId()) === want) { try { total += it.getCount(); } catch (e) {} }
            }
            respFlat(id, "count_item", {data: {item: want, count: total}});
    }, {where: "ext", desc: "read-only: total count of an item id across the whole carry inventory (hotbar + main)", params: [
        {name: "item", type: "string", required: true, desc: "item id, e.g. minecraft:iron_ingot"}
    ]});

    // ---- use_item: equip an item to the hand and right-click (key.use) ------
    // Equips `item` (search hotbar, else swap from main into hotbar slot 1), selects it,
    // optionally pitches the view down (look_down: degrees) so a placeable lands in front,
    // then taps key.use `clicks` times. ONE short tap by default — a long hold would block
    // the handler thread past the 500ms EventLockWatchdog (which kills the handler and can drop the world).
    // For TelePastries cakes: place the cake (look_down + use) then eat a slice (use on it).
    defineCmd("use_item", function (req, id) {
            var want = req.item ? String(req.item) : null;
            var inv = Player.openInventory();
            if (want) {
                var hot = -1;
                for (var sl = 36; sl <= 44; sl++) { var it = null; try { it = inv.getSlot(sl); } catch (e) {} if (it && ("" + it.getItemId()) === want) { hot = sl - 36; break; } }
                if (hot < 0) {
                    var src = -1;
                    for (var s = 9; s <= 35; s++) { var it2 = null; try { it2 = inv.getSlot(s); } catch (e) {} if (it2 && ("" + it2.getItemId()) === want) { src = s; break; } }
                    if (src < 0) { respErr(id, "use_item", "item not in inventory: " + want); return; }
                    try { inv.swap(src, 37); } catch (e) {}  // 37 = hotbar slot index 1
                    hot = 1;
                }
                var hk = "key.hotbar." + (hot + 1);
                try { KeyBind.keyBind(hk, true); KeyBind.keyBind(hk, false); } catch (e) {}
                Client.waitTick(2);
            }
            if (typeof req.look_down === "number") {
                try {
                    var p = Player.getPlayer();
                    p.lookAt(p.getYaw(), Math.max(-90, Math.min(90, req.look_down)));
                } catch (e) {}
                Client.waitTick(2);
            }
            var clicks = (typeof req.clicks === "number") ? Math.max(1, Math.min(8, req.clicks)) : 1;
            for (var c = 0; c < clicks; c++) {
                try { KeyBind.keyBind("key.use", true); } catch (e) {}
                Client.waitTick(2);
                try { KeyBind.keyBind("key.use", false); } catch (e) {}
                Client.waitTick(3);
            }
            var dim = ""; try { dim = "" + World.getDimension(); } catch (e) {}
            respFlat(id, "use_item", {data: {item: want, clicks: clicks, dimension: dim}});
    }, {where: "ext", desc: "equip an item to the hand and tap key.use (right-click); optional look_down pitch + repeat clicks", params: [
        {name: "item", type: "string", required: false, desc: "item id to equip first (else uses held)"},
        {name: "look_down", type: "number", required: false, desc: "pitch degrees (e.g. 80 to aim at the ground before placing)"},
        {name: "clicks", type: "int", required: false, desc: "how many short right-clicks (default 1)"}
    ]});

    // ---- quest_complete / quest_claim: MUTATING FTB Quests actions ----------
    // quest_complete submits task(s) via SubmitTaskMessage — for `item` tasks the SERVER
    // verifies inventory possession (legal: not item-spawning; not consumed when the
    // task's consume_items is false). quest_claim claims ONLY the named quest's rewards
    // (one ClaimRewardMessage per reward) — NEVER all quests: this save has ~270
    // completed-but-unclaimed quests and claim-all would flood/overflow the inventory.
    // IDs are 16-hex unsigned longs — always rebuild the
    // long in Java via Long.parseUnsignedLong(getCodeString(),16); NEVER read the `long
    // id` field into JS (>2^53 loses precision). Surface verified via `reflect`.
    function _ftbQuest(hex) {
        var CQF = Java.type("dev.ftb.mods.ftbquests.client.ClientQuestFile").INSTANCE;
        if (!CQF) throw new Error("ClientQuestFile not loaded (in a world?)");
        return CQF.getQuest(java.lang.Long.parseUnsignedLong(String(hex), 16));
    }

    defineCmd("quest_complete", function (req, id) {
            var Submit = Java.type("dev.ftb.mods.ftbquests.net.SubmitTaskMessage");
            var L = java.lang.Long;
            var sent = [];
            if (req.task) {
                new Submit(L.parseUnsignedLong(String(req.task), 16)).sendToServer();
                sent.push(String(req.task).toUpperCase());
            } else if (req.quest) {
                var q = _ftbQuest(req.quest);
                if (!q) { respErr(id, "quest_complete", "quest not found: " + req.quest); return; }
                var tl = q.getTasksAsList();
                for (var i = 0; i < tl.size(); i++) {
                    var code = "" + tl.get(i).getCodeString();
                    new Submit(L.parseUnsignedLong(code, 16)).sendToServer();
                    sent.push(code.toUpperCase());
                }
            } else {
                respErr(id, "quest_complete", "need 'task' or 'quest'"); return;
            }
            respFlat(id, "quest_complete", {data: {submitted: sent}});
    }, {where: "ext", desc: "MUTATING: submit FTB quest task(s) (SubmitTaskMessage). Item tasks need the item already in inventory (legal, not consumed when consume_items=false)", params: [
        {name: "task", type: "string", required: false, desc: "16-hex task id (submit just this task)"},
        {name: "quest", type: "string", required: false, desc: "16-hex quest id (submit all its tasks)"}
    ]});

    defineCmd("quest_claim", function (req, id) {
            if (!req.quest) { respErr(id, "quest_claim", "need 'quest'"); return; }
            var Claim = Java.type("dev.ftb.mods.ftbquests.net.ClaimRewardMessage");
            var L = java.lang.Long;
            var q = _ftbQuest(req.quest);
            if (!q) { respErr(id, "quest_claim", "quest not found: " + req.quest); return; }
            var rw = q.getRewards(), it = rw.iterator(), claimed = [];
            while (it.hasNext()) {
                var code = "" + it.next().getCodeString();
                new Claim(L.parseUnsignedLong(code, 16), true).sendToServer();
                claimed.push(code.toUpperCase());
            }
            respFlat(id, "quest_claim", {data: {quest: String(req.quest).toUpperCase(), claimed: claimed}});
    }, {where: "ext", desc: "MUTATING: claim ONLY the named quest's rewards (ClaimRewardMessage per reward). Never claims other quests' rewards", params: [
        {name: "quest", type: "string", required: true, desc: "16-hex quest id whose rewards to claim"}
    ]});

    // ---- ore_registry: the LIVE ore-block list straight from the Forge registry ---------
    // The config ore set is DERIVED from the running game (via
    // scripts/dev/extract_ores_live.py → config/ores_live.json → build-time import into
    // cfg.ore.ids via src/bot/profile/pack.ts), not a static GitHub-source scrape. Two sources, unioned:
    //   1) the `forge:ores` block tag — the modded convention; GTCEu tags every ore variant;
    //   2) an id-suffix scan (path ends "_ore") for ore blocks a mod forgot to tag.
    // Pure Forge registry API (net.minecraftforge.registries.*) — NOT obfuscated, no srg()
    // needed; registries are frozen after mod-load → safe to read off the render thread.
    defineCmd("ore_registry", function (req, id) {
            var FR = Java.type("net.minecraftforge.registries.ForgeRegistries");
            var RL = Java.type("net.minecraft.resources.ResourceLocation");
            var seen = {};                       // id → "tag" | "name" | "both"
            var tagged = 0, byName = 0;
            var tags = FR.BLOCKS.tags();
            var ti = tags.getTag(tags.createTagKey(new RL("forge", "ores"))).iterator();
            while (ti.hasNext()) {
                seen["" + FR.BLOCKS.getKey(ti.next())] = "tag";
                tagged++;
            }
            var ki = FR.BLOCKS.getKeys().iterator();
            while (ki.hasNext()) {
                var kid = "" + ki.next();
                var path = kid.substring(kid.indexOf(":") + 1);
                if (path.length > 4 && path.lastIndexOf("_ore") === path.length - 4) {
                    if (seen[kid]) { seen[kid] = "both"; } else { seen[kid] = "name"; byName++; }
                }
            }
            var ids = Object.keys(seen);
            if (req.namespace) {
                var pre = String(req.namespace) + ":";
                ids = ids.filter(function (s) { return s.indexOf(pre) === 0; });
            }
            ids.sort();
            // Harvest tiers: every block tag whose path matches needs_<material>_tool (the
            // vanilla/Forge harvest-level convention — mods incl. GTCEu register theirs the
            // same way) → which of OUR ore ids it contains. Shipped as raw tag names per id;
            // the extractor maps material→rank host-side, so a new modded tier needs no ext
            // change. getTagNames() is a java Stream — .iterator() works (BaseStream).
            // TagKey is a vanilla record → its accessor location() is SRG (f_203868_).
            var tierLoc = srg("TagKey", "location");
            var toolTags = {};
            var tierTagCount = 0;
            var tierError = null;
            try {
                var tni = tags.getTagNames().iterator();
                while (tni.hasNext()) {
                    var tk = tni.next();
                    var tloc = "" + tk[tierLoc]();
                    var tpath = tloc.substring(tloc.indexOf(":") + 1);
                    if (!/^needs_.+_tool$/.test(tpath)) continue;
                    tierTagCount++;
                    var mi = tags.getTag(tk).iterator();
                    while (mi.hasNext()) {
                        var bid = "" + FR.BLOCKS.getKey(mi.next());
                        if (!seen[bid]) continue;
                        (toolTags[bid] = toolTags[bid] || []).push(tloc);
                    }
                }
            } catch (e2) { tierError = "" + (e2.message || e2); /* tiers are best-effort — the ore list is still the payload */ }
            writeResp(id, { ok: true, type: "ore_registry", id: id, count: ids.length,
                sources: { tag: tagged, nameOnly: byName, tierTags: tierTagCount, tierError: tierError },
                ids: ids, tool_tags: toolTags });
    }, { where: "ext", desc: "LIVE ore-block ids from the Forge registry (forge:ores tag ∪ *_ore id scan) — the generator behind config/ores_live.json", params: [
        { name: "namespace", type: "string", required: false, desc: "filter to one mod namespace (e.g. gtceu)" }
    ] });

    // =======================================================================
    // CINEMA CAMERA (film rig) — cam_pose / cam_aim / cam_look_at / cam_free /
    // cam_spectate / cam_hud / cam_state.
    // =======================================================================
    // These belong on the CAMERA client (an OP spectator, bridge 55546), never on a
    // worker bot: cam_pose/cam_spectate issue vanilla op commands, and a bot must stay
    // non-op (docs/FLEET_PLAYBOOK.md § 1).
    //
    // WHY a per-FRAME Forge hook and not setRotation per tick: LocalPlayer overrides
    // getViewXRot/getViewYRot and hands the camera the RAW angle with no partialTick lerp
    // (pitch never lerps; yaw only while isPassenger). A once-per-tick rotation therefore
    // steps at 20 Hz on video. Forge's ViewportEvent.ComputeCameraAngles is posted every
    // FRAME from GameRenderer.renderLevel, offers setYaw/setPitch/setRoll, overrides the
    // LocalPlayer angle, and does NOT move the player entity (the server sees no rotation,
    // so nothing about the bot's world changes because we filmed it).
    //
    // Registration gotcha: MinecraftForge.EVENT_BUS.addListener(Consumer) throws
    // "Failed to resolve handler" for a jsMacros MethodWrapper — Forge's TypeResolver
    // cannot infer the event class from its class-level type var. The explicit-Class
    // overload addListener(priority, receiveCancelled, EventClass, consumer) skips the
    // resolver entirely, so that is the one we use.
    //
    // The callback runs on the RENDER thread ~60-144×/s, so its body is PURE ARITHMETIC
    // over numbers seeded by the commands below — no world scans, no IO, no sleeps (the
    // EventLockWatchdog kills a handler that blocks >500 ms, and can drop the world with
    // it). Camera→target angles are computed in the COMMAND, not in the hook; the hook
    // only eases the current angle toward the stored one, which is what makes a 4 Hz
    // host-side update stream (scripts/demo/shoot.py) look like continuous motion.
    //
    // State lives on globalThis so `reload_ext` re-evaluating this file does NOT add a
    // second listener (addListener returns void in 1.20.1 — there is no handle to
    // unregister). We mutate the SAME object the live closure captured.
    var CAM = globalThis.__MC_CAM;
    if (!CAM) {
        CAM = globalThis.__MC_CAM = {
            hooked: false,   // Forge listener registered (once per JVM)
            mode: "off",     // off = vanilla control; aim = hold the stored angle
            frames: 0,       // proves the hook fires at FPS, not tick rate
            yaw: 0, pitch: 0, roll: 0,          // current (eased) angles
            wantYaw: 0, wantPitch: 0,            // target angles
            smooth: 1,       // per-frame ease factor, (0..1]; 1 = snap
            error: null,     // registration failure, surfaced by cam_state
        };
    }

    // shortest signed distance between two yaw angles (deg), so a pan across ±180 does
    // not take the 359° way round
    function camWrap(d) { return ((d + 540) % 360) - 180; }

    function camEnsureHook() {
        if (CAM.hooked) return true;
        try {
        var FBus = Java.type("net.minecraftforge.common.MinecraftForge").EVENT_BUS;
        var Ev = Java.type("net.minecraftforge.client.event.ViewportEvent$ComputeCameraAngles");
        var Prio = Java.type("net.minecraftforge.eventbus.api.EventPriority");
        // Math.fround on every setter: these take a Java float and GraalJS refuses a
        // double→float narrowing it considers lossy.
        // DEBT (docs/RIG.md, Film § 0): addListener returns void in 1.20.1 — there is
        // NO handle to unregister with, so this listener outlives the GraalJS context that made
        // it. Anything that closes the context under a running client (a `sync` rewriting this
        // file → jsMacros restarts the service) leaves it firing "Context closed" every frame
        // until the render thread crashes the client. A dispose hook cannot fix it (the context
        // is closed before the new script runs); the fix would be a Java-side trampoline holding
        // a swappable callback, registered once per client lifetime. Until then: never deploy
        // into a live camera — `./gerda sync --skip <cam-instance>`.
        FBus.addListener(Prio.NORMAL, false, Ev.class, JavaWrapper.methodToJava(function (e) {
            var C = globalThis.__MC_CAM;
            C.frames++;
            if (C.mode === "off") return;
            var s = C.smooth;
            C.yaw += camWrap(C.wantYaw - C.yaw) * s;
            C.pitch += (C.wantPitch - C.pitch) * s;
            e.setYaw(Math.fround(C.yaw));
            e.setPitch(Math.fround(C.pitch));
            e.setRoll(Math.fround(C.roll));
        }));
        CAM.hooked = true;
        CAM.error = null;
        return true;
        } catch (e) {
            // Keep the reason where cam_state can report it — a silent no-hook camera
            // would look like "the rig works" while every take is unsteered.
            CAM.error = "" + (e.message || e);
            throw e;
        }
    }

    // Seed the eased angles from where the camera is actually looking, so engaging the
    // hook never snaps the frame.
    function camSeedFromPlayer() {
        var p = Player.getPlayer();
        if (!p) return;
        CAM.yaw = p.getYaw();
        CAM.pitch = p.getPitch();
    }

    function camAngles(req) {
        if (req.smooth != null) {
            var s = Number(req.smooth);
            if (!(s > 0) || s > 1) throw new Error("smooth must be in (0,1] — 1 snaps, ~0.15 is a soft ease");
            CAM.smooth = s;
        }
        if (req.roll != null) CAM.roll = Number(req.roll);
    }

    function camReport(id, type, extra) {
        var f = {mode: CAM.mode, hooked: CAM.hooked, frames: CAM.frames,
                 yaw: Math.round(CAM.yaw * 10) / 10, pitch: Math.round(CAM.pitch * 10) / 10,
                 roll: CAM.roll, smooth: CAM.smooth};
        if (extra) for (var k in extra) f[k] = extra[k];
        respFlat(id, type, f);
    }

    defineCmd("cam_pose", function (req, id) {
        if (req.x == null || req.y == null || req.z == null) throw new Error("cam_pose needs x, y, z");
        var cmd = "/tp @s " + req.x + " " + req.y + " " + req.z;
        if (req.yaw != null && req.pitch != null) cmd += " " + req.yaw + " " + req.pitch;
        Chat.say(cmd);
        if (req.spectator) Chat.say("/gamemode spectator @s");
        // A vanilla /tp yaw/pitch is authoritative only until the hook overrides it, so a
        // posed shot that also wants a HELD angle gets it seeded here.
        if (req.yaw != null && req.pitch != null && CAM.mode !== "off") {
            CAM.wantYaw = Number(req.yaw); CAM.wantPitch = Number(req.pitch);
        }
        camReport(id, "cam_pose", {sent: cmd, note: "fire-and-forget op command — verify with get_state"});
    }, {where: "ext", desc: "Place the CAMERA client (op) at x/y/z with an optional yaw/pitch, optionally switching to spectator. Vanilla /tp — camera client only, never a bot.",
        params: [{name: "x", type: "number", required: true}, {name: "y", type: "number", required: true},
                 {name: "z", type: "number", required: true}, {name: "yaw", type: "number", required: false},
                 {name: "pitch", type: "number", required: false},
                 {name: "spectator", type: "boolean", required: false, desc: "also /gamemode spectator @s"}]});

    defineCmd("cam_aim", function (req, id) {
        if (req.yaw == null || req.pitch == null) throw new Error("cam_aim needs yaw and pitch");
        camEnsureHook();
        if (CAM.mode === "off") camSeedFromPlayer();
        camAngles(req);
        CAM.wantYaw = Number(req.yaw); CAM.wantPitch = Number(req.pitch);
        CAM.mode = "aim";
        camReport(id, "cam_aim");
    }, {where: "ext", desc: "Hold the camera at an absolute yaw/pitch every FRAME (Forge ViewportEvent hook). Eases toward the angle by `smooth`; survives the player's own rotation.",
        params: [{name: "yaw", type: "number", required: true}, {name: "pitch", type: "number", required: true},
                 {name: "roll", type: "number", required: false, desc: "dutch angle, degrees (vanilla has none)"},
                 {name: "smooth", type: "number", required: false, desc: "per-frame ease 0..1 (1 = snap, 0.15 ≈ soft pan)"}]});

    defineCmd("cam_look_at", function (req, id) {
        if (req.x == null || req.y == null || req.z == null) throw new Error("cam_look_at needs x, y, z");
        var p = Player.getPlayer();
        if (!p) throw new Error("no player — camera client is not in-world yet");
        camEnsureHook();
        if (CAM.mode === "off") camSeedFromPlayer();
        camAngles(req);
        // Vanilla Entity.lookAt math, evaluated HERE (not in the per-frame hook) so the
        // hook stays pure arithmetic. Call this repeatedly (~4 Hz from the host) to track
        // a moving subject; the hook's easing turns the steps into a continuous pan.
        var dx = Number(req.x) - p.getX();
        var dy = Number(req.y) - (p.getY() + 1.62); // standing eye height
        var dz = Number(req.z) - p.getZ();
        var flat = Math.sqrt(dx * dx + dz * dz);
        CAM.wantYaw = (Math.atan2(dz, dx) * 180 / Math.PI) - 90;
        CAM.wantPitch = -(Math.atan2(dy, flat) * 180 / Math.PI);
        CAM.mode = "aim";
        camReport(id, "cam_look_at", {target: [Number(req.x), Number(req.y), Number(req.z)],
                                      dist: Math.round(Math.sqrt(dx * dx + dy * dy + dz * dz) * 10) / 10});
    }, {where: "ext", desc: "Aim the camera at a world point every FRAME. Poll it (~4 Hz) with a moving subject's position for a smooth tracking pan — the easing does the interpolation.",
        params: [{name: "x", type: "number", required: true}, {name: "y", type: "number", required: true},
                 {name: "z", type: "number", required: true},
                 {name: "roll", type: "number", required: false}, {name: "smooth", type: "number", required: false}]});

    defineCmd("cam_free", function (req, id) {
        CAM.mode = "off";
        CAM.roll = 0;
        camReport(id, "cam_free", {note: "vanilla camera control restored (hook stays registered, idle)"});
    }, {where: "ext", desc: "Release the camera hook — vanilla/spectator control again. The listener stays registered but stops writing angles.", params: []});

    defineCmd("cam_spectate", function (req, id) {
        // Vanilla /spectate: the camera BECOMES the target's view, and the client
        // interpolates a foreign entity normally — so this is the one MOVING camera that
        // needs no code. Bare /spectate releases back to the camera's own body.
        var cmd = req.target ? ("/spectate " + req.target) : "/spectate";
        Chat.say(cmd);
        camReport(id, "cam_spectate", {sent: cmd,
            note: "requires the camera to be in spectator gamemode; bare call releases"});
    }, {where: "ext", desc: "POV shot: vanilla /spectate <player|uuid> so the camera rides a bot's eyes (smooth, no code). Omit target to release.",
        params: [{name: "target", type: "string", required: false, desc: "player name; omit to release"}]});

    defineCmd("cam_hud", function (req, id) {
        // F1 equivalent — also hides the jsMacros "Miner: …" overlay, which renders on the
        // spectator too. Fail-loud through defineCmd if the SRG field name ever drifts.
        var hide = req.hide == null ? true : !!req.hide;
        var o = Client.getMinecraft()[srg("Minecraft", "options")];
        o[srg("Options", "hideGui")] = hide;
        respFlat(id, "cam_hud", {hideGui: o[srg("Options", "hideGui")]});
    }, {where: "ext", desc: "Hide/show the HUD on this client (vanilla F1 + the jsMacros overlay). Always hide before a take.",
        params: [{name: "hide", type: "boolean", required: false, desc: "default true"}]});

    defineCmd("cam_state", function (req, id) {
        // `frames` is the liveness proof: sample it twice a second apart — it must climb at
        // FPS (60+/s), not tick rate (20/s). Flat = the hook is not firing.
        camReport(id, "cam_state", {error: CAM.error});
    }, {where: "ext", desc: "Camera hook state: mode, registered?, eased angles, and the per-frame counter (must climb at FPS, not 20/s).", params: []});

    try { java.lang.System.out.println("[EXT] loaded: emi_search, emi_recipe, emi_uses, prospect, markers, reflect, recipe, read_chat, quests, quest_complete, quest_claim, ore_registry, cam_pose, cam_aim, cam_look_at, cam_free, cam_spectate, cam_hud, cam_state"); } catch (e) {}
})();
