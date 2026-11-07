# Build your own bot on the harness

Who this is for: you want the game-access plumbing — a TCP bridge, a worker that
drives a `Module` tick-by-tick, eyes/hands, MCP for LLM operators — but **not**
our mining bot — say a farmer, a courier or an arena fighter. This page shows the floor
(how little you must adopt) and the ceiling (how much of our stack you can pull in).

Gerda is two things and this doc is about keeping them separate:
[**Gerda the harness**](https://github.com/flamerix-ai/gerda/tree/main/harness)
(the plain-JS jsMacros services) runs *any* bot; **Gerda Bot** (`src/`) is our
reference implementation that happens to ship in the same repo. Everything below
replaces the second while reusing the first.

## The three layers — floor to ceiling

The harness is not a monolith — it's three separate jsMacros services (bridge,
main, worker) you register one by one, talking only through `GlobalVars` keys
(all defined in one file, `ipc.js`). So the floor is even lower than "write a `Module`": register
**bridge + main only** and you have remote game control with **no bot at all** —
`status`, `scan`, `inventory`, `eval`/`jeval`, screenshots and GUI clicks, every
ext.js plugin, the whole MCP surface. Worker-passthrough commands just fail loudly;
nothing else cares. A bot only enters the picture when you register the worker:
your code must then produce a **`Module`** object (`init` / `tick` / `command` /
`stop`, optional `describe` / `onChat`) that `worker.js` eval-loads under the fixed
bundle name `__gerda_bot.bundle.js`. Everything above that is a choice.

