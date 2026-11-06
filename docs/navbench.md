# Navigator benchmarks

The navigator is the part of Gerda Bot that moves the player: walking, climbing, dropping
down, routing around obstacles and jumping gaps. `navbench` measures it in the live game on
small, repeatable courses. A bench answers three questions:

- **Does the bot arrive?** Every run counts as arrived or not.
- **How fast?** Time is in game ticks (20 ticks = 1 second). The bench drives the bot at the
  same per-tick cadence as a real mission, so ticks are an honest proxy for wall-clock time.
- **Which planner is faster here?** A* is the default planner. D* Lite is optional, and a bench
  can race the two on the same course.

Run the benches after you change movement code or navigator tuning, to confirm the change
did not make the bot slower or less reliable. The leg benches also run in the live arena gate
(`just gate-live`), where PASS = arrived. See [TESTING.md](TESTING.md).

## Before you run

The benches use the same setup as the arena gate:

- **A connected, opped test bot.** A bench builds its course with operator commands (`/fill`,
  `/tp`, kit items). That is test setup only — missions never use operator commands. Op the
  test bot for the session and de-op it when you finish.
- **A clean, flat test area.** Each course builds at fixed world coordinates. On a lived-in
  world those coordinates can land in terrain or in your base.
- **The right client.** By default the bench drives the client on bridge port 55544, and that
  can be your own game client. Pass `--port <port>` to drive a fleet bot instead. The port must
  be in `mc-bots.json`, because a mission bench writes its ore marker into that bot's own world
  store. Either way, confirm that the connected player is the test bot.

## Running

```
./gerda bench list              # list the benches
./gerda bench run flat          # run one bench
./gerda bench run --all         # run every bench
./gerda bench build flat        # only build the course (to look at it in-game)
./gerda bench run flat --port 55545   # drive the bot on bridge port 55545
```

`./gerda bench` is a shortcut for `python scripts/dev/navbench.py`.

## Reading the results

Each course runs several times: 3 times for a leg bench, 2 for a mission bench. For each leg
(or mission) and planner, the report prints:

- the **median ticks** of the runs that arrived;
- the **arrival count**, for example `3/3` (for a mission bench: how many runs mined the area
  out).

When a bench races two planners, the report also prints the ratio of their medians (below 1.0
means the second planner is faster). Live physics is noisy, so compare medians, not single
runs, and repeat a run before you trust a small difference.

## The benches

### Leg benches

A leg bench drives the bot from a start point to a goal and isolates one kind of movement. Each
course sits over a catch floor, so a missed jump is a survivable fall, not a death.

| bench     | leg(s)           | what it tests                          |
|-----------|------------------|----------------------------------------|
| `flat`    | `flat12`, `flat24` | straight sprint over 12 and 24 blocks |
| `climb`   | `climb6`         | a 6-step staircase up                  |
| `descend` | `descend6`       | a 6-step staircase down (1-block drops) |
| `detour`  | `around`         | routing around a wall that blocks the straight line |
| `gap`     | `jump3`          | a sprint-jump over a 2-block void      |

### Mission benches

A mission bench runs a whole mission once per planner and measures the ticks from mission start
until the area is mined out. It shows how navigation speed adds up in real work: walking to the
ore, breaking it, and moving between blocks. Mission benches measure throughput only, so they
are not part of the arena gate.

- **`drill-throughput`** — the `drill` mission walks to an iron cluster buried in a small stone
  hill, digs a shaft down to it and mines it out, picking up the drops.
- **`ore-room`** — the `mine` mission clears a 7×5 slab of iron ore, one block high, in open
  air. The measure is that no ore is left. The item count is lower than 35, because some drops
  fall into the holes the bot mines.

## Writing a bench

A bench is one JSON file in `scenarios/bench/<name>.json`:

```json
{
  "desc": "What the course tests.",
  "ops": [
    { "op": "fill", "from": [39, 88, -1], "to": [70, 88, 3], "block": "minecraft:stone" },
    { "op": "give", "item": "minecraft:diamond_pickaxe" }
  ],
  "start": [41, 89, 1],
  "legs": [ { "name": "flat12", "to": [53, 89, 1] } ],
  "impls": ["astar", "dstar"],
  "repeats": 3,
  "timeout": 30
}
```

- `ops` builds the course and kits the bot. It uses the same operations as the arena specs
  (`clear`, `fill`, `clearinv`, `give`, `select`, …). The runner teleports the bot to `start`
  before every run, so the ops do not place the player.
- `legs` lists the goals to drive to from `start`.
- `impls` picks the planners: `astar` (the default) and/or `dstar`.
- `repeats`, `timeout` and `arrival` are optional.
- For a mission bench, replace `legs` with `"mission": { "name": "mine", "params": {} }`.

Every key, its default and the code that reads it: [SCENARIOS.md § Benches](SCENARIOS.md#benches).

Courses must not overlap: each `build` clears only its own region. Put a new course clear of
the existing ones.

## Gerda vs Baritone

We raced the navigator against [Baritone](https://github.com/cabaletta/baritone) on the same
legs, 3 runs per leg. The table shows median ticks; lower is faster.

| leg        | Gerda   | Baritone |
|------------|--------:|---------:|
| `flat12`   | **36**  | 37       |
| `flat24`   | **78**  | 79       |
| `climb6`   | 62      | **58**   |
| `descend6` | 43      | 42       |
| `around`   | 115     | **102**  |
| `jump3`    | 29      | 29       |

- **Reliability is equal.** Both arrive on all six legs.
- **Speed is equal on flat ground, descents and the gap.** Gerda is 7% slower on the climb and
  13% slower on the detour.

Both gaps are the cost of deliberate safety choices:

- **The bot sprints only with clear ground ahead.** Before it sprints, the navigator checks
  that the next two cells are safe to run on. This stops the bot from sliding off a short
  bridge, and it keeps the bot on its line through diagonal corners. A looser check saves a few
  ticks on the detour but makes the bot overshoot the corner and miss the goal.
- **Climbing is limited by jump timing.** The bot keeps sprinting through each stair jump and
  clears one stair per jump, whatever its speed. The remaining gap is the delay between landing
  and the next jump, about 0.7 ticks per stair.
