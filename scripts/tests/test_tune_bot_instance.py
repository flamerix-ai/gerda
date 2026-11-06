"""Unit tests for scripts/ops/tune_bot_instance.py — which instances it tunes by default, and
which running launchers make it skip the instance.cfg heap edit.

Default set: it used to be the hardcoded `Monifactory_bot_1..4`, so a fifth bot (or a fleet named
otherwise) was silently left at the launcher's huge default heap. It is now every `_bot_`
instance the fleet registry or the instances dir knows. Neg-control-first: the cases that matter
are the exclusions — the human instance is never in the set even if its name carries `_bot_`, a
non-bot instance (the shader camera) stays out, and an empty fleet is a loud SystemExit, not a
silent exit-0 that tuned nothing. main() itself is driven with no args against a scratch
instances dir + registry, so a hardcoded target list in main() fails.

Launcher detection: Prism, MultiMC and FreesmLauncher all rewrite instance.cfg from memory. The
pattern is checked against the process NAMES each launcher runs under (incl. the Nix-wrapped
comm) AND against the game client's `java` comm, which must NOT match — the old `pgrep -f`
matched the game java because its cmdline carries the launcher's instances path. Only the
caller's own uid counts (`pgrep -u`) and zombie pids are dropped: on the dev host another uid's
launchers, many of them defunct, made the tuner always report "launcher running".

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -t scripts/tests -v
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "scripts" / "ops"))
import fleet_registry  # noqa: E402
import tune_bot_instance as tune  # noqa: E402

HUMAN = "Monifactory"


def registry(*names: str) -> dict:
    return {"version": 1, "bots": [{"name": n, "port": 55544 + i} for i, n in enumerate(names)]}


class DefaultTargetsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def make(self, *names: str) -> None:
        for n in names:
            (self.root / n).mkdir()

    def test_instances_dir_bots_beyond_four(self) -> None:
        self.make(HUMAN, "Monifactory_bot_1", "Monifactory_bot_5", "Other_bot_x")
        self.assertEqual(
            tune.default_targets(self.root, registry(), HUMAN),
            ["Monifactory_bot_1", "Monifactory_bot_5", "Other_bot_x"],
        )

    def test_registry_and_dir_are_unioned(self) -> None:
        self.make("Monifactory_bot_1")
        got = tune.default_targets(self.root, registry(HUMAN, "Monifactory_bot_1", "Far_bot_2"), HUMAN)
        self.assertEqual(got, ["Far_bot_2", "Monifactory_bot_1"])

    def test_non_bot_instances_excluded(self) -> None:
        self.make(HUMAN, "Monifactory_cam_shader", "Monifactory_bot_3")
        self.assertEqual(tune.default_targets(self.root, registry(), HUMAN), ["Monifactory_bot_3"])

    def test_human_instance_never_included_even_with_bot_mark(self) -> None:
        human = "Main_bot_play"
        self.make(human, "Monifactory_bot_1")
        got = tune.default_targets(self.root, registry(human), human)
        self.assertEqual(got, ["Monifactory_bot_1"])

    def test_no_bots_is_loud(self) -> None:
        self.make(HUMAN, "Monifactory_cam_shader")
        with self.assertRaises(SystemExit) as cm:
            tune.default_targets(self.root, registry(HUMAN), HUMAN)
        self.assertIn("no bot instances found", str(cm.exception))

    def test_non_dict_registry_entries_skipped(self) -> None:
        self.make("Monifactory_bot_1")
        reg = {"version": 1, "bots": ["Junk_bot_9", None, 7, {"name": "Far_bot_2", "port": 55545}]}
        self.assertEqual(tune.default_targets(self.root, reg, HUMAN), ["Far_bot_2", "Monifactory_bot_1"])


class BotNameRuleTests(unittest.TestCase):
    """One home for the `_bot_` rule (fleet_registry.is_bot_instance); the hub keeps its exact
    behaviour — no humanInstance exclusion there, only the name mark."""

    def test_rule(self) -> None:
        for name, want in (("Monifactory_bot_1", True), ("X_bot_5", True), (HUMAN, False),
                           ("Monifactory_cam_shader", False), ("Monifactory_bot", False)):
            with self.subTest(name=name):
                self.assertIs(fleet_registry.is_bot_instance(name), want)

    def test_hub_uses_the_shared_rule(self) -> None:
        import fleet_hub  # noqa: PLC0415 — heavy daemon module, only this case needs it

        for name in ("Monifactory_bot_1", HUMAN, "Main_bot_play"):
            with self.subTest(name=name):
                self.assertIs(fleet_hub._is_fleet_bot(name), fleet_registry.is_bot_instance(name))
        with mock.patch.object(fleet_hub.fleet_registry, "is_bot_instance", lambda _n: "sentinel"):
            self.assertEqual(fleet_hub._is_fleet_bot("anything"), "sentinel")


class MainDefaultTargetsTests(unittest.TestCase):
    """main() with no args must tune the DERIVED set (registry ∪ instances dir, minus the human),
    reading the real env/config keys — not a hardcoded bot_1..4 list."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        tmp = Path(self.tmp.name)
        inst = tmp / "instances"
        for n in ("X_bot_5", "Human_bot_main", "Monifactory_cam_shader"):
            (inst / n).mkdir(parents=True)
        reg = tmp / "mc-bots.json"
        reg.write_text(json.dumps(registry("Human_bot_main", "Reg_bot_7")), "utf-8")
        env = {
            "MC_INSTANCES_ROOT": str(inst),
            "MC_BOTS_REGISTRY": str(reg),
            "MC_HUMAN_INSTANCE": "Human_bot_main",
        }
        patcher = mock.patch.dict(os.environ, env)
        patcher.start()
        self.addCleanup(patcher.stop)
        # instances_root()/load() are @cache'd process-wide: clear before AND after, so neither
        # a value cached by another test nor ours leaks across.
        for fn in (tune.local_config.instances_root, tune.local_config.load):
            fn.cache_clear()
            self.addCleanup(fn.cache_clear)

    def test_no_args_tunes_derived_set(self) -> None:
        called: list[str] = []

        def fake_tune(inst: str) -> bool:
            called.append(inst)
            return True

        with mock.patch.object(tune, "tune", fake_tune), mock.patch.object(sys, "argv", ["tune_bot_instance.py"]):
            rc = tune.main()
        self.assertEqual(rc, 0)
        self.assertEqual(set(called), {"X_bot_5", "Reg_bot_7"})

    def test_explicit_args_win(self) -> None:
        called: list[str] = []
        with (
            mock.patch.object(tune, "tune", lambda i: called.append(i) or True),
            mock.patch.object(sys, "argv", ["tune_bot_instance.py", "Only_bot_1"]),
        ):
            self.assertEqual(tune.main(), 0)
        self.assertEqual(called, ["Only_bot_1"])

    def test_corrupt_registry_is_loud_not_a_smaller_set(self) -> None:
        # The forgiving load() reads a corrupt mc-bots.json as empty, which would quietly drop
        # Reg_bot_7 and tune only the instances dir; main() must refuse instead.
        Path(os.environ["MC_BOTS_REGISTRY"]).write_text('{"bots": [ ,]}', "utf-8")
        called: list[str] = []
        with (
            mock.patch.object(tune, "tune", lambda i: called.append(i) or True),
            mock.patch.object(sys, "argv", ["tune_bot_instance.py"]),
            self.assertRaises(SystemExit) as cm,
        ):
            tune.main()
        self.assertIn("mc-bots.json", str(cm.exception.code))
        self.assertEqual(called, [])


