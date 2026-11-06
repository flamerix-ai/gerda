"""Arena `checks` (mission-less jeval assertions) and `known_bad` (negative-control arenas).

The mod-testing path (docs/MOD_TESTING.md): an arena builds a scene, then asserts game state
through `jeval`, with no bot mission. A known-bad arena marks a check `wrong` on purpose; that
check passes only when the game answers the right value of its unmarked twin (same `jeval`)
and the twin passed. No verdict is inverted.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "scripts" / "dev"))
sys.path.insert(0, str(REPO / "mcp"))
import arena  # noqa: E402
import gate_live  # noqa: E402

POSITIVE = "gtceu-ore-harvest-tier"
KNOWN_BAD = "gtceu-ore-harvest-tier-knownbad"


class _Jeval:
    """A bridge whose jeval replies come from a list, in order; records the code it was sent."""

    def __init__(self, replies: list[dict]) -> None:
        self.replies = list(replies)
        self.sent: list[str] = []

    def send(self, type_: str, payload: dict | None = None) -> dict:
        assert type_ == "jeval", type_
        self.sent.append((payload or {})["code"])
        return self.replies.pop(0)


class _MissionBridge:
    """Accepts mission_start; jeval replies come from a list. Records (type, payload)."""

    def __init__(self, replies: list[dict]) -> None:
        self.replies = list(replies)
        self.sent: list[tuple[str, dict]] = []

    def send(self, type_: str, payload: dict | None = None) -> dict:
        self.sent.append((type_, payload or {}))
        return self.replies.pop(0) if type_ == "jeval" else {"ok": True}


def _ok(data: object) -> dict:
    return {"ok": True, "type": "jeval", "data": data}


CHECK = {"desc": "d", "jeval": "1", "expect": True}


class CheckOutcomeTests(unittest.TestCase):
    def test_equal_value_passes(self) -> None:
        passed, line = arena.check_outcome(CHECK, _ok(True))
        self.assertTrue(passed)
        self.assertIn("[PASS] d", line)

    def test_a_different_value_fails_and_shows_both(self) -> None:
        passed, line = arena.check_outcome(CHECK, _ok(False))
        self.assertFalse(passed)
        self.assertIn("got false, expected true", line)

    def test_one_is_not_true(self) -> None:  # canonical JSON: no Python truthiness
        self.assertFalse(arena.check_outcome(CHECK, _ok(1))[0])
        self.assertFalse(arena.check_outcome({**CHECK, "expect": 1}, _ok(1.0))[0])

    def test_objects_compare_by_content_not_key_order(self) -> None:
        check = {**CHECK, "expect": {"held": "a", "drops": True}}
        self.assertTrue(arena.check_outcome(check, _ok({"drops": True, "held": "a"}))[0])
        self.assertFalse(arena.check_outcome(check, _ok({"drops": False, "held": "a"}))[0])

    def test_a_jeval_error_is_a_fail_with_the_error_text(self) -> None:
        passed, line = arena.check_outcome(CHECK, {"ok": False, "error": "boom"})
        self.assertFalse(passed)
        self.assertIn("jeval error: boom", line)


class RunChecksTests(unittest.TestCase):
    def test_every_check_runs_even_after_a_failure(self) -> None:
        c = _Jeval([_ok(False), _ok(True)])
        with contextlib.redirect_stdout(io.StringIO()) as out:
            ok = arena.run_checks(c, [CHECK, {**CHECK, "jeval": "2"}])  # type: ignore[arg-type]
        self.assertFalse(ok)
        self.assertEqual(c.sent, ["1", "2"])
        self.assertIn("[FAIL] checks", out.getvalue())

    def test_all_passing_is_a_pass(self) -> None:  # positive control
        c = _Jeval([_ok(True), _ok(True)])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(arena.run_checks(c, [CHECK, CHECK]))  # type: ignore[arg-type]

    def test_a_mission_less_arena_runs_its_checks(self) -> None:
        spec = {"name": "t", "ops": [{"op": "clearinv"}], "checks": [CHECK]}
        c = _Jeval([_ok(False)])
        with mock.patch.object(arena, "build"), contextlib.redirect_stdout(io.StringIO()):
            self.assertFalse(arena.run(c, spec))  # type: ignore[arg-type]
        self.assertEqual(c.sent, ["1"])

    def test_a_mission_arena_runs_its_checks_after_the_verdict(self) -> None:
        spec = {
            "name": "t", "ops": [], "checks": [CHECK],
            "mission": {"name": "m"}, "expect": {"events": ["DONE"], "timeout": 5},
        }
        c = _MissionBridge([_ok(False)])
        with (
            mock.patch.object(arena, "build"),
            mock.patch.object(arena, "_reset_worker"),
            mock.patch.object(arena, "_ensure_bot_ready"),
            mock.patch.object(arena, "_recent_events", return_value=[{"event": "DONE"}]),
            mock.patch.object(arena.time, "sleep"),
            contextlib.redirect_stdout(io.StringIO()) as out,
        ):
            self.assertFalse(arena.run(c, spec))  # type: ignore[arg-type]  # mission PASS, check FAIL
        self.assertEqual([t for t, _ in c.sent], ["mission_start", "jeval"])
        self.assertIn("[PASS] seen=['DONE']", out.getvalue())

    def test_a_mission_arena_without_events_runs_its_checks(self) -> None:
        spec = {"name": "t", "ops": [], "checks": [CHECK], "mission": {"name": "m"}}
        c = _MissionBridge([_ok(False)])
        with (
            mock.patch.object(arena, "build"),
            mock.patch.object(arena, "_reset_worker"),
            mock.patch.object(arena, "_ensure_bot_ready"),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            self.assertFalse(arena.run(c, spec))  # type: ignore[arg-type]
        self.assertEqual([t for t, _ in c.sent], ["mission_start", "jeval"])

    def test_a_wrong_check_is_judged_by_its_twin_verdict(self) -> None:
        twin = {**CHECK, "desc": "twin", "jeval": "x", "expect": False}
        wrong = {**CHECK, "desc": "wrong", "jeval": "x", "wrong": True}
        # the twin got a third value (it FAILS); the wrong check got the right value
        c = _Jeval([_ok("air"), _ok(False)])
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertFalse(arena.run_checks(c, [twin, wrong]))  # type: ignore[arg-type]
        self.assertIn("[FAIL] wrong: its unmarked twin 'twin' failed", out.getvalue())

    def test_a_build_only_arena_still_passes_without_asking(self) -> None:
        c = _Jeval([])
        with mock.patch.object(arena, "build"), contextlib.redirect_stdout(io.StringIO()):
            self.assertTrue(arena.run(c, {"name": "t", "ops": [{"op": "clearinv"}]}))  # type: ignore[arg-type]
        self.assertEqual(c.sent, [])


class WrongCheckOutcomeTests(unittest.TestCase):
    """A wrong check (claims `true`) against its twin (states the right `false`)."""

    WRONG = {**CHECK, "wrong": True}
    TWIN = {**CHECK, "desc": "twin", "expect": False}

    def outcome(self, reply: dict, twin_passed: bool = True) -> tuple[bool, str]:
        return arena.wrong_outcome(self.WRONG, reply, self.TWIN, twin_passed)

    def test_the_right_value_with_a_passing_twin_passes(self) -> None:  # positive control
        passed, line = self.outcome(_ok(False))
        self.assertTrue(passed)
        self.assertIn("refused the wrong true", line)

    def test_an_accepted_wrong_value_fails(self) -> None:
        passed, line = self.outcome(_ok(True))
        self.assertFalse(passed)
        self.assertIn("cannot tell right from wrong", line)

    def test_a_jeval_error_on_a_wrong_check_fails(self) -> None:  # an error is no refusal
        passed, line = self.outcome({"ok": False, "error": "boom"})
        self.assertFalse(passed)
        self.assertIn("jeval error: boom", line)

    def test_a_third_value_fails(self) -> None:  # neither the wrong nor the right answer
        for got in (None, 0, "false", {"x": 1}):
            with self.subTest(got=got):
                passed, line = self.outcome(_ok(got))
                self.assertFalse(passed)
                self.assertIn("neither the wrong", line)

    def test_a_failed_twin_fails_the_refusal(self) -> None:
        passed, line = self.outcome(_ok(False), twin_passed=False)
        self.assertFalse(passed)
        self.assertIn("its unmarked twin 'twin' failed", line)


# The shipped known-bad asks three things in order: which block is at the ore cell (unmarked,
# expects tungstate ore), whether a stone pickaxe gets the drop (unmarked twin, expects no drop),
# and the same question again, marked wrong (claims the drop).
_ORE = _ok("gtceu:tungstate_ore")
_REFUSED = _ok({"held": "minecraft:stone_pickaxe", "drops": False})  # the true game answer
_ACCEPTED = _ok({"held": "minecraft:stone_pickaxe", "drops": True})  # the wrong claim holds
_NO_KIT = _ok({"held": "minecraft:air", "drops": False})  # the pickaxe was never given
_NULL = _ok(None)
_ERROR = {"ok": False, "error": "ReferenceError: srg is not defined"}


class KnownBadVerdictTests(unittest.TestCase):
    """A known-bad counts as PASS only when its marked check is refused BY VALUE and everything
    else holds — through both front doors, `arena.py run` and `just gate-live`."""

    def _gate(self, replies: list[dict]) -> bool:
        with (
            mock.patch.object(arena, "build"),
            mock.patch.object(gate_live, "clean"),
            contextlib.redirect_stdout(io.StringIO()),
        ):
            results, _, _ = gate_live._gate_arenas(_Jeval(replies), [KNOWN_BAD])  # type: ignore[arg-type]
        return results[KNOWN_BAD]

    def _cli_exit(self, replies: list[dict]) -> object:
        c = _Jeval(replies)
        with (
            mock.patch.object(arena, "build"),
            mock.patch.object(arena, "BridgeClient", return_value=c),
            mock.patch.object(sys, "argv", ["arena.py", "run", KNOWN_BAD]),
            contextlib.redirect_stdout(io.StringIO()),
            self.assertRaises(SystemExit) as exit_,
        ):
            arena.main()
        return exit_.exception.code

    def test_the_wrong_claim_refused_passes(self) -> None:  # positive control
        self.assertTrue(self._gate([_ORE, _REFUSED, _REFUSED]))
        self.assertEqual(self._cli_exit([_ORE, _REFUSED, _REFUSED]), 0)

    def test_the_wrong_claim_accepted_fails(self) -> None:
        self.assertFalse(self._gate([_ORE, _ACCEPTED, _ACCEPTED]))
        self.assertEqual(self._cli_exit([_ORE, _ACCEPTED, _ACCEPTED]), 1)

    def test_a_failed_placement_fails(self) -> None:  # the ore never got placed: block is air
        self.assertFalse(self._gate([_ok("minecraft:air"), _REFUSED, _REFUSED]))
        self.assertEqual(self._cli_exit([_ok("minecraft:air"), _REFUSED, _REFUSED]), 1)

    def test_a_missing_kit_fails(self) -> None:  # no pickaxe in hand: a value, but not the right one
        self.assertFalse(self._gate([_ORE, _NO_KIT, _NO_KIT]))
        self.assertEqual(self._cli_exit([_ORE, _NO_KIT, _NO_KIT]), 1)

    def test_a_null_reply_fails(self) -> None:  # null differs from the wrong value, and is no refusal
        self.assertFalse(self._gate([_ORE, _REFUSED, _NULL]))
        self.assertEqual(self._cli_exit([_ORE, _REFUSED, _NULL]), 1)

    def test_a_jeval_error_fails(self) -> None:
        self.assertFalse(self._gate([_ERROR, _ERROR, _ERROR]))
        self.assertEqual(self._cli_exit([_ERROR, _ERROR, _ERROR]), 1)
        self.assertFalse(self._gate([_ORE, _REFUSED, _ERROR]))  # an error on the wrong check is no refusal


class ValidationTests(unittest.TestCase):
    # Each refusal names its own rule, so a test reds only on the rule it is about.
    TWIN = {**CHECK, "expect": False}

    def refused(self, spec: dict, rule: str) -> None:
        with self.assertRaisesRegex(arena.SpecError, rule):
            arena.validate_arena_spec(spec, "t")

    def test_an_empty_check_list_is_refused(self) -> None:
        for checks in ([], {"jeval": "1"}):
            with self.subTest(checks=checks):
                self.refused({"checks": checks}, "'checks' must be a non-empty list")

    def test_a_check_without_code_is_refused(self) -> None:
        for ch in ({"jeval": " ", "expect": 1}, {"expect": 1}, "1"):
            with self.subTest(check=ch):
                self.refused({"checks": [ch]}, "needs a non-empty 'jeval' string")

    def test_a_check_without_expect_is_refused(self) -> None:
        self.refused({"checks": [{"jeval": "1"}]}, "has no 'expect' value")

    def test_a_known_bad_that_asserts_nothing_is_refused(self) -> None:
        self.refused({"known_bad": "x", "ops": []}, "marks its wrong check")

    def test_a_known_bad_must_name_its_wrong_behaviour(self) -> None:
        for text in ("", "  ", 1):
            with self.subTest(text=text):
                self.refused({"checks": [self.TWIN, {**CHECK, "wrong": True}], "known_bad": text},
                             "must say which wrong behaviour")

    def test_a_known_bad_without_a_marked_wrong_check_is_refused(self) -> None:
        self.refused({"checks": [CHECK], "known_bad": "x"}, "marks its wrong check")

    def test_a_wrong_check_outside_a_known_bad_is_refused(self) -> None:
        self.refused({"checks": [self.TWIN, {**CHECK, "wrong": True}]}, "belongs in a known-bad arena")

    def test_wrong_must_be_literally_true(self) -> None:
        self.refused({"checks": [self.TWIN, {**CHECK, "wrong": "yes"}], "known_bad": "x"},
                     "'wrong' must be true")

    def test_load_validates_the_arena(self) -> None:  # _load → validate_arena_spec, before a build
        with tempfile.TemporaryDirectory() as d:
            Path(d, "bad.json").write_text(json.dumps({"checks": [{"jeval": "1"}]}), "utf-8")
            with mock.patch.object(arena, "ARENA_DIR", Path(d)), \
                    self.assertRaisesRegex(arena.SpecError, "has no 'expect' value"):
                arena._load("bad")

    def test_a_set_cannot_carry_checks(self) -> None:
        for key, value in (("checks", [CHECK]), ("known_bad", "x")):
            with self.subTest(key=key):
                spec = {"snapshot": {"boxes": [{"from": [0, 0, 0], "to": [1, 1, 1]}]}, key: value}
                with self.assertRaisesRegex(arena.SpecError, f"declares '{key}'"):
                    arena.validate_set_spec(spec, "sets/x")

    def test_a_wrong_check_without_a_twin_is_refused(self) -> None:
        other = {**CHECK, "jeval": "2", "expect": False}  # an unmarked check, but other code
        with self.assertRaisesRegex(arena.SpecError, "has 0 unmarked twin"):
            arena.validate_arena_spec({"checks": [other, {**CHECK, "wrong": True}], "known_bad": "x"}, "t")

    def test_a_wrong_check_with_two_twins_is_refused(self) -> None:
        twin = {**CHECK, "expect": False}
        with self.assertRaisesRegex(arena.SpecError, "has 2 unmarked twin"):
            arena.validate_arena_spec({"checks": [twin, twin, {**CHECK, "wrong": True}], "known_bad": "x"}, "t")

    def test_a_twin_that_expects_the_wrong_value_is_refused(self) -> None:
        with self.assertRaisesRegex(arena.SpecError, "expect the same value"):
            arena.validate_arena_spec({"checks": [CHECK, {**CHECK, "wrong": True}], "known_bad": "x"}, "t")

    def test_a_well_formed_check_list_validates(self) -> None:  # positive control
        arena.validate_arena_spec({"checks": [CHECK]}, "t")
        twin = {**CHECK, "expect": False}
        arena.validate_arena_spec({"checks": [twin, {**CHECK, "wrong": True}], "known_bad": "x"}, "t")


class ShippedGtceuPairTests(unittest.TestCase):
    """The worked example of docs/MOD_TESTING.md, as files: both load, both are gated, and the
    known-bad differs from the positive arena only in what it expects."""

    def test_both_load_and_join_the_full_gate(self) -> None:
        gated = gate_live._asserting_names()
        self.assertIn(POSITIVE, gated)
        self.assertIn(KNOWN_BAD, gated)

    def test_the_known_bad_builds_the_same_scene(self) -> None:
        good, bad = arena._load(POSITIVE), arena._load(KNOWN_BAD)
        self.assertEqual(good["ops"], bad["ops"])
        self.assertNotIn("known_bad", good)
        self.assertTrue(bad["known_bad"])

    def test_the_known_bad_contradicts_a_positive_check_on_the_same_code(self) -> None:
        good = {c["jeval"]: c["expect"] for c in arena._load(POSITIVE)["checks"]}
        bad = arena._load(KNOWN_BAD)["checks"]
        contradicted = [c for c in bad if c["jeval"] in good and c["expect"] != good[c["jeval"]]]
        self.assertEqual(len(contradicted), 1, json.dumps(bad, indent=1))
        self.assertIs(contradicted[0].get("wrong"), True)  # the contradiction is the marked one
        # every other known-bad check is one the positive arena makes too, verbatim, unmarked
        for c in bad:
            if c not in contradicted:
                self.assertEqual(good.get(c["jeval"]), c["expect"])
                self.assertNotIn("wrong", c)


if __name__ == "__main__":
    unittest.main()
