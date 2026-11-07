// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Flamerix AI. Licensed under the Apache License, Version 2.0 (LICENSES/Apache-2.0.txt).
// bot_template.js — Gerda bot template: write YOUR OWN bot on the harness.
// ---------------------------------------------------------------------------
// Gerda is two things:
//   1. The HARNESS (this folder): always-on jsMacros services that give you a
//      TCP bridge, eyes/hands primitives, and a worker that eval-loads a
//      `Module` object and drives it tick-by-tick.
//   2. GERDA BOT — OUR implementation of that `Module` contract: the TS
//      kernel in `src/` (entry: `src/bot/entry/worker-bundle.ts`, built by tsup
//      into `dist/__gerda_bot.bundle.js`) — missions, navigator, reflexes.
//
// You do NOT need our bot to use the harness. Any file that assigns a
// `Module` object with the shape below to `globalThis.Module` is a valid bot:
// copy this file, rename it, implement your logic (plain JS, no build step),
// then deploy it AS the worker bundle and reload the worker:
//   ./gerda sync -s yourbot.js -n __gerda_bot.bundle.js
//   ./gerda ctl send reload_worker
// worker.js then calls init() once and tick() every Minecraft tick, and every
// command the container does not own itself reaches command() — e.g.
// `./gerda ctl send my_start`. (`./gerda ctl load` is something else: a
// sandboxed side module that sees only World/Player and never gets commands.)
// Full guide: docs/BUILD_YOUR_OWN_BOT.md.
// ---------------------------------------------------------------------------
"use strict";

var MyModule = {
    name: "my_module",

    // Called once when worker.js loads the bundle. Return your initial state.
    init: function () {
        return {
            running: false,
            tickCount: 0,
        };
    },

    // Called every tick by the container. Must return new state.
    tick: function (st) {
        st.tickCount++;
        if (st.running) {
            // Your per-tick logic here.
            // Example: check distance, attack block, move, etc.
        }
        return st;
    },

    // Called when a passthrough command arrives from `./gerda ctl send` / MCP.
    // Only names the container does NOT own reach here: `start`, `stop`, `halt`,
    // `goto`, `load`, `status`, … are container commands (`./gerda ctl send
    // describe` lists them), so pick your own names.
    // `./gerda ctl send my_target '{"x":100,"y":64,"z":200}'` →
    // cmd = {type: "my_target", x: 100, y: 64, z: 200, …}.
    command: function (st, cmd) {
        switch (cmd.type) {
            case "my_start":
                st.running = true;
                break;
            case "pause": // not a container command, so it does reach the module
                st.running = false;
                break;
            case "my_target":
                // Example: remember where to go; tick() would steer there.
                st.target = {x: cmd.x, y: cmd.y, z: cmd.z};
                break;
        }
        return st;
    },

    // Called before unload. Cleanup if needed.
    stop: function (st) {
        st.running = false;
        // e.g. release keys, stop Baritone, etc.
    }
};

// worker.js reads the GLOBAL `Module` after eval. Assign it on globalThis: this
// file is strict mode, and a strict-mode `var Module` stays inside the eval.
globalThis.Module = MyModule;
