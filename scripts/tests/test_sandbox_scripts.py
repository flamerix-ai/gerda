"""scripts/sandbox/{sbx.sh,provision.sh,Containerfile}: the checks that guard what gets installed.

No container, no network and no display (the stubs: sandbox_fixture.py). Each fail-closed
behaviour has its known-good twin next to it, so a stub that refused everything could not pass
the suite. Every guarded line of these scripts carries a `# gate:<id>` tag, and the mutants these
tests must kill are in scripts/dev/mutants/sandbox.toml.

Stdlib-only (unittest); needs bash and coreutils (sha256sum), which the flake devShell has:
    python3 -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import hashlib
import os
import re
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sandbox_fixture import (  # noqa: E402
    DEVSHELL_TOOLS, LAUNCHER, REPO, SBX, XDOTOOL, XPROP, Pack, Sandbox, sha, tracked_files,
)


class ClosedPathTests(Sandbox):
    """The fixture's PATH reaches the stubs and DEVSHELL_TOOLS, nothing of this host (CI has less)."""

    def test_the_path_is_the_stubs_then_the_devshell_tools(self) -> None:  # known-good
        self.assertEqual(self.env["PATH"].split(":"), [str(self.bin), str(self.tools)])
        self.assertEqual(sorted(p.name for p in self.tools.iterdir()), sorted(DEVSHELL_TOOLS))
        for verb in ("pgrep", "pkill", "setsid"):   # procps / util-linux: not in the devShell
            self.assertEqual(self.sbx(f"command -v {verb}").stdout.strip(), str(self.bin / verb))

    def test_a_host_tool_off_the_list_is_not_found(self) -> None:
        known = {p.name for p in self.bin.iterdir()} | set(DEVSHELL_TOOLS)
        # bash's builtins and keywords: `command -v` finds them without any PATH lookup
        known |= {ln.split()[-1] for ln in self.sbx("enable -a").stdout.splitlines()}
        known |= {"if", "then", "else", "elif", "fi", "case", "esac", "for", "select", "while",
                  "until", "do", "done", "in", "function", "time", "coproc"}
        host = next((p.name for d in os.environ["PATH"].split(":") if os.path.isdir(d)
                     for p in sorted(Path(d).iterdir())
                     if p.name not in known and os.access(p, os.X_OK)
                     and re.fullmatch(r"[\w.+-]+", p.name)), None)
        self.assertIsNotNone(host, "no host tool off the list to try")
        r = self.sbx(f"command -v {host}")
        self.assertNotEqual(r.returncode, 0, f"{host} reached from the closed PATH: {r.stdout}")

    def test_a_miss_behind_or_true_is_recorded(self) -> None:
        r = self.sbx("no_such_tool_sbx 2>/dev/null || true; pgrep -x foo || true")
        self.assertEqual(r.returncode, 0)   # the script hid both misses ...
        self.assertEqual(self.missing.read_text().splitlines(),   # ... the fixture did not
                         ["no_such_tool_sbx", "pgrep (stub has no form ['-x', 'foo'])"])
        self.missing.write_text("")   # recorded on purpose here; the cleanup check is for real runs

    def test_the_pgrep_stub_finds_and_pkill_stops_a_live_process(self) -> None:
        mark = f"sbx-pgrep-{self.tmp.name}"
        p = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)", mark])
        self.addCleanup(p.kill)
        self.assertEqual(self.sbx(f'pgrep -f -- "{mark}"').stdout.split(), [str(p.pid)])
        self.assertEqual(self.sbx(f'pgrep -f -- "{mark}-other"').returncode, 1)   # no match
        self.assertEqual(self.sbx(f'pkill -f -- "{mark}"').returncode, 0)
        self.assertEqual(p.wait(timeout=10), -15)   # SIGTERM
        self.assertEqual(self.sbx(f'pgrep -f -- "{mark}"').returncode, 1)


class CachedKeyTests(Sandbox):
    def cached(self, url: str) -> str:
        return self.sbx(f'cached "{url}"').stdout.strip()

    def test_two_urls_with_the_same_file_name_get_two_files(self) -> None:
        a, b = self.cached("https://a.example/1/download"), self.cached("https://b.example/2/download")
        self.assertNotEqual(a, b)

    def test_the_same_url_gets_the_same_file_with_a_readable_name(self) -> None:  # known-good
        url = "https://cdn.example/x/fabric-api-0.92.12%2B1.20.1.jar"
        path = self.cached(url)
        self.assertEqual(path, self.cached(url))
        digest = hashlib.sha256(url.encode()).hexdigest()
        self.assertEqual(path, f"{self.cache}/dl/{digest}-fabric-api-0.92.12+1.20.1.jar")


