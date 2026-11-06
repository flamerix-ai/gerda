"""Engine tests against an in-memory fake source — and a guard proving the engine
imports zero game/mod code (the engine's agnosticism contract)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import (  # noqa: E402
    Effect,
    Mode,
    Objective,
    ObjectiveEngine,
    Requirement,
    ResolveOutcome,
    have_item,
    manual,
    opaque,
)


class FakeSource:
    """In-memory ObjectiveSource. Holds mutable satisfied-state; rebuilds Objective
    snapshots on discover/refresh so it behaves like a live, mutating backend."""

    name = "fake"

    def __init__(self, objectives: list[Objective]) -> None:
        self._defs = {o.id: o for o in objectives}
        self._satisfied: dict[str, set[str]] = {o.id: set() for o in objectives}
        self._finalized: set[str] = set()
        self.submit_calls: list[tuple[str, str]] = []
        self.finalize_calls: list[str] = []

    def _view(self, oid: str) -> Objective:
        d = self._defs[oid]
        sat = self._satisfied[oid]
        reqs = [
            Requirement(r.kind, r.id, r.args, r.id in sat or r.satisfied, r.drivable)
            for r in d.requirements
        ]
        complete = all(r.satisfied for r in reqs) if reqs else False
        deps_done = all(self._is_complete(dep) for dep in d.deps)
        return Objective(
            id=d.id, title=d.title, source=self.name, requirements=reqs,
            effects=d.effects, deps=d.deps, recurring=d.recurring,
            complete=complete, can_start=deps_done,
            needs_finalize=complete and bool(d.effects) and d.id not in self._finalized,
        )

    def _is_complete(self, oid: str) -> bool:
        o = self._defs.get(oid)
        if o is None:
            return True
        sat = self._satisfied[oid]
        return all((r.id in sat or r.satisfied) for r in o.requirements) if o.requirements else False

    def discover(self) -> list[Objective]:
        return [self._view(oid) for oid in self._defs]

    def refresh(self, objective: Objective) -> Objective:
        return self._view(objective.id)

    def mark_satisfied(self, objective: Objective, requirement: Requirement) -> bool:
        self.submit_calls.append((objective.id, requirement.id))
        self._satisfied[objective.id].add(requirement.id)
        return True

    def finalize(self, objective: Objective) -> bool:
        self.finalize_calls.append(objective.id)
        self._finalized.add(objective.id)
        return True


def item_resolver_factory(have: set[str]):
    def resolver(req: Requirement) -> ResolveOutcome:
        item = req.args["item"]
        if item in have:
            return ResolveOutcome(True, f"already have {item}")
        return ResolveOutcome(False, f"cannot acquire {item}")
    return resolver


class CoreEngineTests(unittest.TestCase):
    def test_auto_completes_tractable_in_order_and_finalizes(self) -> None:
        objs = [
            Objective("Q1", "checkmark quest", "fake", [manual("t1")], effects=[Effect("claim")]),
            Objective("Q2", "have iron", "fake",
                      [have_item("t2", "iron_ingot", 3)], effects=[Effect("claim")]),
        ]
        src = FakeSource(objs)
        eng = ObjectiveEngine(
            {"have_item": item_resolver_factory({"iron_ingot"})}, mode=Mode.AUTO,
        )
        results = eng.run(src, max_steps=10)
        statuses = [r.status for r in results]
        # two done, then idle
        self.assertEqual(statuses[:2], ["done", "done"])
        self.assertEqual(statuses[-1], "idle")
        self.assertEqual(set(src.finalize_calls), {"Q1", "Q2"})
        self.assertIn(("Q1", "t1"), src.submit_calls)
        self.assertIn(("Q2", "t2"), src.submit_calls)

    def test_dependency_gating(self) -> None:
        objs = [
            Objective("A", "first", "fake", [manual("ta")]),
            Objective("B", "needs A", "fake", [manual("tb")], deps=["A"]),
        ]
        src = FakeSource(objs)
        eng = ObjectiveEngine({}, mode=Mode.AUTO)
        # Before anything, only A is actionable (B's dep not done).
        ready = [o.id for o in eng.actionable(src.discover())]
        self.assertEqual(ready, ["A"])
        eng.run(src, max_steps=10)
        # After A completes, B became actionable and ran too.
        self.assertTrue(src._is_complete("B"))

    def test_blocked_reports_precise_reason(self) -> None:
        objs = [Objective("X", "custom task", "fake", [opaque("tx", "custom")])]
        src = FakeSource(objs)
        eng = ObjectiveEngine({}, mode=Mode.AUTO)
        self.assertEqual(eng.actionable(src.discover()), [])
        r = eng.step(src)
        self.assertEqual(r.status, "blocked")
        self.assertIn("not drivable", r.detail)

    def test_unacquirable_item_blocks_at_runtime(self) -> None:
        objs = [Objective("Y", "have gold", "fake", [have_item("ty", "gold_ingot", 1)])]
        src = FakeSource(objs)
        eng = ObjectiveEngine(
            {"have_item": item_resolver_factory(set())}, mode=Mode.AUTO,
        )
        r = eng.step(src)
        self.assertEqual(r.status, "blocked")
        self.assertIn("cannot acquire gold_ingot", r.detail)

    def test_approve_mode_decline_skips(self) -> None:
        objs = [Objective("Z", "checkmark", "fake", [manual("tz")])]
        src = FakeSource(objs)
        eng = ObjectiveEngine({}, mode=Mode.APPROVE, approver=lambda _o: False)
        r = eng.step(src)
        self.assertEqual(r.status, "skipped")
        self.assertEqual(src.submit_calls, [])

    def test_recurring_objective_stays_actionable_when_complete(self) -> None:
        objs = [Objective("R", "keep stocked", "fake",
                          [have_item("tr", "iron_ingot", 32)], recurring=True)]
        src = FakeSource(objs)
        # mark it complete in the backend
        src._satisfied["R"].add("tr")
        eng = ObjectiveEngine({"have_item": item_resolver_factory({"iron_ingot"})}, mode=Mode.AUTO)
        ready = [o.id for o in eng.actionable(src.discover())]
        self.assertEqual(ready, ["R"])  # recurring => still actionable though complete


class AgnosticismGuardTest(unittest.TestCase):
    def test_core_imports_no_game_code(self) -> None:
        """Importing the engine core must not pull in bridge/MC/FTB modules."""
        import core  # noqa: F401

        forbidden = ("bridge_client", "resolve_craft_chain", "acquire")
        leaked = [m for m in sys.modules if any(f in m for f in forbidden)]
        self.assertEqual(leaked, [], f"engine core leaked game modules: {leaked}")


if __name__ == "__main__":
    unittest.main()
