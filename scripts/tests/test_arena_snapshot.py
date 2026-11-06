"""Unit tests for the film-set snapshot half of scripts/dev/arena.py — the pure logic that
turns live block reads into `ops_generated` and back.

Neg-control-first. Every positive here is paired with a known-bad that must raise
arena.SpecError, because the failure mode this code exists to prevent is SILENT: a snapshot
that dropped a box, mis-decoded a run, or swallowed an unloaded chunk still writes a
plausible-looking spec, and you only discover the wrong stage hours later in the take. The
load-bearing assertion is the 1:1 ROUND-TRIP — compress the grid, replay the ops offline,
demand the original grid back, air included.

No live bridge is mocked: `snapshot`/`_read_box` are the only impure functions and they are
a thin loop over the pure pieces tested here.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "dev"))
import arena  # noqa: E402

STONE = "minecraft:stone"
ORE = "minecraft:iron_ore"
SAND = "minecraft:red_sand"
AIR = arena.AIR


def grid(lo, hi, fill):
    return dict.fromkeys(arena.box_cells(lo, hi), fill)


def rle_reply(lo, hi, cells):
    """Encode a grid the way harness-side `snapshot_js` does: palette + flat run pairs.

    Mirrors the JS encoder's contract so parse_block_reply is tested against the shape it
    will actually receive (read order y → z → x).
    """
    palette: list[str] = []
    index: dict[str, int] = {}
    runs: list[int] = []
    last = -1
    for cell in arena.box_cells(lo, hi):
        bid = cells[cell]
        if bid not in index:
            index[bid] = len(palette)
            palette.append(bid)
        i = index[bid]
        if i == last:
            runs[-1] += 1
        else:
            runs.extend([i, 1])
            last = i
    return {"ok": True, "type": "eval", "data": {"p": palette, "r": runs}}


class CompressionTests(unittest.TestCase):
    def test_uniform_box_is_a_single_fill(self) -> None:
        lo, hi = (0, 0, 0), (3, 3, 3)
        ops = arena.compress_box(lo, hi, grid(lo, hi, STONE))
        self.assertEqual(ops, [{"op": "fill", "from": [0, 0, 0], "to": [3, 3, 3], "block": STONE}])

    def test_all_air_box_is_a_single_clear(self) -> None:
        lo, hi = (-5, 60, 7), (-1, 62, 9)
        ops = arena.compress_box(lo, hi, grid(lo, hi, AIR))
        self.assertEqual(ops, [{"op": "clear", "from": [-5, 60, 7], "to": [-1, 62, 9]}])

    def test_an_ore_plane_merges_into_one_exception_fill(self) -> None:
        # The compression that matters: a lined chamber wall must NOT become 25 /setblock
        # round-trips. Greedy meshing grows x, then z, then y.
        lo, hi = (0, 0, 0), (4, 4, 4)
        cells = grid(lo, hi, STONE)
        for x in range(5):
            for z in range(5):
                cells[(x, 0, z)] = ORE
        ops = arena.compress_box(lo, hi, cells)
        self.assertEqual(
            ops,
            [
                {"op": "fill", "from": [0, 0, 0], "to": [4, 4, 4], "block": STONE},
                {"op": "fill", "from": [0, 0, 0], "to": [4, 0, 4], "block": ORE},
            ],
        )

    def test_a_lone_exception_becomes_a_set(self) -> None:
        lo, hi = (0, 0, 0), (2, 2, 2)
        cells = grid(lo, hi, STONE)
        cells[(1, 1, 1)] = ORE
        ops = arena.compress_box(lo, hi, cells)
        self.assertEqual(ops[1], {"op": "set", "pos": [1, 1, 1], "block": ORE})

    def test_round_trip_restores_the_grid_exactly_air_included(self) -> None:
        # A stand-in for a real set: mostly stone, a carved air corridor, an ore seam, a
        # sand pad. Replaying the generated ops offline must reproduce EVERY cell.
        lo, hi = (-4, 68, -3), (3, 74, 4)
        cells = grid(lo, hi, STONE)
        for cell in arena.box_cells(lo, hi):
            x, y, z = cell
            if 70 <= y <= 72 and -2 <= x <= 1:  # the carved corridor
                cells[cell] = AIR
            elif y == 68 and z % 2 == 0:  # the seam
                cells[cell] = ORE
        cells[(0, 69, 0)] = SAND  # a single odd block
        ops = arena.compress_box(lo, hi, cells)
        self.assertEqual(arena.apply_ops(ops), cells)

    def test_round_trip_when_air_is_the_dominant_block(self) -> None:
        # Dominant air → the base op is `clear`; the terrain becomes the exceptions. A set
        # that is mostly sky (the gap platforms over the gorge) takes this branch.
        lo, hi = (0, 100, 0), (9, 106, 5)
        cells = grid(lo, hi, AIR)
        for x in range(0, 4):
            for z in range(0, 6):
                cells[(x, 100, z)] = STONE
        ops = arena.compress_box(lo, hi, cells)
        self.assertEqual(ops[0]["op"], "clear")
        self.assertEqual(arena.apply_ops(ops), cells)

    def test_compression_is_deterministic(self) -> None:
        # The generat has to be byte-stable between snapshots of an UNCHANGED world, or every
        # re-snapshot lands a noise diff. Equal counts are tie-broken on the block id.
        lo, hi = (0, 0, 0), (1, 1, 1)
        cells = grid(lo, hi, STONE)
        for cell in list(cells)[:4]:
            cells[cell] = ORE
        self.assertEqual(arena.compress_box(lo, hi, cells), arena.compress_box(lo, hi, cells))

    # ── NEG-CONTROLS ─────────────────────────────────────────────────────────────
    def test_a_hole_in_the_read_is_rejected(self) -> None:
        lo, hi = (0, 0, 0), (2, 2, 2)
        cells = grid(lo, hi, STONE)
        del cells[(1, 1, 1)]
        with self.assertRaises(arena.SpecError) as ctx:
            arena.compress_box(lo, hi, cells)
        self.assertIn("missing", str(ctx.exception))


class SplitBoxTests(unittest.TestCase):
    def test_a_small_box_is_not_split(self) -> None:
        self.assertEqual(arena.split_box((0, 0, 0), (4, 4, 4), cap=2000), [((0, 0, 0), (4, 4, 4))])

    def test_split_tiles_the_parent_exactly(self) -> None:
        lo, hi = (-10, 60, -10), (9, 79, 9)  # 8000 cells
        subs = arena.split_box(lo, hi, cap=500)
        seen: set[tuple[int, int, int]] = set()
        for slo, shi in subs:
            self.assertLessEqual(arena.box_volume(slo, shi), 500)
            cells = arena.box_cells(slo, shi)
            self.assertFalse(seen & set(cells), "sub-boxes overlap")
            seen.update(cells)
        self.assertEqual(seen, set(arena.box_cells(lo, hi)))

    def test_the_shipped_read_cap_keeps_every_sub_box_watchdog_safe(self) -> None:
        for path in sorted((REPO / "scenarios" / "sets").glob("*.json")):
            spec = json.loads(path.read_text("utf-8"))
            for box in spec["snapshot"]["boxes"]:
                lo, hi = arena.box_bounds(box)
                for slo, shi in arena.split_box(lo, hi):
                    self.assertLessEqual(arena.box_volume(slo, shi), arena.SNAPSHOT_READ_CELLS)

    # ── NEG-CONTROL ──────────────────────────────────────────────────────────────
    def test_an_impossible_cap_raises_instead_of_looping(self) -> None:
        with self.assertRaises(arena.SpecError):
            arena.split_box((0, 0, 0), (0, 0, 0), cap=0)


class ReadJsTests(unittest.TestCase):
    """The generated JS must survive main.js's sandbox, which bans the obvious loop forms."""

    @staticmethod
    def banned_pattern() -> re.Pattern[str]:
        """Read BANNED_PATTERNS out of harness/main.js — a drift guard, not a copy: if the
        sandbox is tightened, this test fails here instead of at the next live snapshot."""
        src = (REPO / "harness" / "main.js").read_text("utf-8")
        m = re.search(r"var BANNED_PATTERNS = /(.+)/i;", src)
        assert m, "BANNED_PATTERNS not found in harness/main.js"
        return re.compile(m.group(1), re.IGNORECASE)

    def test_the_snapshot_expression_passes_the_sandbox(self) -> None:
        js = arena.snapshot_js((-350, 101, -77), (-338, 110, -65))
        self.assertIsNone(self.banned_pattern().search(js), js)
        self.assertIn("World.getBlock", js)

    def test_the_sandbox_pattern_really_bites(self) -> None:  # neg-control for the guard itself
        self.assertIsNotNone(self.banned_pattern().search("while (true) { getBlock(); }"))
        self.assertIsNotNone(self.banned_pattern().search("for(;;){ getBlock(); }"))

    def test_the_expression_covers_the_whole_box(self) -> None:
        js = arena.snapshot_js((1, 2, 3), (4, 5, 6))
        for bound in ("y=2", "y<=5", "z=3", "z<=6", "x=1", "x<=4"):
            self.assertIn(bound, js)


