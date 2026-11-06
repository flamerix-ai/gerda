# Gerda — a bot harness for Minecraft, and an autonomous GregTech mining fleet built on it

*Gerda — open-source bot framework by **Flamerix AI**.*

> **In memory of Gerda**, a much-loved dog. This project carries her name.
>
> **Why it exists.** Heavy modpacks like Monifactory are wonderful, and they ask for more
> evenings than most of us have. Gerda is for playing them anyway: send a bot, or an AI
> agent driving it, to do the routine grind and the boring crafting, and keep the fun
> parts for yourself.

**No LLM in the loop.** The bot is deterministic code: it senses, plans and acts every tick, with
no API cost and no model to wait for. An LLM can *drive* it through the bundled MCP server, but
nothing depends on one.

Gerda is two things:

1. **The harness** (`harness/` + host tooling). A framework for running bot code inside
   Minecraft on the [jsMacros](https://jsmacros.wagyourtail.xyz/) mod (GraalJS): always-on
   services, a loopback TCP bridge, an MCP server, screenshots and synthetic GUI input,
   hot-reloadable mod-API plugins, and a worker that loads any `Module` object
   (init/tick/command/stop) and drives it tick by tick. It works without our bot:
   `harness/bot_template.js` is a plain-JS skeleton. See
   [docs/BUILD_YOUR_OWN_BOT.md](docs/BUILD_YOUR_OWN_BOT.md).
2. **Gerda Bot** (`src/`). Our reference bot on that contract: an autonomous ore-mining bot
   and multi-bot fleet for **GregTech CEu** (Monifactory modpack, Forge 1.20.1). A TypeScript
   kernel compiles to one bundle. No server-side mods are needed. The bot plays as a real
   player: no cheats.

**Which doc do I need?**
- Run the bot: [docs/SETUP.md](docs/SETUP.md)
- Write your own bot on the harness: [docs/BUILD_YOUR_OWN_BOT.md](docs/BUILD_YOUR_OWN_BOT.md)
- Test your mod in a real game: [docs/MOD_TESTING.md](docs/MOD_TESTING.md)
- Anything else: the full table in [docs/index.md](docs/index.md#which-doc-do-i-need)
- All docs as a website: [flamerix-ai.github.io/gerda](https://flamerix-ai.github.io/gerda/)

**Test your mod in a real game.** Clone the repo, put your mod jar or modpack into a
headless container, and write checks as small JSON arenas: build a scene, then assert game
state through the bridge, with full Java access to your mod's classes. A known-bad twin marks
a check that is wrong on purpose and passes only when the game refuses that wrong value, so a
check that cannot fail shows up. A recording of the run comes out as a video. Worked example (a
GregTech CEu ore that needs an iron pickaxe) and the commands:
[docs/MOD_TESTING.md](docs/MOD_TESTING.md).

**Works on your Minecraft version?** The harness runs on every version that has a jsMacros
build — tested on Forge 1.20.1 and 1.18.2 and on Fabric 1.20.1 and 1.21. Gerda Bot moves on
Forge only. The tested matrix and a vanilla quick recipe:
[docs/PORTABILITY.md](docs/PORTABILITY.md).

## What it does

- **Its own navigator.** A* over a cached world view by default (D* Lite is an optional incremental
  replanner, `nav_engine {engine: dstar|auto}`), executed with live hazard checks. It walks,
  sprints, climbs ladders, pillars up, mines through, bridges gaps and sprint-jumps gaps of up to 3
  blocks. It refuses jumps it cannot make, clutches falls with a water bucket, and stays out of pits
  it cannot climb back from.
- **GregTech-aware mining.** Reads HV prospector scans as data (vein names and coordinates),
  mines each vein as a volume, knows tool tiers, swaps tools, and picks ores from the live Forge
  registry (2800+ ore ids).
- **Missions.** `drill` (prospect → shaft → excavate), `chop`, `hunt`, `fetch`, `loot-run`,
  `search` (maps chests and barrels), `follow`, `storage` (base deposit, including Functional
  Storage drawers), `craft` (recipe chains from EMI's API), an endless `sustain` loop
  (mine → smelt → craft → repair), and more. See [docs/MISSIONS.md](docs/MISSIONS.md).
- **Co-op fleet.** A hub gives each bot its own region, leases vein claims, treats peers as
  obstacles, shares hazard maps and runs a task queue ("need iron" → a drill mission on a free
  bot).
- **Safety tiers** ([docs/SAFETY.md](docs/SAFETY.md)). Prevention (planner vetoes), reaction
  (water clutch, swim-out, stuck detection, auto-respawn) and recovery (teleport escalation).
  Only the survival reflexes (respawn, air and swim-out, water clutch, HP floor and damage
  distress) and the recovery they trigger run even while idle; the other reflexes, such as stuck
  detection, need an active mission.
- **AI-operator tooling.** Bridge + MCP server, screenshots, synthetic GUI input, headless EMI
  item and recipe search, FTB Quests automation, per-tick decision tracing.
- **Hands-free filming** ([docs/RIG.md](docs/RIG.md)). Bot and camera clients run in headless
  compositors, so nothing appears on your monitor. The scene is staged from data, a scripted
  camera flies while the bot works, a motion probe rejects dead takes, and the video is cut from
  a JSON cut list with burned-in captions. Our teaser was shot this way. The
  `/gerda-film` and `/gerda-run` Claude Code skills (`.claude/skills/`) drive both flows.
- **Three test layers** ([docs/TESTING.md](docs/TESTING.md)). Unit and property tests on a mock
  runtime, a live facade smoke, and in-game arena scenarios (`just gate-live`).

## Architecture

```
bridge_ctl.py / MCP ──TCP:55544──► bridge.js ──GlobalVars──► main.js ──eval──► worker.js ──runs──► dist/__gerda_bot.bundle.js
```

The harness services in `harness/` are plain jsMacros scripts. The bot in `src/` is a layered
TypeScript kernel: one typed facade over jsMacros (with a mock twin), an FSM with one plugin per
concern, the navigator, pure domain logic, missions, and one typed config schema. How the pieces fit
together — the command path, the tiers, one tick — is in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md); the map of mechanisms is in the
[docs index](docs/index.md). To add a mission or
capability, read [docs/EXTENDING.md](docs/EXTENDING.md).

## Quickstart

**Follow [docs/SETUP.md](docs/SETUP.md)** — one ordered path from an empty machine to a driven
bot: get the code, install the tools, get the game (launcher + Monifactory 0.13.4), install
jsMacros, build and deploy, register the services, check it works. In short:

```sh
git clone https://github.com/flamerix-ai/gerda.git && cd gerda
nix develop          # with Nix on x86_64 Linux: every tool at once (without Nix: SETUP step 2)
bun install          # toolchain (needs bun, just, python3 — SETUP step 2)
just hooks           # point git at the versioned pre-commit/pre-push gates
just check           # tsc + biome + vitest + python suites (offline, no game needed)
just sync            # build + deploy bundle + services into your game instance(s)
```

The game side — a Monifactory instance in a MultiMC-format launcher, with the jsMacros jar in
its `mods/` — is SETUP steps 3–4. Register the `main` and `bridge` services once, in the jsMacros
GUI (Esc → Mods → JS Macros → Config) or in its config file (SETUP step 6); `main` starts the
worker itself. After that, everything reloads without the GUI. Then talk to the bot:

```sh
./gerda ctl status
./gerda ctl get_state
./gerda ctl send mission_start '{"name": "drill", "params": {"ore": "iron"}}'
./gerda ctl pause     # take over; walking manually also pauses it
```

`./gerda` is the CLI for every host-side tool (screenshots, the live test gate, the fleet hub,
SRG lookups, …). Run it bare for the list.

The MCP server ([mcp/](mcp/)) exposes the same bridge as `mc_*` tools for LLM agents. To use it
in Claude Code, copy `.mcp.json.example` to `.mcp.json`. Details: [mcp/README.md](mcp/README.md).

## Community — help us make Gerda better

We are Flamerix AI, a software company, and we want Gerda to be easy to use for players,
server admins and modders. You can help:

- Tell us what is unclear, inconvenient, or looks wrong.
- Suggest how to make setup, docs or the bot simpler.
- Share what you built on the harness, or a port to another pack or version.

Let's make the Minecraft modding world more interesting together.

- Questions and ideas: [GitHub Discussions](https://github.com/flamerix-ai/gerda/discussions)
- Bugs and requests: [GitHub Issues](https://github.com/flamerix-ai/gerda/issues)
- Contact: [hello@flamerix.ai](mailto:hello@flamerix.ai)

Contributing code: [CONTRIBUTING.md](CONTRIBUTING.md).

## Disclaimer

Built for single-player and your own server. Run bots only on servers that allow automation.

## License

[MPL-2.0](LICENSE) for the code; `harness/bot_template.js` is
[Apache-2.0](LICENSES/Apache-2.0.txt) so your bot built from it can use any license. See
[NOTICE](NOTICE) for attribution.

> This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
> of the MPL was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