class PackFromUrlTests(Sandbox):
    URL = "https://example.invalid/MyPack.zip"

    def test_a_url_without_a_sha256_is_refused_before_any_download(self) -> None:
        r = self.sbx(f'do_pack MyPack "{self.URL}"')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("needs the zip's sha256", r.stderr)
        self.assertEqual(self.calls(), [])

    def test_a_malformed_sha256_is_refused(self) -> None:
        r = self.sbx(f'do_pack MyPack "{self.URL}" abc123')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not a sha256", r.stderr)
        self.assertEqual(self.calls(), [])

    def test_unpinned_downloads_again_over_a_cached_copy(self) -> None:
        launcher = self.home / "apps" / "FreesmLauncher"
        launcher.mkdir(parents=True)
        (launcher / "FreesmLauncher").write_text("")  # the launcher step is not under test
        (launcher / "FreesmLauncher").chmod(0o755)
        zip_path = Path(self.sbx(f'cached "{self.URL}"').stdout.strip())
        zip_path.parent.mkdir(parents=True)
        zip_path.write_text("the old pack")
        self.sbx(f'do_pack MyPack "{self.URL}" --unpinned', STUB_BODY="the new pack")
        self.assertIn(f"curl {self.URL}", self.calls())
        self.assertEqual(zip_path.read_text(), "the new pack")


class NoWebsiteRouteTests(unittest.TestCase):
    """The sandbox never downloads through the CurseForge website: mods come from the launcher's
    own import (its official API access honours the authors' third-party opt-outs) or --from."""

    ROUTE = re.compile(r"curseforge\.com/api|www\.curseforge\.com/[^\s\"']*/download|_cf_fetch|CF_DOWNLOAD")
    # this file holds the pattern and its known-bads; the pins TSV is data (names + sha256)
    EXEMPT = {Path(__file__).resolve(), SBX / "monifactory-0.13.4-client-files.tsv"}

    def test_no_tracked_file_names_the_website_route(self) -> None:
        files = tracked_files()
        self.assertGreater(len(files), 100)  # the scan saw the tree, not an empty list
        self.assertIn(SBX / "sbx.sh", files)
        for f in files:
            if f.resolve() in self.EXEMPT:
                continue
            with self.subTest(file=str(f.relative_to(REPO))):
                self.assertIsNone(self.ROUTE.search(f.read_bytes().decode("utf-8", "replace")))

    def test_the_pattern_catches_the_removed_route(self) -> None:  # known-bad
        for old in ('CF_DOWNLOAD_URL="https://www.curseforge.com/api/v1/mods/%s/files/%s/download"',
                    'xargs -P 8 -n 2 bash "$SBX_DIR/sbx.sh" _cf_fetch < "$ids"',
                    "https://www.curseforge.com/minecraft/mc-mods/x/download/7396677"):
            with self.subTest(old=old):
                self.assertIsNotNone(self.ROUTE.search(old))


class LauncherSeedTests(Sandbox):
    """The launcher never offers to fetch the official CurseForge app's API key: the import
    uses the launcher's own CurseForge access."""

    KEY = "FlameKeyShouldBeFetchedOnStartup"

    def test_the_seeded_launcher_config_turns_the_key_fetch_off(self) -> None:
        ldir = self.home / "apps" / "FreesmLauncher"
        self.stub("FreesmLauncher", "", ldir)  # installed already: the download is not under test
        r = self.sbx("install_launcher")
        self.assertEqual(r.returncode, 0, r.stderr)
        cfg = (ldir / "freesmlauncher.cfg").read_text().splitlines()
        self.assertIn(f"{self.KEY}=false", cfg)
        self.assertEqual([ln for ln in cfg if ln.startswith(self.KEY)], [f"{self.KEY}=false"])

    def test_no_tracked_file_turns_the_key_fetch_on(self) -> None:
        on = re.compile(self.KEY + r"\s*=\s*(true|1)\b", re.I)
        files = tracked_files()
        self.assertIn(SBX / "sbx.sh", files)
        # exempt: this file (the pattern) and the mutant files, which hold that mutant on purpose
        mutant_dir = REPO / "scripts" / "dev" / "mutants"
        for f in files:
            if f.resolve() == Path(__file__).resolve() or f.parent == mutant_dir:
                continue
            with self.subTest(file=str(f.relative_to(REPO))):
                self.assertIsNone(on.search(f.read_bytes().decode("utf-8", "replace")))


