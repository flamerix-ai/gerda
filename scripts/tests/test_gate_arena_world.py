"""`just gate-live` on a fresh world: arena chunks are force-loaded, and a dead bridge stops the gate.

Two live failures on a fresh server (onboarding run):
  * the arenas build at x/z around 0,0, where nobody stood: every /fill answered "That position
    is not loaded", the bot was teleported into the untouched ocean and drowned. build() and
    clean() now hold a `/forceload` ticket on the build's chunks while they write.
  * after an arena FAIL the client stopped answering; clean() raised TimeoutError inside the
    gate's `finally` and the gate died with a traceback after 3 of 13 arenas. _gate_arenas now
    stops cleanly and lists the rest as not run (the gate exits 2).

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import contextlib
import io
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "scripts" / "dev"))
sys.path.insert(0, str(REPO / "mcp"))
import arena  # noqa: E402
import gate_live  # noqa: E402

SPEC = {
    "name": "t",
    "ops": [
        {"op": "clear", "from": [-3, 100, 2], "to": [20, 110, 40]},
        {"op": "fill", "from": [0, 99, 5], "to": [10, 99, 9], "block": "minecraft:stone"},
        {"op": "set", "pos": [4, 100, -6], "block": "minecraft:oak_log"},
        {"op": "player", "pos": [1, 100, 1]},
        {"op": "give", "item": "minecraft:stone_pickaxe"},
    ],
}


class _Chat:
    def __init__(self) -> None:
        self.lines: list[str] = []

    def send(self, type_: str, payload: dict | None = None) -> dict:
        if type_ == "chat" and payload:
            self.lines.append(payload["message"])
        return {"ok": True}


def _writes(lines: list[str]) -> list[int]:
    return [i for i, m in enumerate(lines) if m.startswith(("/fill", "/setblock", "/tp"))]


class ForceloadTests(unittest.TestCase):
    def setUp(self) -> None:
        for p in (mock.patch.object(arena, "_assert_dimension"), mock.patch.object(arena.time, "sleep")):
            p.start()
            self.addCleanup(p.stop)

    def test_box_covers_every_positional_op(self) -> None:
        self.assertEqual(arena.forceload_box(SPEC["ops"]), (-3, -6, 20, 40))
        self.assertIsNone(arena.forceload_box([{"op": "give", "item": "x"}]))

    def test_build_loads_the_chunks_before_the_first_write_and_releases_them_after(self) -> None:
        c = _Chat()
        with contextlib.redirect_stdout(io.StringIO()):
            arena.build(c, SPEC)  # type: ignore[arg-type]
        add = c.lines.index("/forceload add -3 -6 20 40")
        remove = c.lines.index("/forceload remove -3 -6 20 40")
        writes = _writes(c.lines)
        self.assertLess(add, min(writes))
        self.assertGreater(remove, max(writes))

    def test_clean_holds_the_same_ticket(self) -> None:
        c = _Chat()
        with contextlib.redirect_stdout(io.StringIO()):
            arena.clean(c, SPEC)  # type: ignore[arg-type]
        writes = _writes(c.lines)
        self.assertLess(c.lines.index("/forceload add -3 -6 20 40"), min(writes))
        self.assertGreater(c.lines.index("/forceload remove -3 -6 20 40"), max(writes))


class _FailingForceload(_Chat):
    """A bridge that refuses the /forceload add (dead client, not op) and answers the rest."""

    def send(self, type_: str, payload: dict | None = None) -> dict:
        if type_ == "chat" and payload and payload["message"].startswith("/forceload add"):
            raise TimeoutError("timed out")
        return super().send(type_, payload)


class FeedbackRestoredWhenForceloadFails(unittest.TestCase):
    """build() / clean() turn command feedback off first; a failing /forceload add must not leave
    it off (the add sat outside the try: the gamerule stayed false for the rest of the session)."""

    def setUp(self) -> None:
        for p in (mock.patch.object(arena, "_assert_dimension"), mock.patch.object(arena.time, "sleep")):
            p.start()
            self.addCleanup(p.stop)

    def _check(self, fn) -> None:
        c = _FailingForceload()
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(TimeoutError):
            fn(c, SPEC)
        self.assertEqual(c.lines[0], "/gamerule sendCommandFeedback false")
        self.assertEqual(c.lines[-1], "/gamerule sendCommandFeedback true")
        self.assertEqual(_writes(c.lines), [])  # nothing written into an unloaded world

    def test_build(self) -> None:
        self._check(arena.build)

    def test_clean(self) -> None:
        self._check(arena.clean)


class _DiesOnFirstWrite(_Chat):
    """A bridge whose first world write fails, and that is dead for every send after it."""

    def __init__(self) -> None:
        super().__init__()
        self.dead = False

    def send(self, type_: str, payload: dict | None = None) -> dict:
        if self.dead:
            raise TimeoutError("bridge gone")
        if type_ == "chat" and payload and payload["message"].startswith(("/fill", "/setblock")):
            self.dead = True
            raise RuntimeError("the write that ended the build")
        return super().send(type_, payload)


class DeadBridgeKeepsTheOriginalError(unittest.TestCase):
    """The finally's feedback restore runs over a dead bridge: it must warn, not replace the error
    that ended the writes with its own TimeoutError."""

    def setUp(self) -> None:
        for p in (mock.patch.object(arena, "_assert_dimension"), mock.patch.object(arena.time, "sleep")):
            p.start()
            self.addCleanup(p.stop)

    def _check(self, fn) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out), self.assertRaises(RuntimeError) as caught:
            fn(_DiesOnFirstWrite(), SPEC)
        self.assertNotIsInstance(caught.exception, TimeoutError)
        self.assertIn("the write that ended the build", str(caught.exception))
        self.assertIn("sendCommandFeedback true failed", out.getvalue())

    def test_build(self) -> None:
        self._check(arena.build)

    def test_clean(self) -> None:
        self._check(arena.clean)


class _RefusesTeardown(_Chat):
    """A bridge that answers every write, then refuses one teardown command."""

    def __init__(self, refuse: str) -> None:
        super().__init__()
        self.refuse = refuse

    def send(self, type_: str, payload: dict | None = None) -> dict:
        if type_ == "chat" and payload and payload["message"].startswith(self.refuse):
            self.lines.append(payload["message"])
            raise TimeoutError(f"{self.refuse} refused")
        return super().send(type_, payload)


class TeardownFailureAfterCleanWritesRaises(unittest.TestCase):
    """The teardown swallows a failure only while an error from the writes propagates. After writes
    that went through, a failed restore raises: a build or clean that ends normally has left no
    feedback off and no forced chunks. Both teardown commands are still sent."""

    def setUp(self) -> None:
        for p in (mock.patch.object(arena, "_assert_dimension"), mock.patch.object(arena.time, "sleep")):
            p.start()
            self.addCleanup(p.stop)

    def _check(self, fn, refuse: str) -> None:
        c = _RefusesTeardown(refuse)
        with contextlib.redirect_stdout(io.StringIO()), self.assertRaises(TimeoutError) as caught:
            fn(c, SPEC)
        self.assertIn(refuse, str(caught.exception))
        self.assertGreater(len(_writes(c.lines)), 0)  # the writes all went through first
        self.assertIn("/forceload remove -3 -6 20 40", c.lines)
        self.assertEqual(c.lines[-1], "/gamerule sendCommandFeedback true")

    def test_build_feedback_restore(self) -> None:
        self._check(arena.build, "/gamerule sendCommandFeedback true")

    def test_clean_feedback_restore(self) -> None:
        self._check(arena.clean, "/gamerule sendCommandFeedback true")

    def test_build_forceload_remove(self) -> None:
        self._check(arena.build, "/forceload remove")

    def test_clean_forceload_remove(self) -> None:
        self._check(arena.clean, "/forceload remove")


class GateStopsOnDeadBridge(unittest.TestCase):
    def test_clean_timeout_stops_the_gate_and_lists_the_rest(self) -> None:
        names = ["a", "b", "c", "d"]

        def clean(_c: object, spec: dict) -> None:
            if spec["name"] == "b":
                raise TimeoutError("timed out")

        with mock.patch.object(gate_live, "_load", side_effect=lambda n: {"name": n}), \
                mock.patch.object(gate_live, "run", side_effect=[True, False]), \
                mock.patch.object(gate_live, "clean", side_effect=clean), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            results, not_run, aborted = gate_live._gate_arenas(object(), names)  # type: ignore[arg-type]
        self.assertEqual(results, {"a": True, "b": False})
        self.assertEqual(not_run, ["c", "d"])
        self.assertTrue(aborted)
        self.assertIn("[ABORT] clean after b failed: timed out", out.getvalue())

    def test_a_crashed_arena_is_a_fail_and_the_gate_goes_on(self) -> None:
        with mock.patch.object(gate_live, "_load", side_effect=lambda n: {"name": n}), \
                mock.patch.object(gate_live, "run", side_effect=[RuntimeError("boom"), True]), \
                mock.patch.object(gate_live, "clean"), \
                contextlib.redirect_stdout(io.StringIO()):
            results, not_run, aborted = gate_live._gate_arenas(object(), ["a", "b"])  # type: ignore[arg-type]
        self.assertEqual((results, not_run, aborted), ({"a": False, "b": True}, [], False))


class GateMainExitOnAbort(unittest.TestCase):
    """main(): a dead bridge exits 2 and runs neither the benches nor the park, wherever the
    failing clean() sits. The LAST position is the one a not-run-list check missed: nothing is
    left in the list there, so the benches ran against the dead client and the gate said FAIL."""

    NAMES = ["a", "b", "c"]

    def _main(self, dead_after: str | None) -> tuple[int | None, mock.MagicMock, mock.MagicMock]:
        def clean(_c: object, spec: dict) -> None:
            if spec["name"] == dead_after:
                raise TimeoutError("timed out")

        bench = mock.MagicMock(return_value={"bench:x": True})
        park = mock.MagicMock()
        with mock.patch.object(sys, "argv", ["gate_live.py"]), \
                mock.patch.object(gate_live, "_asserting_names", return_value=list(self.NAMES)), \
                mock.patch.object(gate_live, "_all_names", return_value=list(self.NAMES)), \
                mock.patch.object(gate_live, "_bench_names", return_value=["x"]), \
                mock.patch.object(gate_live, "BridgeClient"), \
                mock.patch.object(gate_live, "_preflight"), \
                mock.patch.object(gate_live, "_load", side_effect=lambda n: {"name": n}), \
                mock.patch.object(gate_live, "run", return_value=True), \
                mock.patch.object(gate_live, "clean", side_effect=clean), \
                mock.patch.object(gate_live, "_gate_bench", bench), \
                mock.patch.object(gate_live, "_park_bot", park), \
                contextlib.redirect_stdout(io.StringIO()), \
                self.assertRaises(SystemExit) as ex:
            gate_live.main()
        code = ex.exception.code
        return (code if isinstance(code, int) or code is None else -1), bench, park

    def test_a_dead_bridge_exits_2_without_benches_at_every_position(self) -> None:
        for dead_after in self.NAMES:  # first, middle, last
            with self.subTest(dead_after=dead_after):
                code, bench, park = self._main(dead_after)
                self.assertEqual(code, 2)
                bench.assert_not_called()
                park.assert_not_called()

    def test_neg_control_a_live_bridge_runs_the_benches_and_passes(self) -> None:
        code, bench, park = self._main(None)
        self.assertEqual(code, 0)
        bench.assert_called_once()
        park.assert_called_once()


if __name__ == "__main__":
    unittest.main()
