# Safety architecture — prevention / reaction / recovery

The bot's self-preservation is **three concerns that cannot overlap by construction**. When you
add a mission or a guard, decide which tier it belongs to — putting one concern in the wrong tier
is what creates conflicts and dead code.

| Tier | Owns the question | Scope | When it runs | Where it lives |
|------|-------------------|-------|--------------|----------------|
| **Prevention** | "Will I *choose* to commit to something fatal?" | self-movement / self-actions only | plan-time | planner (`shared/domain/planner.ts`, `movement-types.ts`), mission-specific guards (e.g. drill `floorVerdict`) |
| **Reaction** | "Is something hurting me *right now*?" | any cause, incl. external (OP `/tp`, mob, lava) | every tick | the **reflex layer** (`shared/reflexes/`) |
| **Recovery** | "Get to safety + respawn" | terminal landing | on a reflex divert / death | `bot/capabilities/recover.ts` (the `RECOVER` phase) |

Prevention is plan-time & self-only; reaction is runtime & cause-agnostic; recovery is the landing
every reaction diverts to. A given piece of logic belongs to exactly one.

## The rule that prevents duplicated dead code

> **Missions may PREVENT (proactive, task-specific), but must NOT re-implement REACTION.**

- ✅ The drill refusing to open a shaft floor over water or a fatal drop (`floorVerdict` in
  `bot/missions/drill/floor-safety.ts`)
  is **Prevention** — task-specific, stays in the mission. It is a *different* concern from the
  global `swimOut` / `waterClutch` reflexes (the *reaction* if prevention fails). That is
  defense-in-depth, **not** duplication.
- ❌ A mission with its own `if (health < X) teleport()` would duplicate the `vitals` reflex — that
  is dead **Reaction**. Delete it and let `vitals` own it (the `tool` reflex owns worn tools).

If you catch yourself writing a health/air/fall *reaction* inside a mission, stop — it belongs in a
reflex, where it runs for **every** mission and for the idle bot too.

## Reaction tier: survival vs mission-progress reflexes

Reflexes run before mission logic each tick, first-to-fire preempts. They split by an explicit
`survival` flag on the capability (`shared/kernel/capability.ts`):

