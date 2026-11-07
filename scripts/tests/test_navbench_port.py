"""Unit tests for `scripts/dev/navbench.py --port` and the registry lookup it shares with
gate_live.py (`fleet_registry.game_dir_for_port`).

The bench used to dial only the default bridge (55544), which can be the HUMAN's own client, so
benching a fleet bot meant editing the script. `--port` mirrors gate_live.py: it dials that port
AND points arena marker seeding (`MC_INST`) at the bot's own instance, or a mission bench seeds a
world store the bot never reads.

Neg-control-first: the no-flag lane must leave the default client and MC_INST untouched (a flag
that leaked its env into every run would pass the positive case), a port the registry does not
know must exit loudly instead of benching the default client, and the lookup must not match a
different port's entry. A corrupt registry must not read as "port not registered": the lookup
raises, and both gate_live.py and navbench.py report invalid JSON + the path. The registry is a
scratch file — the live mc-bots.json is never read.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -t scripts/tests -v
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "scripts" / "dev"))
import fleet_registry  # noqa: E402
import navbench  # noqa: E402


class PortTestBase(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.reg = Path(self.tmp.name) / "mc-bots.json"
        self.bot_dir = Path(self.tmp.name) / "Monifactory_bot_1"
        self.reg.write_text(
            json.dumps(
                {
                    "version": 1,
                    "bots": [
                        {"name": "Monifactory", "port": 55544, "instanceDir": "/elsewhere/Monifactory"},
                        {"name": "Monifactory_bot_1", "port": 55545, "instanceDir": str(self.bot_dir)},
                    ],
                }
            ),
            "utf-8",
        )
        env = {k: v for k, v in os.environ.items() if k != "MC_INST"}
        env["MC_BOTS_REGISTRY"] = str(self.reg)
        patcher = mock.patch.dict(os.environ, env, clear=True)
        patcher.start()
        self.addCleanup(patcher.stop)


class GameDirForPortTests(PortTestBase):
    def test_known_port_maps_to_its_game_dir(self) -> None:
        self.assertEqual(fleet_registry.game_dir_for_port(55545), self.bot_dir / "minecraft")

    def test_other_port_is_not_matched(self) -> None:
        self.assertEqual(fleet_registry.game_dir_for_port(55544), Path("/elsewhere/Monifactory/minecraft"))
        self.assertIsNone(fleet_registry.game_dir_for_port(55599))

    def test_absent_registry_is_none(self) -> None:
        self.reg.unlink()
        self.assertIsNone(fleet_registry.game_dir_for_port(55545))

    def test_corrupt_registry_raises_naming_path_and_cause(self) -> None:
        self.reg.write_text('{"version": 1, "bots": [', "utf-8")
        with self.assertRaises(fleet_registry.RegistryUnreadable) as cm:
            fleet_registry.game_dir_for_port(55545)
        self.assertIn(str(self.reg), str(cm.exception))
        self.assertIn("not valid JSON", str(cm.exception))

    def test_wrong_shape_registry_raises(self) -> None:
        self.reg.write_text('{"version": 1, "bots": {}}', "utf-8")
        with self.assertRaises(fleet_registry.RegistryUnreadable) as cm:
            fleet_registry.game_dir_for_port(55545)
        self.assertIn("not a registry", str(cm.exception))

    def test_non_dict_entries_skipped(self) -> None:
        data = json.loads(self.reg.read_text("utf-8"))
        data["bots"][:0] = ["junk", None, 55545]
        self.reg.write_text(json.dumps(data), "utf-8")
        self.assertEqual(fleet_registry.game_dir_for_port(55545), self.bot_dir / "minecraft")

    def test_non_dict_rows_are_dropped_at_the_read_boundary(self) -> None:
        # Every reader goes through load_strict, so a junk row must not crash any of them —
        # resolve() and sync's assign() did `.get` on each row unguarded.
        data = json.loads(self.reg.read_text("utf-8"))
        data["bots"][:0] = ["junk", None, 7]
        self.reg.write_text(json.dumps(data), "utf-8")
        self.assertTrue(all(isinstance(b, dict) for b in fleet_registry.load_strict()["bots"]))
        self.assertEqual(fleet_registry.resolve("Monifactory_bot_1"), ("127.0.0.1", 55545))
        ports = fleet_registry.assign([("Monifactory_bot_1", self.bot_dir)], path=self.reg)
        self.assertEqual(ports, {str(self.bot_dir): 55545})

    def test_forgiving_load_still_never_raises(self) -> None:
        self.reg.write_text("not json", "utf-8")
        self.assertEqual(fleet_registry.load(), {"version": 1, "bots": []})


class CorruptRegistryReportTests(PortTestBase):
    """Both runners must name the real cause (invalid JSON + the path), not "port N not in
    mc-bots.json" while the port IS there."""

    def setUp(self) -> None:
        super().setUp()
        self.reg.write_text('{"bots": [{"name": "Monifactory_bot_1", "port": 55545,', "utf-8")

    def test_navbench_names_the_cause(self) -> None:
        with self.assertRaises(SystemExit) as cm:
            navbench._client(55545)
        msg = str(cm.exception.code)
        self.assertIn("not valid JSON", msg)
        self.assertIn(str(self.reg), msg)
        self.assertNotIn("not in mc-bots.json", msg)
        self.assertNotIn("MC_INST", os.environ)

    def test_gate_live_names_the_cause(self) -> None:
        import gate_live  # noqa: PLC0415 — only this case needs the gate runner

        stderr = io.StringIO()
        with (
            mock.patch.object(gate_live, "BridgeClient", mock.MagicMock(name="BridgeClient")),
            mock.patch.object(gate_live, "_preflight"),
            mock.patch.object(sys, "argv", ["gate_live.py", "--bench-only", "--port", "55545"]),
            mock.patch.object(sys, "stderr", stderr),
            self.assertRaises(SystemExit) as cm,
        ):
            gate_live.main()
        self.assertEqual(cm.exception.code, 2)
        err = stderr.getvalue()
        self.assertIn("not valid JSON", err)
        self.assertIn(str(self.reg), err)
        self.assertNotIn("not in mc-bots.json", err)
        self.assertNotIn("MC_INST", os.environ)


class NavbenchPortFlagTests(PortTestBase):
    def run_main(self, *argv: str) -> mock.MagicMock:
        client = mock.MagicMock(name="BridgeClient")
        with (
            mock.patch.object(navbench, "BridgeClient", client),
            mock.patch.object(navbench, "_load", lambda n: {"name": n}),
            mock.patch.object(navbench, "build"),
            mock.patch.object(navbench, "run"),
            mock.patch.object(sys, "argv", ["navbench.py", *argv]),
        ):
            navbench.main()
        return client

    def test_port_dials_that_bridge_and_points_marker_store(self) -> None:
        client = self.run_main("build", "flat", "--port", "55545")
        client.assert_called_once_with(port=55545)
        self.assertEqual(os.environ.get("MC_INST"), str(self.bot_dir / "minecraft"))

    def test_no_port_keeps_default_bridge_and_store(self) -> None:
        client = self.run_main("build", "flat")
        client.assert_called_once_with()
        self.assertNotIn("MC_INST", os.environ)

    def test_unknown_port_is_loud(self) -> None:
        with self.assertRaises(SystemExit) as cm:
            self.run_main("build", "flat", "--port", "55599")
        self.assertIn("55599", str(cm.exception))
        self.assertNotIn("MC_INST", os.environ)


if __name__ == "__main__":
    unittest.main()
