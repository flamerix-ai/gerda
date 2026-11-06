# Extending Gerda Bot

A practical guide to growing **our reference bot** (Gerda Bot): writing missions,
plans, capabilities, and bridge commands, plus the SRG-mapping workflow for new
jsMacros/Forge calls. Read this before adding a feature — it points you at the right
layer and the existing patterns to copy. Writing your OWN bot on top of the harness
instead — not extending ours? See [Build your own bot](BUILD_YOUR_OWN_BOT.md).

## The two planes (pick the right one)

| | **Mission plane** (`src/`, bundled TS kernel) | **Primitive plane** (`harness/`, jsMacros services) |
|---|---|---|
| What | Deterministic FSM: missions, capabilities, reflexes | Bridge commands an operator (a script, you, or an LLM over MCP) calls directly over TCP |
| Sees the world via | the `Runtime` facade only (`src/core/runtime/Runtime.ts`) | full jsMacros/Java (`Java.type`, `Client`, mod APIs) |
| Can | break/scan/move/place/use/craft/move-stacks (whatever the facade exposes) | anything — screenshots, GUI clicks, EMI ([Eyes & hands](EYES_HANDS.md)), `jeval` |
| Can't | call bridge primitives; touch raw Java | run a tight per-tick control loop |
| Add by | a new mission/capability + `bun run check` | a new `ext.js` plugin + `reload_ext` |

Rule of thumb: a **steady-state goal loop** (mine until full, fell a tree) is a
**mission**. A **one-shot operator action** (look up a recipe, click a GUI, drive a
recipe book) is a **primitive** (ext.js / `jeval`). When the kernel needs a new world
verb (place a block), add it to the **facade** (below) so missions can use it.

## Writing a mission

A `Mission` (`src/shared/kernel/mission.ts`) is a pluggable goal state-machine; the kernel
runs ONE at a time, swapped at runtime via `mission_start` with no reload. The
[missions reference](MISSIONS.md) catalogs the shipped ones (params, outputs, phases);
`examples/advanced/patrol-mission.ts` is a copy-ready hand-written template
(`examples/` is leveled basic → intermediate → advanced). Two ways to build one:

- **`missionFromCaps(name, caps, opts)`** — compose from capability modules (handlers/
  guards/edges/commands merged). Best when behavior splits into focused concerns. See
  `src/bot/missions/mine/index.ts` (scan/navigation/mine/loot/…). **Caveat:** the composed
  `init` does NOT receive `mission_start` params — use this only when config, not
  params, drives the mission.
- **Hand-written `Mission` object** — when you need `init(ctx, params)`. See
  `src/bot/missions/fetch/index.ts` (simplest), `src/bot/missions/chop/index.ts` (a full
  SCAN→GOTO→MINE loop), `src/bot/missions/craft/index.ts` (a stationary sub-stepped
  sequence).

A mission declares:
- `initialPhase` + `edges` (a `PartialTransitionTable<State>` — only the phases it
  uses; `GLOBAL_EDGES` + `UNIVERSAL_TARGETS` are merged in by the kernel).
- `handlers: { PHASE(ctx) {…} }` — one per phase it owns.
- `movementPhases` — phases where the navigator drives motion (reflexes use this so they
  don't read the bot's own movement as human input).
