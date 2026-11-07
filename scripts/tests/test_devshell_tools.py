"""The suites' required host tools are on PATH — a missing one FAILS here, it does not skip.

motion_probe's luma/motion checks and the sandbox `record` step run on real clips, so their tests
need `ffmpeg` and `ffprobe`. Those tests skip without them, and a skip is silent: the mutant run
then refuses a skipped CONTROL (scripts/dev/mutants.py), which names the symptom, not the cause.
This test names the cause: the tool, and the flake package that provides it (`ffmpeg-headless` in
the default devShell). Without Nix: install ffmpeg (it ships ffprobe).

Stdlib-only (unittest).
"""
from __future__ import annotations

import os
import re
import shutil
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]

# tool -> the default devShell package (flake.nix) that puts it on PATH.
REQUIRED = {"ffmpeg": "ffmpeg-headless", "ffprobe": "ffmpeg-headless"}


def missing(path: str | None) -> list[str]:
    """The REQUIRED tools that `path` (a PATH string; None = this process's PATH) does not provide."""
    return [t for t in REQUIRED if shutil.which(t, path=path) is None]


class RequiredToolsTests(unittest.TestCase):
    def test_every_required_tool_is_on_path(self) -> None:
        gone = missing(None)
        self.assertEqual(gone, [], "not on PATH: " + ", ".join(
            f"{t} (flake.nix default devShell package `{REQUIRED[t]}`)" for t in gone)
            + " — run the suites in the flake devShell (nix develop), or install ffmpeg")

    def test_a_path_without_the_tools_names_every_one(self) -> None:  # known-bad
        with tempfile.TemporaryDirectory() as empty:
            self.assertEqual(missing(empty), list(REQUIRED))

    def test_a_path_with_both_tools_misses_none(self) -> None:  # known-good twin, no host ffmpeg needed
        with tempfile.TemporaryDirectory() as d:
            for t in REQUIRED:
                p = Path(d) / t
                p.write_text("#!/bin/sh\n")
                p.chmod(0o755)
            self.assertEqual(missing(d), [])
            os.remove(Path(d) / "ffprobe")
            self.assertEqual(missing(d), ["ffprobe"])

    def test_the_named_package_is_in_the_default_devshell(self) -> None:
        flake = (REPO / "flake.nix").read_text()
        default = re.search(r"default = pkgs\.mkShell \{(.*?)\n        \};", flake, re.S)
        self.assertIsNotNone(default, "flake.nix: no `default = pkgs.mkShell { … };` block")
        assert default is not None                            # narrow for the type checker
        packages = {ln.split("#")[0].strip() for ln in default.group(1).splitlines()}
        for pkg in sorted(set(REQUIRED.values())):
            self.assertIn(pkg, packages, f"flake.nix default devShell does not list `{pkg}`")


if __name__ == "__main__":
    unittest.main()