| Layer | You register / adopt… | Build step | Proof / template |
|---|---|---|---|
| **0 — primitives only, no bot** | bridge + main (+ ext.js) | none | remote-drive the game from the host: [`examples/basic/drive_bot.sh`](https://github.com/flamerix-ai/gerda/blob/main/examples/basic/drive_bot.sh), the [MCP server](https://github.com/flamerix-ai/gerda/tree/main/mcp) |
| **1 — plain-JS bot** | + worker; nothing but the `Module` contract | none | [`harness/bot_template.js`](https://github.com/flamerix-ai/gerda/blob/main/harness/bot_template.js) |
| **2 — TS bot on the Runtime facade** | `src/core/runtime/` (the only mandatory TS layer) | tsup | [`examples/advanced/standalone-bot.ts`](https://github.com/flamerix-ai/gerda/blob/main/examples/advanced/standalone-bot.ts) — a complete bot in a small fraction of the full bundle |
| **3 — the whole kernel, à la carte** | FSM/capabilities, nav, reflexes, missions — pick what you want | tsup | [EXTENDING.md](EXTENDING.md), [`examples/`](https://github.com/flamerix-ai/gerda/tree/main/examples) |

(For completeness: bridge *alone* is a deliberate zero-logic pipe — newline-framed
JSON ↔ `GlobalVars` — so "keep the bridge + MCP, replace main with your own
`GlobalVars` consumer" is a documented seam, but exotic; the practical floor is
bridge + main.)

Take an arena fighter as the example. The **navigator** (`src/shared/nav/`) is probably useful
to *any* bot that has to walk somewhere without falling in a hole — take it. The
**reflexes** (water clutch, swim-out, stuck watchdog) are useful if your bot roams
dangerous terrain — maybe take them. The **missions** (drill, chop, search…) are
*ours* — they encode our mining-economy goals, so unless you're mining you'll write
your own on the same seam. Layer 3 is a menu, not a package.

## Recipe — a plain-JS bot, no build step

The fastest path. No TypeScript, no tsup, no `node_modules` even.

1. Copy [`harness/bot_template.js`](https://github.com/flamerix-ai/gerda/blob/main/harness/bot_template.js)
   to `yourbot.js` and fill in `init` / `tick` / `command` / `stop`. All bot memory
   lives in the state object the harness threads through those calls — never in
   module-level variables (the worker can reload the bundle at any tick). The template is
   Apache-2.0, so your bot can use any license.
   Keep the last line, `globalThis.Module = MyModule;`: `worker.js` reads the
   global, and in a strict-mode file a `var Module` never leaves the worker's
   `eval` (the worker then loads no module and says so in `get_state.worker.fatal`).
2. Deploy it **as the worker bundle** and reload the worker:
   `./gerda sync -s yourbot.js -n __gerda_bot.bundle.js`, then
   `./gerda ctl send reload_worker`. `worker.js` loads the bundle by that fixed
   name, so your file takes the place of Gerda Bot; `./gerda sync` without
   `-s` puts Gerda Bot back. With more than one instance, add `--only <instance>`:
   without it the file goes into every instance, and another running bot loads it
   at its next worker reload.
3. Drive it: `./gerda ctl send my_start`, `./gerda ctl send my_target '{"x":100,"y":64,"z":200}'`.
   Every command the container does not own reaches your `command()`; the
   container's own names (`start`, `stop`, `halt`, `goto`, `load`, `status`, …
   — `./gerda ctl send describe` lists them) never do, so give yours other names.
   `./gerda ctl get_state` shows `worker.status` and, if the load failed,
   `worker.fatal` with the reason.

Inside `tick` you have the jsMacros service scope directly (`World`, `Player`,
`Hud`, `Java`, …). This is enough for real behaviour; you trade type-safety and the mock
test harness for zero ceremony. It uses only jsMacros' own API, so it runs on every
Minecraft version and loader that has a jsMacros build ([PORTABILITY.md](PORTABILITY.md)).

Not this: `./gerda ctl load yourbot.js` loads a *passive side module* into the
container — a sandbox that sees only `World`/`Player`, runs next to the worker and
never receives commands. It is not a way to run a bot.

## Recipe — a TS bot on the Runtime facade

One rung up: full TypeScript over the game, and — the real prize — a **mock twin**
(`src/core/runtime/mock.ts`) that implements the identical `Runtime` interface, so your
whole bot is unit-testable without Minecraft. This is the layer
[`examples/advanced/standalone-bot.ts`](https://github.com/flamerix-ai/gerda/blob/main/examples/advanced/standalone-bot.ts)
uses and nothing more.

The integration model is a **fork — clone this repo as your workspace**. There are
deliberately **no npm packages** to depend on; the harness and the build assume
they live in the tree with you.

1. Write your entry anywhere in the tree, e.g. `src/my-bot/entry.ts`. It ends by
   assigning your `Module` onto the global:
   `(globalThis as { Module?: unknown }).Module = makeYourBot(runtime);`.
2. Point the build at it — **one line** in `tsup.config.ts`:
   `entry: { "__gerda_bot.bundle": "src/my-bot/entry.ts" }`. `worker.js` loads the
   bundle by that fixed name, so building *your* entry under it is exactly how any
   custom bot replaces ours. Swap the line back to restore Gerda Bot.
3. `bun run build && ./gerda sync`, then `./gerda reload-worker`: the running worker keeps
   the old bundle until it reloads.
4. Drive it: `./gerda ctl send <yourcmd>` (a name the container does not own —
   `start`/`stop`/`halt` are container commands that manage the worker service). The `just`
   recipes wrap all of the above (`just build`, `just sync`, `just watch`).
5. **Test on the mock**: construct your bot with `createMockRuntime()` (from
   `src/core/runtime/mock.ts`) instead of `createJsMacrosRuntime()` and assert against it — the facade is the seam that makes
   any bot on it testable, and it can't drift from the real runtime because both
   implement the same interface. Your tests go in `test-ts/` and run under
   `bun run check` alongside ours.

## Using more of our stack

Once you're on the facade, pulling in kernel machinery is additive. The FSM +
capability pipeline (`src/shared/kernel/`, `src/bot/capabilities/`), the navigator
(`src/shared/nav/`), reflexes, and the mission sequencer are all separable modules — wire
in the ones you want in your entry file. The graded worked examples walk each seam:

- [`examples/intermediate/heartbeat-capability.ts`](https://github.com/flamerix-ai/gerda/blob/main/examples/intermediate/heartbeat-capability.ts) — the smallest always-on capability (tick guard + typed blackboard slice + a command).
- [`examples/advanced/patrol-mission.ts`](https://github.com/flamerix-ai/gerda/blob/main/examples/advanced/patrol-mission.ts) — a complete pluggable goal state-machine, the template every real mission follows.

The deep dive on missions/plans/capabilities and the Runtime contract is
[EXTENDING.md](EXTENDING.md); the conventions reviews enforce are in
[CONTRIBUTING.md](https://github.com/flamerix-ai/gerda/blob/main/CONTRIBUTING.md).

## Config overrides — tune without forking the schema

Every tunable lives in one typed file (`src/shared/config/schema.ts`); a magic number in
logic code is a bug. To change values for *your* deployment without editing that
file, drop a gitignored **`config/local.overrides.json`** — a deep-partial override
(e.g. `{ "nav": { "sprint": false } }`) that `makeConfig` merges over the defaults
at build time. It's validated: an unknown top-level key fails **loud** at init
(naming the key + the file) rather than silently doing nothing. Details in
[EXTENDING.md](EXTENDING.md).

## Your commands over the bridge & MCP — auto-discovery

Add a `describe()` method to your `Module` and its entries **merge into the
container's command manifest** (the `mc://api` resource). That means `bridge_ctl`,
the [MCP server](https://github.com/flamerix-ai/gerda/tree/main/mcp), and any LLM
operator discover *your* bot's commands with **zero MCP redeploy** — you ship a new
bot, the manifest updates itself. Anything main.js doesn't handle itself falls
through to your `Module`'s `command`, reachable as `./gerda ctl send <type>` or
`mc_send`.

## Fleet — the hub is mission-agnostic

Multi-bot coordination is not mining-specific. `scripts/ops/fleet_hub.py` queue
entries are arbitrary `{mission, params}` `mission_start` payloads — enqueue *your*
bot's missions with `./gerda fleet enqueue` (or the `mc_fleet_enqueue` MCP tool)
and the hub schedules them onto free bots with **no hub changes**. Only the small
`WANT_PRESETS` dict (a resource → mission preset, "need iron" → a drill mission) and
the vein-claim leasing semantics are mining-flavoured; ignore or replace them and
the presence, disjoint-region, peers-as-obstacles, and task-queue machinery all
still work. See [FLEET_PLAYBOOK.md](FLEET_PLAYBOOK.md).

## A different pack or Minecraft version

A plain-JS bot on jsMacros' own API runs on every version and loader that has a jsMacros
build. Gerda Bot's raw-Java layer calls Forge **SRG names**: a different *pack* on Forge is
mostly free, a Fabric or NeoForge runtime is a port. The tested support matrix and the porting
steps are in [PORTABILITY.md](PORTABILITY.md).

## Orientation map — where everything lives

| Directory | What it is |
|---|---|
| [`harness/`](https://github.com/flamerix-ai/gerda/tree/main/harness) | Game-side jsMacros services (bridge / main / worker / ext / eyes-hands). Deployed as-is, **not** bundled. Your bot loads here. |
| `src/` | The TS bot — `core/runtime/` (facade, the only mandatory layer), `shared/kernel/`, `bot/capabilities/`, `shared/nav/`, `shared/domain/`, `bot/missions/`, `shared/config/`, `bot/entry/`. Fork target. |
| `scripts/ops/` | Live-bot ops: `sync`, `bridge_ctl` (`ctl`), `fleet_hub` + `fleet_ctl`, `wedge_watchdog` (launcher relaunch), screenshots. |
| `scripts/dev/` | Dev tooling: `srg.py`, `decompile.sh`, arena gate, navbench. |
| `mcp/` | The stdio MCP server wrapping the bridge as `mc_*` tools. |
| [`examples/`](https://github.com/flamerix-ai/gerda/tree/main/examples) | Graded worked templates, basic → advanced. Start here. |
| `./gerda` | Umbrella CLI over every host-side tool — run it bare for the full list. |
| `just` | Task runner wrapping the build/sync/check/watch recipes. |

Never installed the toolchain? [SETUP.md](SETUP.md) takes you from an empty machine
to a driven bot.