- `init?(ctx, params)`, `isDone?(ctx)` (→ the sequencer decides what's next),
  `outputs?(ctx)` (data the next plan step can bind to), `onAbort?(ctx)`.
- optional `guards` (mission-scoped pre-dispatch middleware) and `commands`.

Steps to add one:
1. If it needs a new phase, add it to `STATE` in `src/bot/profile/states.ts` (like `CRAFT`/
   `RESTOCK`) and list its edges in the mission's `edges` table. Mission-internal
   phases are NOT universal targets.
2. Keep per-mission scratch in a typed blackboard slice: `defineSlice<T>("name", init)`
   then `ctx.slice(KEY)`. The global blackboard survives mission switches, so **reset
   your slice in `init`** (see `resetChop`).
3. Put pure logic in `src/shared/domain/` (jsMacros-free, unit-tested); the handler only wires
   the facade to it. Tunables go in `src/shared/config/schema.ts` — a magic number in a
   handler is a bug.
4. Register it in `src/bot/entry/worker-bundle.ts`: `.registerMission(myMission)`.
5. Test it on the mock in `test-ts/` (drive `kernel.tick(st)`; see
   `chop-mission.test.ts` for the GOTO-teleport + `flushBreak` loop pattern).

## Overriding config in a fork (without editing schema.ts)

To tune tunables in a fork without touching `src/shared/config/schema.ts`, drop an OPTIONAL
`config/local.overrides.json` — a deep-partial `ConfigOverrides` blob,
e.g. `{ "nav": { "sprint": false } }` — then rebuild. `tsup` bakes it into the bundle
(esbuild `define`), and `makeConfig` merges it one level deep per section (siblings kept).
The file is **gitignored** (per-fork, not shared); absent → the build is unchanged. An
unknown top-level key fails loudly (a malformed/non-object file fails the BUILD; a valid
JSON object with a bad section key throws a `ContractError` at bundle init, naming the key).

## Writing a plan (orchestrator)

A `Plan` (`src/bot/orchestrator/plan.ts`) is DATA: `{ name, steps, defaultMode? }`, an
ordered list of `MissionStep`s the orchestrator chains. This table is the complete step shape:

| field | meaning |
|---|---|
| `mission` | registered mission name; an unknown name parks the plan in `failed` |
| `params?` | a static object, or a `ParamBinding` `(prev) => params` that feeds the previous step's `outputs` into this one |
| `guards?` | `StepGuardSpec[]` checked before the step starts; a failing guard parks the plan in `blocked` (the reason shows in `plan_status`) |
| `mode?` | `"auto"` chains on completion; `"approve"` parks for a `proceed`/`run` command. Default: the plan's `defaultMode`, else `"auto"` |
| `id?` | label for `select {step:"<id>"}` jumps and for branch targets |
| `repeat?` | loop: run the step up to N times on success before advancing (default 1) |
| `repeatWhile?` | loop-until: a guard; re-run the step on success while it passes (overrides `repeat`) |
| `retries?` | retry: re-run the step up to N times when its mission ends in ERROR (default 0) |
| `next?` | branch on success: `(prev) => id`, index, `null` or `undefined`; `null` finishes the plan, `undefined` advances to the next step |
| `onFail?` | branch on failure: the step id/index to jump to once `retries` are spent; absent → the plan fails |

Guards: `src/bot/orchestrator/guards.ts` (`hasItems`, `inventoryHasRoom`) and
`src/bot/orchestrator/sensors.ts` (`veinExhaustedGuard`, `lowStockGuard`). Define plans in
`src/bot/plans/*.ts`, register in `worker-bundle.ts` (`makeOrchestrator(kernel, [myPlan])`).
Drive over the bridge: `plan_start`, `proceed`/`continue`, `run`, `step`, `select`,
`plan_status`, `plans`, `plan_abort`.

The orchestrator is an always-on capability that also installs the kernel's
`MissionSequencer` (`src/shared/kernel/sequencer.ts`) — the single hook consulted on mission
completion. The default `IDLE_SEQUENCER` just goes IDLE; nothing else changes the
single-active-mission invariant.

## Writing a capability

A `Capability` (`src/shared/kernel/capability.ts`) is a self-describing plugin: `edges?`,
`guard?(ctx)` (pre-dispatch middleware; return true to short-circuit), `handlers?`,
`commands?`, `init?`, `requires?` (resources resolved before its guard). Register
ALWAYS-ON ones (lifecycle/reflexes/persistence/hud/telemetry/mission-control/
orchestrator) with `kernel.register(cap)` — they survive mission swaps. Set
`always: true` for a heartbeat guard that runs even while idle (telemetry). Mission-
scoped caps go through `missionFromCaps`. Reflexes live in `src/shared/reflexes/` and only
target universal landings (RECOVER/PAUSED/ERROR).

The always-on capabilities Gerda Bot registers, in `makeModule()` of
`src/bot/entry/worker-bundle.ts`, after the reflexes ([SAFETY.md](SAFETY.md)). Each lives in
`src/bot/capabilities/` except the orchestrator (`src/bot/orchestrator/index.ts`); their
commands are listed in [COMMANDS.md](COMMANDS.md).

| Capability | What it owns |
|---|---|
| `core` | The lifecycle commands `start`/`pause`/`resume`/`halt` and the shutdown teardown (keys released, Baritone stopped, HUD cleared). |
| `maintenance` | Resumable interrupts that suspend the exact phase and resume it (`EAT`). |
| `recover` | The `RECOVER` landing every reflex diverts to: release keys, teleport home, re-enter the mission. |
| `persistence` | Durable waypoints and run stats in `mc_world.json`; `add_waypoint`, `remove_waypoint`, `save_now`, `goto_waypoint`. |
| `hud` | The status overlay: phase, held-tool durability, waypoint and vein counters. |
| `telemetry` | Prometheus counters and gauges, pushed when `cfg.telemetry.pushUrl` is set; `metrics`. |
| `diagnostics` | The live facade `smoke` test, `trace`, `storage_probe`, and the one-tick `greedy_to`/`greedy_stop`. |
| `navProbe` | A per-tick greedy-navigator test drive while idle or paused: `greedy_drive`, `nav_trace`, `set_arrival`/`set_dstar`/`set_timeout`. |
| `navEngine` | `nav_engine`: the runtime navigator-engine override for production GOTO. |
| `sensors` | `sensors`: a read-out of what the sustain-loop guards see (vein exhaustion, item stock). |
| `event-export` | Mirrors the whitelisted bus events into the ring that `poll_events` drains. |
| `mission-control` | `mission_start`, `mission_abort`, `mission_status`, `missions`. |
| `chat-command` | In-game `!<bot> <verb>` driving; the trust list is off by default. |
| `orchestrator` | Chains missions into plans and installs the mission sequencer; the plan commands. |

## Growing the harness (main.js / ext.js)

`main.js` is **stable infra** — rarely edited. New mod commands go in **`ext.js`**, the
reloadable plugin layer. Each plugin self-registers:

```js
register("my_cmd", function (req, id) {
  // req = the parsed JSON command; return a plain object (becomes the response data)
  return { ok: true, foo: 42 };
}, { where: "ext", desc: "one line: what it does", params: [{ name: "x", type: "int", required: true }] });
```

Globals available to plugins: `Java, World, Player, Hud, Chat, Client, KeyBind,
JavaWrapper, writeResp, register`. Iteration loop: **edit ext.js → `./gerda sync` →
`reload_ext`** (re-evals into a fresh `EXT` registry, rollback-on-error, NO main
restart). Removed/renamed commands disappear on reload. Each plugin carries its own
"how this was derived" SRG/reflection comment. The meta is the command's row in [COMMANDS.md](COMMANDS.md): after adding or changing one, run `just commands-ref`.

To add a container meta-command (eyes/hands/eval-class), it goes in `main.js` HANDLERS;
after editing + `./gerda sync`, send **`reload_main`** (defers a `restartService`, so the
response flushes first; the worker keeps running). A running main.js that does not know
`reload_main` yet needs one bootstrap restart. Send this as `jeval`; the restart runs on a
background thread, so the render thread never blocks:

```js
new java.lang.Thread(JavaWrapper.methodToJava(function () {
  java.lang.Thread.sleep(1000);
  JsMacros.getServiceManager().restartService("main");
})).start()
```

After that restart, `reload_main` works.

## SRG-mapping workflow (calling vanilla/Forge methods)

Forge 1.20.1 obfuscates vanilla method names to SRG (`m_6375_` etc.); jsMacros'
*wrapper* classes are NOT remapped (call them by real name). So:

- **jsMacros-wrapped API** (`Player.getInteractionManager().interactBlock(...)`,
  `Player.getPlayer().lookAt(...)`, `World.getBlock(...)`) → call by name, **no SRG**.
  Declare the method in `types/jsmacros.d.ts` so the facade can use it.
- **Raw vanilla `Screen`/client internals** (GUI clicks, key events, recipe book) →
  need the **SRG name**. The runtime uses **Mojang class names but SRG member names**
  (`LocalPlayer.respawn()` is called as `m_7583_`, `Options.keyUse` is `f_92095_`). Find
  the name with these tools, in order:
  1. **`scripts/dev/srg.py` — offline name resolver (start here).** Composes the launcher's
     on-disk mapping files (no download, no in-game risk):
     - `srg.py LocalPlayer respawn` → `m_7583_` (Mojang member → SRG; lists overloads with
       descriptors; falls back to a global search if the member is inherited).
     - `srg.py --rev m_7583_` → `LocalPlayer.respawn()` (SRG → Mojang).
     - `srg.py --class FoodData` → the class's full Mojang↔SRG table.
     With a **ParchmentMC export** present (`mappings/parchment-*.json`), lookups gain
     **parameter names** + **javadoc**: `srg.py AbstractContainerMenu clicked` →
     `m_150399_  # …clicked(int slotId, int button, ClickType clickType, Player player)`.
     Parchment release `2023.09.03` is the final one for 1.20.1. Download it once into
     `mappings/` (the `srg.py` docstring has the one-liner) and the index picks it up.
     Don't find a name by calling candidate `m_…_` names in-game: the call runs on the
     render thread and can trip the EventLockWatchdog (and drop the world).
  2. **`reflect {expr, filter?, depth?, mojang?}`** over the bridge (ext.js) — evaluate
     any expression and dump its runtime class's **method signatures** + fields, with each
     SRG name **annotated with its Mojang name + Parchment param names** (`m_38707_(int,float):void
     →eat(foodLevelModifier, saturationLevelModifier)` — runtime TYPES, Parchment NAMES) via
     `srg_names.json` (exported by `srg.py --export`, deployed by `gerda sync`). The live
     companion to `srg.py`: `reflect {expr:"Player.openInventory()", filter:"craft"}`,
     `reflect {expr:"Java.type('dev.emi.emi.api.recipe.EmiRecipe')"}`. `mojang:false` to skip.
  3. **Read the source** when you need to know what a method *does* (not just its name):
     `scripts/dev/decompile.sh mc` (decompiles the MC client jar with Vineflower) or
     `scripts/dev/decompile.sh mod <name>` (any mod, e.g. `emi`/`gtceu`), then
     `rg -n 'PATTERN' decompiled/…`. The output is Mojang-named: SRG member tokens are
     rewritten through `srg.py --remap` (`--raw` keeps them SRG). Output is gitignored. Needs
     the flake dev shell (it provides `vineflower` + `jdk21`).
  4. **Signature on mappings.dev / Linkie** under the owning class (web fallback), or
     cross-check the names already in `main.js`'s `SRG` map. In `src/`, the one home for SRG
     tokens is `src/core/runtime/jsmacros/srg.ts`; add a new one there.
- **When even that won't reach it** (obfuscated client internals jsMacros doesn't
  wrap, e.g. the recipe book): use a **`jeval` bridge primitive** with reflection, and
  prove it live with a probe (`harness/probes/probe_runtime.js`) BEFORE relying on it. Crafting
  is an example: the recipe-book API does not work on Monifactory, so the facade crafts through
  manual grid placement.

  In `jeval`, don't paste raw SRG tokens (they rot on a version bump and read as
  noise). ext.js exposes a global **`srg(class, member)`** (and `srgAll` for overloads)
  that inverts `srg_names.json`, so you call vanilla methods by their Mojang name:
  `var raw = Player.getPlayer().getRaw(); raw[srg('Player','getFoodData')]()[srg('FoodData','getFoodLevel')]()`.
  `srg()` throws if the name is unknown (fail-loud); inherited members resolve under
  their DECLARING class (`srg('LivingEntity','getMainHandItem')`, not the subclass). It
  reloads with `reload_ext` (same JS context as jeval).

  Regenerate the `reflect` annotation map after a version change:
  `python3 scripts/dev/srg.py --export harness/srg_names.json` then `just sync`.

