# Missions

The reference for the bot's mission system. A **mission** is a pluggable goal
state-machine (`src/shared/kernel/mission.ts`). The kernel loads ALL missions into a
registry and runs **exactly one** at a time,
switchable at runtime with `mission_start` and no reload. A mission brings its own
`initialPhase`, `edges`, per-phase `handlers`, `params`, an optional completion check
(`isDone`) and result (`outputs`), plus `movementPhases` and `onAbort`. Reflexes (see
[SAFETY.md § Reaction tier](SAFETY.md#reaction-tier-survival-vs-mission-progress-reflexes))
and the global handlers (RECOVER, lifecycle) live in the kernel, mission-agnostic, and run
under every mission.

Drive missions over the bridge:

- `mission_start {name, params?}` — activate a mission by name (no reload).
- `mission_abort` — stop the active mission → IDLE.
- `mission_status` — log the active mission + phase.
- `missions` — log the registered mission names (each self-describes its `params`).

Coordinates in the examples below are placeholders: use your own chest's, furnace's or
destination's coordinates.

A **plan** (the orchestrator, `src/bot/orchestrator/`) chains missions into an ordered
sequence; a completed mission's `outputs` can feed the next step's params — see
[Mission chaining](#mission-chaining) below.

**Writing a new mission:** read [`docs/EXTENDING.md`](EXTENDING.md) § Writing a mission
(the two authoring styles, the facade contract, the SRG workflow). The worked template
is [`examples/advanced/patrol-mission.ts`](https://github.com/flamerix-ai/gerda/blob/main/examples/advanced/patrol-mission.ts) — a
complete, small mission that exercises every part of the contract.

## Contract notes that apply to all missions

- **Two authoring styles.** `missionFromCaps(name, caps, opts)` composes a mission from
  capability modules (their handlers/guards/edges merged) — used by `mine`, `chop`,
  `drill`. **Caveat:** the composed capability `init`s do NOT receive `mission_start`
  params, so a composed mission's params (e.g. `count`, `ore`) are read in the
  mission-level `init` and pushed into shared slices before the caps tick. All other
  missions are hand-written `Mission` objects (so their `init(ctx, params)` sees params).
- **Params are self-described** (a `ParamSpec` list: `name`/`type`/`required`/`desc`).
  Types are `string | int | float | bool`. Parsing is normalized via `_params.ts`
  (`parseIdList`, `intParam`, `intParamOr`, `toSet`).
- **`required` is a description, not an enforced gate here.** The coordinate missions
  (`goto`/`fetch`/`stash`/`interact`) parse x/y/z with the strict `intParam`; a
  missing/invalid coordinate leaves the target `null` and the first tick **finishes as a
  graceful no-op** (`*_GAVE_UP`/"no target"), it does not ERROR. `smelt`'s
  `output` is declared `required` but `init` defaults it to `""`.
- **The shared GOTO leg (`walkTo`, `_goto-leg.ts`).** Every "walk to a fixed stand, then
  arrive / time-out / give-up-when-blocked" phase uses this one driver (goto, fetch,
  stash, prospect, storage, loot-run, search). It owns the arrival radius
  (`cfg.nav.gotoArrivalDist`), the phase timeout (`cfg.nav.gotoTimeoutTicks`), the greedy
  step, and the `arrived | blocked_no_path` verdict; the caller supplies the
  arrive/blocked/timeout callbacks. It is a **column (Y-free), best-effort** approach: a
  block ends the leg, no ore-style dig escalation. `interact`, `hunt`, `follow` use
  bespoke legs (moving targets / interact-anyway-when-in-reach).
- **`movementPhases`** tells the reflex layer "movement here is bot-driven", so the
  stuck/human-input reflexes don't read greedy's own `key.forward` as a human takeover.
- **Tunables live in `src/shared/config/schema.ts`** — every default below that reads `cfg.*`
  resolves there.

## Registered missions

Only the 15 missions registered in `src/bot/entry/worker-bundle.ts` are documented.
`src/bot/missions/harvest/` is not a mission: it holds the shared ore and wood harvest
profiles that `mine`, `chop` and `drill` import.

| Mission | What it does | Key params |
|---|---|---|
| [`mine`](#mine) | Surface-mine ore: scan → walk → break + vein-follow, auto dump when full | `count` |
| [`drill`](#drill) | Dig a shaft to a cached prospector vein and strip-mine its volume | `ore` |
| [`chop`](#chop) | Fell trees: the mine loop with a wood harvest profile | `count` |
| [`fetch`](#fetch) | Walk to a chest and withdraw items | `x`,`y`,`z`,`items` |
| [`stash`](#stash) | Walk to a chest and deposit whitelisted items (fail-loud) | `x`,`y`,`z`,`items` |
| [`storage`](#storage) | Route items into the base storage network (drawers + chests) | `items` |
| [`loot-run`](#loot-run) | Sweep registered containers and take their contents | `items`,`near` |
| [`search`](#search) | Serpentine grid survey, recording containers to the world model | `cols`,`rows`,`step` |
| [`smelt`](#smelt) | Drive a furnace/machine: load, wait, collect (region-agnostic) | `output`,`input`,`fuel` |
| [`craft`](#craft) | Craft a recipe chain via manual grid placement | `chain`,`want` |
| [`goto`](#goto) | Walk to a fixed x/y/z, best-effort | `x`,`y`,`z` |
| [`prospect`](#prospect) | Walk to the nearest cached vein of an ore group | `ore` |
| [`hunt`](#hunt) | Seek → chase → melee huntable mobs | `count`,`targets` |
| [`follow`](#follow) | Trail a peer at a follow-gap (persistent) | `target`,`gap` |
| [`interact`](#interact) | Right-click a held item onto a block or item-frame entity | `x`,`y`,`z`,`item`,`profile` |

---

### mine

Surface-mining loop (`missionFromCaps`, composing `inventory`, `loot`, `scan`,
`navigation`, `mine`, `homeReturn`, `storage`). Scans for the configured ore, greedy-walks
to a reachable side-stand, breaks it and drains the local vein/layer cluster, sheds junk
and diverts HOME→DUMP→RETURN when the bag fills. Ore selection is **cfg-driven**
(`oreProfile(ctx.cfg)`) — there is no `ore` param.

| name | type | required | default | desc |
|---|---|---|---|---|
| `count` | int | no | `0` (unlimited) | stop after N ore broken (0/omit = mine until aborted/exhausted) |

**Phases:** `SCAN → GOTO → MINE` (with `LOOT` diverts and `HOME → DUMP → RETURN` on a
full bag), the full `TRANSITIONS` table. `movementPhases: {GOTO, HOME, RETURN, LOOT}`.
An unreachable ore is skipped, not fatal (`onBlocked: "skip"`): a `blocked` greedy verdict, or
a GOTO that advances no cell along its planned route for `cfg.nav.gotoStallTicks`
(`NAV_GOTO_STALL` — a detour that leads away first still advances), caches the target
and returns to SCAN. `chop` shares both.

**Completion:** `isDone` = `count > 0 && (broken ≥ count || exhausted)` — only a bounded
batch self-completes; an unlimited run never does (it parks at PAUSED when exhausted).
**Outputs:** `{ mined, origin, exhausted }`.

**Notable:** `onBlocked = "skip"` — when a dense patch walls off the walkable side-stand,
it caches that ore and re-scans for a reachable one instead of ERRORing the run (contrast
`drill`, which digs to it).

```
./gerda ctl send mission_start '{"name": "mine", "params": {"count": 64}}'
```

---

### drill

Dig to a prospected vein and strip-mine it (`missionFromCaps`, composing `navigation`,
`descend`, `digTo`, `excavate`, `mine`, `scan`). The HV prospector (ext.js `prospect`,
run first) caches veins as surface X/Z in `mc_world.json`; this mission reads the nearest
cached vein of the requested ore group, walks to its X/Z, digs a 1-wide shaft straight
down (DESCEND, real hammer) until the shaft exposes the ore, strip-mines the vein VOLUME
(EXCAVATE), and hands each exposed clump to MINE's vein-follow.

| name | type | required | default | desc |
|---|---|---|---|---|
| `ore` | string | no | via `drillProfile(cfg, …)` | ore group, e.g. `iron`/`gold` |

**Phases:** `GOTO → DESCEND → EXCAVATE ⇄ MINE`, with `DIG_TO` and `SCAN`.
`movementPhases: {GOTO, DIG_TO, EXCAVATE, DESCEND}` (DESCEND's step-1 walk-onto-marker is
a sustained bot-driven walk).

**Completion:** no `isDone` override — the mission **never self-completes**; it ends via
the graceful PAUSE at the end of the corridor plan, or abort. **Outputs:**
`{ mined, vein }`.

**Notable:** `onBlocked = "dig"` — when greedy can't WALK to the next ore (offset/above in
solid rock), it mines a staircase/tunnel to it (DIG_TO) rather than skipping. No cached
vein → a graceful PAUSE + `DRILL_NEEDS_PROSPECT` alert (recoverable by recharge + prospect
+ resume), not a hard ERROR. `warnIfMissingTool(pickaxe, ore)` warns loudly (not blocking)
if the bag can't harvest that ore's tier.

```
./gerda ctl send mission_start '{"name": "drill", "params": {"ore": "iron"}}'
```

---

### chop

Fell trees — the **same loop as `mine`** (`missionFromCaps` composing a `bagWatch`,
`loot`, `scan`, `navigation`, `mine`) with the WOOD harvest profile. Scans for logs,
walks, breaks, and diverts to LOOT so felled logs (which land 2-3 blocks away, outside
vanilla pickup range) are actually collected.

| name | type | required | default | desc |
|---|---|---|---|---|
| `count` | int | no | `0` (until none) | stop after N logs (0/omit = until none) |

**Phases:** `SCAN → GOTO → MINE` with `LOOT`. `movementPhases: {GOTO, LOOT}`.

**Completion:** `isDone` = `count > 0 && (broken ≥ count || exhausted)`. It deliberately
also completes on `exhausted` even with a count goal, so a bot in a treeless area (e.g. one
that respawned somewhere treeless) doesn't spin `CHOP_SCAN_EXHAUSTED` forever.
**Outputs:** `{ logs, exhausted }`. **onAbort:** release keys + nav stop.

**Notable:** `onBlocked = "skip"` — canopy logs past a safe-fall hazard veto are skipped,
not walled on (a forest has many trees). `bagWatch` ends a full-bag run gracefully via the
shared `exhausted` path. `warnIfMissingTool(axe)` (warn-only — felling without an axe works,
just slowly).

```
./gerda ctl send mission_start '{"name": "chop", "params": {"count": 16}}'
```

---

### fetch

Walk to a chest and withdraw items. Hand-written to demonstrate a mission authored
directly (shares nothing with `mine` except the kernel/reflex/GOTO layer).

| name | type | required | default | desc |
|---|---|---|---|---|
| `x` | int | yes | — | chest X |
| `y` | int | yes | — | chest Y |
| `z` | int | yes | — | chest Z |
| `items` | string | no | omit = all | ids to withdraw — JSON array `["minecraft:coal"]` or CSV; omit → withdraw all |

**Phases:** `GOTO → RESTOCK → IDLE` (RESTOCK is an internal `OPEN → WITHDRAW` sub-step).
`movementPhases: {GOTO}`.

**Completion:** `isDone` after a successful withdraw, immediately if there's no target, or
if GOTO gives up (no self-heal — one target). **Outputs:** none.
**onAbort:** close screen + nav stop.

**Notable:** RESTOCK must `useOnBlock` to open the chest GUI *before* reading its slots —
`rt.inv.open()` reflects only the currently-open screen. `stepOpen` is **fail-loud**: a
chest GUI that doesn't open within `cfg.containerOpenGraceTicks` → ERROR, never a silent
empty withdraw.

```
./gerda ctl send mission_start '{"name": "fetch", "params": {"x": 100, "y": 64, "z": 200, "items": ["minecraft:coal"]}}'
```

---

### stash

Walk to a single chest and deposit whitelisted items. The mirror of `fetch` for the
deposit direction; **fail-loud** on a rejected deposit.

| name | type | required | default | desc |
|---|---|---|---|---|
| `x` | int | yes | — | chest X |
| `y` | int | yes | — | chest Y |
| `z` | int | yes | — | chest Z |
| `items` | string | yes | — | ids to deposit — JSON array `["minecraft:raw_iron"]` or CSV |

**Phases:** `GOTO → STASH → IDLE` (STASH is an internal `OPEN → DEPOSIT → DONE`).
`movementPhases: {GOTO}`.

**Completion:** `isDone` after deposit, or immediately if there's no chest target / GOTO
gives up. **Outputs:** `{ deposited }`. **onAbort:** close screen + nav stop.

**Notable:** region-agnostic — shift-clicks (vanilla `quick`) carry slots whose id is on
the whitelist, highest slot first (so a compacting container doesn't shift indices), and
**verifies** the bag's count actually dropped. A silent `quick()` failure → `STASH_BLOCKED`
+ hard ERROR ("chest full or shift-click rejected"). `stepOpen` timeout → ERROR too.

```
./gerda ctl send mission_start '{"name": "stash", "params": {"x": 100, "y": 64, "z": 200, "items": ["minecraft:raw_iron", "minecraft:raw_copper"]}}'
```

---

### storage

Route items into the base **storage network** (kernel-native). Plans the
deposit across the registered storages, walks between them, and deposits by kind: drawers
(stand + aim slot quadrant + `useOnBlock` per stack) vs chests (open GUI + shift-click
auto-route).

| name | type | required | default | desc |
|---|---|---|---|---|
| `items` | string | yes | — | ids to deposit into the network — JSON array `["minecraft:raw_iron"]` or CSV |

**Phases:** `GOTO ⇄ STORE` (walk to each visit's stand, deposit, advance to the next).
`movementPhases: {GOTO}`.

**Completion:** `isDone` once all planned visits are exhausted (or immediately: nothing to
deposit, empty registry). **Outputs:** `{ deposited, unplaced }` (`unplaced` = ids the
planner couldn't route). **onAbort:** close screen + nav stop.

**Notable:** the client-sync boundary — drawers are read LIVE (`rt.storage.read`, contents
replicate client-side); chests/barrels are server-only headless, so they route from the
**recorded snapshot** in the registry and a chest visit writes back the updated snapshot
(the "chest with memory", capped at 27 slots). **Best-effort skip, not ERROR**: an
unreachable stand, a drawer slot rejecting an item after the grace window
(`STORAGE_DRAWER_BLOCKED`), or a chest GUI that won't open (`STORAGE_CHEST_NO_GUI`) all
skip and keep the item. The drawer AIM→USE is a deliberate 2-tick gap so the new rotation
flushes to the server before its use-raycast.

```
./gerda ctl send mission_start '{"name": "storage", "params": {"items": ["minecraft:iron_ingot", "minecraft:copper_ingot"]}}'
```

---

### loot-run

Sweep registered containers and take their contents. Greedy nearest-neighbour walk over
the container visit list, opening each and quick-taking (whitelisted or all).

| name | type | required | default | desc |
|---|---|---|---|---|
| `items` | string | no | omit = all | only take these ids — JSON array or CSV; omit = take everything |
| `near` | int | no | `null` (all) | only loot containers within this many blocks of the start |
| `breakBlocked` | bool | no | `false` | mine off a solid block capping a chest instead of skipping it (leaves a hole; opt-in) |

**Phases:** `GOTO ⇄ RANSACK` (RANSACK is `OPEN → TAKE → CLOSE`). `movementPhases: {GOTO}`.

**Completion:** `isDone` after the last visit (or immediately if no candidate containers).
**Outputs:** `{ taken, containers }`. **onAbort:** close screen + nav stop.

**Notable:** **never ERRORs** — an unreachable container, a chest that won't open, or a
full inventory all log and advance. Because the GUI is opened (client-synced), the
`recorded`/`looted` snapshot written back to `mc_world.json` is exact; `looted` means the
chest is truly empty (so a whitelist run doesn't permanently hide a chest holding other
items). Drawers are excluded from `LOOTABLE_KINDS` (they're the deposit target, not
loot). A chest capped by a solid block is skipped (`LOOT_BLOCKED`) unless `breakBlocked`
mines the cap.

```
./gerda ctl send mission_start '{"name": "loot-run", "params": {"near": 64}}'
```

---

### search

Serpentine (boustrophedon) grid survey that scans a cuboid at each stop and records any
containers found into the world model — feeds `loot-run`/`storage`.

| name | type | required | default | desc |
|---|---|---|---|---|
| `cols` | int | no | `cfg.search.cols` | grid columns |
| `rows` | int | no | `cfg.search.rows` | grid rows |
| `step` | int | no | `cfg.search.gridStep` | blocks between stops |
| `radius` | int | no | `cfg.search.scanRadius` | scan radius per stop |
| `height` | int | no | `cfg.search.scanHeight` | ± vertical scan reach |
| `x` | int | no | bot X | grid origin X |
| `z` | int | no | bot Z | grid origin Z |
| `lanes` | int | no | `1` | split columns across N bots |
| `lane` | int | no | `0` | this bot's lane index `[0..lanes-1]` |

**Phases:** `GOTO ⇄ SCAN` (walk to the next stop, voxel-scan spread over ticks, advance).
`movementPhases: {GOTO}`.

**Completion:** `isDone` when all grid points are visited/skipped (or the grid is empty).
**Outputs:** `{ found, stops }`. **onAbort:** nav stop.

**Notable:** even rows walk left→right, odd rows reverse — one continuous path. Multi-bot
lane striping keeps only columns where `c % lanes === lane`. The scan is budgeted
(`cfg.search.scanPerTick`) so it never storms `getBlock` in one tick. **Never ERRORs** —
an unreachable stop is logged and skipped (like `loot-run`).

```
./gerda ctl send mission_start '{"name": "search", "params": {"cols": 8, "rows": 8, "step": 16}}'
```

---

### smelt

Drive a furnace (or any single-input→single-output machine that honours shift-click) —
load, wait, collect. **Region-agnostic**: it never hardcodes slot/region names; loading
rides vanilla shift-click auto-routing and progress is read by matching the output item id
in the open screen's non-player slots.

| name | type | required | default | desc |
|---|---|---|---|---|
| `mode` | string | no | `full` | `full` (load+wait+collect) \| `load` (load & leave) \| `collect` (drain ready output) |
| `input` | string | no | `""` | raw item id to smelt; required for full/load, unused for collect |
| `output` | string | yes* | `""` | expected smelted id (e.g. `minecraft:iron_ingot`) |
| `fuel` | string | no | `null` | fuel item id (omit for electric/pre-fueled) |
| `count` | int | no | `0` | collect ≥ this many output (0 = the loaded batch) |
| `x` | int | no | use open screen | furnace block X |
| `y` | int | no | use open screen | furnace block Y |
| `z` | int | no | use open screen | furnace block Z |

\* `output` is declared `required` but `init` defaults it to `""` — no hard abort.

**Phases:** one kernel `SMELT` state driving an internal `OPEN → LOAD → WAIT → COLLECT →
DONE` step machine (with mode shortcuts). Stationary — **no `movementPhases`**.

**Completion:** `isDone` when the step machine reaches `DONE`. **Outputs:**
`{ smelted, collected }`. **onAbort:** close screen + release keys.

**Notable:** the three modes exist for the sustain loop — a furnace cooks server-side in a
loaded chunk whether or not the bot waits, so `load` shifts ore+fuel in and returns
immediately (the bot goes mining) and `collect` comes back to drain. Verify-convention on
LOAD (input must leave the bag, else `SMELT_LOAD_BLOCKED` → ERROR) and COLLECT (re-read the
output diff). Asymmetric GUI-lost handling: lost screen in OPEN/LOAD/WAIT → ERROR, in
COLLECT → best-effort finish. **Live-verified on a vanilla furnace only** — GTCEu machine
GUIs (macerator/EBF) are UNVERIFIED.

```
./gerda ctl send mission_start '{"name": "smelt", "params": {"mode": "full", "input": "gtceu:raw_iron", "output": "minecraft:iron_ingot", "fuel": "minecraft:coal", "x": 102, "y": 64, "z": 200}}'
```

---

### craft

Craft a recipe chain by **manual grid placement** (the Monifactory recipe-book API is
dead — each chain step carries its grid layout and the server computes the result).
Optionally places a crafting table for 3×3 steps.

| name | type | required | default | desc |
|---|---|---|---|---|
| `chain` | string | no | `cfg.craft.defaultChain` | JSON `[{grid:(id\|null)[], times}]` (default → chest from oak logs) |
| `table` | bool | no | `true` | place a table for the final step |
| `want` | string | no | `null` | conditional restock: target item id — skip (no-op) if ≥`min` already carried or materials short |
| `min` | int | no | `1` | want-mode threshold: craft only when carrying fewer than this many `want` |

**Phases:** one kernel `CRAFT` state driving an internal `CLOSE → PRE → PLACE_TABLE →
OPEN_TABLE → FINAL → DONE` step machine. Stationary — **no `movementPhases`**.

**Completion:** `isDone` when the step machine reaches `DONE`. **Outputs:**
`{ crafted, tablePos }`. **onAbort:** clear grid (returns items) + close screen + release
keys.

**Notable:** always enters via CLOSE (a prior aborted craft can leave a 3×3 table screen
open, corrupting a 2×2 recipe). Place→wait-a-tick→take is split because `craft_out` fills
the tick after placement. Placement and table-open are **effect-verified** (a "placed"
interaction can aim into the ground). Reuses an existing adjacent table before consuming
one. The `want`/`min` conditional-restock path is deliberately **skip-safe** (an
unattended loop must never stall/ERROR on it) — no-ops to DONE when already stocked or
materials short; a plain craft without `want` still fails loud on a bad recipe.

```
./gerda ctl send mission_start '{"name": "craft", "params": {"want": "minecraft:chest", "min": 1}}'
```

---

### goto

Walk to a fixed x/y/z, best-effort — the standalone form of `fetch`'s GOTO leg with
nothing after it (a plan chains it as "walk to the furnace bank" / "return to base").

| name | type | required | default | desc |
|---|---|---|---|---|
| `x` | int | yes | — | destination X |
| `y` | int | yes | — | destination Y |
| `z` | int | yes | — | destination Z |

**Phases:** `GOTO → IDLE`. `movementPhases: {GOTO}`.

**Completion:** `isDone` once `walkTo` resolves (arrive / timeout / blocked). **Outputs:**
`{ arrived }` (true only on `GOTO_ARRIVED`; false on any give-up). **onAbort:** nav stop.

**Notable:** column (Y-free) approach, best-effort — a block ends the trip (no ore-style
dig escalation). A missing target finishes the same tick (`GOTO_GAVE_UP`, `arrived:false`).

```
./gerda ctl send mission_start '{"name": "goto", "params": {"x": 100, "y": 64, "z": 200}}'
```

---

### prospect

Walk to the nearest un-mined cached vein of an ore group — the `goto` mission with a
dynamically-resolved target. Makes the sustain loop's "shaft" dynamic: reads the HV
prospector's vein cache and heads for the closest one.

| name | type | required | default | desc |
|---|---|---|---|---|
| `ore` | string | no | `cfg.sustain.oreKind` | vein kind to seek (a `PROSPECT_ORE_GROUPS` key) |

**Phases:** `GOTO → IDLE`. `movementPhases: {GOTO}`.

**Completion:** `isDone` the tick it arrives, times out, is blocked, or the cache is
empty. **Outputs:** `{ found, arrived, target }`. **onAbort:** nav stop.

**Notable:** an empty cache → `PROSPECT_EMPTY` + finish (`found:false`), so a plan can
branch (pause for a human to run the ext.js `prospect` scan) rather than stalling. Reads the
world-scoped model off disk to pick the nearest non-depleted vein.

```
./gerda ctl send mission_start '{"name": "prospect", "params": {"ore": "iron"}}'
```

---

### hunt

Seek → chase → melee huntable mobs. Picks the nearest huntable mob by uuid, greedy-walks
to its moving cell, and swings on cooldown when in reach.

| name | type | required | default | desc |
|---|---|---|---|---|
| `count` | int | no | `0` (until none) | stop after N kills (0/omit = until none) |
| `targets` | string | no | `cfg.hunt.targets` | override huntable ids — JSON array `["minecraft:cow"]` or CSV |

**Phases:** `SEEK → CHASE → STRIKE` (STRIKE → CHASE when the target moves out of reach,
→ SEEK when killed/lost). `movementPhases: {CHASE}`.

**Completion:** `isDone` when `kills ≥ count` (count > 0), or SEEK finds nothing after a
grace window (`cfg.hunt.seekGraceTicks`) — never ERROR. **Outputs:** `{ kills }`.
**onAbort:** greedy release + release keys + nav stop.

**Notable:** the mob feed is a render-thread snapshot (`world.mobs()`) bridged main→worker;
STRIKE is a crosshair `attack(uuid)` aimed by `lookAt` (no live entity ref off-thread), and
a kill is confirmed only by the target vanishing next tick. Best-effort sword auto-equip
(fists work). No explicit LOOT phase — a kill-spot linger lets vanilla auto-pickup grab the
drops. SEEK tolerates transient empty snapshots (publish cadence race) before declaring
done.

```
./gerda ctl send mission_start '{"name": "hunt", "params": {"count": 5, "targets": ["minecraft:cow"]}}'
```

---

### follow

Trail a peer at a follow-gap so the bot walks WITH them rather than shoving into them. It
uses the fleet peer sensor. **Persistent** — runs until halted.

| name | type | required | default | desc |
|---|---|---|---|---|
| `target` | string | no | `null` (nearest) | peer username to follow (e.g. `Steve`); omit = nearest player/bot |
| `gap` | int | no | `cfg.follow.gap` | hold this many blocks back |

**Phases:** single `FOLLOW` phase. `movementPhases: {FOLLOW}`.

**Completion:** `isDone` **always false** — only `halt`/`stop`/abort ends it. Losing the
peer stands and re-acquires (by uuid, falling back to name/nearest), it does not end the
mission. **Outputs:** `{ target }`. **onAbort:** greedy release + release keys + nav stop.

**Notable:** the target feed is the render-thread peer snapshot (`world.peers()`) bridged
main→worker. Hysteresis (a comfort band around `gap`) prevents walk/stop stutter when the
leader stands still. A custom `progress` policy exempts the stall watchdog whenever the bot
is holding/waiting (a deliberate hold ≠ a wedge) and only watches feet while actively
driving. **Never ERRORs.**

```
./gerda ctl send mission_start '{"name": "follow", "params": {"target": "Steve", "gap": 3}}'
```

---

### interact

Right-click a held item onto a target block or item-frame entity — the mission-shaped
counterpart of the storage drawer's look-aimed use and the `interact_place` ext primitive.

| name | type | required | default | desc |
|---|---|---|---|---|
| `x` | int | yes | — | target block X |
| `y` | int | yes | — | target block Y |
| `z` | int | yes | — | target block Z |
| `item` | string | no | keep held | item id to hold + place |
| `face` | string | no | toward the bot | face to right-click |
| `profile` | string | no | (resolved) | target kind: `frame` \| `display` \| `generic` |
| `verify` | string | no | (profile default) | override verify: `consumed` \| `none` |

**Phases:** `GOTO → INTERACT → IDLE` (INTERACT is an internal `AIM → USE → VERIFY`).
`movementPhases: {GOTO}`.

**Completion:** `isDone` on a successful VERIFY (`INTERACT_DONE`) or any give-up
(`INTERACT_GAVE_UP`). **Outputs:** `{ placed }`. **onAbort:** nav stop.

**Notable:** the `frame` profile targets a vanilla item-frame **entity** (not a block):
AIM resolves the nearest frame uuid via `world.frames()` (the `mc_frames` bridge) and USE
calls `useOnEntity` — no frame found → fail loud (never a silent block click).
`display`/`generic` go through `useOnBlock`. AIM/USE straddle a tick boundary (rotation
must flush first); VERIFY waits `cfg.interact.graceTicks` (server-authoritative). GOTO has
a blocked-but-in-reach fallback — if already within `cfg.interact.reach`, it interacts
anyway.

```
./gerda ctl send mission_start '{"name": "interact", "params": {"x": 100, "y": 65, "z": 200, "item": "minecraft:diamond", "profile": "frame"}}'
```

---

## Mission chaining

The kernel consults exactly one **`MissionSequencer`** (`src/shared/kernel/sequencer.ts`) when a
mission completes (`isDone → true`). The default `IDLE_SEQUENCER` collapses to IDLE; the
**orchestrator** (`src/bot/orchestrator/`, an always-on capability wired in
`worker-bundle.ts`) installs its own sequencer to run **plans** — ordered lists of mission
steps. It drives `kernel.startMission`/`abortMission` for everything, preserving the
single-active-mission invariant (it is not itself a mission).

A plan step names a mission plus optional params, guards, drive mode and control flow
(loop, retry, branch); the complete step shape is in
[EXTENDING.md § Writing a plan](EXTENDING.md#writing-a-plan-orchestrator). Each step runs
autonomously (`mode: "auto"`) or waits for an operator command
(`proceed`/`run`/`step`/`select`), gated on the step's `guards` (e.g.
`inventoryHasRoom(0.9)`). A typo'd mission name parks the plan in `failed`.

**Outputs feed the next step's params.** A step's `params` may be a static object OR a
`ParamBinding` — `(prev) => params`, where `prev` is the just-completed mission's
`outputs(ctx)` (captured before teardown). This is how `mine`'s `{ mined, origin }` or
`prospect`'s `{ target }` can bind into the following step.

Registered plans (built in `worker-bundle.ts`): `gather-and-mine` (`chop` → `mine`),
`sustain-mine-smelt`, and the dynamic `sustain-cycle` (mine → return → collect → load →
craft → store → prospect, looping via `next: () => 0`). Drive plans with:

```
./gerda ctl send plan_start '{"name": "gather-and-mine"}'
./gerda ctl send run          # flip to auto, drain to completion
./gerda ctl send plan_status  # cursor + blocked reason + active mission
./gerda ctl send plans        # the registered plan names
```

`plan_status` replies with `result.data` = `{plan, cursor, status, blockedReason,
currentStep, activeMission, phase}`, and logs the same fields as `ORCH_STATUS`.

See [`docs/EXTENDING.md`](EXTENDING.md) for authoring plans and the guard/`ParamBinding`
API.
