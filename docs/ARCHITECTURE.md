# How Gerda works

This page is a map. It names each part, says what it is for, and points at the code that
holds it. The code is the reference: when this page and the code disagree, the code wins.

## Overview

Gerda has two parts. **The harness** (`harness/`) is a set of plain-JS jsMacros services
that run inside the Minecraft client: a TCP bridge, a supervisor that answers commands, and
a worker that loads a bot and drives it one game tick at a time. **Gerda Bot** (`src/`) is
our reference bot: a TypeScript kernel that `tsup` (`tsup.config.ts`) compiles to one file,
`dist/__gerda_bot.bundle.js`. That bundle assigns `globalThis.Module`, and the worker
`eval`-loads it. The script engine is GraalJS (ECMAScript 2022). The harness
accepts any object with the `Module` contract, not only ours: `harness/bot_template.js` is
a plain-JS skeleton.

## The command path

A command from the host travels through five boxes. Each box has one job.

```
 host                 │  inside the Minecraft client (jsMacros services)
                      │
 bridge_ctl.py ──┐    │
                 ├─TCP:55544─► bridge.js ──GlobalVars──► main.js
 MCP server "mc" ┘    │                                    │ 1. HANDLERS  (built-in, screen.js)
                      │                                    │ 2. EXT       (ext.js plugins)
                      │                                    │ 3. passthrough
                      │                                    ▼  GlobalVars
                      │                                 worker.js ──tick──► Module
                      │                                                  (dist/__gerda_bot.bundle.js)
```

| Box | Role | Code |
|---|---|---|
| Host clients | Send newline-framed JSON requests and read the correlated reply | `scripts/ops/bridge_ctl.py`, `mcp/server.py`, `mcp/bridge_client.py` |
| bridge | Zero-logic TCP gateway: queues each request into `GlobalVars`, relays the reply | `harness/bridge.js` |
| main | Always-on supervisor: routes a command to a built-in handler, then to an ext plugin, then to the worker | `harness/main.js#dispatch`, routing rule `harness/safe-io.js#route` (TS twin `src/shared/harness/dispatch.ts#routeDispatch`) |
| ext | Hot-reloadable mod-API plugins (EMI, prospector, FTB Quests, camera…) | `harness/ext.js`, registry `harness/main.js#register` |
| eyes and hands | Screenshots and synthetic GUI input, merged into main's handlers | `harness/screen.js` |
| worker | Loads the bundle, calls `Module.command` and `Module.tick`, writes a heartbeat | `harness/worker.js#loadBundle`, `harness/worker.js#processCommand` |
| Module | The bot. Ours is built in `src/bot/entry/worker-bundle.ts#makeModule` | `src/bot/entry/worker-bundle.ts` |

The services share no module system. They talk only through `GlobalVars` keys, and every
key and envelope shape is defined once in `harness/ipc.js` (TS twin `src/core/ipc/ipc.ts`).
The wire protocol, the key tables and the tick pacing are in [IPC.md](IPC.md).

## The three tiers of `src/`

`src/` is layered **core < shared < bot**. An import may only point down a tier, so a fork
can take `core/` alone, or `core/` + `shared/`, without our bot.

| Tier | What lives there | Key entry points |
|---|---|---|
| `src/core/` | The only boundary over jsMacros and Java, the IPC envelope, dependency-free primitives. Pack-agnostic. | `src/core/runtime/Runtime.ts#Runtime`, real impl `src/core/runtime/jsmacros/index.ts#createJsMacrosRuntime`, mock twin `src/core/runtime/mock.ts#createMockRuntime`, SRG tokens `src/core/runtime/jsmacros/srg.ts` |
| `src/shared/` | The reusable engine: kernel, navigator, pure domain logic, config schema, reflexes, the harness twins | `src/shared/kernel/`, `src/shared/nav/`, `src/shared/domain/`, `src/shared/reflexes/`, `src/shared/config/schema.ts` |
| `src/bot/` | Gerda Bot: capabilities, missions, plans, the orchestrator, the pack profile, entry wiring. The only tier that knows GregTech. | `src/bot/capabilities/`, `src/bot/missions/`, `src/bot/plans/`, `src/bot/orchestrator/`, `src/bot/profile/`, `src/bot/entry/worker-bundle.ts` |

