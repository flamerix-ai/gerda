"""The fleet queue can dispatch to a one-instance setup, and says so when nothing can take a task.

SETUP creates one instance, `Monifactory`. The hub dispatched only to `*_bot_*` names (the rest
are the human's own client), so on that setup `fleet want` / `enqueue` sat `queued` forever with
no hint, and pinning `--bot Monifactory` was refused. local.config.json `fleetInstances` (env
MC_FLEET_INSTANCES) now names extra fleet instances, and enqueue/want replies carry a `warning`
when no fleet instance is online.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "scripts" / "ops"))
sys.path.insert(0, str(REPO / "mcp"))
import fleet_registry  # noqa: E402
import local_config  # noqa: E402

NO_ENV = {k: v for k, v in os.environ.items() if k != "MC_FLEET_INSTANCES"}


def _with(config: dict, env: dict[str, str] | None = None):
    patches = [mock.patch.dict(os.environ, {**NO_ENV, **(env or {})}, clear=True),
               mock.patch.object(local_config, "load", return_value=config)]
    for p in patches:
        p.start()
    return patches


class FleetInstanceRule(unittest.TestCase):
    def _case(self, config: dict, env: dict[str, str] | None = None) -> None:
        for p in _with(config, env):
            self.addCleanup(p.stop)

    def test_default_is_the_bot_name_mark_only(self) -> None:
        self._case({})
        self.assertTrue(fleet_registry.is_bot_instance("Monifactory_bot_1"))
        self.assertFalse(fleet_registry.is_bot_instance("Monifactory"))

    def test_config_list_adds_an_instance(self) -> None:
        self._case({"fleetInstances": ["Monifactory"]})
        self.assertTrue(fleet_registry.is_bot_instance("Monifactory"))
        self.assertFalse(fleet_registry.is_bot_instance("Other"))

    def test_env_list_adds_instances(self) -> None:
        self._case({}, {"MC_FLEET_INSTANCES": "Monifactory, Solo"})
        self.assertTrue(fleet_registry.is_bot_instance("Solo"))
        self.assertTrue(fleet_registry.is_bot_instance("Monifactory"))

    def test_a_non_list_fails_loud(self) -> None:
        self._case({"fleetInstances": {"Monifactory": True}})
        with self.assertRaises(SystemExit):
            fleet_registry.is_bot_instance("Monifactory")


class _State:
    def __init__(self, names: list[str]) -> None:
        self.names = names

    def online_rows(self) -> list[dict]:
        return [{"name": n, "online": True} for n in self.names]


class HubDispatchWarning(unittest.TestCase):
    def setUp(self) -> None:
        import fleet_hub  # noqa: PLC0415 — heavy daemon module, only these cases need it

        self.hub = fleet_hub

    def _warn(self, online: list[str], config: dict) -> str | None:
        patches = _with(config)
        try:
            return self.hub._with_dispatch_warning({"ok": True}, _State(online)).get("warning")
        finally:
            for p in patches:
                p.stop()

    def test_only_the_humans_client_online_warns(self) -> None:
        warning = self._warn(["Monifactory"], {})
        self.assertIsNotNone(warning)
        self.assertIn("Monifactory", warning or "")
        self.assertIn("fleetInstances", warning or "")

    def test_a_listed_instance_takes_tasks_without_warning(self) -> None:
        self.assertIsNone(self._warn(["Monifactory"], {"fleetInstances": ["Monifactory"]}))

    def test_a_bot_instance_online_no_warning(self) -> None:
        self.assertIsNone(self._warn(["Monifactory", "Monifactory_bot_1"], {}))

    def test_the_pin_refusal_names_the_way_out(self) -> None:
        self.assertIn("fleetInstances", self.hub.NOT_A_FLEET_BOT)


if __name__ == "__main__":
    unittest.main()
