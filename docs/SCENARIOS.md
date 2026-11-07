# Scenario files: arenas, benches and sets

A scenario file is a JSON spec that builds a small scene in the live game and then tests
or measures something in it. This page is the field reference for the three families the
host tools read. How to run the gate and why it is shaped this way: [TESTING.md](TESTING.md).
A tutorial for mod checks: [MOD_TESTING.md](MOD_TESTING.md).

| Directory | What it is | Read by | Shape |
|---|---|---|---|
| `scenarios/arenas/<name>.json` | **Arena**: build, then run a mission or a plan and assert its log events, or assert game state with `checks` | `scripts/dev/arena.py`, `scripts/dev/gate_live.py` | `#/$defs/arena` |
| `scenarios/bench/<name>.json` | **Bench**: build a course, then time navigator legs or one mission per planner | `scripts/dev/navbench.py`, `scripts/dev/gate_live.py` | `#/$defs/bench` |
| `scenarios/sets/<name>.json` | **Film set**: staging captured from the live world, no assertions | `scripts/dev/arena.py` | `#/$defs/set` |

The shot lists in `scenarios/shots/` are a different format, read by the shot runner:
[RIG.md § Shot runner](RIG.md#shot-runner).

**The name of a spec is its file name** without `.json`. An arena or set file that declares a
`name` key does not load (`scripts/dev/arena.py#_load`).

## The schema and what checks it

`scenarios/scenario.schema.json` (JSON Schema 2020-12) states the shape of every family: the
keys, their types, which are required, and which combinations are refused. The parsers read
keys with plain dict access and ignore a key they do not know. Without the schema, a typo
such as `expcet` would silently drop an arena out of the full gate.

`scripts/tests/test_scenario_schema.py` (part of `just test-py`, so of the pre-push `just
check`) holds the schema in place:

- every tracked file matches its `$defs` entry, and every arena and set also loads through
  `scripts/dev/arena.py#_load`, which adds the cross-field rules of
  `scripts/dev/arena.py#validate_arena_spec` and `scripts/dev/arena.py#validate_set_spec`;
- every key the three parsers read is in the schema, and every schema key is read by a
  parser;
- every key and op kind in the schema is named on this page, and the examples on this page
  validate;
- every event in `expect.events` and every `done_event` is a string literal in `src/`, every
  mission name has a `###` heading in [MISSIONS.md](MISSIONS.md), and every plan name is a plan
  in `src/bot/plans/`.

To check a new file before you run it in the game:

```
python3 -m unittest discover -s scripts/tests -t scripts/tests -p test_scenario_schema.py
```

## Arenas

### A minimal arena

<!-- scenario-example: arena -->
```json
{
  "desc": "goto walks 8 blocks over flat stone; PASS = GOTO_ARRIVED, no ERROR",
  "ops": [
    { "op": "clear", "from": [-2, 101, -2], "to": [10, 104, 2] },
    { "op": "fill", "from": [-2, 100, -2], "to": [10, 100, 2], "block": "minecraft:stone" },
    { "op": "clearinv" },
    { "op": "give", "item": "minecraft:diamond_pickaxe" },
    { "op": "select", "slot": 0 },
    { "op": "player", "pos": [0, 101, 0] }
  ],
  "mission": { "name": "goto", "params": { "x": 8, "y": 101, "z": 0 } },
  "expect": { "events": ["GOTO_ARRIVED"], "timeout": 60 }
}
```

`scenarios/arenas/goto-travel.json` is this arena.

### Arena keys

| Key | Type | Required / default | Meaning | Parser |
|---|---|---|---|---|
| `desc` | string | optional | One line printed by `build` and `list`. Say what PASS proves. | `scripts/dev/arena.py#build` |
| `ops` | list of [ops](#ops) | required, at least one | Build the scene and kit the bot, in order. | `scripts/dev/arena.py#_build_ops` |
| `mission` | object | optional | The mission to start after the build: `name` (a mission in [MISSIONS.md](MISSIONS.md)) and `params` (an object, default `{}`, the mission's parameters as documented there). Sent as `mission_start`. | `scripts/dev/arena.py#run` |
| `plan` | string | optional; not with `mission` | A plan name from `src/bot/plans/` (for example `sustain-cycle`), sent as `plan_start`. The orchestrator chains its steps. | `scripts/dev/arena.py#run` |
| `marker` | object | optional; needs `mission` or `plan` | A prospector vein for the `drill` mission: `ore` (an ore intent, such as `iron`), `x`, `z` (integers). Written into the world store after the worker restart and before the mission starts. | `scripts/dev/arena.py#_seed_marker` |
| `expect` | object | optional; needs `mission` or `plan` | The log events that prove the mission worked: [the `expect` block](#the-expect-block). | `scripts/dev/arena.py#run` |
| `checks` | list of [checks](#checks) | optional, at least one | `jeval` assertions on game state. | `scripts/dev/arena.py#run_checks` |
| `known_bad` | string | optional | Marks the arena as a negative control and says which wrong behaviour it asserts: [known-bad arenas](#known-bad-arenas). | `scripts/dev/arena.py#validate_arena_spec` |

What `run` does, in order (`scripts/dev/arena.py#run`): build the ops; with neither `mission` nor
`plan`, run the `checks` and stop (no checks: build only, a PASS). Otherwise restart the worker,
respawn the bot if it is dead and teleport it back to the first `player` op
(`scripts/dev/arena.py#_ensure_bot_ready`), seed `marker`, start the mission or plan, wait for
`expect`, then run the `checks`.

**Gate membership.** `just gate-live` with no names runs every arena that asserts something:
a non-empty `expect.events`, or `checks` (`scripts/dev/arena.py#asserts`). An arena with
neither, such as `parkour-gap2`, is a build-only fixture you run by name. The `--quick` core is
the list `CORE` in `scripts/dev/gate_live.py`.

### The `expect` block

| Key | Type | Required / default | Meaning |
|---|---|---|---|
| `events` | list of strings | required, at least one | Event names from the bot's log, such as `ORE_FOUND`, `GOTO_ARRIVED`, `DRILL_VEIN_REACHED`. Every one must appear. Order and count do not matter. |
| `timeout` | number (seconds) | default `60` | Wall-clock time to wait for all of them. |

The runner polls the log once a second and reads only the entries after the last `BOOT`, so an
earlier worker boot cannot pass or fail this run (`scripts/dev/arena.py#_recent_events`). The
arena FAILS when an event is still missing at the timeout, or when any `TRANSITION` to `ERROR`
was logged, even if every event arrived. Name events the mission emits on every run, not ones
that depend on remembered world state: [TESTING.md § Adding an arena](TESTING.md#adding-an-arena).

With a `mission` but no `expect`, `run` runs the `checks` right after the mission starts, without
waiting for the mission.

### Checks

A check runs one `jeval` (the privileged bridge command: full jsMacros and Java scope, including
`srg(class, member)` from `harness/ext.js`) and compares the value of its last expression with
`expect`.

| Key | Type | Required / default | Meaning | Parser |
|---|---|---|---|---|
| `desc` | string | optional; default: the first 60 characters of `jeval` | Printed on the PASS/FAIL line. | `scripts/dev/arena.py#check_outcome` |
| `jeval` | string, not blank | required | JavaScript. Wrap several statements in an IIFE, `(function () { …; return v; })()`. | `scripts/dev/arena.py#validate_arena_spec` |
| `expect` | any JSON value | required | The exact value `jeval` must return. | `scripts/dev/arena.py#check_outcome` |
| `wrong` | `true` | optional; only in a `known_bad` arena | This check's `expect` is wrong on purpose. | `scripts/dev/arena.py#wrong_outcome` |

`expect` is compared as canonical JSON (`json.dumps(…, sort_keys=True)`,
`scripts/dev/arena.py#_canon`): `true` is not `1`, `1` is not `1.0`, and the key order of an object
does not matter. An object must match whole. With `"expect": { "held":
"minecraft:iron_pickaxe", "drops": true }`, the `jeval` has to return an object with exactly
those two keys and values; a missing key, an extra key or `"drops": 1` is a FAIL. A `jeval` error
is a FAIL that prints the error. Every check runs, also after one fails, and the list passes only
when all of them pass.

<!-- scenario-example: checks -->
```json
{
  "desc": "an iron pickaxe harvests tungstate ore",
  "ops": [
    { "op": "clear", "from": [-2, 101, -2], "to": [2, 104, 3] },
    { "op": "fill", "from": [-2, 100, -2], "to": [2, 100, 3], "block": "minecraft:stone" },
    { "op": "set", "pos": [0, 101, 2], "block": "gtceu:tungstate_ore" },
    { "op": "clearinv" },
    { "op": "give", "item": "minecraft:iron_pickaxe" },
    { "op": "player", "pos": [0, 101, 0] },
    { "op": "wait", "ticks": 40 }
  ],
  "checks": [
    {
      "desc": "the placed block is GTCEu tungstate ore",
      "jeval": "World.getBlock(0, 101, 2).getId()",
      "expect": "gtceu:tungstate_ore"
    },
    {
      "desc": "an iron pickaxe in hand gets the drop",
      "jeval": "(function () { Player.openInventory().setSelectedHotbarSlotIndex(0); var p = Player.getPlayer(); var state = World.getBlock(0, 101, 2).getBlockStateHelper().getRaw(); return { held: p.getMainHand().getItemId(), drops: p.getRaw()[srg('Player', 'hasCorrectToolForDrops')](state) }; })()",
      "expect": { "held": "minecraft:iron_pickaxe", "drops": true }
    }
  ]
}
```

The full pair is `scenarios/arenas/gtceu-ore-harvest-tier.json` and its known-bad twin.

### Known-bad arenas

A known-bad arena proves that a check can fail. The rules, all enforced at load
(`scripts/dev/arena.py#validate_arena_spec`):

- `known_bad` is a non-blank string, and the arena marks at least one check `"wrong": true`.
  A `wrong` check outside a `known_bad` arena is refused, and so is any `wrong` value but `true`.
- Each `wrong` check has exactly one unmarked **twin** in the same arena: the same `jeval`
  text and a different `expect`, the right value (`scripts/dev/arena.py#twin_index`).

A `wrong` check PASSES only when its `jeval` succeeded, returned exactly its twin's `expect`, and
the twin passed (`scripts/dev/arena.py#wrong_outcome`). The wrong value itself, a `null`, a third
value or an error is a FAIL. No verdict is inverted. Why and how to write one:
[MOD_TESTING.md](MOD_TESTING.md).

## Ops

Every op is an object with an `op` key. Coordinates are lists of three integers `[x, y, z]`;
boxes are inclusive and their corners can come in any order. Build ops go to the game as chat
commands, so the driven client must be opped. Each op is one bridge round-trip
(`scripts/dev/arena.py#_apply_op`).

| `op` | Other keys | Effect |
|---|---|---|
| `clear` | `from`, `to` | `/fill … minecraft:air` over the box. |
| `fill` | `from`, `to`, `block` | `/fill` the box with `block`. `block` goes into the command as written, so it can carry a block state or NBT (`minecraft:chest{Items:[…]}`). Vanilla `/fill` refuses a box of more than 32768 blocks. |
| `set` | `pos`, `block` | `/setblock` one block. |
| `clearinv` | — | `/clear @s`: empty the bot's inventory. |
| `give` | `item`, `count` (integer ≥ 1, default `1`) | `/give @s`. |
| `select` | `slot` (integer 0–8) | Select a hotbar slot (taps `key.hotbar.<slot + 1>`). |
| `player` | `pos` | `/tp @s` to the centre of the block: `x + 0.5`, `y`, `z + 0.5`. An arena's first `player` op is also its start, where the bot is put back before the mission. |
| `marker` | `ore`, `x`, `z` | Write a prospector vein into the world store at once, host-side. |
| `wait` | `ticks` (integer ≥ 0) | Sleep `ticks / 20` seconds on the host, for example to let the server sync blocks and items to the client before the checks read them. |

`clean` sets every `clear`, `fill` and `set` region back to air (`scripts/dev/arena.py#clean`).
Build and clean hold a `/forceload` ticket on the touched chunks while they write
(`scripts/dev/arena.py#forceload_box`). Arenas build at fixed coordinates, and each `clean` clears
only its own regions, so two arenas must not overlap.

A `marker` op and a top-level `marker` write the world store of the instance in `MC_INST`
(default: the human instance; `gate_live.py --port` points it at that bot's instance).

## Benches

A bench races navigator legs, or one whole mission, per planner. Running and reading the
results: [navbench.md](navbench.md).

<!-- scenario-example: bench -->
```json
{
  "desc": "flat sprint, 12 blocks",
  "ops": [
    { "op": "clear", "from": [39, 88, -1], "to": [70, 94, 3] },
    { "op": "fill", "from": [39, 88, -1], "to": [70, 88, 3], "block": "minecraft:stone" },
    { "op": "clearinv" }
  ],
  "start": [41, 89, 1],
  "legs": [{ "name": "flat12", "to": [53, 89, 1] }],
  "repeats": 3,
  "timeout": 25
}
```

| Key | Type | Required / default | Meaning | Parser |
|---|---|---|---|---|
| `name` | string | default: the file name | The label of the report. | `scripts/dev/navbench.py#_load` |
| `desc` | string | optional | Printed by `build`. | `scripts/dev/navbench.py#build` |
| `ops` | list of ops | optional | The same op vocabulary, without `player`: the runner teleports the bot to `start` itself before every run. | `scripts/dev/navbench.py#build` |
| `start` | `[x, y, z]` | required | Where every run starts. | `scripts/dev/navbench.py#_anchor` |
| `legs` | list of `{ "name", "to" }` | a leg bench: required; not with `mission` | Each leg drives from `start` to `to` through the nav probe. | `scripts/dev/navbench.py#run` |
| `mission` | `{ "name", "params" }` | a mission bench: required; not with `legs` | One whole mission per run, timed from `mission_start` to `done_event`. | `scripts/dev/navbench.py#race_mission` |
| `marker` | `{ "ore", "x", "z" }` | optional; needs `mission` | A vein seeded after each worker restart, for `drill`. | `scripts/dev/navbench.py#race_mission` |
| `collect` | item id | optional; needs `mission` | The item whose bag count before and after the run is the yield. | `scripts/dev/navbench.py#race_mission` |
| `done_event` | string | default `SCAN_EXHAUSTED`; needs `mission` | The event that ends a mission run (`drill` ends at `VEINS_DEPLETED`). | `scripts/dev/navbench.py#race_mission` |
| `impls` | list of `astar`, `dstar` | default `["astar"]` | The planners to race. `greedy` is an alias of `astar`; any other name stops the run. | `scripts/dev/navbench.py#_engine` |
| `repeats` | integer ≥ 1 | default `3` (legs), `2` (mission) | Runs per leg and planner. | `scripts/dev/navbench.py#run`, `scripts/dev/navbench.py#run_mission` |
| `timeout` | number (seconds) | default `30` (legs), `220` (mission) | Per run. | `scripts/dev/navbench.py#run`, `scripts/dev/navbench.py#run_mission` |
| `arrival` | number or `null` | default (`null`, `0`): `cfg.nav.gotoArrivalDist` | How close to `to` counts as arrived, in blocks. | `scripts/dev/navbench.py#race_leg` |

`just gate-live` runs every bench with `legs` and no `mission`, A* only, each leg once with one
retry; PASS = arrived on every leg (`scripts/dev/gate_live.py#_gate_bench`).

## Film sets

A set is staging for a filmed scene: the arena format without assertions, plus a `snapshot`
declaration. `run --all` and `just gate-live` never read `scenarios/sets/`; a set is addressed
as `sets/<name>`. Workflow: [RIG.md § Sets](RIG.md#sets-restage-the-world-from-data).

<!-- scenario-example: set -->
```json
{
  "desc": "a 3x3 pad",
  "snapshot": {
    "boxes": [{ "from": [0, 100, 0], "to": [2, 101, 2] }],
    "dimension": "minecraft:overworld"
  },
  "ops_generated": [
    { "op": "clear", "from": [0, 100, 0], "to": [2, 101, 2] },
    { "op": "fill", "from": [0, 100, 0], "to": [2, 100, 2], "block": "minecraft:stone" }
  ],
  "ops": [{ "op": "marker", "ore": "iron", "x": 1, "z": 1 }]
}
```

| Key | Type | Required / default | Meaning | Parser |
|---|---|---|---|---|
| `desc` | string | optional | As for an arena. | `scripts/dev/arena.py#build` |
| `snapshot` | object | required | `boxes`: a non-empty list of `{ "from", "to" }` boxes to capture, each at most 32768 cells (`SNAPSHOT_MAX_CELLS`). `dimension`: a namespaced dimension id, stamped by `snapshot`; `build` and `clean` refuse a client in another dimension. | `scripts/dev/arena.py#validate_set_spec`, `scripts/dev/arena.py#_assert_dimension` |
| `ops_generated` | list of `clear`/`fill`/`set` ops | written by `snapshot` | A generated file section: re-run `snapshot`, never edit it by hand. | `scripts/dev/arena.py#compress_box` |
| `ops` | list of ops | optional | Hand-written setup applied after `ops_generated`: `marker`, `give`, `player`, `select`, `wait`, and any block a snapshot cannot express (stairs and slabs restage in their default orientation). | `scripts/dev/arena.py#_build_ops` |

A set that declares `mission`, `plan`, `expect`, `checks` or `known_bad` does not load. A build
over 2000 ops is refused (`BUILD_MAX_OPS`, `scripts/dev/arena.py#_check_op_budget`).

## Running a scenario

```
just gate-live mine-vein drill-vein                    # named arenas through the gate (no benches)
just gate-live                                         # every asserting arena + every leg bench
python3 scripts/dev/arena.py list                      # arenas and sets, with their desc
python3 scripts/dev/arena.py run mine-vein --port <p>  # one arena: build, run, verify; exit 0/1
python3 scripts/dev/arena.py build mine-vein           # only build the scene
python3 scripts/dev/arena.py clean mine-vein           # its regions back to air
./gerda bench run flat                                 # one bench
```

`arena.py run` does not clean up after itself; `gate_live.py` cleans each arena, pass or fail.
Run every live scenario against an opped test bot in a flat test area, and confirm the
connected player is the bot: [TESTING.md § Layer 3](TESTING.md#layer-3-the-arena-gate-just-gate-live).
