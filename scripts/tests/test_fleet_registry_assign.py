"""fleet_registry.assign keeps bots it was not handed while their instance still exists.

Version matrix (docs/PORTABILITY.md): a sync against a second launcher root (MC_INSTANCES_ROOT
pointed elsewhere) rebuilt mc-bots.json from that root alone — the first root's entries
vanished and their ports went to the next new instance. Neg-control: test_other_root_entry_survives
fails on the old assign(); test_deleted_instance_leaves keeps the cleanup half honest.

Stdlib-only (unittest):
    python3 -m unittest scripts.tests.test_fleet_registry_assign -v
"""
from __future__ import annotations

import contextlib
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
import fleet_registry  # noqa: E402


class AssignKeepsOtherRootsTests(unittest.TestCase):
    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = Path(self._tmp.name)
        self.reg = self.tmp / "mc-bots.json"
        self.root_a = self.tmp / "launcherA" / "instances"
        self.root_b = self.tmp / "launcherB" / "instances"
        for d in (self.root_a / "Main", self.root_b / "Test"):
            d.mkdir(parents=True)

    def tearDown(self) -> None:
        self._tmp.cleanup()

    def bots(self) -> dict[str, int]:
        data = json.loads(self.reg.read_text("utf-8"))
        return {b["instanceDir"]: b["port"] for b in data["bots"]}

    def test_other_root_entry_survives_and_keeps_its_port(self) -> None:
        main = self.root_a / "Main"
        test = self.root_b / "Test"
        fleet_registry.assign([("Main", main)], base_port=55544, path=self.reg)
        self.assertEqual(self.bots(), {str(main): 55544})

        # A sync against the OTHER root must not delete Main, nor reuse its port.
        out = fleet_registry.assign([("Test", test)], base_port=55544, path=self.reg)
        self.assertEqual(out, {str(test): 55545})
        self.assertEqual(self.bots(), {str(main): 55544, str(test): 55545})

    def test_deleted_instance_leaves_the_registry(self) -> None:
        main = self.root_a / "Main"
        test = self.root_b / "Test"
        fleet_registry.assign([("Main", main)], base_port=55544, path=self.reg)
        main.rmdir()
        fleet_registry.assign([("Test", test)], base_port=55544, path=self.reg)
        self.assertNotIn(str(main), self.bots())


class AssignWarnsOnDuplicateNamesTests(unittest.TestCase):
    """Two roots that each hold a `Monifactory`: both rows are kept, but resolve() by name reaches
    only the first one. assign() says so on stderr (it used to be silent)."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = Path(self._tmp.name)
        self.reg = self.tmp / "mc-bots.json"

    def instance(self, root: str, name: str) -> Path:
        d = self.tmp / root / "instances" / name
        d.mkdir(parents=True)
        return d

    def assign(self, instances: list[tuple[str, Path]]) -> str:
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            fleet_registry.assign(instances, base_port=55544, path=self.reg)
        return err.getvalue()

    def test_same_name_in_two_roots_is_warned(self) -> None:
        a = self.instance("launcherA", "Monifactory")
        b = self.instance("launcherB", "Monifactory")
        self.assertEqual(self.assign([("Monifactory", a)]), "")
        err = self.assign([("Monifactory", b)])
        self.assertIn("2 instances are named 'Monifactory'", err)
        self.assertIn(f"{a} (port 55544)", err)
        self.assertIn(f"{b} (port 55545)", err)
        # The warning names the row a lookup reaches — the one resolve() really returns.
        self.assertIn("reaches only port 55545", err)
        self.assertEqual(fleet_registry.resolve("Monifactory", path=self.reg), ("127.0.0.1", 55545))

    def test_neg_control_distinct_names_are_not_warned(self) -> None:
        a = self.instance("launcherA", "Monifactory")
        b = self.instance("launcherB", "Monifactory_bot_1")
        self.assign([("Monifactory", a)])
        self.assertEqual(self.assign([("Monifactory_bot_1", b)]), "")


if __name__ == "__main__":
    unittest.main()
