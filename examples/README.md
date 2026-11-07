# Examples

Worked, heavily-commented starting points, ordered by depth. Each file's header
comment explains how to actually run it; never installed the toolchain at all?
Start at the [docs/SETUP.md](../docs/SETUP.md) Quickstart — it goes from cloning the repo
and installing bun/python/just/uv (Linux, macOS, Windows, or the Nix shortcut) to a bot that
answers over the bridge. Before you load your own plain-JS bot, check it with
`just validate-bundle yourbot.js` (the same check `just sync` runs).

## basic/ — drive the bot, write no code

| File | What it shows |
|---|---|
| [`basic/drive_bot.sh`](basic/drive_bot.sh) | A first session over the TCP bridge: ping, state, scan, movement, starting a mission, pausing, reading the journal. Run the blocks by hand (`./gerda ctl …` is the same thing with fewer keystrokes). |

## intermediate/ — add a command or a tick behaviour

| File | Layer | What it shows |
|---|---|---|
| [`intermediate/ext-plugin.js`](intermediate/ext-plugin.js) | ext.js plugin (`harness/ext.js`) | A new bridge command with the hot-reload loop — edit → `./gerda sync` → `reload_ext`, no game restart. The fastest way to expose a mod's Java API. |
| [`intermediate/heartbeat-capability.ts`](intermediate/heartbeat-capability.ts) | TS kernel (`src/bot/capabilities/`) | The smallest always-on capability: a tick guard, a typed blackboard slice, a bridge command with a correlated reply. Typechecks against the live kernel contracts as part of `bun run check`. |

## advanced/ — a full mission, or a whole bot of your own

Writing a whole bot of your own on the harness? [docs/BUILD_YOUR_OWN_BOT.md](../docs/BUILD_YOUR_OWN_BOT.md)
is the guide these two files anchor — the three layers, the fork model, and how much
of our stack you must adopt (little) versus can reuse (all of it, à la carte).

| File | What it shows |
|---|---|
| [`advanced/patrol-mission.ts`](advanced/patrol-mission.ts) | A complete pluggable goal state-machine: params, FSM edges, a typed memory slice, the shared `walkTo` movement leg, `isDone`/`outputs` (mission chaining), a mission-scoped bridge command, abort cleanup. The template every real mission (drill, fetch, search) follows. |
| [`advanced/standalone-bot.ts`](advanced/standalone-bot.ts) | A complete standalone TS bot from **just the Runtime facade** — no kernel, no missions: your own `Module` (init/tick/command/stop/describe), built by tsup under the bundle name and driven by the same harness. Proves the harness+runtime are usable without Gerda Bot entirely (the plain-JS twin is `harness/bot_template.js`). |

## Which layer do I want?

- **Bot behaviour** (a new mission, a smarter reflex, mining logic) → TS. Pure
  logic goes in `src/shared/domain/` (unit-testable, no game), game-touching code
  behind the `Runtime` facade. Climb heartbeat → patrol, read `docs/EXTENDING.md`.
- **Talking to a mod's Java API** (quests, EMI, GTCEu machines) → an ext.js
  plugin. Full jsMacros/Java scope, reloads in seconds.
- **Orchestrating from outside the game** (scripts, dashboards, AI agents) → the
  bridge (`./gerda ctl`), or the MCP server in `mcp/` which wraps it for LLM
  agents; multi-bot orchestration goes through the hub (`./gerda hub` +
  `./gerda fleet`).

Conventions that apply everywhere are in [CONTRIBUTING.md](../CONTRIBUTING.md).
