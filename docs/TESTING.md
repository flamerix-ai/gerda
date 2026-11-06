# Testing — the three layers

The bot is tested at three levels. **There is no CI.** The versioned git hooks (`just hooks`)
are the gate, and they run layer 1. Layers 2 and 3 need a live game, so you run them by hand
before merging in-game behaviour changes.

| Layer | What | Runs where | Command |
|-------|------|-----------|---------|
| 1. Mock suite | Pure domain logic, capability and mission loops on the mock runtime; the Python host-tool suites; the mutants of the host-tool guards | git hooks: pre-commit the TS half and the gate-tag lint, pre-push all of it | `just check-ts`, `just check` |
| 2. Facade smoke | The raw-Java facade methods, executed in the real worker | a live bot | `./gerda smoke` |
| 3. Arena gate | Real missions in built arenas, plus navigator leg benches | a live, opped test bot | `just gate-live` (`./gerda gate`) |

**pre-commit** runs `just check-ts`, the TS half of `just check` plus the gate-tag lint
(`just gate-tags`), so a commit takes seconds; **pre-push** runs the full `just check` (the TS
half again, the Python suites and the mutants, `just mutants`), builds the bundle
and validates it
(`just validate-bundle`: the deploy step's checks, `validate_bundle()` in `scripts/ops/sync.py`).
Pre-push builds from the checkout, so it refuses to push a commit other than HEAD that shares
history with it — check out the commit you push. (A maintainer-only leak scan also runs when
`scripts/private/` exists; a fork skips it.)
Run from a shell without the dev shell's tools (an IDE, a plain terminal), a hook re-enters the
flake dev shell through `nix develop` when nix is installed; without nix it runs as is.
Do not skip either hook with `--no-verify`. Pre-push writes its output to `pre-push.log` in the
worktree's git dir (`git rev-parse --git-path pre-push.log`) and prints one summary line. On
failure it prints the failing command and the last 40 log lines. `just smoke-clean`
(`./gerda smoke-clean`) is a separate check: it brings the toolchain up on a clean distro in a
rootless container.

## Layer 1 — the mock suite

`just check` = `just check-ts` (the gate-tag lint, then `bun run check`: `tsc --noEmit` +
`biome check` + the defensive-code checker + `vitest`) plus the Python `unittest` suites
(`just test-py`) plus the mutants of the host-tool guards (`just mutants`, below).

**Test count.** This is the one place the docs state it: over **1,000 vitest tests** in
`test-ts/` and about **870 Python tests** (`scripts/tests/` for host tooling,
`scripts/objective/tests/` for the objective engine). Count them yourself with
`node_modules/.bin/vitest list` and `just test-py`.

The vitest suites run the pure `shared/domain/` logic and every capability and mission against
`core/runtime/mock.ts`, which implements the same interface as the real runtime, so it cannot
drift. The planner also has property-based tests (fast-check) for legality, determinism and
completeness on generated terrain. The suite boots no game.

It does **not** cover live movement physics, synthetic-input reach, mod-API calls or the
service harness. Layers 2 and 3 do.

### Mutants of the host-tool guards

A guard in a host tool — a check in the sandbox scripts (`scripts/sandbox/sbx.sh`,
`provision.sh`, `Containerfile`), the arena check rules in `scripts/dev/arena.py`, the
`--min-luma` gate of `scripts/rig/motion_probe.py` — counts as tested only when some test goes
red without it. We keep that evidence as data. A **mutant** is one literal edit that breaks one
guarded line, together with the tests that must then fail and the message they must print.
`scripts/dev/mutants.py` runs them.

- **Tags.** Every die-shaped line in those files carries `# gate:<id>` or `# not-a-gate:
  <reason>` (a reason of three or more words). Die-shaped is a fixed list of failure shapes
  the lint knows: in shell every `return`/`exit` but `0`, every `||` but `|| true`, every
  `false`, fail helper, unguarded `test`/`[`, and checksum check; in a Containerfile every
  `RUN`; in the listed Python functions every `return`, `raise`, `assert`, exit call and
  `.append`. A guard in another shape is not flagged — for example a bare `grep -q`, `cmp` or
  `diff` under `set -e`, `(( … ))`, `${1:?}`, a `trap … ERR`, or a Python failure recorded with
  `+=` or `ok = False`. Such a guard counts as tested only when its author tags it and a
  reviewer checks that, so the lint is a floor, not a proof that every guard is known. Every
  gate tagged today has a mutant that kills it. A file in the scope where the rule finds
  nothing fails the lint. A tag on a comment-only line covers the next line and its `\`
  continuations.
- **Mutant files** are `scripts/dev/mutants/<area>.toml`: the gate ids (`[gates]`), the files
  the lint reads (`[scope]`), and one `mutant` table per edit — `file`, `anchor` (the text to
  replace; it must occur exactly once), `replace`, `test` (test ids), `expect_message`
  (substrings the failing run prints) and `expect_failures` (the exact number of failing tests).
- **`just gate-tags`** (pre-commit) fails on an untagged die-shaped line, a `gate:<id>` that no
  mutant file declares, a declared gate id that no line carries, and a mutant whose anchor does
  not occur exactly once, is not on a line tagged with its gate id, or names a test that does
  not exist.
- **`just mutants [area [mutant ...]]`** (pre-push) copies the tree to a temp dir per mutant —
  the checkout is never changed — makes the edit and runs the named tests. Each area first
  prints a CONTROL row: the same tests on an unedited copy, with their exit code and `Ran N
  tests` line. A red CONTROL stops the run, because a red run of a mutant only means something
  when the same tests pass without the edit. Then one row per mutant: `killed` (the only green
  result), `survived`, `wrong_failure`, or a broken mutant (`anchor_missing`,
  `anchor_ambiguous`, `unparsable`, `run_failed`, `skipped`). `python3 scripts/dev/mutants.py
  list` prints every mutant.

Adding a guard: tag the line `# gate:<id>`, write the test that fails without it, and add the
mutant that removes exactly that guard; `just gate-tags` and `just mutants <area> <name>` show
that it works.

## Layer 2 — facade smoke (`./gerda smoke`)

Some facade methods call raw Java (player sensors via SRG names, eat/respawn on the render
thread). They can pass the mock suite and still fail in-game on a wrong SRG name or a
wrong-thread closure. `scripts/ops/facade_smoke.py` runs the worker's `smoke` command
(`src/bot/capabilities/diagnostics.ts`), which executes those probes in the real worker and
reports one line per check. It exits non-zero on any failure. Run it when you touch
`src/core/runtime/`. `--eat` also takes one real bite and verifies that food rose. Needs a
running bot; `--port` picks one other than the loopback default 55544:

```
./gerda smoke --port 55545          # read-only probes, one line per check
./gerda smoke --port 55545 --json   # the same, machine-readable
```

## Layer 3 — the arena gate (`just gate-live`)

`scripts/dev/gate_live.py` builds and runs the declarative test **arenas**
(`scenarios/arenas/*.json`) against a connected bot and rolls every PASS/FAIL into one exit
code.

```
just gate-live                       # FULL gate: every asserting arena + navigator leg benches
just gate-live --quick               # the curated 5-arena core, no benches
just gate-live mine-vein drill-vein  # a named subset (no benches)
just gate-live --bench-only          # only the navigator leg benches
python scripts/dev/gate_live.py --port <port> …  # target a specific bot (default 55544; ports: mc-bots.json)
python scripts/dev/gate_live.py --list           # list arenas/benches + gate status
```

The full gate set is **derived**: every arena whose spec asserts (non-empty `expect.events`, or
`checks`) is gated. Build-only fixtures (`bridge-engine`, `parkour-gap2`, `mine-down`, …) are left out,
because they would pass trivially. The navigator's movement sub-machines are gated by the
**leg benches** (`scenarios/bench/*.json` with `legs`): each leg is driven through the nav
probe, and PASS = arrived (one retry allowed, because live physics is noisy). Mission benches
(`drill-throughput`, `ore-room`) measure throughput and stay out of the gate.

Each arena (spec: `scripts/dev/arena.py`) builds a structure, kits and teleports the bot,
starts a mission, and asserts that the expected log events fire with **no
`TRANSITION → ERROR`** within a timeout. A missing event or an ERROR is a FAIL. `gate_live.py`
clears each arena's region afterwards, pass or fail.

Build and clean each hold a `/forceload` ticket on the arena's chunks while they write, so an
arena far from every player (a fresh world, where nobody has been near 0,0) is loaded before the
first `/fill`. The ticket is removed when the writes are done.

**Exit codes:** `0` all passed · `1` one or more failed · `2` no verdict: preflight failed (no
bot on the bridge), or the bridge stopped answering mid-gate. In the second case the summary
lists the arenas that did not run; check the client's `latest.log`, then run those by name.

**Give it CPU.** A worker tick that takes seconds (software rendering, a loaded host) makes
missions time out, and the arenas FAIL for that reason, not for the mission logic. Run the gate
on a machine with a real GPU or an idle CPU.

**Use an opped test bot.** Arena setup uses operator commands (`/fill`, `/tp`, kit items).
Fleet bots are non-op players, so op a dedicated test bot for the session and de-op it when
done ([FLEET_PLAYBOOK](FLEET_PLAYBOOK.md)). The gate is not meant for headless CI.

**Use a clean sandbox.** Arenas build at fixed world coordinates. On a live world those
coordinates can land inside terrain or your base, and the bot's world memory (known hazards,
veins) can change what a mission does. Build a flat test area and run the gate there.