class LauncherDetectionTests(unittest.TestCase):
    # comm (process name, ≤15 chars) of each launcher as it actually runs.
    LAUNCHER_COMMS = ("freesmlauncher", "prismlauncher", ".prismlauncher-", "MultiMC")
    NOT_LAUNCHERS = ("java", "bash", "python3")

    def test_pattern_matches_every_launcher(self) -> None:
        for comm in self.LAUNCHER_COMMS:
            with self.subTest(comm=comm):
                self.assertRegex(comm, re.compile(tune.LAUNCHER_PATTERN, re.I))

    def test_pattern_rejects_game_client_and_shells(self) -> None:
        for comm in self.NOT_LAUNCHERS:
            with self.subTest(comm=comm):
                self.assertIsNone(re.search(tune.LAUNCHER_PATTERN, comm, re.I))

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.proc = Path(self.tmp.name)
        patcher = mock.patch.object(tune, "PROC_ROOT", self.proc)
        patcher.start()
        self.addCleanup(patcher.stop)

    def stat(self, pid: str, state: str, comm: str = "prismlauncher") -> None:
        (self.proc / pid).mkdir()
        (self.proc / pid / "stat").write_text(f"{pid} ({comm}) {state} 1 {pid} {pid} 0 -1\n")

    def pgrep_says(self, stdout: str):
        calls: list[list[str]] = []

        def fake_run(argv, **_kw):
            calls.append(argv)
            return subprocess.CompletedProcess(argv, 0 if stdout else 1, stdout=stdout, stderr="")

        return calls, mock.patch.object(tune.subprocess, "run", fake_run)

    def test_pgrep_own_uid_names_not_command_lines(self) -> None:
        # Another user's launcher (a container's uid) is excluded by pgrep `-u`; assert the argv.
        self.stat("123", "S")
        calls, patch = self.pgrep_says("123\n")
        with patch:
            self.assertTrue(tune.launcher_running())
        self.assertEqual(calls, [["pgrep", "-u", str(os.getuid()), "-i", tune.LAUNCHER_PATTERN]])

    def test_only_zombies_is_not_running(self) -> None:
        self.stat("200", "Z")
        self.stat("201", "Z", comm="weird) Z name")
        _, patch = self.pgrep_says("200\n201\n")
        with patch:
            self.assertFalse(tune.launcher_running())

    def test_one_live_among_zombies_is_running(self) -> None:
        self.stat("200", "Z")
        self.stat("202", "S", comm="a) Z b")  # a ') Z' inside comm must not read as a zombie
        _, patch = self.pgrep_says("200\n202\n")
        with patch:
            self.assertTrue(tune.launcher_running())

    def test_unreadable_proc_keeps_pid(self) -> None:
        _, patch = self.pgrep_says("999\n")  # no <PROC_ROOT>/999/stat
        with patch:
            self.assertTrue(tune.launcher_running())

    def test_no_match_is_not_running(self) -> None:
        def fake_run(argv, **_kw):
            return subprocess.CompletedProcess(argv, 1, stdout="", stderr="")

        with mock.patch.object(tune.subprocess, "run", fake_run):
            self.assertFalse(tune.launcher_running())


