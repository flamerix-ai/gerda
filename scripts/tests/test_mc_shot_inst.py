"""Unit tests for which INSTANCE scripts/ops/mc_shot.py reads shots from.

`--file`/`--latest` resize a PNG out of one instance's `screenshots/` dir, and that dir used
to be hard-wired to the HUMAN instance: a shot triggered on a bot or camera client was pulled
by hand-running ffmpeg, and asking mc_shot for it silently handed back the human instance's
STALE ai_shot.png — a wrong frame that looks exactly like a right one. `MC_INST`
(absolute path to an instance's `minecraft` dir) now overrides it, resolved by the ONE home for
that env — `local_config.mc_inst_override`, shared with arena.py's `marker` op — so these cases
cover the resolver both tools use, not a mc_shot-local copy of it.

Neg-control-first: the override winning is the cheap half. What actually protects the caller is
that the MC_INST branch does NOT stick (unset → the normal resolution, asserted against a
fabricated instances root) and that a bogus MC_INST dies LOUDLY rather than falling back to the
human instance — a silent fallback here reproduces the exact stale-frame bug. Resolution runs at
IMPORT time, so every case imports the module fresh under a prepared environment; nothing here
touches a real launcher dir.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import ast
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))  # local_config
sys.path.insert(0, str(REPO / "scripts" / "ops"))  # mc_shot


RELOADED = ("mc_shot", "local_config")


def fake_instance(root: Path, name: str) -> Path:
    """`<root>/<name>/minecraft` with a screenshots dir, i.e. a MultiMC-format instance."""
    inst = root / name / "minecraft"
    (inst / "screenshots").mkdir(parents=True)
    return inst


class InstanceResolutionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        # Every case pins the human-instance NAME too, so a machine-local local.config.json
        # (gitignored, may name any instance) cannot decide the outcome.
        self.base = {"MC_HUMAN_INSTANCE": "Monifactory"}
        # sys.modules hygiene: these tests re-import local_config under a fabricated env, and
        # local_config @caches instances_root() for the life of the process. Leaving that copy
        # behind would hand every LATER suite in the same `unittest discover` run a cache built
        # from a tmpdir that setUp already deleted. Put the originals back, always.
        saved = {name: sys.modules.get(name) for name in RELOADED}
        self.addCleanup(self._restore_modules, saved)

    @staticmethod
    def _restore_modules(saved: dict[str, object]) -> None:
        for name, mod in saved.items():
            if mod is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = mod  # type: ignore[assignment]

    def import_mc_shot(self, env: dict[str, str | None]):
        """Import mc_shot FRESH under `env` (None = unset the var) and return the module.

        Both mc_shot and local_config are dropped from sys.modules first: the instance is
        resolved at IMPORT time, and a cached local_config would let one case's root leak into
        the next and turn a real regression green. The MC_INST branch itself lives in
        local_config (`mc_inst_override`, shared with arena.py's `marker` op) — importing
        mc_shot exercises that resolver end to end.
        """
        to_set = {k: v for k, v in env.items() if v is not None}
        with mock.patch.dict(os.environ, to_set):
            for key, val in env.items():
                if val is None:
                    os.environ.pop(key, None)
            for name in RELOADED:
                sys.modules.pop(name, None)
            import mc_shot  # noqa: PLC0415 — the import IS the code under test

            return mc_shot

    def test_MC_INST_wins(self) -> None:
        inst = fake_instance(self.tmp / "instances", "Monifactory_cam_shader")
        mod = self.import_mc_shot({**self.base, "MC_INST": str(inst), "MC_INSTANCES_ROOT": None})
        self.assertEqual(mod.INSTANCE, str(inst))
        self.assertEqual(mod.SCREENSHOTS_DIR, str(inst / "screenshots"))

    def test_without_MC_INST_the_human_instance_is_used(self) -> None:  # NEG-CONTROL
        # The override must not stick: unset, resolution falls back to <instancesRoot>/<human>.
        root = self.tmp / "instances"
        inst = fake_instance(root, "Monifactory")
        fake_instance(root, "Monifactory_bot_1")  # a sibling that must NOT be picked
        mod = self.import_mc_shot({**self.base, "MC_INST": None, "MC_INSTANCES_ROOT": str(root)})
        self.assertEqual(mod.INSTANCE, str(inst))
        self.assertEqual(mod.SCREENSHOTS_DIR, str(inst / "screenshots"))

    def test_a_bogus_MC_INST_fails_LOUDLY(self) -> None:  # NEG-CONTROL
        # Fail-loud, never a quiet fall-back to the human instance: a typo'd override that
        # degraded into "some other instance's screenshots" is the stale-frame bug itself.
        missing = self.tmp / "instances" / "does_not_exist" / "minecraft"
        root = self.tmp / "instances"
        fake_instance(root, "Monifactory")  # resolvable — so ONLY the bad MC_INST can fail this
        with self.assertRaises(SystemExit) as cm:
            self.import_mc_shot({**self.base, "MC_INST": str(missing), "MC_INSTANCES_ROOT": str(root)})
        self.assertEqual(cm.exception.code, 2)


class DocstringTests(unittest.TestCase):
    """The module docstring is mc_shot's `--help`-adjacent manual. It once claimed the bot can't
    self-screenshot, which contradicts the `screenshot` bridge command (docs/EYES_HANDS.md §
    Eyes) that `--file` exists to read. Parsed from source, so no import-time resolution runs."""

    def docstring(self) -> str:
        src = (REPO / "scripts" / "ops" / "mc_shot.py").read_text("utf-8")
        doc = ast.get_docstring(ast.parse(src))
        self.assertIsNotNone(doc)
        return " ".join(str(doc).split())

    def test_names_the_screenshot_bridge_command(self) -> None:
        self.assertIn("The bot screenshots itself: the `screenshot` bridge command", self.docstring())

    def test_no_stale_cannot_self_screenshot_claim(self) -> None:  # NEG-CONTROL: the old line
        self.assertNotIn("bot can't self-screenshot", self.docstring())


if __name__ == "__main__":
    unittest.main()