- **`survival: true`** — life-preservation. Runs **even when no mission is active** (a parked/IDLE
  bot must not bleed out), via the kernel's idle survival pass. Members: `death` (respawn), `air` +
  `swimOut` (don't drown), `waterClutch` (survive falls), `vitals` (HP floor + distress). If one
  diverts, `RECOVER` runs in the idle path too, so an idle bot fully recovers (incl. teleport).
- **mission-progress** (no flag) — only meaningful with a task, so gated on `st.running`: `tool`
  (hot-swap), `stuck` (stuck *relative to a nav goal*), `hazard` (feet in the void, lava or fire →
  `RECOVER`), `hunger`, `human` (yield the mission).

This is the complete reflex list (`src/shared/reflexes/index.ts`). Evaluation order is
`death → vitals → air → waterClutch → swimOut → tool → stuck → hazard → hunger → human`.

This is deliberately **not** "run everything when idle" — only the five survival reflexes do. A
broken tool on an idle bot does nothing; a drowning idle bot saves itself.

### Anti-false-positive: confirm before teleporting an idle bot

A survival divert to teleport-`RECOVER` must be **confirmed**, never a one-tick spike:

- `vitals` **distress** requires **repeated damage** — `≥ cfg.safety.distressMinEvents` distinct damage ticks
  within `cfg.safety.distressWindow`, not just "lost N HP". A single survived fall is *one* event → never trips
  (so an idle bot that took a fall but is now fine doesn't teleport for nothing); sustained drown /
  lava / suffocation racks up events → escapes.
- The `cfg.safety.minHealth` floor fires immediately (you don't reach it from a glitch).
- `RECOVER` mitigates **in place first** (surface via jump) and only teleports once on stable
  footing — a transient threat stabilises and never escalates.

### Below the reflexes: held keys while the worker tick blocks

Every reflex and every navigator veto runs inside a worker tick. A key that the bot holds stays
held while a worker tick runs, so a tick that blocks lets the body walk with no check at all. In
RCA I-4 a `goto` across a hollow-tower roof ran one synchronous extend-replan for about 25 s.
Forward and sprint were still held from the previous step, and the bot walked off a 39-block
rim. Two layers stop this:

1. **Release before a blocking replan.** The executor releases the movement keys before each
   run of an A* search (`releaseForBlockingWork` in `shared/nav/core.ts`). The drive after the plan
   presses again what the new route wants. The airborne hold puts the released keys back,
   because it keeps the heading through a fall.
2. **Movement-key dead-man in main.js.** main.js ticks on its own thread. When the worker
   heartbeat (`mc_worker_alive`) does not change for `DEADMAN_STALE_TICKS` (10) main ticks,
   main.js releases the movement, jump, sprint and sneak keys once for that stall. It also
   stops the forced sprint and writes a `DEADMAN` record to the journal, which `get_logs`
   shows. `diag.main.deadman.stalls` counts the stalls and `lastStallTick` gives the main tick
   of the last one. main.js cannot see which keys the worker held, so the count includes
   stalls with no key down; it is not a count of prevented falls. A
   worker that ticks normally changes the heartbeat every tick, so the dead-man does not act
   on it. When no worker runs (heartbeat 0), the dead-man does nothing, because a person can
   hold the keys. A stall also releases a key that a person holds at that time; the person
   must press it again.

The decision for layer 2 is `deadmanStep` (`shared/harness/deadman.ts`, with its plain-JS twin
in `harness/safe-io.js`). `test-ts/harness-contract.test.ts` keeps the two equal.

The two layers stop the walk. The search does not hold the worker either: an A* search spans
worker ticks (`PlanSearch` in `shared/domain/planner.ts`). One tick spends about
`cfg.nav.planReadsPerTick` reader calls on it (cache hits included; the budget is checked between
expansions, so a run ends at most one expansion past it) and then yields. On the ground the bot
holds still and the reflexes run until the search has its answer. Off the ground (a fall, a jump
arc, and also swimming or climbing, where the body is not on the ground either) the keys of the
last drive stay held, so the body keeps its heading with no step veto until the search ends. On
the I-4 roof one search reads about a million cells, about 25 s live, which was one blocked tick
before (RCA K-2). The route is installed only when
the search ends, so no plan is cut short by its read count. A cut turned a reachable leg behind a
concave pocket (a lava lake, a wide ravine) into a false `blocked_no_path`;
`test-ts/nav-replan-safety.test.ts` pins that such a leg arrives, and that no tick of the I-4 leg
spends more than one read budget. A partial route whose re-search ends on the cell the last one
ended on is not extended again (`stalled` in `shared/nav/route.ts`), so the I-4 leg searches
twice, not once from every cell. On the ground a search is dropped when the body leaves the cell
it began on. Off the ground it runs on. If the body left that cell by the time the search ends, the
route is not driven from there and the keys stay up: the body follows the route if the feet are on
it, else the next search starts from a body at rest, so a heading is held for one search at most.
A search is also dropped when the goal jumps more than `cfg.nav.goalShiftCells`. A goal that moves
less per call (a chased mob, a followed peer) keeps its search. A route planned for it stays
followable as a partial one, and the moved goal searches as soon as that route runs out. An empty
answer is a verdict only for the cell and the goal its search began with; for any other the next
call searches again. The mine GOTO stall clock and the drill approach clock
(`cfg.drill.approachBlockedTicks`, skips the vein) pause on a tick that only resumes a search; the
leg's phase timeout (`cfg.nav.gotoTimeoutTicks`) counts it, so a search longer than the leg's
budget ends the leg. The other no-progress budgets of a greedy leg count every search tick: the
excavate stall (`cfg.excavate.stallTicks`, rescue leg then skip; its corridor step searches the
adjacent cell, found on the search's second expansion, so that search ends in the tick it begins
unless the cell cannot be entered at all), the chase (`cfg.hunt.chaseTimeoutTicks`, back to
seeking) and the dig-to stall (`cfg.drill.digToStallTicks`, each blocked verdict waits for its
search).

## Prevention tier: one clutch-aware fall predicate

All "will this fall survive?" checks route through **one** SSOT predicate,
`canSurviveFall(drop, cap)` (`core/prim/movement-physics.ts`):

```
canSurviveFall(drop, cap) = clutch  ∨  fallDamage(drop, waterBelow) ≤ maxFallDamage
```

- The **planner's cheap drop** (`dropDownSafe`) passes `clutch: false` — a clutch dive is a
  *separate, costed* move (`waterDrop`), so the cheap drop must not silently offer fatal falls.
- The **executor's fall veto** (`src/shared/nav/executor.ts` `stepIsHazardous`) passes `clutch: true` **when a
  bucket is carried** (the same gate the planner uses to offer a `waterDrop`). So the geofence can
  **never veto a fall the water-clutch would save** — planner and executor stay in lockstep, and the
  "with a bucket you can fall from any height" capability is honoured, not contradicted.

Note the **recoverability** guard (descent rim-veto, "can I climb back out?") is a *different*
concern and is **not** clutch-aware — the clutch saves the fall, not the climb-back.

## Prevention tier: known-before-break digging

The drill's DESCEND shaft never breaks the floor under the bot unless it knows what is below. An
unloaded or unsensed cell can hide a cave, lava or water, and breaking the floor over it drops the
bot in. The rule does not cover EXCAVATE: its void guard (`guardVoidCell`,
`src/bot/missions/drill/excavate.ts`) reads an unreadable cell as `minecraft:stone`.

- **The null convention.** A senses `BlockReader` (`src/shared/domain/senses.ts`) returns `null`
  for an UNKNOWN cell. The drill reads its floor through `knownReader`
  (`src/bot/missions/drill/descend.ts`), which keeps an unreadable cell as `null` instead of
  masking it as stone.
- **The verdict.** `floorVerdict` (`src/bot/missions/drill/floor-safety.ts`) returns `unknown`
  when the block to break, or any cell of the fall column down to the landing, reads `null`.
  `floorUnsafe` checks every support cell of the body's footprint (`footprintAt`).
- **The outcome.** With no band mined yet, `floorUnsafe` logs `DRILL_UNKNOWN_BELOW` and calls
  `skipUnreachableVein` (`src/bot/missions/drill/select-vein.ts`): the bot goes to the next cached
  vein, or to `PAUSED` when none remains. It does not go to `ERROR`. With a band already mined,
  the unknown floor is the bottom of the shaft: `DRILL_DEPTH_DONE`, then `PAUSED`.

## Drowning: one hazard, three layers

Water is not a `classifyBlock` hazard, so drowning has its own predicate, `submergesAt`
(`src/shared/domain/senses.ts`): feet cell AND head cell are water. Wading in 1-deep water stays
allowed. Each layer sits in its own tier:

1. **Prevention — the navigator veto.** `stepIsHazardous` (`src/shared/nav/executor.ts`) refuses
   a step when the step cell, or the landing below it, is submerging. The drill's own
   `floorVerdict` `water` verdict covers the shaft (see the rule above).
2. **Reaction — the `swimOut` reflex** (`src/shared/reflexes/swim-out.ts`, `survival: true`).
   While the bot is submerged and breath is fine, `swimOut` holds jump and releases forward and
   sprint until the head clears water. It gives up after `cfg.safety.swimOutMaxTicks` ticks
   without a height gain. `swimOut` does not act in the settled phases `RECOVER`, `PAUSED` and
   `ERROR` (`REFLEX_SETTLED`, `src/shared/kernel/phase.ts`), so a bot that a drill skip left
   `PAUSED` in water has only the `air` reflex. The `air` reflex (`src/shared/reflexes/air.ts`) runs first and owns the
   terminal escape: when the breath fraction drops to `cfg.safety.airRecoverPct`, `air` diverts to
   `RECOVER`, which holds jump to surface before it teleports (`src/bot/capabilities/recover.ts`).
3. **Mark and skip — the drill's memory.** `recordDrowned`
   (`src/bot/missions/drill/floor-safety.ts`) writes a `drowned` `HazardMarker` to
   `mc_world.json` through `writeHazardMarker` (`src/shared/domain/world-model.ts`). Two
   events write it: `floorUnsafe` on a `water` or `void` verdict with no band mined
   (`DRILL_WATER`, `DRILL_VOID`), and the DESCEND flooded-column watchdog after
   `cfg.drill.waterContactTicks` ticks of water contact with no band mined
   (`DRILL_FLOODED_COLUMN`). On the next run, `selectDrillVein`
   (`src/bot/missions/drill/select-vein.ts`) aims the vein at a column of its bounding box outside
   `cfg.drill.hazardRadius` of every marker, a peer's included. It drops the vein only when every
   candidate column is marked. The marker turns one abort into prevention for every later run.

## Client wedges are not a safety-tier concern

After a headless death the *client process* can stay without a loaded world while the bridge
still answers. That is a process fault, not game state, so it is handled host-side by
`scripts/ops/wedge_watchdog.py` (`./gerda watchdog`): detect, disconnect and reconnect, and
optionally relaunch. It never touches the kernel or bundle. Needs a running bot:

```bash
./gerda watchdog --port 55545 --once                      # one check: exit 0 healthy, 3 wedged
./gerda watchdog --port 55545 --server localhost:25565    # watch; reconnect on a confirmed wedge
```

A relaunch of the instance happens only with `--auto-relaunch <instance>`; without it the
watchdog prints the relaunch command and keeps watching.