The defensive checker refuses an outward import: rule `no-outward-tier-import` in
`scripts/defensive-rules.ts#scanTierImports`, run by `scripts/check-defensive.ts` as part of
`bun run check`. The same checker holds the other reliability rules; they are listed in
[EXTENDING.md § Reliability rules](EXTENDING.md#reliability-rules-enforced-by-bun-run-check).

Domain code in `src/shared/domain/` takes plain data and never sees the runtime. Everything
that touches the game goes through the `Runtime` facade, so the whole kernel runs against the
mock in `test-ts/`.

## One tick of the bot

jsMacros fires a tick listener about 20 times a second. One pass, in order:

1. **Worker tick body** — `harness/worker.js`, the body passed to `IPC.paceTick`
   (`harness/ipc.js#paceTick`, which arms the next listener only after this one returns).
   It bumps the heartbeat, mirrors the render-thread-only reads that main.js publishes
   (world signature, nearby entities), runs at most one queued command through
   `Module.command`, then calls `Module.tick`, then drains the bundle's events into the
   shared event ring. A throw out of `Module.tick` halts the worker and publishes the fault.
2. **Kernel tick** — `Module.tick` is `src/shared/kernel/capability.ts#Kernel.tick`:
   - heartbeat guards run first and never preempt (`Kernel.runAlwaysGuards`; for example
     `src/bot/capabilities/telemetry.ts`);
   - with no mission running, only the survival reflexes run (`Kernel.runSurvivalGuards`),
     plus the handler of a safety landing phase, and the tick ends;
   - otherwise the always-on guards run in registration order, then the active mission's
     guards (`Kernel.runGuards`). The first guard that returns true ends the pass;
   - if no guard ended it, the handler for the current phase runs (`Kernel.runHandler`):
     the active mission's handler first, else an always-on one;
   - when the mission reports done, the mission sequencer picks what runs next;
   - last, the progress watchdog checks that the running phase advanced
     (`Kernel.checkProgress`, policies in `src/shared/kernel/progress.ts`).
3. **Reflexes** — the safety guards in `src/shared/reflexes/index.ts#reflexes`. The array
   order is the evaluation order, and `makeModule` registers them right after the lifecycle
   capability, so they run ahead of every other always-on guard and every mission guard.
   They divert only to the universal landings. Which reflexes run while idle:
   [SAFETY.md](SAFETY.md).
4. **Phases and transitions** — the bot's phase vocabulary and edges are data in
   `src/bot/profile/states.ts` (`STATE`, `TRANSITIONS`, `GLOBAL_EDGES`,
   `UNIVERSAL_TARGETS`, assembled as `GERDA_PHASES`). The kernel builds one
   `src/shared/kernel/fsm.ts#Fsm` from those edges plus each capability's and the active
   mission's `edges` (`Kernel.buildFsm`). An illegal transition throws
   `IllegalTransitionError`; a universal target is reachable from any phase.
5. **Capabilities, missions, plans** — a capability (`src/shared/kernel/capability.ts#Capability`)
   bundles a guard, per-phase handlers, commands and edges. A mission
   (`src/shared/kernel/mission.ts#Mission`, often built with `missionFromCaps`) is one goal
   machine; the kernel runs one at a time. A plan (`src/bot/orchestrator/plan.ts#Plan`) is
   data: an ordered list of mission steps. The orchestrator
   (`src/bot/orchestrator/index.ts#makeOrchestrator`) is an always-on capability that also
   installs the kernel's sequencer (`src/shared/kernel/sequencer.ts#MissionSequencer`).
6. **Navigator** — the only thing that moves the bot. Phase handlers call
   `src/shared/nav/executor.ts#greedyStep` once per tick through the `@/shared/nav` barrel
   (`src/shared/nav/index.ts`). Route planning and its caches are in
   `src/shared/nav/route.ts`, the pure planners in `src/shared/domain/planner.ts` and
   `src/shared/domain/dstar.ts`; the engine choice is the slice in
   `src/shared/nav/engine.ts`.

A capability or mission throw is caught once, at the kernel's dispatch boundary
(`Kernel.dispatch`). A throw from an always-on owner is a core bug and halts the worker; a
throw from a mission owner drops only that mission to ERROR.

## Data and config

| What | Where it lives | Code |
|---|---|---|
| Tunables | One typed schema with defaults; every tunable is there | `src/shared/config/schema.ts#DEFAULT_CONFIG`, merge `src/shared/config/schema.ts#makeConfig`, pack layer `src/bot/profile/config.ts#makeGerdaConfig` |
| Per-fork overrides | Optional, gitignored `config/local.overrides.json`, baked in at build time | `tsup.config.ts`, checked by `src/shared/config/schema.ts#assertConfigOverrideKeys`; how to use: [EXTENDING.md](EXTENDING.md#overriding-config-in-a-fork-without-editing-schemats) |
| Per-tick state | The `BotState` blackboard; capabilities keep typed scratch in slices | `src/shared/kernel/capability.ts#BotState`, `src/shared/kernel/slice.ts#defineSlice` |
| In-bundle events | A typed event bus between capabilities | `src/shared/kernel/bus.ts#Bus` |
| World model | `mc_world.json`, sectioned per world; each writer owns its own section | bundle side `src/shared/kernel/world-store.ts`, `src/bot/capabilities/persistence.ts`; service side `harness/world_store.js`; schema `src/shared/domain/world-model.ts` |
| IPC keys | `GlobalVars` keys between the services | `harness/ipc.js`, tables in [IPC.md](IPC.md) |
| Journal | NDJSON log file plus an in-memory ring; the `get_logs` command tails the file | `src/shared/kernel/logger.ts#Logger`, sink `src/bot/entry/worker-bundle.ts#makeSink` |
| Event ring | Whitelisted bus events, read with `poll_events` | `src/bot/capabilities/event-export.ts` |
| Metrics | Prometheus text, pushed on an interval when a push URL is set | `src/bot/capabilities/telemetry.ts` |

Ore data comes from generated files in `config/`; regenerate them with the `just` recipes
listed in the repo's `justfile` (`extract-ores-live`, `extract-ores`).

## Repo layout and where new code goes

| Directory | What it holds | Put here… |
|---|---|---|
| `src/core/` | The jsMacros/Java boundary (`runtime/`), the IPC envelope, dependency-free primitives | a new game verb: `Runtime.ts` first, then the real impl and the mock |
| `src/shared/` | The reusable engine | pure logic in `shared/domain/` with unit tests; movement in `shared/nav/` |
| `src/bot/` | Gerda Bot | behaviour in `bot/capabilities/` or `bot/missions/` |
| `harness/` | jsMacros services, deployed as-is (not bundled) | a mod-API bridge command in `ext.js` (hot-reloadable) |
| `mcp/` | The MCP server and the canonical bridge client | — |
| `scripts/` | Host tooling behind `./gerda` (see `scripts/README.md`) | ops and dev tools |
| `test-ts/` | vitest suites on the mock runtime | tests for everything in `src/` |
| `scenarios/` | Arena, bench and film-set specs (JSON) | a new in-game test arena |
| `examples/` | Runnable templates, basic → advanced | a worked example |
| `config/` | Generated ore table, optional local overrides | — |

## Where to go next

- [EXTENDING.md](EXTENDING.md) — add a mission, plan, capability or ext plugin; the SRG
  workflow; the `Runtime` facade contract.
- [BUILD_YOUR_OWN_BOT.md](BUILD_YOUR_OWN_BOT.md) — write your own bot on the harness, from
  primitives only up to the whole kernel.
- [IPC.md](IPC.md) — the bridge protocol, every `GlobalVars` key, tick pacing.
- [SAFETY.md](SAFETY.md) — the prevention, reaction and recovery tiers.
- [MISSIONS.md](MISSIONS.md) — every shipped mission, its params and outputs.
- [TESTING.md](TESTING.md) — the three test layers and what each git hook runs.