class VerifyPackFilesTests(Pack):
    def verify(self) -> subprocess.CompletedProcess[str]:
        return self.sbx(f'verify_pack_files "{self.game}" t "{self.pins}"')

    def test_the_pinned_files_pass(self) -> None:  # known-good
        self.write_files(self.game, self.FILES)
        (self.game / "mods" / ".index").mkdir()   # the launcher's metadata dir is not a pack file
        r = self.verify()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("all 2 files match", r.stdout)

    def test_a_changed_byte_fails(self) -> None:
        self.write_files(self.game, {**self.FILES, "mods/a.jar": "jar A"})
        r = self.verify()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("differ from the pins", r.stderr)

    def test_a_missing_file_fails(self) -> None:
        self.write_files(self.game, {"mods/a.jar": "jar a"})
        r = self.verify()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("differ from the pins", r.stderr)

    def test_an_extra_or_disabled_file_fails(self) -> None:
        for extra in ({"mods/x.jar": "x"}, {"mods/a.jar.disabled": "jar a"}):
            with self.subTest(extra=extra):
                shutil.rmtree(self.game, ignore_errors=True)
                files = {**self.FILES, **extra}
                if "mods/a.jar.disabled" in extra:   # an optional mod left unchecked in the import
                    del files["mods/a.jar"]
                self.write_files(self.game, files)
                r = self.verify()
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("differ from the pins", r.stderr)

    def test_a_file_in_another_dir_fails(self) -> None:  # right name, right bytes, wrong folder
        self.write_files(self.game, {"resourcepacks/a.jar": "jar a", "resourcepacks/r p.zip": "pack r"})
        r = self.verify()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("differ from the pins", r.stderr)

    def test_an_empty_install_fails_also_unpinned(self) -> None:
        (self.game / "mods").mkdir(parents=True)
        r = self.sbx(f'verify_pack_files "{self.game}" t ""')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no files in", r.stderr)

    def test_unpinned_records_the_list(self) -> None:
        self.write_files(self.game, self.FILES)
        r = self.sbx(f'verify_pack_files "{self.game}" t ""')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("UNPINNED: 2", r.stdout)
        got = (self.home / ".sbx" / "t-files.tsv").read_text()
        self.assertIn(f"resourcepacks\tr p.zip\t{sha('pack r')}\n", got)

    def test_missing_pins_are_an_error_not_unpinned(self) -> None:
        r = self.sbx(f'check_pins_file "{self.tmp / "no-such.tsv"}" "{self.zip}"')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("is missing — refusing", r.stderr)

    def test_pins_of_another_pack_fail(self) -> None:
        other = self.tmp / "other.tsv"
        other.write_text(self.pins.read_text().replace("12\t22", "12\t99"))
        r = self.sbx(f'check_pins_file "{other}" "{self.zip}"')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("do not list the same files as the manifest", r.stderr)

    def test_a_pins_row_without_a_known_dir_fails(self) -> None:
        good = self.pins.read_text()
        first = good.splitlines()[0]
        for bad in (good.replace("\tmods\t", "\t../mods\t"), good.replace("\tmods\t", "\tconfig\t"),
                    good.replace("\tmods\t", "\t\t"), good.replace("\tmods\t", "\t"),
                    good.replace(first, first + "\textra")):   # a known dir, but a sixth column
            with self.subTest(bad=bad.splitlines()[0]):
                self.pins.write_text(bad)
                r = self.sbx(f'check_pins_file "{self.pins}" "{self.zip}"')
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("row 1: ", r.stderr)

    def test_the_pins_of_the_zip_pass(self) -> None:  # known-good
        r = self.sbx(f'check_pins_file "{self.pins}" "{self.zip}"')
        self.assertEqual(r.returncode, 0, r.stderr)