class SnapshotJsExecutionTests(unittest.TestCase):
    """RUN the generated JS under node, in main.js's exact sandbox wrapper, against a mock World.

    Why this exists: `rle_reply` above is a PYTHON TWIN of the in-game encoder, so every other
    test would stay green if the JS drifted — transpose its loop nesting from y→z→x to x→z→y and
    the twin transposes with it, mirroring the bug instead of catching it. Executing the real
    string closes that hole: node decodes a known mock world, and the transposed variant below is
    the neg-control proving this test can actually see the difference.

    Fail-loud, never skipped: node ships in the dev shell the gate runs in, so a missing node is
    a broken environment, not a reason to wave the check through.
    """

    LO, HI = (10, 20, 30), (12, 21, 33)  # 3 x 2 x 4 — deliberately NOT a cube
    ORE_CELL = (11, 20, 30)

    def world(self, unloaded: tuple[int, int, int] | None = None) -> dict:
        cells: dict[str, str | None] = {}
        for x, y, z in arena.box_cells(self.LO, self.HI):
            cells[f"{x},{y},{z}"] = ORE if (x, y, z) == self.ORE_CELL else STONE
        if unloaded is not None:
            cells[f"{unloaded[0]},{unloaded[1]},{unloaded[2]}"] = None  # getBlock → null
        return cells

    def expected(self) -> dict:
        return {c: (ORE if c == self.ORE_CELL else STONE) for c in arena.box_cells(self.LO, self.HI)}

    @staticmethod
    def transposed_js(lo, hi) -> str:
        """The same encoder with x and y loops swapped — the drift a python twin cannot catch."""
        return (
            "(function(){var P=[],M={},R=[],last=-1,run=0;"
            f"for(var x={lo[0]};x<={hi[0]};x++)"
            f"{{for(var z={lo[2]};z<={hi[2]};z++)"
            f"{{for(var y={lo[1]};y<={hi[1]};y++){{"
            'var b=World.getBlock(x,y,z);var id=b?b.getId():"";'
            "var i=M[id];if(i===undefined){i=P.length;M[id]=i;P.push(id);}"
            "if(i===last){run++;}else{if(last>=0){R.push(last);R.push(run);}last=i;run=1;}"
            "}}}"
            "if(last>=0){R.push(last);R.push(run);}"
            "return {p:P,r:R};})()"
        )

    def run_js(self, code: str, blocks: dict) -> dict:
        """Evaluate `code` exactly as harness/main.js safeEval does and return the payload.

        node OR bun — both ship in the dev shell, and the pre-push hook's environment has bun
        (`just check` runs `bun run check` immediately before this suite) even when node is not on PATH.
        Neither present is a hard FAILURE, never a skip: a silently un-run encoder test is the
        same blind spot the python twin already had.
        """
        runner = shutil.which("node") or shutil.which("bun")
        self.assertIsNotNone(runner, "need node or bun on PATH to run the encoder (both are in the dev shell)")
        # .cjs: the wrapper uses `with(_ctx)`, which is illegal in ESM (always strict), and this
        # repo's package.json declares "type": "module".
        harness = (
            f"const CODE = {json.dumps(code)};\n"
            f"const BLOCKS = {json.dumps(blocks)};\n"
            "const World = { getBlock(x, y, z) {\n"
            "  const id = BLOCKS[x + ',' + y + ',' + z];\n"
            "  if (id === undefined) throw new Error('unmocked cell ' + [x, y, z]);\n"
            "  return id === null ? null : { getId: () => id };\n"
            "} };\n"
            # The literal wrapper from harness/main.js safeEval (main.js:251).
            'const fn = new Function("_ctx", "var java=undefined, JsMacros=undefined, '
            'event=undefined; with(_ctx){return(" + CODE + ");}");\n'
            "const out = fn({World, Player: null, GlobalVars: null, Math, JSON, String, "
            "Number, Date, console: {log(){}}});\n"
            "process.stdout.write(JSON.stringify(out));\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "run_snapshot_js.cjs"
            path.write_text(harness, "utf-8")
            proc = subprocess.run([str(runner), str(path)], capture_output=True, text=True, timeout=60)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(proc.stdout)

    def test_the_real_js_encodes_the_world_the_decoder_expects(self) -> None:
        payload = self.run_js(arena.snapshot_js(self.LO, self.HI), self.world())
        decoded = arena.parse_block_reply({"ok": True, "data": payload}, self.LO, self.HI)
        self.assertEqual(decoded, self.expected())

    def test_the_wrapper_is_the_one_main_js_uses(self) -> None:
        # Drift guard for the sandbox wrapper itself: if safeEval's `new Function` prologue
        # changes, the harness above stops being a faithful stand-in.
        src = (REPO / "harness" / "main.js").read_text("utf-8")
        self.assertIn(
            'new Function("_ctx", "var java=undefined, JsMacros=undefined, event=undefined; '
            'with(_ctx){return(" + code + ");}")',
            src,
        )

    # ── NEG-CONTROLS ─────────────────────────────────────────────────────────────
    def test_a_transposed_loop_nesting_is_caught(self) -> None:
        payload = self.run_js(self.transposed_js(self.LO, self.HI), self.world())
        decoded = arena.parse_block_reply({"ok": True, "data": payload}, self.LO, self.HI)
        # It still decodes (same cell count) — the ONLY difference is read order, which is
        # exactly what the python-twin encoder was blind to.
        self.assertEqual(len(decoded), arena.box_volume(self.LO, self.HI))
        self.assertNotEqual(decoded, self.expected())

    def test_an_unloaded_chunk_surfaces_as_a_rejected_read(self) -> None:
        # End-to-end through the REAL js: getBlock returns null → the encoder emits "" → the
        # decoder refuses, instead of restaging a hole as air.
        payload = self.run_js(arena.snapshot_js(self.LO, self.HI), self.world(unloaded=(12, 21, 33)))
        with self.assertRaises(arena.SpecError) as ctx:
            arena.parse_block_reply({"ok": True, "data": payload}, self.LO, self.HI)
        self.assertIn("chunk NOT loaded", str(ctx.exception))


class ParseReplyTests(unittest.TestCase):
    def test_a_well_formed_reply_decodes_to_the_grid(self) -> None:
        lo, hi = (0, 0, 0), (2, 1, 2)
        cells = grid(lo, hi, STONE)
        cells[(1, 1, 1)] = ORE
        cells[(0, 0, 0)] = AIR
        self.assertEqual(arena.parse_block_reply(rle_reply(lo, hi, cells), lo, hi), cells)

    # ── NEG-CONTROLS: one per rejection rule ─────────────────────────────────────
    def test_a_bridge_error_is_raised_not_swallowed(self) -> None:
        with self.assertRaises(arena.SpecError):
            arena.parse_block_reply({"ok": False, "error": "boom"}, (0, 0, 0), (0, 0, 0))

    def test_a_non_object_reply_is_rejected(self) -> None:
        with self.assertRaises(arena.SpecError):
            arena.parse_block_reply("pong", (0, 0, 0), (0, 0, 0))

    def test_a_missing_data_object_is_rejected(self) -> None:
        with self.assertRaises(arena.SpecError):
            arena.parse_block_reply({"ok": True}, (0, 0, 0), (0, 0, 0))

    def test_an_unloaded_chunk_sentinel_is_rejected(self) -> None:
        # World.getBlock returns null off a loaded chunk; the JS encodes that as "" and it
        # must NOT be silently restaged as air.
        reply = {"ok": True, "data": {"p": [""], "r": [0, 1]}}
        with self.assertRaises(arena.SpecError) as ctx:
            arena.parse_block_reply(reply, (0, 0, 0), (0, 0, 0))
        self.assertIn("chunk NOT loaded", str(ctx.exception))

    def test_an_unnamespaced_block_id_is_rejected(self) -> None:
        reply = {"ok": True, "data": {"p": ["stone"], "r": [0, 1]}}
        with self.assertRaises(arena.SpecError):
            arena.parse_block_reply(reply, (0, 0, 0), (0, 0, 0))

    def test_a_short_read_is_rejected(self) -> None:
        reply = {"ok": True, "data": {"p": [STONE], "r": [0, 3]}}
        with self.assertRaises(arena.SpecError) as ctx:
            arena.parse_block_reply(reply, (0, 0, 0), (1, 1, 1))
        self.assertIn("box holds", str(ctx.exception))

    def test_a_long_read_is_rejected(self) -> None:
        reply = {"ok": True, "data": {"p": [STONE], "r": [0, 99]}}
        with self.assertRaises(arena.SpecError):
            arena.parse_block_reply(reply, (0, 0, 0), (1, 1, 1))

    def test_an_odd_run_list_is_rejected(self) -> None:
        reply = {"ok": True, "data": {"p": [STONE], "r": [0]}}
        with self.assertRaises(arena.SpecError):
            arena.parse_block_reply(reply, (0, 0, 0), (0, 0, 0))

    def test_an_out_of_range_palette_index_is_rejected(self) -> None:
        reply = {"ok": True, "data": {"p": [STONE], "r": [4, 1]}}
        with self.assertRaises(arena.SpecError):
            arena.parse_block_reply(reply, (0, 0, 0), (0, 0, 0))

    def test_a_zero_length_run_is_rejected(self) -> None:
        reply = {"ok": True, "data": {"p": [STONE], "r": [0, 0]}}
        with self.assertRaises(arena.SpecError):
            arena.parse_block_reply(reply, (0, 0, 0), (0, 0, 0))

    def test_a_runaway_run_count_is_rejected_before_it_is_materialised(self) -> None:
        # r=[0, 2**31] would allocate ~17 GB if the budget were only checked after extend().
        # The test passing INSTANTLY (rather than swapping the box to death) is the assertion.
        reply = {"ok": True, "data": {"p": [STONE], "r": [0, 2**31]}}
        with self.assertRaises(arena.SpecError) as ctx:
            arena.parse_block_reply(reply, (0, 0, 0), (1, 1, 1))
        self.assertIn("overflow", str(ctx.exception))

    def test_water_is_refused(self) -> None:
        # Fluids are id-only, so source-vs-flowing is lost and a restage writes a PERMANENT
        # source (an eternal waterfall down the clutch corridor). Snapshot dry.
        cells = grid((0, 0, 0), (1, 1, 1), STONE)
        cells[(1, 0, 1)] = "minecraft:water"
        with self.assertRaises(arena.SpecError) as ctx:
            arena.parse_block_reply(rle_reply((0, 0, 0), (1, 1, 1), cells), (0, 0, 0), (1, 1, 1))
        self.assertIn("(1, 0, 1)", str(ctx.exception))
        self.assertIn("DRY", str(ctx.exception))

    def test_lava_is_refused(self) -> None:
        cells = grid((0, 0, 0), (1, 1, 1), "minecraft:lava")
        with self.assertRaises(arena.SpecError):
            arena.parse_block_reply(rle_reply((0, 0, 0), (1, 1, 1), cells), (0, 0, 0), (1, 1, 1))

    def test_a_wet_looking_but_solid_block_is_not_refused(self) -> None:  # positive control
        # The fluid guard must key on the fluid ids, not on a substring — `water_cauldron`,
        # `waterlogged`-named blocks and ice are ordinary solid blocks and must snapshot fine.
        cells = grid((0, 0, 0), (1, 1, 1), "minecraft:water_cauldron")
        decoded = arena.parse_block_reply(rle_reply((0, 0, 0), (1, 1, 1), cells), (0, 0, 0), (1, 1, 1))
        self.assertEqual(decoded, cells)


class SpecTests(unittest.TestCase):
    def make(self, **over) -> dict:
        spec = {
            "desc": "a set",
            "snapshot": {"boxes": [{"from": [0, 0, 0], "to": [2, 2, 2]}]},
            "ops_generated": [],
            "ops": [],
        }
        spec.update(over)
        return spec

    def test_a_well_formed_set_validates(self) -> None:
        arena.validate_set_spec(self.make(), "sets/x")

    def test_every_shipped_set_validates(self) -> None:
        paths = sorted((REPO / "scenarios" / "sets").glob("*.json"))
        self.assertTrue(paths, "no film sets shipped")
        for path in paths:
            arena.validate_set_spec(json.loads(path.read_text("utf-8")), f"sets/{path.stem}")

    def test_sets_are_invisible_to_the_gate_surface(self) -> None:
        # THE isolation invariant: `run --all` (and `just gate-live` on top of it) enumerates
        # scenarios/arenas ONLY. A set leaking in here would be run as a mission-less arena.
        names = arena._all_names()
        self.assertIn("drill-gap-vein", names)  # positive control: arenas ARE enumerated
        set_stems = {p.stem for p in (REPO / "scenarios" / "sets").glob("*.json")}
        self.assertTrue(set_stems)
        self.assertFalse(set_stems & set(names))
        self.assertTrue(all(n.startswith(arena.SET_PREFIX) for n in arena._all_set_names()))

    def test_the_prefix_routes_to_the_right_directory(self) -> None:
        self.assertEqual(arena._spec_path("sets/04b_gap"), REPO / "scenarios" / "sets" / "04b_gap.json")
        self.assertEqual(arena._spec_path("bridge-gap"), REPO / "scenarios" / "arenas" / "bridge-gap.json")

    def test_generated_ops_are_built_before_the_hand_written_ones(self) -> None:
        spec = self.make(
            name="sets/x",
            ops_generated=[{"op": "fill", "from": [0, 0, 0], "to": [1, 1, 1], "block": STONE}],
            ops=[{"op": "player", "pos": [0, 2, 0]}],
        )
        self.assertEqual([o["op"] for o in arena._build_ops(spec)], ["fill", "player"])

    def test_a_spec_round_trips_through_the_dumper(self) -> None:
        spec = self.make(
            name="sets/x",  # injected by _load, deliberately NOT persisted
            snapshot={"boxes": [{"from": [0, 0, 0], "to": [2, 2, 2]}], "dimension": "minecraft:overworld"},
            ops_generated=[{"op": "set", "pos": [1, 2, 3], "block": ORE}],
            ops=[{"op": "marker", "ore": "iron", "x": -343, "z": -70}],
        )
        text = arena._dump_spec(spec)
        back = json.loads(text)
        self.assertNotIn("name", back)
        self.assertEqual(back, {k: v for k, v in spec.items() if k != "name"})
        self.assertEqual(list(back), ["desc", "snapshot", "ops_generated", "ops"])
        # The dimension stamp survives the dumper verbatim — a re-snapshot rewrites the same
        # value in the same place, so an unchanged world stays a zero-diff.
        self.assertEqual(back["snapshot"]["dimension"], "minecraft:overworld")
        # One leaf object per line — a 300-op generat must stay diff-readable.
        self.assertIn('    {"op": "set", "pos": [1, 2, 3], "block": "minecraft:iron_ore"}', text)

    # ── NEG-CONTROLS: one per rejection rule ─────────────────────────────────────
    def test_a_set_that_runs_a_mission_is_refused(self) -> None:
        with self.assertRaises(arena.SpecError) as ctx:
            arena.validate_set_spec(self.make(mission={"name": "drill"}), "sets/x")
        self.assertIn("scenarios/arenas", str(ctx.exception))

    def test_a_set_that_runs_a_plan_is_refused(self) -> None:
        with self.assertRaises(arena.SpecError):
            arena.validate_set_spec(self.make(plan="sustain-cycle"), "sets/x")

    def test_a_set_that_asserts_events_is_refused(self) -> None:
        with self.assertRaises(arena.SpecError):
            arena.validate_set_spec(self.make(expect={"events": ["BOOT"]}), "sets/x")

    def test_a_set_without_a_snapshot_declaration_is_refused(self) -> None:
        spec = self.make()
        del spec["snapshot"]
        with self.assertRaises(arena.SpecError):
            arena.validate_set_spec(spec, "sets/x")

    def test_an_empty_box_list_is_refused(self) -> None:
        with self.assertRaises(arena.SpecError):
            arena.validate_set_spec(self.make(snapshot={"boxes": []}), "sets/x")

    def test_a_box_without_corners_is_refused(self) -> None:
        with self.assertRaises(arena.SpecError):
            arena.validate_set_spec(self.make(snapshot={"boxes": [{"from": [0, 0, 0]}]}), "sets/x")

    def test_an_oversized_box_is_refused(self) -> None:
        big = {"from": [0, 0, 0], "to": [63, 63, 63]}  # 262144 cells
        with self.assertRaises(arena.SpecError) as ctx:
            arena.validate_set_spec(self.make(snapshot={"boxes": [big]}), "sets/x")
        self.assertIn("cap", str(ctx.exception))

    def test_the_box_cap_is_inclusive(self) -> None:  # boundary positive control
        edge = {"from": [0, 0, 0], "to": [31, 31, 31]}  # exactly SNAPSHOT_MAX_CELLS
        self.assertEqual(arena.box_volume(*arena.box_bounds(edge)), arena.SNAPSHOT_MAX_CELLS)
        arena.validate_set_spec(self.make(snapshot={"boxes": [edge]}), "sets/x")

    def test_a_non_list_ops_key_is_refused(self) -> None:
        with self.assertRaises(arena.SpecError):
            arena.validate_set_spec(self.make(ops={"op": "clearinv"}), "sets/x")

    def write_set(self, stem: str, spec: dict) -> str:
        path = REPO / "scenarios" / "sets" / f"{stem}.json"
        path.write_text(json.dumps(spec), "utf-8")
        self.addCleanup(path.unlink)
        return f"sets/{stem}"

    def test_a_persisted_name_key_is_refused(self) -> None:  # NEG-CONTROL
        # `name` is DERIVED from the filename and filtered out by the dumper, so a hand-written
        # one is shadowed on load and deleted on the next write — a disagreement with no symptom
        # until someone trusts it. It must fail loudly instead.
        name = self.write_set("_test_named", dict(self.make(), name="sets/something_else"))
        with self.assertRaises(arena.SpecError) as ctx:
            arena._load(name)
        self.assertIn("filename", str(ctx.exception))

    def test_the_same_spec_without_the_key_loads(self) -> None:  # positive control
        name = self.write_set("_test_unnamed", self.make())
        self.assertEqual(arena._load(name)["name"], name)  # injected, from the filename

    def test_building_a_set_with_no_ops_is_refused(self) -> None:
        # The pre-snapshot stub state: a set whose world was never captured must fail loudly,
        # not "apply 0 ops" and leave the operator filming bare terrain.
        with self.assertRaises(arena.SpecError) as ctx:
            arena._build_ops(self.make(name="sets/x"))
        self.assertIn("snapshot", str(ctx.exception))


class FakeBridge:
    """A scripted stand-in for BridgeClient: the two `eval` shapes arena.py sends, plus chat.

    Not a mock framework and not a live bridge — the guards under test are pure decisions made
    ON a reply, so the reply is the only part that has to be real. `dimension=None` plays the
    client that cannot answer (between worlds), which must abort just as hard as a wrong one.
    """

    def __init__(self, dimension: str | None = "minecraft:overworld", box=None, cells=None, ok: bool = True) -> None:
        self.dimension = dimension
        self.box = box
        self.cells = cells
        self.ok = ok
        self.sent: list[tuple[str, dict]] = []

    def send(self, cmd: str, payload: dict | None = None) -> dict:
        self.sent.append((cmd, payload or {}))
        if cmd == "eval":
            code = (payload or {}).get("code", "")
            if "getDimension" in code:
                if not self.ok:
                    return {"ok": False, "type": "eval", "error": "no world"}
                return {"ok": True, "type": "eval", "data": self.dimension}
            assert self.box is not None, "unexpected block read"
            return rle_reply(self.box[0], self.box[1], self.cells)
        if cmd in ("chat", "key"):
            return {"ok": True, "type": cmd}
        raise AssertionError(f"unexpected bridge command {cmd}")

    def block_ops(self) -> list[str]:
        return [p["message"] for c, p in self.sent if c == "chat" and p["message"].startswith(("/fill", "/setblock"))]


class DimensionGuardTests(unittest.TestCase):
    """A box is a bare (x,y,z) volume: read it from javd:void and you get a well-formed,
    all-air, totally wrong set. Positives and neg-controls for the one read that notices."""

    def spec(self, **over) -> dict:
        spec = {
            "name": "sets/x",
            "desc": "a set",
            "snapshot": {"boxes": [{"from": [0, 0, 0], "to": [1, 1, 1]}]},
            "ops_generated": [{"op": "fill", "from": [0, 0, 0], "to": [1, 1, 1], "block": STONE}],
            "ops": [],
        }
        spec.update(over)
        return spec

    def test_the_dimension_expression_survives_the_sandbox(self) -> None:
        # It rides the same sandboxed `eval` as the block read, whose BANNED_PATTERNS rejects
        # loops and the word `java` — asserted against the LIVE regex in harness/main.js.
        c = FakeBridge()
        self.assertEqual(arena._client_dimension(c), "minecraft:overworld")
        code = c.sent[0][1]["code"]
        self.assertIsNone(ReadJsTests.banned_pattern().search(code), code)
        self.assertIn("World.getDimension", code)

    def test_a_bridge_error_is_not_a_dimension(self) -> None:  # NEG-CONTROL
        with self.assertRaises(arena.SpecError):
            arena._client_dimension(FakeBridge(ok=False))

    def test_a_non_string_dimension_is_refused(self) -> None:  # NEG-CONTROL
        for bad in (None, "", "   ", 7):
            with self.subTest(reply=bad), self.assertRaises(arena.SpecError):
                arena._client_dimension(FakeBridge(dimension=bad))

    def test_a_stringified_null_is_refused(self) -> None:  # NEG-CONTROL
        # `"" + World.getDimension()` turns a between-worlds null into the 4-char STRING "null"
        # — a real transient (live mc_world.json files carry `UNKNOWN_NAME|null` sections), and
        # the likely state right after a bare `--wait-ready` returns. It must never be stamped.
        for bad in ("null", "undefined"):
            with self.subTest(reply=bad), self.assertRaises(arena.SpecError):
                arena._client_dimension(FakeBridge(dimension=bad))

    def test_an_unnamespaced_dimension_is_refused(self) -> None:  # NEG-CONTROL
        # Every real id is namespaced (minecraft:overworld, javd:void — every key in every live
        # world store); no ':' means the reply was not a dimension id at all.
        with self.assertRaises(arena.SpecError):
            arena._client_dimension(FakeBridge(dimension="overworld"))

    def test_snapshot_stamps_the_dimension_and_round_trips_it(self) -> None:
        path = REPO / "scenarios" / "sets" / "_test_dimguard.json"
        self.addCleanup(lambda: path.exists() and path.unlink())
        box = ((0, 0, 0), (1, 1, 1))
        c = FakeBridge(dimension="minecraft:overworld", box=box, cells=grid(*box, STONE))
        spec = self.spec(name="sets/_test_dimguard", ops_generated=[])
        arena.snapshot(c, "sets/_test_dimguard", spec)
        self.assertEqual(spec["snapshot"]["dimension"], "minecraft:overworld")
        on_disk = json.loads(path.read_text("utf-8"))
        self.assertEqual(on_disk["snapshot"]["dimension"], "minecraft:overworld")
        # A re-snapshot of the same world rewrites the identical file — the zero-diff property.
        before = path.read_text("utf-8")
        arena.snapshot(FakeBridge(box=box, cells=grid(*box, STONE)), "sets/_test_dimguard", arena._load("sets/_test_dimguard"))
        self.assertEqual(path.read_text("utf-8"), before)

    def test_snapshot_refuses_to_recapture_from_another_dimension(self) -> None:  # NEG-CONTROL
        # The destructive case: the generat is GOOD and a read from the void would overwrite it.
        box = ((0, 0, 0), (1, 1, 1))
        spec = self.spec(snapshot={"boxes": [{"from": [0, 0, 0], "to": [1, 1, 1]}], "dimension": "minecraft:overworld"})
        c = FakeBridge(dimension="javd:void", box=box, cells=grid(*box, AIR))
        with self.assertRaises(arena.SpecError) as ctx:
            arena.snapshot(c, "sets/x", spec)
        self.assertIn("javd:void", str(ctx.exception))
        self.assertEqual(spec["ops_generated"][0]["block"], STONE)  # untouched

    def test_build_refuses_a_mismatched_dimension_before_any_op(self) -> None:  # NEG-CONTROL
        spec = self.spec(snapshot={"boxes": [{"from": [0, 0, 0], "to": [1, 1, 1]}], "dimension": "minecraft:overworld"})
        c = FakeBridge(dimension="javd:void")
        with self.assertRaises(arena.SpecError) as ctx:
            arena.build(c, spec)
        self.assertIn("javd:void", str(ctx.exception))
        self.assertEqual(c.block_ops(), [])  # not one block written before it gave up

    def test_build_refuses_a_spec_with_no_stamp(self) -> None:  # NEG-CONTROL
        spec = self.spec()  # pre-guard spec: no snapshot.dimension at all
        with self.assertRaises(arena.SpecError) as ctx:
            arena.build(FakeBridge(), spec)
        self.assertIn("re-snapshot", str(ctx.exception).lower())

    def test_snapshot_refuses_a_blind_recapture_of_an_unstamped_generat(self) -> None:  # NEG-CONTROL
        # A generat with no stamp is exactly the pre-guard shipped shape: re-capturing it blind
        # from the wrong world would overwrite good ops with plausible all-air ones.
        box = ((0, 0, 0), (1, 1, 1))
        spec = self.spec()  # ops_generated present, no snapshot.dimension
        c = FakeBridge(dimension="minecraft:overworld", box=box, cells=grid(*box, AIR))
        with self.assertRaises(arena.SpecError) as ctx:
            arena.snapshot(c, "sets/x", spec)
        self.assertIn("hand-stamp", str(ctx.exception).lower())
        self.assertEqual(spec["ops_generated"][0]["block"], STONE)  # untouched

    def test_clean_refuses_a_mismatched_dimension_before_any_op(self) -> None:  # NEG-CONTROL
        # clean is the DESTRUCTIVE path: it air-fills whole regions, so it carries both guards.
        spec = self.spec(snapshot={"boxes": [{"from": [0, 0, 0], "to": [1, 1, 1]}], "dimension": "minecraft:overworld"})
        c = FakeBridge(dimension="javd:void")
        with self.assertRaises(arena.SpecError):
            arena.clean(c, spec)
        self.assertEqual(c.block_ops(), [])  # not one region aired out

    def test_clean_refuses_a_spec_with_no_stamp(self) -> None:  # NEG-CONTROL
        with self.assertRaises(arena.SpecError):
            arena.clean(FakeBridge(), self.spec())

    def test_clean_proceeds_when_the_dimension_matches(self) -> None:  # positive control
        spec = self.spec(snapshot={"boxes": [{"from": [0, 0, 0], "to": [1, 1, 1]}], "dimension": "minecraft:overworld"})
        c = FakeBridge(dimension="minecraft:overworld")
        arena.clean(c, spec)
        self.assertEqual(len(c.block_ops()), 1)  # the one fill region got aired

    def test_build_proceeds_when_the_dimension_matches(self) -> None:  # positive control
        spec = self.spec(snapshot={"boxes": [{"from": [0, 0, 0], "to": [1, 1, 1]}], "dimension": "minecraft:overworld"})
        c = FakeBridge(dimension="minecraft:overworld")
        arena.build(c, spec)
        self.assertEqual(len(c.block_ops()), 1)

    def test_an_arena_needs_no_stamp(self) -> None:  # positive control: guard is set-scoped
        arena_spec = {"name": "bridge-gap", "desc": "an arena", "ops": [{"op": "clearinv"}]}
        c = FakeBridge()
        arena.build(c, arena_spec)
        self.assertNotIn("eval", [cmd for cmd, _ in c.sent])  # no dimension read at all

    def test_a_non_string_stamp_is_refused_by_the_validator(self) -> None:  # NEG-CONTROL
        # "null"/"overworld": a hand-written stamp must clear the same bar as the live read.
        for bad in (None, "", 7, ["minecraft:overworld"], "null", "overworld"):
            with self.subTest(dimension=bad), self.assertRaises(arena.SpecError):
                arena.validate_set_spec(
                    {"snapshot": {"boxes": [{"from": [0, 0, 0], "to": [1, 1, 1]}], "dimension": bad}}, "sets/x"
                )

    def test_a_string_stamp_validates(self) -> None:  # positive control
        arena.validate_set_spec(
            {"snapshot": {"boxes": [{"from": [0, 0, 0], "to": [1, 1, 1]}], "dimension": "minecraft:the_nether"}},
            "sets/x",
        )


class OpBudgetTests(unittest.TestCase):
    """The write-side twin of SNAPSHOT_MAX_CELLS: every op is a chat round-trip."""

    @staticmethod
    def ops(n: int) -> list[dict]:
        return [{"op": "set", "pos": [i, 0, 0], "block": STONE} for i in range(n)]

    def test_an_over_budget_build_is_refused(self) -> None:  # NEG-CONTROL
        with self.assertRaises(arena.SpecError) as ctx:
            arena._check_op_budget(self.ops(arena.BUILD_MAX_OPS + 1), "sets/x")
        msg = str(ctx.exception)
        self.assertIn(str(arena.BUILD_MAX_OPS + 1), msg)  # names the count…
        self.assertIn("BUILD_MAX_OPS", msg)  # …and the knob

    def test_the_cap_is_inclusive(self) -> None:  # boundary positive control
        arena._check_op_budget(self.ops(arena.BUILD_MAX_OPS), "sets/x")

    def test_every_shipped_spec_is_within_budget(self) -> None:
        for path in sorted((REPO / "scenarios" / "sets").glob("*.json")):
            spec = json.loads(path.read_text("utf-8"))
            spec["name"] = f"sets/{path.stem}"
            arena._check_op_budget(arena._build_ops(spec), spec["name"])

    def test_every_shipped_set_is_stamped_with_a_namespaced_dimension(self) -> None:
        # The three teaser sets were captured on the dedicated server's minecraft:overworld
        # (world-store evidence `localhost|minecraft:overworld` + the palette check at capture);
        # an unstamped shipped set would refuse to build — a stamp is part of being shippable.
        for path in sorted((REPO / "scenarios" / "sets").glob("*.json")):
            with self.subTest(set=path.stem):
                dim = json.loads(path.read_text("utf-8"))["snapshot"]["dimension"]
                self.assertIn(":", dim)

    def test_an_over_budget_capture_is_refused_before_the_write(self) -> None:  # NEG-CONTROL
        # The capture-side twin of the build cap: a spec that could never build must die at
        # capture time, while the world its boxes describe is still intact — and BEFORE the
        # over-budget result hits the disk.
        path = REPO / "scenarios" / "sets" / "_test_budget.json"
        self.addCleanup(lambda: path.exists() and path.unlink())
        box = ((0, 0, 0), (1, 1, 1))
        spec = {
            "name": "sets/_test_budget",
            "desc": "a set",
            "snapshot": {"boxes": [{"from": [0, 0, 0], "to": [1, 1, 1]}]},
            "ops_generated": [],
            "ops": self.ops(arena.BUILD_MAX_OPS + 1),
        }
        c = FakeBridge(box=box, cells=grid(*box, STONE))
        with self.assertRaises(arena.SpecError):
            arena.snapshot(c, "sets/_test_budget", spec)
        self.assertFalse(path.exists())  # refused before the write, not after

    def test_the_budget_is_checked_before_the_first_op_goes_out(self) -> None:
        spec = {
            "name": "sets/x",
            "snapshot": {"boxes": [{"from": [0, 0, 0], "to": [1, 1, 1]}], "dimension": "minecraft:overworld"},
            "ops_generated": self.ops(arena.BUILD_MAX_OPS + 1),
        }
        c = FakeBridge()
        with self.assertRaises(arena.SpecError):
            arena.build(c, spec)
        self.assertEqual(c.block_ops(), [])  # refused, not truncated half-way through


class CliTests(unittest.TestCase):
    """The two CLI guards that keep sets out of the gate and keep `list` usable."""

    @staticmethod
    def run_cli(script: str, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            [sys.executable, str(REPO / "scripts" / "dev" / script), *args],
            capture_output=True, text=True, timeout=120,
        )

    def test_the_gate_lists_arenas_without_a_bridge(self) -> None:  # positive control
        proc = self.run_cli("gate_live.py", "--list")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("drill-vein", proc.stdout)

    def test_the_gate_refuses_a_film_set_by_name(self) -> None:  # NEG-CONTROL
        # Naming a set on the gate would "PASS" a build with nothing asserted AND reshape a
        # shoot location. It must die on the argument, before it ever dials the bridge.
        proc = self.run_cli("gate_live.py", "sets/03_ore_chamber")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("film sets are staging only", proc.stdout + proc.stderr)

    def test_snapshot_refuses_an_arena(self) -> None:  # NEG-CONTROL
        proc = self.run_cli("arena.py", "snapshot", "drill-vein")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("sets/", proc.stdout + proc.stderr)

    def test_one_broken_set_does_not_blank_the_listing(self) -> None:
        broken = REPO / "scenarios" / "sets" / "_test_broken.json"
        broken.write_text("{ this is not json", "utf-8")
        self.addCleanup(broken.unlink)
        proc = self.run_cli("arena.py", "list")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("UNREADABLE", proc.stdout)
        self.assertIn("sets/04b_gap", proc.stdout)  # the healthy ones still print
        self.assertIn("drill-vein", proc.stdout)


if __name__ == "__main__":
    unittest.main()
