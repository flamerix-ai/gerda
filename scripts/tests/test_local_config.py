"""Unit tests for scripts/local_config.py — the machine-config resolution tiers.

Stdlib-only (unittest), so they run on any Python ≥3.11 with zero installs:
    python3 -m unittest discover -s scripts/tests -v
Platform-specific tiers (env / config file / autodetect) are exercised with fake
dirs + monkeypatched module attributes, so the suite is OS-independent.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import local_config


class LocalConfigBase(unittest.TestCase):
    def setUp(self) -> None:
        self._env = dict(os.environ)
        for k in list(os.environ):
            if k.startswith("MC_"):
                del os.environ[k]
        self.tmp = tempfile.TemporaryDirectory()
        self.tmpdir = Path(self.tmp.name)
        self._orig_config_path = local_config.config_path
        self._orig_candidates = local_config._candidate_roots
        cfg = self.tmpdir / "local.config.json"
        local_config.config_path = lambda: cfg
        local_config._candidate_roots = lambda: []
        local_config.load.cache_clear()
        local_config.instances_root.cache_clear()

    def tearDown(self) -> None:
        os.environ.clear()
        os.environ.update(self._env)
        local_config.config_path = self._orig_config_path
        local_config._candidate_roots = self._orig_candidates
        local_config.load.cache_clear()
        local_config.instances_root.cache_clear()
        self.tmp.cleanup()

    def make_instances(self, *names: str) -> Path:
        root = self.tmpdir / "instances"
        for n in names:
            (root / n).mkdir(parents=True)
        root.mkdir(exist_ok=True)
        return root


class InstancesRootTests(LocalConfigBase):
    def test_env_tier_wins(self) -> None:
        root = self.make_instances()
        other = self.tmpdir / "config-root"
        os.environ["MC_INSTANCES_ROOT"] = str(root)
        local_config.config_path().write_text(json.dumps({"instancesRoot": str(other)}))
        self.assertEqual(local_config.instances_root(), root)

    def test_env_nonexistent_is_loud(self) -> None:
        os.environ["MC_INSTANCES_ROOT"] = str(self.tmpdir / "nope")
        with self.assertRaises(SystemExit):
            local_config.instances_root()

    def test_config_tier(self) -> None:
        root = self.make_instances()
        local_config.config_path().write_text(json.dumps({"instancesRoot": str(root)}))
        self.assertEqual(local_config.instances_root(), root)

    def test_config_tilde_expansion(self) -> None:
        root = self.make_instances()
        rel = "~/" + str(root.relative_to(Path.home())) if root.is_relative_to(Path.home()) else str(root)
        local_config.config_path().write_text(json.dumps({"instancesRoot": rel}))
        self.assertEqual(local_config.instances_root(), root)

    def test_config_nonexistent_is_loud(self) -> None:
        local_config.config_path().write_text(json.dumps({"instancesRoot": str(self.tmpdir / "nope")}))
        with self.assertRaises(SystemExit):
            local_config.instances_root()

    def test_malformed_config_is_loud(self) -> None:
        local_config.config_path().write_text("{not json")
        with self.assertRaises(SystemExit):
            local_config.instances_root()

    def test_autodetect_tier(self) -> None:
        root = self.make_instances()
        local_config._candidate_roots = lambda: [self.tmpdir / "absent", root]
        self.assertEqual(local_config.instances_root(), root)

    def test_nothing_found_is_loud_with_hint(self) -> None:
        with self.assertRaises(SystemExit) as ctx:
            local_config.instances_root()
        self.assertIn("local.config.json", str(ctx.exception))
        self.assertIn("MC_INSTANCES_ROOT", str(ctx.exception))


class InstanceDirTests(LocalConfigBase):
    def test_found(self) -> None:
        root = self.make_instances("Monifactory")
        os.environ["MC_INSTANCES_ROOT"] = str(root)
        self.assertEqual(local_config.instance_dir("Monifactory"), root / "Monifactory")

    def test_missing_lists_known(self) -> None:
        root = self.make_instances("Alpha", "Beta")
        os.environ["MC_INSTANCES_ROOT"] = str(root)
        with self.assertRaises(SystemExit) as ctx:
            local_config.instance_dir("Gamma")
        msg = str(ctx.exception)
        self.assertIn("Alpha", msg)
        self.assertIn("Beta", msg)


class GetTests(LocalConfigBase):
    def test_config_value_and_default(self) -> None:
        local_config.config_path().write_text(json.dumps({"humanInstance": "MyPack"}))
        self.assertEqual(local_config.get("humanInstance"), "MyPack")
        self.assertEqual(local_config.get("missingKey", "fallback"), "fallback")

    def test_env_override_snake_cases_camel(self) -> None:
        local_config.config_path().write_text(json.dumps({"humanAccountName": "from-file"}))
        os.environ["MC_HUMAN_ACCOUNT_NAME"] = "from-env"
        self.assertEqual(local_config.get("humanAccountName"), "from-env")


class ServerCtlTests(LocalConfigBase):
    def make_server(self, root: Path) -> Path:
        ctl = root / local_config.SERVER_DIR_NAME / "server-ctl.sh"
        ctl.parent.mkdir(parents=True)
        ctl.write_text("#!/bin/sh\n")
        return ctl

    def test_env_root_resolves_the_script(self) -> None:
        ctl = self.make_server(self.tmpdir / "srv")
        os.environ["MC_SERVER_ROOT"] = str(self.tmpdir / "srv")
        self.assertEqual(local_config.server_ctl(), ctl)

    def test_config_root_resolves_the_script(self) -> None:
        ctl = self.make_server(self.tmpdir / "srv")
        local_config.config_path().write_text(json.dumps({"serverRoot": str(self.tmpdir / "srv")}))
        self.assertEqual(local_config.server_ctl(), ctl)

    def test_unset_root_falls_back_to_the_one_default(self) -> None:
        os.environ["HOME"] = str(self.tmpdir / "home")
        want = self.tmpdir / "home" / "mc-servers" / local_config.SERVER_DIR_NAME
        self.assertEqual(local_config.server_dir(), want)
        ctl = self.make_server(self.tmpdir / "home" / "mc-servers")
        self.assertEqual(local_config.server_ctl(), ctl)

    def test_unset_root_without_the_default_install_is_loud(self) -> None:
        os.environ["HOME"] = str(self.tmpdir / "home")
        with self.assertRaises(SystemExit) as ctx:
            local_config.server_ctl()
        self.assertIn(str(self.tmpdir / "home" / "mc-servers"), str(ctx.exception))
        self.assertIn("MC_SERVER_ROOT", str(ctx.exception))

    def test_set_but_empty_root_is_loud_not_the_default(self) -> None:
        os.environ["HOME"] = str(self.tmpdir / "home")
        self.make_server(self.tmpdir / "home" / "mc-servers")   # the default WOULD resolve
        for where in ("env", "config"):
            with self.subTest(where=where):
                os.environ.pop("MC_SERVER_ROOT", None)
                if where == "env":
                    os.environ["MC_SERVER_ROOT"] = ""
                    local_config.config_path().write_text("{}")
                else:
                    local_config.config_path().write_text(json.dumps({"serverRoot": " "}))
                local_config.load.cache_clear()
                with self.assertRaises(SystemExit) as ctx:
                    local_config.server_ctl()
                self.assertIn("set but empty", str(ctx.exception))

    def test_env_root_beats_the_default(self) -> None:
        os.environ["HOME"] = str(self.tmpdir / "home")
        self.make_server(self.tmpdir / "home" / "mc-servers")
        os.environ["MC_SERVER_ROOT"] = str(self.tmpdir / "srv")
        self.assertEqual(local_config.server_dir(),
                         self.tmpdir / "srv" / local_config.SERVER_DIR_NAME)
        with self.assertRaises(SystemExit):
            local_config.server_ctl()   # the env root has no script — no fallback to the default

    def test_root_without_the_script_is_loud(self) -> None:
        os.environ["MC_SERVER_ROOT"] = str(self.tmpdir / "empty")
        with self.assertRaises(SystemExit) as ctx:
            local_config.server_ctl()
        self.assertIn("server-ctl.sh not found", str(ctx.exception))


class CameraAccountNameTests(LocalConfigBase):
    def test_config_value(self) -> None:
        local_config.config_path().write_text(json.dumps({"cameraAccountName": "Steve"}))
        self.assertEqual(local_config.camera_account_name(), "Steve")

    def test_env_override(self) -> None:
        local_config.config_path().write_text(json.dumps({"cameraAccountName": "from-file"}))
        os.environ["MC_CAMERA_ACCOUNT_NAME"] = "from-env"
        self.assertEqual(local_config.camera_account_name(), "from-env")

    def test_unset_is_loud_never_a_hardcoded_name(self) -> None:
        with self.assertRaises(SystemExit) as ctx:
            local_config.camera_account_name()
        self.assertIn("cameraAccountName", str(ctx.exception))


class UnresolvableRootTests(unittest.TestCase):
    """A machine-root refusal leaves local_config as SystemExit, the module's one failure type —
    callers that degrade on `except SystemExit` (sustain_live's optional instance lookup, the
    objective suite's module-level skip) would otherwise crash on a bare MachineRootError."""

    def setUp(self) -> None:
        local_config.load.cache_clear()
        self.addCleanup(local_config.load.cache_clear)

    def test_machine_root_refusal_surfaces_as_system_exit(self) -> None:
        def refuse() -> Path:
            raise local_config.machine_root.MachineRootError("probe gave no usable answer")

        with mock.patch.object(local_config.machine_root, "root", refuse):
            with self.assertRaises(SystemExit) as cm:
                local_config.load()
        self.assertIn("probe gave no usable answer", str(cm.exception))
        self.assertIsInstance(cm.exception.__cause__, local_config.machine_root.MachineRootError)

    def test_unpatched_root_resolves_without_raising(self) -> None:
        # NEG-CONTROL: the real probe in this checkout answers, so the lane above fails only
        # because of the injected refusal.
        self.assertEqual(
            local_config.config_path(), local_config.machine_root.root() / "local.config.json"
        )


if __name__ == "__main__":
    unittest.main()