# FreesmLauncher's instance.cfg layout on the dev host: settings in [General], window state in a
# trailing [UI]. The old append-at-end writer left the heap keys under [UI], where the launcher
# never reads them, while [General] kept the global 16G/8G.
LIVE_CFG = """[General]
ConfigVersion=1.2
MaxMemAlloc=16384
MinMemAlloc=8192
OverrideMemory=true
name=Monifactory_bot_1

[UI]
InstanceAccountId=abc
MaxMemAlloc=4096
MinMemAlloc=2048
mods_Page\\ColumnsOverride=false
"""


def section_of(lines: list[str], key: str) -> list[str]:
    """Sections (by header) in which `key=` appears, in file order."""
    cur, found = None, []
    for ln in lines:
        if ln.startswith("[") and ln.endswith("]"):
            cur = ln[1:-1]
        elif ln.startswith(key + "="):
            found.append(cur)
    return found


class InstanceCfgSectionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "instance.cfg"

    def lines(self) -> list[str]:
        return self.path.read_text().splitlines()

    def placement_problems(self) -> list[str]:
        out = []
        lines = self.lines()
        for k, v in tune.INSTANCE_CFG.items():
            if section_of(lines, k) != ["General"]:
                out.append(f"{k} in {section_of(lines, k)}")
            elif f"{k}={v}" not in lines:
                out.append(f"{k} not set to {v}")
        return out

    def test_live_layout_moves_the_heap_into_general(self) -> None:
        self.path.write_text(LIVE_CFG)
        tune.set_ini_keys(self.path, tune.INSTANCE_CFG, "General")
        self.assertEqual(self.placement_problems(), [])
        # every other line survives verbatim, in order
        kept = [ln for ln in LIVE_CFG.splitlines() if not re.match(r"^(MaxMemAlloc|MinMemAlloc)=", ln)]
        self.assertEqual([ln for ln in self.lines() if not re.match(r"^(MaxMemAlloc|MinMemAlloc)=", ln)], kept)

    def test_missing_keys_are_inserted_inside_general_not_at_eof(self) -> None:
        self.path.write_text("[General]\nname=x\n\n[UI]\nInstanceAccountId=abc\n")
        tune.set_ini_keys(self.path, tune.INSTANCE_CFG, "General")
        self.assertEqual(self.placement_problems(), [])
        lines = self.lines()
        self.assertLess(max(lines.index(f"{k}={v}") for k, v in tune.INSTANCE_CFG.items()), lines.index("[UI]"))

    def test_general_as_the_last_section_appends_at_its_end(self) -> None:
        self.path.write_text("[UI]\nMaxMemAlloc=4096\n\n[General]\nname=x\n")
        tune.set_ini_keys(self.path, tune.INSTANCE_CFG, "General")
        self.assertEqual(self.placement_problems(), [])

    def test_a_repeat_inside_general_keeps_one(self) -> None:
        self.path.write_text("[General]\nMaxMemAlloc=16384\nMaxMemAlloc=16384\n")
        tune.set_ini_keys(self.path, tune.INSTANCE_CFG, "General")
        self.assertEqual(self.lines().count("MaxMemAlloc=4096"), 1)
        self.assertEqual(self.placement_problems(), [])

    def test_no_general_section_is_loud(self) -> None:
        self.path.write_text("[UI]\nInstanceAccountId=abc\n")
        with self.assertRaises(SystemExit):
            tune.set_ini_keys(self.path, tune.INSTANCE_CFG, "General")
        self.assertEqual(self.path.read_text(), "[UI]\nInstanceAccountId=abc\n")

    def test_known_bad_the_section_blind_writer_fails_the_placement_check(self) -> None:
        # neg-control: the old writer on the live layout must FAIL the same check, or the check
        # cannot tell a misplaced heap from a correct one
        self.path.write_text("[General]\nname=x\n\n[UI]\nInstanceAccountId=abc\n")
        tune.set_keys(self.path, tune.INSTANCE_CFG, "=")
        self.assertNotEqual(self.placement_problems(), [])

    def test_tune_writes_the_heap_into_general(self) -> None:
        base = Path(self.tmp.name) / "Monifactory_bot_9"
        (base / "minecraft").mkdir(parents=True)
        (base / "minecraft" / "options.txt").write_text("renderDistance:12\n")
        self.path = base / "instance.cfg"
        self.path.write_text(LIVE_CFG)
        with mock.patch.object(tune.local_config, "instances_root", return_value=Path(self.tmp.name)), \
             mock.patch.object(tune, "launcher_running", return_value=False):
            self.assertTrue(tune.tune("Monifactory_bot_9"))
        self.assertEqual(self.placement_problems(), [])


if __name__ == "__main__":
    unittest.main()
