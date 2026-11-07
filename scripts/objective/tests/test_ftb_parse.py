"""FTB adapter tests: offline SNBT parse vs the real genesis.snbt + a live-merge
check driven by a fake bridge (no game needed)."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # tests -> objective -> scripts

from core import KIND_HAVE_ITEM, KIND_MANUAL, Mode, ObjectiveEngine, ResolveOutcome  # noqa: E402
from sources import ftb_quests as ftb  # noqa: E402

# The skipUnless below already handles "the pack isn't installed" — but only if this module
# survives being imported. instance_dir() raises SystemExit when there is no launcher AT ALL
# (as opposed to a launcher without this pack), which killed the whole test process before
# any skip could apply. Catch it so a machine with no Minecraft skips these instead of erroring.
try:
    INSTANCE = ftb.default_instance()
except SystemExit:
    INSTANCE = None
HAS_INSTANCE = INSTANCE is not None and (
    INSTANCE / "config/ftbquests/quests/chapters/genesis.snbt"
).exists()


@unittest.skipUnless(HAS_INSTANCE, "Monifactory instance not present")
class FtbParseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.graph = ftb.load_graph(INSTANCE)
        cls.lang = ftb.load_lang(INSTANCE)

    def test_genesis_quest_present_with_expected_shape(self) -> None:
        iron = self.graph["4D1D437CC1EA334D"]
        self.assertEqual(iron.chapter, "genesis")
        self.assertEqual(iron.dependencies, ["09C8FE545131A402"])
        self.assertEqual(iron.reward_ids, ["318894ADCA9CF9DB"])
        items = {(t.item, t.count) for t in iron.tasks}
        self.assertEqual(items, {("minecraft:iron_ingot", 12), ("gtceu:wrought_iron_ingot", 12)})

    def test_tag_filter_task(self) -> None:
        drawers = self.graph["4A696D4BA5442928"]
        self.assertTrue(drawers.optional)
        t = drawers.tasks[0]
        self.assertEqual(t.tag, "functionalstorage:drawer")
        self.assertIsNone(t.item)

    def test_shorthand_string_item_task(self) -> None:
        # "Movin' Around" uses item: "rehooked:wood_hook" (string shorthand, not a dict)
        hook = self.graph["372BE3F076893D71"]
        t = hook.tasks[0]
        self.assertEqual(t.item, "rehooked:wood_hook")
        self.assertIsNone(t.tag)

    def test_title_resolution(self) -> None:
        iron = self.graph["4D1D437CC1EA334D"]
        title = ftb.resolve_title(iron, self.lang)
        # title key points at a *different* id (2E8BFA2E719B1C47) — must resolve, not echo
        self.assertNotIn("{", title)
        self.assertTrue(title)

    def test_task_requirement_mapping(self) -> None:
        iron = self.graph["4D1D437CC1EA334D"]
        reqs = [ftb.task_requirement(t, satisfied=False) for t in iron.tasks]
        self.assertTrue(all(r.kind == KIND_HAVE_ITEM for r in reqs))
        drawers = self.graph["4A696D4BA5442928"]
        dr = ftb.task_requirement(drawers.tasks[0], satisfied=False)
        self.assertEqual(dr.args.get("tag"), "functionalstorage:drawer")


class FakeBridge:
    """Mimics BridgeClient.send for the `quests`/`quest_complete`/`quest_claim` set."""

    def __init__(self, quests: list[dict]) -> None:
        self._quests = {q["id"]: q for q in quests}
        self.submits: list[str] = []
        self.claims: list[str] = []

    def send(self, cmd: str, payload: dict | None = None) -> dict:
        payload = payload or {}
        if cmd == "quests":
            qs = list(self._quests.values())
            if payload.get("quest"):
                qs = [q for q in self._quests.values() if q["id"] == payload["quest"]]
            elif payload.get("chapter"):
                qs = [q for q in self._quests.values() if q["chapter"] == payload["chapter"]]
            return {"ok": True, "data": {"quests": qs}}
        if cmd == "quest_complete":
            tid = payload["task"]
            self.submits.append(tid)
            for q in self._quests.values():
                for t in q["tasks"]:
                    if t["id"] == tid:
                        t["complete"] = True
                q["complete"] = all(t["complete"] for t in q["tasks"])
                if q["complete"]:
                    q["unclaimed"] = True
            return {"ok": True}
        if cmd == "quest_claim":
            self.claims.append(payload["quest"])
            self._quests[payload["quest"]]["unclaimed"] = False
            return {"ok": True}
        return {"ok": False, "error": f"unknown {cmd}"}


@unittest.skipUnless(HAS_INSTANCE, "Monifactory instance not present")
class FtbLiveMergeTests(unittest.TestCase):
    def _checkmark_quest(self) -> dict:
        # 09C8FE545131A402 is a checkmark, available, the dep of Iron Supply
        return {"id": "09C8FE545131A402", "chapter": "genesis", "complete": False,
                "can_start": True, "unclaimed": False,
                "tasks": [{"id": "7BC2DC471C278E85", "type": "checkmark", "complete": False}]}

    def test_engine_completes_a_checkmark_through_adapter(self) -> None:
        bridge = FakeBridge([self._checkmark_quest()])
        src = ftb.FtbQuestSource(bridge, instance=INSTANCE, chapters=["genesis"])
        eng = ObjectiveEngine({}, mode=Mode.AUTO)
        results = eng.run(src, max_steps=5)
        self.assertEqual(results[0].status, "done")
        self.assertIn("7BC2DC471C278E85", bridge.submits)
        self.assertIn("09C8FE545131A402", bridge.claims)

    def test_engine_acquires_item_then_submits(self) -> None:
        iron_live = {"id": "4D1D437CC1EA334D", "chapter": "genesis", "complete": False,
                     "can_start": True, "unclaimed": False,
                     "tasks": [{"id": "2A510F7AFB3A7019", "type": "item", "complete": False},
                               {"id": "5B599343AEB7F56C", "type": "item", "complete": False}]}
        bridge = FakeBridge([iron_live])
        src = ftb.FtbQuestSource(bridge, instance=INSTANCE, chapters=["genesis"])
        acquired: list[str] = []

        def fake_ensure(req) -> ResolveOutcome:
            acquired.append(req.args.get("item") or req.args.get("tag"))
            return ResolveOutcome(True, "pretend-acquired")

        eng = ObjectiveEngine({KIND_HAVE_ITEM: fake_ensure}, mode=Mode.AUTO)
        results = eng.run(src, max_steps=5)
        self.assertEqual(results[0].status, "done")
        self.assertEqual(set(acquired), {"minecraft:iron_ingot", "gtceu:wrought_iron_ingot"})
        self.assertEqual(set(bridge.submits), {"2A510F7AFB3A7019", "5B599343AEB7F56C"})
        self.assertIn("4D1D437CC1EA334D", bridge.claims)


if __name__ == "__main__":
    unittest.main()
