# `harness/` — Gerda, the game-side service layer

These are the always-on **jsMacros Services** (plain JS, GraalJS/ES2022) that give
any bot its game access: a loopback TCP bridge, a supervisor with eyes/hands
primitives, and a worker that eval-loads and drives a `Module` tick-by-tick. They
are **deployed as-is by `./gerda sync` — NOT bundled** (the TS build in `src/`
produces only `dist/__gerda_bot.bundle.js`, the bot the worker runs). This folder
is the framework; `src/` is our reference bot on it.

**You can run your own bot here without touching `src/`** — the worker loads any
`Module` object. Start from [`bot_template.js`](bot_template.js) (plain-JS, no build
step) and read [`../docs/BUILD_YOUR_OWN_BOT.md`](../docs/BUILD_YOUR_OWN_BOT.md).

## The files

| File | What it is |
|---|---|
| `bridge.js` | Thin TCP gateway (`127.0.0.1:55544`, newline-framed JSON). No logic — queues commands into `GlobalVars`, relays responses. |
| `main.js` | Always-on supervisor + stable game-primitive container: `safeEval`, service lifecycle, bridge dispatch, worker heartbeat, `eval`/`jeval`, `reload_main`. Stable infra — rarely edited. |
| `worker.js` | Managed Service that eval-loads the bundle (fixed name `__gerda_bot.bundle.js`), reads its `Module` interface, drives it tick-by-tick, writes a heartbeat. |
| `ext.js` | **Reloadable** mod-API plugin layer (EMI / prospector / markers / quests). Each plugin self-registers via `register(name, fn, meta)`. |
| `screen.js` | The "eyes & hands" primitives (screenshot / read / click / scroll / type / keypress / introspect), eval-merged into main.js's `HANDLERS`. Container-scoped, not a reloadable plugin. |
| `ipc.js` | GlobalVars-key + wire-envelope SSOT shared by bridge/main/worker (mirror of `src/core/ipc/ipc.ts`, drift-gated). |
| `world_store.js` | `mc_world.json` read-modify-write SSOT shared by main.js + ext.js. |
| `safe-io.js` | Pure dispatch-routing + SRG-inversion logic, drift-gated against `src/shared/harness/`. |
| `bot_template.js` | Plain-JS `Module` skeleton — copy this to write your own bot. |
| `probes/` | Standalone diagnostic macros (runtime probe, key debug). |
| `srg_names.json` | Generated SRG↔Mojang name map (see below). |

`ipc.js` / `world_store.js` / `safe-io.js` / `screen.js` are eval-included by
main.js (and ext.js) like a poor-man's `require` — each publishes a `globalThis.__*`
global. The isolated Services share nothing else.

## Reloading (no jsMacros GUI needed)

- **ext.js** — the hot loop: edit → `./gerda sync` → **`reload_ext`** re-evals the
  file into a fresh registry (rollback-on-error). Removed/renamed commands disappear.
  No main.js restart.
- **main.js** — edit → `./gerda sync` → **`reload_main`** defers a
  `ServiceManager.restartService("main")` on a background thread; the worker keeps
  running across it. (First time you add a brand-new main.js command, you need one
  bootstrap restart to load the version that has it.)
- **worker.js / the bundle** — `./gerda sync` redeploys the bundle; the worker
  picks it up on reload. Drive the whole edit→verify loop over the bridge.

## SRG names

The runtime uses Mojang class names but **SRG member names** (`m_7583_`, `f_92095_`).
`srg_names.json` is the generated inversion map — regenerate it after a game/version
change with `python scripts/dev/srg.py --export harness/srg_names.json` then
`./gerda sync`. It's large and **gitignored**. In `jeval`, call vanilla methods by
Mojang name via the `srg(class, member)` helper instead of pasting raw tokens.

`main.js` also carries **~7 hardcoded SRG tokens** (the screen-input family, etc.)
that can't go through the resolver — each carries a "how this was derived" comment so
it can be re-resolved by signature. Version porting (regenerating the map + the
hardcoded tokens) lives in [`../docs/PORTABILITY.md`](../docs/PORTABILITY.md) — never
guess SRG names by trial-calling in-game.