class ClientPinsFileTests(unittest.TestCase):
    """The shipped client pins: one row per file the client zip's manifest lists, each with its
    dir. (The live `client` step checks them against the zip itself.)"""

    def test_every_row_has_a_pack_dir_and_a_sha256(self) -> None:
        rows = [r.split("\t") for r in (SBX / "monifactory-0.13.4-client-files.tsv").read_text().splitlines()]
        self.assertEqual(len(rows), 220)
        for r in rows:
            with self.subTest(row=r[3] if len(r) > 3 else r):
                self.assertEqual(len(r), 5)
                self.assertIn(r[2], ("mods", "resourcepacks", "shaderpacks"))
                self.assertRegex(r[4], r"^[0-9a-f]{64}$")
                self.assertEqual(r[2] == "mods", r[3].endswith(".jar"))


class FromDirTests(Pack):
    """The fallback: pack files copied out of an instance installed in the user's own launcher."""

    def setUp(self) -> None:
        super().setUp()
        self.src = self.tmp / "MyInstance"
        # the user's instance also holds their own extra jar, and a world
        self.write_files(self.src / "minecraft", {**self.FILES, "mods/own.jar": "mine", "saves/w/level.dat": "w"})

    def copy(self, pins: str = "", miss: str = "") -> subprocess.CompletedProcess[str]:
        return self.sbx(f'src=$(from_game_dir "{self.src}") && copy_pack_files "$src" "{self.game}" t "{pins}" "{miss}"'
                        f' && verify_pack_files "{self.game}" t "{pins and self.home / ".sbx" / "t-pins.tsv"}"')

    def test_pinned_copy_takes_exactly_the_pinned_files(self) -> None:  # known-good
        r = self.copy(str(self.pins))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(sorted(p.name for p in (self.game / "mods").iterdir()), ["a.jar"])
        self.assertTrue((self.game / "resourcepacks" / "r p.zip").is_file())
        self.assertFalse((self.game / "saves").exists())

    def test_a_missing_pinned_file_fails_and_names_it(self) -> None:
        (self.src / "minecraft" / "mods" / "a.jar").unlink()
        r = self.copy(str(self.pins))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("missing: mods/a.jar", r.stdout)
        self.assertIn("1 pinned file(s) not found", r.stderr)

    def test_a_pinned_file_in_another_dir_counts_as_missing(self) -> None:
        (self.src / "minecraft" / "mods" / "a.jar").rename(self.src / "minecraft" / "resourcepacks" / "a.jar")
        r = self.copy(str(self.pins))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("missing: mods/a.jar", r.stdout)

    def test_the_may_miss_file_may_be_absent(self) -> None:
        (self.src / "minecraft" / "mods" / "a.jar").unlink()
        r = self.copy(str(self.pins), "a.jar")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("all 1 files match", r.stdout)

    def test_a_tampered_source_file_fails(self) -> None:
        (self.src / "minecraft" / "mods" / "a.jar").write_text("jar A")
        r = self.copy(str(self.pins))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("differ from the pins", r.stderr)

    def test_unpinned_copy_takes_every_pack_file(self) -> None:
        r = self.copy()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("UNPINNED: 3", r.stdout)

    def test_a_dir_without_mods_is_refused(self) -> None:
        r = self.sbx(f'from_game_dir "{self.tmp}"')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no mods/", r.stderr)


class _Import(Pack):
    """The launcher's own import (-I) against the fake launcher, xdotool and xprop."""

    # Fast timings for the fake launcher; each test may override one.
    TIMING = {"SBX_IMPORT_POLL": "0.1", "SBX_IMPORT_SETTLE": "0", "SBX_IMPORT_QUIET": "3",
              "SBX_IMPORT_TIMEOUT": "20", "SBX_IMPORT_DIALOG_TIMEOUT": "3"}

    def setUp(self) -> None:
        super().setUp()
        self.root = self.home / "apps" / "FreesmLauncher"
        self.stub("FreesmLauncher", LAUNCHER, self.root)
        self.stub("xdotool", XDOTOOL)
        self.stub("xprop", XPROP)
        self.stub("import", "#!/bin/sh\nexit 1\n")   # ImageMagick's screenshot
        self.fixture = self.tmp / "fixture"
        self.write_files(self.fixture, self.FILES)
        self.addCleanup(subprocess.run, [self.bin / "pkill", "-f", "--", f"-d {self.root} -I "], check=False)

    def env_for(self, mode: str, **env: str) -> dict[str, str]:
        return {**self.TIMING, "STUB_IMPORT": mode, "STUB_STATE": str(self.tmp / "state"),
                "STUB_FIXTURE": str(self.fixture), "SBX_DISPLAY": ":99", **env}

    def run_import(self, mode: str, **env: str) -> subprocess.CompletedProcess[str]:
        return self.sbx(
            f'ensure_x() {{ echo "ensure_x $DISP" >> "$STUB_LOG"; }}; launcher_import "{self.root}" MyPack "{self.zip}"'
            f' && verify_pack_files "{self.root}/instances/MyPack/minecraft" t "{self.pins}"',
            timeout=60, **self.env_for(mode, **env))

    def launcher_running(self) -> bool:
        return subprocess.run([self.bin / "pgrep", "-f", "--", f"-d {self.root} -I "], capture_output=True).returncode == 0