## The Runtime facade contract

`src/core/runtime/Runtime.ts` is the ONLY abstraction over jsMacros. Any new world verb:
1. add the method to the `Runtime` interface (`Runtime.ts`);
2. implement it for real in `src/core/runtime/jsmacros/` (the ONLY code that touches the
   globals and the only place allowed `try/catch`, inside `attempt`/`fx`);
3. implement it in `src/core/runtime/mock.ts` (in-memory) — **the build fails until you do**,
   which is what keeps the mock from drifting;
4. declare any new jsMacros method it calls in `types/jsmacros.d.ts`.

`Result<T>` semantics: an `err` means a REAL external failure — never fabricate a
fallback a caller could mistake for data. Callers branch on `.ok` (the defensive
checker forbids dropping a `Result`). The `interact` group in `Runtime.ts` is a good example.

## The verify-convention (effect-check critical actions)

`Result<T>` is a contract on the **call** (it returns `err` on a real failure). It is
NOT a contract on the **effect** — a fire-and-forget action can return `ok` yet not
change the world (a bite the render thread dropped, a `/home` on cooldown, a deposit
into a full chest). For the handful of **irreversible / expensive / autonomy-critical**
actions, add a lightweight effect-check; do NOT build a framework or check every action
(pure reads and cheap-to-retry writes don't need it).

The convention, in a tick-driven handler:
1. **snapshot** the relevant state before the action (food level, position, slot counts);
2. **act**;
3. once settled, **read the state back and compare** — emit an effect-verified event /
   log on success, and a **WARN** on the failure case (never proceed silently).

Worked examples (copy these):
- `maintenance.EAT` — bites until `player.food() ≥ target`, emits `ate`; WARNs `EAT_TIMEOUT`
  / `EAT_OUT_OF_FOOD` when food does not rise.
- `recover.RECOVER` — presses respawn until `player.alive()`, emits `respawned`.
- `home-return.HOME/RETURN` — snapshots XZ, then WARNs `TELEPORT_NO_MOVE` if the player
  didn't move ≥ `cfg.teleportMinMoveBlocks`, so a failed `/home` never proceeds at the
  wrong spot.
- `storage.DUMP` — re-reads the bag after depositing and WARNs `DEPOSIT_INCOMPLETE` if ore
  remains, so a full chest shows up in the log instead of looping.
- `craft` — takes the **server-computed** yield (`craft.take()` returns the real count)
  and `isDone` checks the inventory count reached the goal.

The live `smoke` harness (`diagnostics.ts`) is the build-time companion: it exercises the
raw-Java facade methods in the worker context so a broken effect path is caught by
`scripts/ops/facade_smoke.py` before a real run, not mid-combat.

## Reliability rules (enforced by `bun run check`)

`bun run check` = `tsc` + `biome` + `vitest` + `check-defensive`. The defensive checker
forbids, outside designated boundaries: `try/catch`, `as` casts, empty catches, dropped
`Result`s. The versioned git hooks (`just hooks`) run it as the gate; what each hook runs:
[TESTING.md](TESTING.md). Escape hatch: a `// reliability-ok: <reason>` comment on the line (used e.g.
for the orchestrator's plan-input boundary, since it dispatches as owner=core and a bad
plan must not become a `CoreFatalError`). Prefer `must()` / a type guard over a cast.

## Bundle size budget

`scripts/ops/sync.py` refuses to deploy a bundle longer than `MAX_CODE_LEN` characters
(`just validate-bundle` and the pre-push hook run the same check). It is a review budget, not
a runtime limit: `worker.js` eval-loads the bundle with no length check, and GraalJS evaluates
far larger code. The budget exists so that bundle growth is a decision someone writes down.
The comment above `MAX_CODE_LEN` lists every raise and what it paid for.

The budget is 1 MiB (1048576 characters); the full Gerda Bot bundle is about
592000, so a fork has roughly 450000 characters of room for its own capabilities and missions.
`just validate-bundle` prints `<size>/<budget>`. When your change goes over, either trim it or raise
`MAX_CODE_LEN` and add one line to that comment naming what grew. The separate 256000 cap in
`harness/main.js` limits the snippets the `eval` bridge command accepts; it does not apply to
the bundle.

## Deploy / verify loop

- `just build` / `bun run build` — tsup → `dist/__gerda_bot.bundle.js` (IIFE).
- `just sync` / `bun run deploy` — build + deploy bundle + services to game instances.
- Kernel/bundle change → full redeploy (worker re-evals the bundle). `ext.js` change →
  `reload_ext`. `main.js` change → `reload_main`.
- Inspect a live bot via the `mc` MCP tools (`mc_ping`/`mc_get_state`/`mc_send`) or
  `python scripts/ops/bridge_ctl.py …` (also `./gerda ctl …`, the repo-root umbrella CLI
  that dispatches to the `scripts/ops`+`scripts/dev` tools). Use `get_logs` to read the
  NDJSON journal between steps (e.g. `ORCH_*`, `MISSION_*`, `LOG_FOUND`, `CRAFT_*`).
