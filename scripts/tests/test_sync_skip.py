"""Unit tests for `scripts/ops/sync.py --skip <instance>` — the deploy filter that keeps a
RUNNING camera client from having its jsMacros harness files rewritten under it.

Why (docs/RIG.md, Film § 0): a plain `just sync` rewrote the 9 SERVICE_FILES into
EVERY launcher instance, including the live `Monifactory_cam_shader` camera. jsMacros restarts
a service whose file changes, the GraalJS context closed, and the per-frame Forge listener
registered from harness/ext.js — which 1.20.1 gives no unregister handle for — kept firing into
the dead context until the render thread crashed the client (~5 min reboot mid-shoot).

Neg-control-first: the positive case (`--skip cam` → cam gets nothing) is paired with the SAME
scenario run WITHOUT the flag (both instances get everything), so a `--skip` implementation that
simply deployed nowhere, or a fixture whose "cam" dir was unwritable for an unrelated reason,
fails here instead of reading as a pass. The third lane is the failure mode the option exists to
prevent: a typo'd instance name must exit non-zero and NAME the unknown + the known instances,
never no-op its way into the camera.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -t scripts/tests -v
"""
from __future__ import annotations

import contextlib
import io
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "ops"))
import sync  # noqa: E402

SYNC_PY = REPO / "scripts" / "ops" / "sync.py"

GOOD_BUNDLE = 'var Module = { init: function(){}, tick: function(){}, stop: function(){} };\n'

CAM = "Monifactory_cam_shader"
BOT = "Monifactory_bot_1"


def make_instance(root: Path, name: str) -> Path:
    """Create <root>/<name>/minecraft/config/jsMacros/Macros and return the Macros dir."""
    macros = root / name / sync.MACRO_SUBPATH
    macros.mkdir(parents=True)
    return macros


class SkipDeployTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.cam = make_instance(self.root, CAM)
        self.bot = make_instance(self.root, BOT)
        self.bundle = self.root / "bundle.js"
        self.bundle.write_text(GOOD_BUNDLE, "utf-8")

        # The instance root is machine config; the port registry is a REAL repo-root file
        # (mc-bots.json) — stub assign() so the suite never rewrites the developer's fleet,
        # while still recording exactly which instances deploy() handed it.
        self.assigned: list[list[tuple[str, Path]]] = []

        def fake_assign(instances, base_port=0, **_kw):
            self.assigned.append(list(instances))
            return {str(d): 55544 + i for i, (_n, d) in enumerate(sorted(instances))}

        for patcher in (
            mock.patch.object(sync.local_config, "instances_root", lambda: self.root),
            mock.patch.object(sync.fleet_registry, "assign", fake_assign),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def deployed_files(self, macros: Path) -> set[str]:
        return {p.name for p in macros.iterdir()}

    # ── POSITIVE ──────────────────────────────────────────────────────────────────
    def test_skipped_instance_receives_nothing_and_the_other_receives_everything(self) -> None:
        rc = sync.deploy(self.bundle, skip=[CAM])
        self.assertEqual(rc, 0)
        self.assertEqual(self.deployed_files(self.cam), set(), "the camera must be untouched")
        got = self.deployed_files(self.bot)
        self.assertIn("__gerda_bot.bundle.js", got)
        self.assertIn("bridge_port.txt", got)
        for svc in sync.SERVICE_FILES:
            self.assertIn(svc, got, f"{svc} must still reach the un-skipped instance")

    # ── NEG-CONTROL for the positive above ────────────────────────────────────────
    def test_only_deploys_into_the_named_instance_and_nowhere_else(self) -> None:
        # A custom bundle (-s) meant for one bot used to land in every instance of the root.
        with contextlib.redirect_stdout(io.StringIO()):
            rc = sync.deploy(self.bundle, only=[BOT])
        self.assertEqual(rc, 0)
        self.assertEqual(self.deployed_files(self.cam), set())
        self.assertIn("__gerda_bot.bundle.js", self.deployed_files(self.bot))
        self.assertEqual(sorted(n for n, _ in self.assigned[0]), sorted([CAM, BOT]))  # registry intact

    def test_unknown_only_name_fails_loud_and_deploys_nothing(self) -> None:
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            rc = sync.deploy(self.bundle, only=["Monifactory_bot_9"])
        self.assertEqual(rc, 1)
        self.assertIn("--only names no such instance", out.getvalue())
        self.assertEqual(self.deployed_files(self.cam) | self.deployed_files(self.bot), set())

    def test_without_skip_BOTH_instances_receive_the_files(self) -> None:
        # Proves the flag is what emptied the cam dir — not a broken fixture, not a deploy
        # that silently writes nowhere.
        rc = sync.deploy(self.bundle)
        self.assertEqual(rc, 0)
        for macros in (self.cam, self.bot):
            got = self.deployed_files(macros)
            self.assertIn("__gerda_bot.bundle.js", got)
            for svc in sync.SERVICE_FILES:
                self.assertIn(svc, got, f"{svc} missing from {macros}")

    def test_skip_does_not_disturb_the_port_registry(self) -> None:
        # assign() REBUILDS mc-bots.json from the list it is given: a skipped instance dropped
        # from that list would lose its entry and free its port for the next new instance.
        sync.deploy(self.bundle, skip=[CAM])
        self.assertEqual(len(self.assigned), 1)
        self.assertEqual({name for name, _ in self.assigned[0]}, {CAM, BOT})

    def test_repeated_skip_excludes_each_named_instance(self) -> None:
        third = make_instance(self.root, "Monifactory_bot_2")
        rc = sync.deploy(self.bundle, skip=[CAM, BOT])
        self.assertEqual(rc, 0)
        self.assertEqual(self.deployed_files(self.cam), set())
        self.assertEqual(self.deployed_files(self.bot), set())
        self.assertIn("__gerda_bot.bundle.js", self.deployed_files(third))

    # ── FAIL-LOUD lanes ───────────────────────────────────────────────────────────
    def test_unknown_skip_name_fails_loud_and_deploys_nothing(self) -> None:
        # A silent no-op skip is EXACTLY the failure this option exists to prevent: a typo
        # would deploy into the live camera and the only symptom is the crash 5 s later.
        rc = sync.deploy(self.bundle, skip=["Monifactory_cam_shade"])  # typo: missing 'r'
        self.assertEqual(rc, 1)
        self.assertEqual(self.deployed_files(self.cam), set())
        self.assertEqual(self.deployed_files(self.bot), set())
        self.assertEqual(self.assigned, [], "a refused run must not touch the port registry")

    def test_skip_of_all_discovered_instances_returns_one(self) -> None:
        # Refusing beats "deployed successfully to nobody": that reads green in a script and
        # leaves the fleet running last session's bundle.
        rc = sync.deploy(self.bundle, skip=[CAM, BOT])
        self.assertEqual(rc, 1)
        self.assertEqual(self.assigned, [])

    # ── absent generated data: said ONCE, not per instance ────────────────────────
    def deploy_with_service_dir(self, service_dir: Path) -> str:
        out = io.StringIO()
        with mock.patch.object(sync, "SERVICE_DIR", service_dir), contextlib.redirect_stdout(out):
            self.assertEqual(sync.deploy(self.bundle), 0)
        return out.getvalue()

    def test_absent_data_file_is_reported_once_across_instances(self) -> None:
        empty = self.root / "empty_harness"
        empty.mkdir()
        log = self.deploy_with_service_dir(empty)
        for data in sync.DATA_FILES:
            self.assertEqual(log.count(f"Skipped data {data} "), 1, log)
            for macros in (self.cam, self.bot):
                self.assertNotIn(data, self.deployed_files(macros))

    def test_present_data_file_reaches_every_instance_with_no_skip_line(self) -> None:
        # NEG-CONTROL for the lane above: the same two instances, the data present.
        full = self.root / "full_harness"
        full.mkdir()
        for data in sync.DATA_FILES:
            (full / data).write_text("{}", "utf-8")
        log = self.deploy_with_service_dir(full)
        self.assertNotIn("Skipped data", log)
        for data in sync.DATA_FILES:
            for macros in (self.cam, self.bot):
                self.assertIn(data, self.deployed_files(macros))


class SkipCliTests(unittest.TestCase):
    """End-to-end through the real CLI (the form the film flow types)."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        make_instance(self.root, CAM)
        make_instance(self.root, BOT)
        self.bundle = self.root / "bundle.js"
        self.bundle.write_text(GOOD_BUNDLE, "utf-8")

        # The CLI writes mc-bots.json on a successful deploy. `MC_BOTS_REGISTRY` points the
        # subprocess at a SEEDED scratch registry, so the developer's live one (shared by every
        # worktree) is never in play; every CLI lane here must refuse BEFORE assign(), and a
        # regression that reorders the checks shows up as a rewritten scratch file.
        self.registry = self.root / "mc-bots.json"
        self.registry.write_text('{"version": 1, "bots": []}\n', "utf-8")
        self.before = self.registry.read_bytes()

    def run_cli(self, *args: str) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        env["MC_INSTANCES_ROOT"] = str(self.root)
        env["MC_BOTS_REGISTRY"] = str(self.registry)
        return subprocess.run(
            [sys.executable, str(SYNC_PY), *args],
            capture_output=True, text=True, cwd=str(REPO), env=env,
        )

    def test_unknown_skip_exits_non_zero_naming_unknown_and_known(self) -> None:
        r = self.run_cli("-s", str(self.bundle), "--skip", "Monifactory_cam_shade")
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("Monifactory_cam_shade", r.stdout)
        self.assertIn(CAM, r.stdout)
        self.assertIn(BOT, r.stdout)
        self.assertNotIn("Deployed service", r.stdout)
        self.assertEqual(
            self.registry.read_bytes(), self.before,
            "the refused run must not have rewritten mc-bots.json",
        )

    def test_skip_is_refused_together_with_validate_only(self) -> None:
        # validate-only discovers no instance at all, so a skip list there would read as
        # "I protected the camera" while protecting nothing.
        r = self.run_cli("--validate-only", str(self.bundle), "--skip", CAM)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("--skip has no meaning here", r.stderr)

    def test_help_documents_the_option(self) -> None:
        r = self.run_cli("--help")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("--skip", r.stdout)


if __name__ == "__main__":
    unittest.main()