class LauncherImportTests(_Import):
    def test_the_launcher_imports_the_zip_under_the_instance_name(self) -> None:  # known-good
        r = self.run_import("ok")
        self.assertEqual(r.returncode, 0, r.stderr)
        staged = self.home / ".sbx" / "import" / "MyPack.zip"
        self.assertIn(f"launcher DISPLAY=:98 -d {self.root} -I {staged}", self.calls())
        self.assertEqual(staged.read_bytes(), self.zip.read_bytes())
        self.assertIn("xdotool DISPLAY=:98 key Return", self.calls())
        self.assertIn("all 2 files match", r.stdout)
        self.assertFalse(self.launcher_running())

    def test_the_import_runs_on_its_own_display(self) -> None:  # never the game's (:99 here)
        r = self.run_import("ok")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("ensure_x :98", self.calls())
        x = [c for c in self.calls() if c.startswith(("xdotool", "xprop", "launcher"))]
        self.assertTrue(x)
        self.assertEqual([c for c in x if not c.split()[1] == "DISPLAY=:98"], [])

    def test_optional_mods_are_selected_and_accepted(self) -> None:  # known-good
        r = self.run_import("optional")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(len([c for c in self.calls() if " mousemove " in c]), 2)

    def test_blocked_files_fail_with_their_names(self) -> None:
        r = self.run_import("blocked")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("blocked: x.jar", r.stdout)
        self.assertIn("--from", r.stderr)
        self.assertFalse((self.root / "instances" / "MyPack").exists())
        self.assertFalse(self.launcher_running())

    def test_a_failure_in_the_launcher_log_fails_without_a_dialog(self) -> None:
        r = self.run_import("logfail")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("the launcher reported: Instance creation failed", r.stderr)

    def test_the_blocked_dialog_fails_without_a_log_line(self) -> None:
        r = self.run_import("blockedwin")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("files blocked for third-party launchers", r.stderr)

    def test_an_unexpected_window_fails(self) -> None:
        r = self.run_import("unknown")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("unexpected launcher window 'Update available", r.stderr)

    def test_an_untitled_dialog_is_not_the_main_window(self) -> None:  # Qt titles it with the app name
        for style in ("both", "type", "transient"):   # either mark alone makes it a dialog
            with self.subTest(xprop=style):
                shutil.rmtree(self.root / "instances", ignore_errors=True)
                r = self.run_import("untitled", STUB_XPROP=style)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("unexpected launcher window 'Freesm Launcher Maple 2.3.1'", r.stderr)

    def test_a_second_non_dialog_window_is_not_the_main_window(self) -> None:
        r = self.run_import("normalother")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("unexpected launcher window 'Some Window'", r.stderr)

    def test_an_instance_under_another_name_fails(self) -> None:
        r = self.run_import("othername")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("the launcher created", r.stderr)
        self.assertIn("MyPack-1 instead of", r.stderr)

    def test_an_import_that_is_not_a_curseforge_instance_fails(self) -> None:
        r = self.run_import("notflame")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("is not a CurseForge import", r.stderr)

    def test_a_failed_return_key_fails(self) -> None:
        r = self.run_import("ok", STUB_XDO_FAIL="windowfocus")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("xdotool could not press Return", r.stderr)

    def test_a_dialog_that_ignores_return_times_out(self) -> None:
        r = self.run_import("stuck", SBX_IMPORT_TIMEOUT="20")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("the New Instance dialog did not take Return", r.stderr)

    def test_an_unclickable_optional_dialog_fails(self) -> None:
        for geom in ("none", "partial"):
            with self.subTest(geom=geom):
                r = self.run_import("optional", STUB_GEOM=geom)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("xdotool could not click the Select Optional Mods dialog", r.stderr)

    def test_an_optional_dialog_that_ignores_the_clicks_times_out(self) -> None:
        r = self.run_import("optstuck", SBX_IMPORT_TIMEOUT="20")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("the Select Optional Mods dialog did not take the clicks", r.stderr)

    def test_a_launcher_that_exits_fails_at_once(self) -> None:
        r = self.run_import("crash", SBX_IMPORT_TIMEOUT="20")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("the launcher exited during the import", r.stderr)

    def test_an_import_that_never_commits_times_out(self) -> None:
        r = self.run_import("hang", SBX_IMPORT_TIMEOUT="3")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no instance after 3s", r.stderr)

    def test_a_running_launcher_is_never_driven(self) -> None:
        r = self.sbx(f'launcher_pids() {{ echo 4242; }}; ensure_x() {{ :; }}; launcher_import "{self.root}" MyPack "{self.zip}"',
                     **self.env_for("ok"))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("the launcher of", r.stderr)
        self.assertIn("is running", r.stderr)
        self.assertFalse(any(c.startswith("launcher ") for c in self.calls()))