**Check it is the bot, not you.** The default bridge port (55544) can be your own client. The
preflight prints the connected player name — confirm it is the test bot.

### Adding an arena

Add `scenarios/arenas/<name>.json` (ops + `mission` + `expect.events`); a non-empty
`expect.events` puts it in the full gate. Every key and op, with its default and the code that
reads it: [SCENARIOS.md](SCENARIOS.md). `scenarios/scenario.schema.json` holds the shape of every
scenario file, and `scripts/tests/test_scenario_schema.py` checks each tracked file against it.

An arena can also assert game state with no mission: `checks`, a list of `jeval` expressions
with the JSON value each must return. A `known_bad` arena marks its wrong-on-purpose checks
`"wrong": true`: a marked check passes only on a different value from a jeval that succeeded,
and every other check must pass as usual (no verdict is inverted). This is the mod-testing
path, with a worked GregTech CEu pair (`gtceu-ore-harvest-tier` and its known-bad twin):
[MOD_TESTING.md](MOD_TESTING.md). Add it to `CORE` in `scripts/dev/gate_live.py` only
if it guards a core behaviour that breaks easily (keep `--quick` small). Arenas must not overlap
in world space: each `build` clears only its own region.

**A film set is not an arena.** Staging captured from the live world lives in
`scenarios/sets/<name>.json` (no `mission`/`plan`/`expect`, plus a `snapshot` declaration) and
is outside the gate. See [RIG.md](RIG.md).

**Assert behaviours, not state-dependent side effects.** `expect.events` should name events the
mission emits on every run: `ORE_FOUND`, `DRILL_VEIN_REACHED`, `GOTO_ARRIVED`, `PLACE_CELL`. Do
not assert events that depend on accumulated world state or config latches. `WAYPOINT` is
deduplicated against existing vein markers within `cfg.scan.veinRadius`, and `VEINS_DEPLETED` needs
the mining slice's `exhausted` latch plus nearby waypoints. The mock suite covers those. This is
why `mine-vein`/`drill-vein` assert only the mined/reached event.

## Navigator benches

`scripts/dev/navbench.py` (`./gerda bench`) measures the navigator in-game: leg benches for
arrival and wall-clock ticks, planner A/B (A* vs D* Lite), and whole-mission throughput. See
[navbench.md](navbench.md).
