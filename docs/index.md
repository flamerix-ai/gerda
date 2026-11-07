# Gerda

*Gerda — open-source bot framework by **Flamerix AI**.*

> **In memory of Gerda**, a much-loved dog. This project carries her name.
>
> **Why it exists.** Heavy modpacks like Monifactory are wonderful, and they ask for more
> evenings than most of us have. Gerda is for playing them anyway: send a bot, or an AI
> agent driving it, to do the routine grind and the boring crafting, and keep the fun
> parts for yourself.

Gerda is two things. **The harness** is a framework for running bot code inside Minecraft on
the [jsMacros](https://jsmacros.wagyourtail.xyz/) mod: a TCP bridge, an MCP server for LLM
operators, screenshots and GUI input, and a worker that drives any `Module` tick by tick. It
works without our bot (`harness/bot_template.js`). **Gerda Bot** is our reference bot on top
of it: an autonomous ore-mining bot and multi-bot fleet for **GregTech CEu** (Monifactory,
Forge 1.20.1). It plays as a real, non-op player with no extra server-side mods; its only
privilege is the pack's FTB Essentials teleport.

New here? [Setup from zero](SETUP.md) takes you from an empty machine to a driven bot. The
[repo README](https://github.com/flamerix-ai/gerda#readme) has the feature tour, and
[examples/](https://github.com/flamerix-ai/gerda/tree/main/examples) has templates from basic
to advanced.

## Which doc do I need?

| I want to… | Read |
|---|---|
| Run the bot for the first time | [SETUP.md](SETUP.md) |
| Understand how the pieces fit together | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Test my mod or modpack in a real game, headless, with a video | [MOD_TESTING.md](MOD_TESTING.md) |
| Write my own bot on the harness | [BUILD_YOUR_OWN_BOT.md](BUILD_YOUR_OWN_BOT.md) |
| Extend Gerda Bot: a mission, capability or ext plugin | [EXTENDING.md](EXTENDING.md) + [MISSIONS.md](MISSIONS.md) |
| Run on another Minecraft version, loader or modpack (support matrix + vanilla recipe) | [PORTABILITY.md](PORTABILITY.md) |
| Run a server and a fleet | [FLEET_PLAYBOOK.md](FLEET_PLAYBOOK.md) + [SERVER_SETUP.md](SERVER_SETUP.md) + [BOT_INSTANCE_SETUP.md](BOT_INSTANCE_SETUP.md) |
| Film the bot, or run a client off-screen | [RIG.md](RIG.md) |
| Understand the bridge protocol and IPC keys | [IPC.md](IPC.md) |
| Look up a bridge command and its arguments | [COMMANDS.md](COMMANDS.md) (generated from the source) |
| Take screenshots and click through game menus over the bridge | [EYES_HANDS.md](EYES_HANDS.md) |
| Contribute | [CONTRIBUTING.md](https://github.com/flamerix-ai/gerda/blob/main/CONTRIBUTING.md) + [TESTING.md](TESTING.md) |
| See how it was built | [BUILD_STORY.md](BUILD_STORY.md) |

## Map of the mechanisms

| Mechanism | What it is | Docs | Code |
|---|---|---|---|
| **Kernel & capabilities** | Validated FSM, tick pipeline, one plugin per concern, typed blackboard slices, error-classification boundary | [Extending § Capabilities](EXTENDING.md#writing-a-capability) | `src/shared/kernel/`, `src/bot/capabilities/` |
| **Missions** | Pluggable goal state machines, swapped at runtime (`mission_start`), chained by plans | [Missions](MISSIONS.md) | `src/bot/missions/`, `src/bot/orchestrator/` |
| **Navigator** | A* over a cached world view (D* Lite optional); greedy execution with ladders, pillaring, bridging, parkour and hazard vetoes | [Benches](navbench.md) | `src/shared/nav/` |
| **Vein excavation** | Vein-as-volume strip mining with multi-band descent and tool-tier awareness | [Missions § drill](MISSIONS.md) | `src/bot/missions/drill/`, `src/bot/missions/mine/` |
| **Safety & reflexes** | Prevention → reaction → recovery: water clutch, swim-out, stall watchdogs, auto-respawn; survival reflexes active while idle | [Safety](SAFETY.md) | `src/shared/reflexes/`, `src/shared/kernel/progress.ts` |
| **Service harness** | Always-on jsMacros services: bridge, supervisor, worker, hot-reloadable ext plugins | [IPC](IPC.md), [Extending § Harness](EXTENDING.md#growing-the-harness-mainjs-extjs) | `harness/` |
| **Runtime facade** | The one typed boundary over jsMacros; a mock twin makes the kernel unit-testable | [Extending § Runtime](EXTENDING.md#the-runtime-facade-contract) | `src/core/runtime/` |
| **Multi-bot fleet** | Hub: presence, disjoint regions, vein-claim leases, task queue, "need iron" presets | [Fleet playbook](FLEET_PLAYBOOK.md) | `scripts/ops/fleet_hub.py` |
| **MCP for LLM operators** | Standard MCP stdio server: `mc_*` tools + live command manifest (`mc://api`) | [mcp/README](https://github.com/flamerix-ai/gerda/tree/main/mcp) | `mcp/server.py` |
| **Eyes & hands** | Screenshots, synthetic GUI input, EMI search as data, FTB Quests automation | [Eyes & hands](EYES_HANDS.md) | `harness/screen.js`, `harness/ext.js` |
| **SRG tooling** | Offline Forge SRG↔Mojang lookup, live reflection dumps, jar decompilation | [Extending § SRG](EXTENDING.md#srg-mapping-workflow-calling-vanillaforge-methods) | `scripts/dev/srg.py`, `scripts/dev/decompile.sh` |
| **Quest autopilot** | Mod-agnostic objective engine with an FTB Quests adapter | [Fleet playbook](FLEET_PLAYBOOK.md) | `scripts/objective/` |
| **Config** | Every tunable in one typed schema | [Extending § Config](EXTENDING.md#overriding-config-in-a-fork-without-editing-schemats) | `src/shared/config/schema.ts` |
| **Testing** | Mock unit/property tests, live facade smoke, in-game arenas | [Testing](TESTING.md) · [Scenario files](SCENARIOS.md) | `test-ts/`, `scenarios/arenas/` |
| **Filming rig** | Off-screen clients, staged sets, scripted camera, motion-probed takes, cut-list assembly | [Rig](RIG.md) | `scripts/ops/capture_rig.sh`, `scripts/rig/` |
| **Host tooling** | The `./gerda` CLI: drive bots, screenshots, live gate, fleet client | [scripts/README](https://github.com/flamerix-ai/gerda/tree/main/scripts) | `gerda`, `scripts/` |

## Repo layout and where new code goes

The bot in `src/` has three tiers, and imports point only down: **core < shared < bot**. The
defensive checker in `bun run check` enforces it. The tier table, the full repo layout with
where new code goes, and the path of one command and one tick are in
[How Gerda works](ARCHITECTURE.md). Entry point: `src/bot/entry/worker-bundle.ts`.