class PackInstanceTests(_Import):
    """pack_instance: pins first, then the import or the copy, then the check — and never a
    removal of anything this step did not make."""

    def pack_instance(self, from_dir: str = "", pins: Path | None = None, pre: str = "") -> subprocess.CompletedProcess[str]:
        return self.sbx(f'{pre}ensure_x() {{ :; }}; pack_instance "{self.root}" MyPack "{self.zip}" t "{pins or self.pins}" 1024 2048 "{from_dir}"',
                        **self.env_for("ok"))

    def test_a_failure_after_the_check_keeps_the_verified_instance(self) -> None:
        r = self.pack_instance(pre='write_jsm_options() { die "late failure"; }; ')
        self.assertEqual(r.returncode, 1)
        self.assertIn("late failure", r.stderr)
        self.assertNotIn("removed the unverified instance", r.stderr)
        self.assertTrue((self.root / "instances" / "MyPack" / "minecraft" / "mods" / "a.jar").is_file())

    def test_the_step_checks_what_the_launcher_installed(self) -> None:
        r = self.pack_instance()
        self.assertEqual(r.returncode, 0, r.stderr)  # known-good
        self.assertTrue((self.home / ".sbx" / "t-files.done").exists())
        shutil.rmtree(self.root / "instances" / "MyPack")
        for mark in (self.home / ".sbx").glob("t-*.done"):
            mark.unlink()
        (self.fixture / "mods" / "a.jar").write_text("jar A")   # the launcher installed other bytes
        r = self.pack_instance()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("differ from the pins", r.stderr)
        self.assertFalse((self.home / ".sbx" / "t-files.done").exists())

    def test_a_failed_check_removes_the_unverified_instance(self) -> None:
        (self.fixture / "mods" / "a.jar").write_text("jar A")
        r = self.pack_instance()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("removed the unverified instance", r.stderr)
        self.assertFalse((self.root / "instances" / "MyPack").exists())

    def test_foreign_pins_stop_the_step_before_the_launcher(self) -> None:
        other = self.tmp / "other.tsv"
        other.write_text(self.pins.read_text().replace("12\t22", "12\t99"))
        r = self.pack_instance(pins=other)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("do not list the same files as the manifest", r.stderr)
        self.assertFalse(any(c.startswith("launcher ") for c in self.calls()))

    def test_an_instance_the_step_did_not_start_is_never_removed(self) -> None:
        own = self.root / "instances" / "MyPack" / "minecraft" / "saves" / "keep.dat"
        own.parent.mkdir(parents=True)
        own.write_text("mine")
        r = self.pack_instance()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("was not made by this step", r.stderr)
        self.assertEqual(own.read_text(), "mine")
        self.assertNotIn("launcher", " ".join(self.calls()))

    def test_a_from_dir_inside_the_instance_is_refused(self) -> None:
        inst = self.root / "instances" / "MyPack"
        self.write_files(inst / "minecraft", self.FILES)
        self.mark("t-started")   # an interrupted earlier run
        r = self.pack_instance(str(inst))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("inside", r.stderr)
        self.assertTrue((inst / "minecraft" / "mods" / "a.jar").is_file())


class ProvisionFromTests(Sandbox):
    """provision.sh stages only the pack folders of a --from instance into the container."""

    def test_client_from_stages_the_pack_folders(self) -> None:  # known-good
        inst = self.tmp / "Inst"
        for d in ("mods", "resourcepacks", "saves"):
            (inst / "minecraft" / d).mkdir(parents=True)
        r = self.provision("client", "--from", str(inst), STUB_RUNNING="true")
        self.assertEqual(r.returncode, 0, r.stderr)
        cps = [c for c in self.calls() if c.startswith("podman cp ")]
        self.assertEqual(cps, [f"podman cp {inst}/minecraft/mods t:/tmp/sbx-from-client/mods",
                               f"podman cp {inst}/minecraft/resourcepacks t:/tmp/sbx-from-client/resourcepacks"])
        self.assertTrue(self.calls()[-1].endswith("bash /opt/sbx/sbx.sh client --from /tmp/sbx-from-client"))

    def test_a_folder_without_mods_stops_before_the_step(self) -> None:
        r = self.provision("client", "--from", str(self.tmp), STUB_RUNNING="true")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no mods/", r.stderr)
        self.assertFalse(any("sbx.sh client" in c for c in self.calls()))


class PackArgsTests(Sandbox):
    def test_an_instance_name_that_is_not_a_plain_name_is_refused(self) -> None:
        for name in ("../x", "a/b", "-x", "a b"):
            with self.subTest(name=name):
                r = self.sbx(f'do_pack "{name}" /nonexistent.zip')
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("letters, digits", r.stderr)

    def test_from_needs_a_directory(self) -> None:
        r = self.sbx('do_pack MyPack /nonexistent.zip --from /nonexistent-dir')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no such directory", r.stderr)
        self.assertEqual(self.calls(), [])

    def test_provision_refuses_the_name_before_any_copy(self) -> None:
        zip_ = self.tmp / "p.zip"
        zip_.write_text("zip")
        for name in ("../x", "a/b", "-x", "a b"):
            with self.subTest(name=name):
                self.log.write_text("")
                r = self.provision("pack", name, str(zip_), STUB_RUNNING="true")
                self.assertNotEqual(r.returncode, 0)
                self.assertIn(f"pack: instance name '{name}'", r.stderr)
                self.assertEqual([c for c in self.calls() if c.startswith("podman ")], [])


class DestroyTests(Sandbox):
    """provision.sh destroy removes only what `up` labelled, and says so only when it did."""

    LABELLED = {"STUB_EXISTS": "1", "STUB_VEXISTS": "1", "STUB_CLABEL": "1", "STUB_VLABEL": "1"}

    def removals(self) -> list[str]:
        return [c for c in self.calls() if c.startswith(("podman rm", "podman volume rm"))]

    def test_destroy_needs_its_yes(self) -> None:
        r = self.provision("destroy", **self.LABELLED)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("pass --yes", r.stderr)
        self.assertEqual(self.removals(), [])

    def test_an_unlabelled_container_is_not_removed(self) -> None:
        r = self.provision("destroy", "--yes", **{**self.LABELLED, "STUB_CLABEL": ""})
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("container t has no gerda.sandbox label", r.stderr)
        self.assertEqual(self.removals(), [])
        self.assertNotIn("removed", r.stdout)

    def test_an_unlabelled_volume_is_not_removed(self) -> None:
        r = self.provision("destroy", "--yes", **{**self.LABELLED, "STUB_VLABEL": "<no value>"})
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("volume t-home has no gerda.sandbox label", r.stderr)
        self.assertEqual([c for c in self.removals() if "volume" in c], [])

    def test_a_failed_removal_is_reported_as_a_failure(self) -> None:
        for knob, what in (("STUB_RM_RC", "could not remove container"), ("STUB_VRM_RC", "could not remove volume")):
            with self.subTest(knob=knob):
                r = self.provision("destroy", "--yes", **{**self.LABELLED, knob: "1"})
                self.assertNotEqual(r.returncode, 0)
                self.assertIn(what, r.stderr)
                self.assertNotIn("removed", r.stdout)

    def test_a_labelled_sandbox_is_removed(self) -> None:  # known-good
        r = self.provision("destroy", "--yes", **self.LABELLED)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("removed t + t-home", r.stdout)
        self.assertEqual(len(self.removals()), 2)

    def test_up_labels_the_container_and_the_volumes_it_creates(self) -> None:
        r = self.provision("up")
        self.assertEqual(r.returncode, 0, r.stderr)
        run = next(c for c in self.calls() if c.startswith("podman run "))
        self.assertIn("--label gerda.sandbox=1", run)
        created = [c for c in self.calls() if c.startswith("podman volume create")]
        self.assertEqual(len(created), 2)
        self.assertTrue(all("--label gerda.sandbox=1" in c for c in created))


def pins_env(text: str | None = None) -> dict[str, str]:
    """NAME -> value of every assignment in pins.env (a trailing `# comment` is not the value)."""
    text = (SBX / "pins.env").read_text() if text is None else text
    return dict(re.findall(r'^([A-Z0-9_]+)="?([^"\s]*)"?(?:\s+#.*)?$', text, re.M))


class PinsFileTests(unittest.TestCase):
    """Every download pin in pins.env is set: fetch() refuses a download without one, so a blank
    pin would only show on the day that step runs."""

    def bad_pins(self, text: str) -> list[str]:
        pins = pins_env(text)
        bad = [k for k, v in pins.items() if k.endswith("_SHA256") and not re.fullmatch(r"[0-9a-f]{64}", v)]
        bad += [k for k, v in pins.items() if k.endswith("_SHA1") and not re.fullmatch(r"[0-9a-f]{40}", v)]
        bad += [k for k in pins if k.endswith("_URL") and k[: -len("_URL")] + "_SHA256" not in pins]
        return sorted(bad)

    def test_every_pin_is_set(self) -> None:
        text = (SBX / "pins.env").read_text()
        self.assertGreater(len([k for k in pins_env(text) if k.endswith("_SHA256")]), 10)
        self.assertEqual(self.bad_pins(text), [])

    def test_a_blank_short_or_missing_pin_is_caught(self) -> None:  # known-bad
        ok = 'A_URL="u"\nA_SHA256="' + "a" * 64 + '"   # gate:pins-set\n'
        self.assertEqual(self.bad_pins(ok), [])
        self.assertEqual(self.bad_pins(ok.replace("a" * 64, "")), ["A_SHA256"])
        self.assertEqual(self.bad_pins(ok.replace("a" * 64, "a" * 63)), ["A_SHA256"])
        self.assertEqual(self.bad_pins('A_URL="u"\n'), ["A_URL"])
        self.assertEqual(self.bad_pins('B_SHA1=""\n'), ["B_SHA1"])


class ImagePinTests(unittest.TestCase):
    """The image build runs no unpinned remote script and floats on no tag."""

    def setUp(self) -> None:
        self.cf = (SBX / "Containerfile").read_text()
        self.pins = pins_env()
        self.provision = (SBX / "provision.sh").read_text()

    def test_no_remote_script_is_piped_into_a_shell(self) -> None:
        piped = re.compile(r"\|\s*(env\s+)?(\S+=\S+\s+)*(ba)?sh\b")
        self.assertIsNone(piped.search(self.cf))
        # known-bad: both forms the old Containerfile used
        self.assertTrue(piped.search("curl -fsSL https://x/install | BUN_INSTALL=/b bash -s v1"))
        self.assertTrue(piped.search("curl -LsSf https://x/i.sh \\\n  | env A=1 B=2 sh"))

    def test_the_base_image_is_a_pinned_digest(self) -> None:
        self.assertRegex(self.cf, r"(?m)^FROM \$\{BASE_IMAGE\}$")
        self.assertRegex(self.pins["BASE_IMAGE"], r"@sha256:[0-9a-f]{64}$")

    def test_every_build_arg_is_pinned_and_passed(self) -> None:
        for arg in re.findall(r"(?m)^ARG (\w+)$", self.cf):
            with self.subTest(arg=arg):
                self.assertTrue(self.pins.get(arg), f"{arg} has no value in pins.env")
                self.assertIn(f'--build-arg {arg}="${arg}"', self.provision)
        for sha_ in ("BUN_SHA256", "UV_SHA256"):
            self.assertRegex(self.pins[sha_], r"^[0-9a-f]{64}$")

    def test_archives_are_checked_before_they_are_unpacked(self) -> None:
        self.assertIn("| sha256sum -c - \\", self.cf)
        check = self.cf.index("sha256sum -c")
        self.assertLess(check, self.cf.index("unzip -q bun.zip"))
        self.assertLess(check, self.cf.index("tar xzf uv.tar.gz"))


if __name__ == "__main__":
    unittest.main()
