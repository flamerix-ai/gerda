"""scripts/sandbox/{sbx.sh,provision.sh}: the gates inside the steps — server, client warm-up,
repo, world generation, start, verify, record, wait — each driven with the commands around it
replaced by shell functions or PATH stubs (sandbox_fixture.py), so the guarded branch runs
without a container, a game or a network. Every test here kills the mutant of one
`# gate:<id>` (scripts/dev/mutants/sandbox.toml); each fail case has its known-good twin.

Stdlib-only (unittest); the record case also needs ffmpeg + ffprobe, which the default devShell
provides — without them it is skipped, and test_devshell_tools.py fails.
"""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from sandbox_fixture import REPO, Sandbox  # noqa: E402

# Every step calls `sleep` while it waits; these tests make it instant.
NO_SLEEP = "sleep() { :; }; "


class DieTests(Sandbox):
    def test_die_ends_the_step_with_status_1(self) -> None:
        r = self.sbx('CUR=t; die "x"; echo after')
        self.assertEqual(r.returncode, 1)
        self.assertIn("FAIL: t: x", r.stderr)
        self.assertNotIn("after", r.stdout)

    def test_provision_die_ends_with_status_1(self) -> None:
        r = self.provision("destroy")   # its first refusal, before any podman call
        self.assertEqual(r.returncode, 1)
        self.assertIn("FAIL: provision:", r.stderr)


class DispatchTests(Sandbox):
    """An unknown step prints the usage and FAILS: a typo in a step name must not read as done."""

    def run_sbx(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["bash", str(REPO / "scripts" / "sandbox" / "sbx.sh"), *args],
                              env=self.env, capture_output=True, text=True, timeout=60)

    def test_an_unknown_sbx_step_fails(self) -> None:
        r = self.run_sbx("servre")
        self.assertEqual(r.returncode, 1)
        self.assertIn("sbx.sh", r.stdout)   # the usage

    def test_sbx_help_passes(self) -> None:  # known-good twin
        r = self.run_sbx("help")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("sbx.sh", r.stdout)

    def test_an_unknown_provision_step_fails(self) -> None:
        r = self.provision("destory")
        self.assertEqual(r.returncode, 1)
        self.assertIn("provision.sh", r.stdout)

    def test_provision_help_passes(self) -> None:  # known-good twin
        r = self.provision("help")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("provision.sh", r.stdout)


class FetchTests(Sandbox):
    URL = "https://example.invalid/a.jar"

    def fetch(self, pin: str) -> subprocess.CompletedProcess[str]:
        return self.sbx(f'fetch "{self.URL}" "{pin}" "$SBX_CACHE/dl/a.jar"', STUB_BODY="the jar")

    def test_a_download_with_another_sha256_fails_and_is_moved_aside(self) -> None:
        r = self.fetch(hashlib.sha256(b"another jar").hexdigest())
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("sha256 mismatch for a.jar", r.stderr)
        self.assertFalse((self.cache / "dl" / "a.jar").exists())
        self.assertTrue((self.cache / "dl" / "a.jar.bad").exists())

    def test_the_pinned_download_passes(self) -> None:  # known-good
        r = self.fetch(hashlib.sha256(b"the jar").hexdigest())
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual((self.cache / "dl" / "a.jar").read_text(), "the jar")

    def test_no_pin_is_refused_before_any_download(self) -> None:
        r = self.fetch("")
        self.assertEqual(r.returncode, 1)
        self.assertIn("no sha256 pin for", r.stderr)
        self.assertEqual(self.calls(), [])
        self.assertFalse((self.cache / "dl" / "a.jar").exists())

    def test_unpinned_is_refused_outside_the_pack_step(self) -> None:
        r = self.sbx(f'CUR=client; fetch "{self.URL}" UNPINNED "$SBX_CACHE/dl/a.jar"', STUB_BODY="the jar")
        self.assertEqual(r.returncode, 1)
        self.assertIn("accepted only by the pack step, not by client", r.stderr)
        self.assertEqual(self.calls(), [])

    def test_unpinned_in_the_pack_step_downloads_and_says_so(self) -> None:  # known-good twin
        r = self.sbx(f'CUR=pack; fetch "{self.URL}" UNPINNED "$SBX_CACHE/dl/a.jar"', STUB_BODY="the jar")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("UNPINNED: a.jar taken without a check", r.stdout)
        self.assertEqual((self.cache / "dl" / "a.jar").read_text(), "the jar")


class WaitLogTests(Sandbox):
    def wait(self, text: str, secs: int = 9) -> subprocess.CompletedProcess[str]:
        log = self.tmp / "x.log"
        log.write_text(text)
        return self.sbx(f'{NO_SLEEP}wait_log "{log}" "^ready" "^boom" {secs}')

    def test_a_fail_line_is_a_failure(self) -> None:
        r = self.wait("starting\nboom: it broke\nready\n")
        self.assertEqual(r.returncode, 1)
        self.assertIn("log FAIL", r.stdout)

    def test_no_ok_line_is_a_timeout(self) -> None:
        r = self.wait("starting\n")
        self.assertEqual(r.returncode, 2)
        self.assertIn("log TIMEOUT 9s", r.stdout)

    def test_an_ok_line_passes(self) -> None:  # known-good
        r = self.wait("starting\nready\n")
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("log OK", r.stdout)


class _Server(Sandbox):
    def setUp(self) -> None:
        super().setUp()
        self.srv = self.home / "mc-servers" / "monifactory-0.13.4"
        (self.srv / "logs").mkdir(parents=True)
        self.stub("server-ctl.sh", '#!/bin/sh\n[ "$1" = status ] && echo stopped\nexit 0\n', self.srv)


class ServerStartTests(_Server):
    def start(self, log: str) -> subprocess.CompletedProcess[str]:
        (self.srv / "logs" / "latest.log").write_text(log)
        return self.sbx(f"{NO_SLEEP}srv_start_wait")

    def test_a_crashed_boot_fails(self) -> None:
        r = self.start("[main] ---- Minecraft Crash Report ----\n")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("server did not reach Done", r.stderr)

    def test_a_server_that_is_done_passes(self) -> None:  # known-good
        r = self.start('[Server thread/INFO]: Done (41.2s)! For help, type "help"\n')
        self.assertEqual(r.returncode, 0, r.stderr)


class LaunchTests(Sandbox):
    def test_a_second_game_of_the_same_root_is_refused(self) -> None:
        r = self.sbx(f'{NO_SLEEP}ensure_x() {{ :; }}; game_pids() {{ echo 4242; }}; launch "$LDIR" Monifactory "{self.tmp}/l.log"')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("is already running", r.stderr)


class _Client(Sandbox):
    """do_client with the install, the import and the launch replaced by functions."""

    SNIPPET = (NO_SLEEP + 'install_launcher() { :; }; fetch() { :; }; add_pinned_jar() { :; }; '
               'launch() { :; }; stop_launcher_root() { :; }; '
               'pack_instance() { echo "pack_instance $*" >> "$STUB_LOG"; mkdir -p "$GAME/mods"; }; '
               'wait_log() { return "$STUB_WAIT_RC"; }; do_client')

    def setUp(self) -> None:
        super().setUp()
        self.ldir = self.home / "apps" / "FreesmLauncher"
        self.game = self.ldir / "instances" / "Monifactory" / "minecraft"
        (self.home / "logs").mkdir()
        (self.home / "logs" / "client-warmup.log").write_text("launcher output\n")

    def mappings(self) -> None:
        m = (self.ldir / "libraries/net/minecraft/client/1.20.1-20230612.114412"
             / "client-1.20.1-20230612.114412-mappings.txt")
        m.parent.mkdir(parents=True)
        m.write_text("mappings")

    def options(self, services: dict) -> None:
        f = self.game / "config" / "jsMacros" / "options.json"
        f.parent.mkdir(parents=True)
        f.write_text(json.dumps({"version": 3, "core": {"services": services}}))

    def client(self, wait_rc: int = 0) -> subprocess.CompletedProcess[str]:
        return self.sbx(self.SNIPPET, STUB_WAIT_RC=str(wait_rc))


class ClientWarmupTests(_Client):
    GOOD = {"main": {"file": "main.js", "enabled": True}, "bridge": {"file": "bridge.js", "enabled": True}}

    def test_the_client_is_installed_against_its_pins(self) -> None:
        self.mappings()
        self.options(self.GOOD)
        r = self.client()
        self.assertEqual(r.returncode, 0, r.stderr)
        call = next(c for c in self.calls() if c.startswith("pack_instance "))
        self.assertIn(" client /", call)
        self.assertIn("monifactory-0.13.4-client-files.tsv", call.split(" client ", 1)[1].split()[0])

    def test_a_warm_up_that_misses_the_title_screen_fails(self) -> None:
        r = self.client(wait_rc=2)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("warm-up launch did not reach the title screen", r.stderr)
        self.assertFalse((self.home / ".sbx" / "client-warmup.done").exists())

    def test_a_warm_up_without_mappings_fails(self) -> None:
        self.options(self.GOOD)
        r = self.client()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no Forge mappings", r.stderr)

    def test_a_warm_up_that_lost_the_services_fails(self) -> None:
        self.mappings()
        self.options({"main": {"file": "main.js", "enabled": True}})
        r = self.client()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("lost the services during warm-up", r.stderr)
        self.assertFalse((self.home / ".sbx" / "client-warmup.done").exists())

    def test_a_good_warm_up_passes(self) -> None:  # known-good
        self.mappings()
        self.options(self.GOOD)
        r = self.client()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.home / ".sbx" / "client-warmup.done").exists())


class _Repo(Sandbox):
    """do_repo on a cloned ~/gerda with a stub ./gerda; bun and just are PATH stubs."""

    def setUp(self) -> None:
        super().setUp()
        self.repo = self.home / "gerda"
        self.repo.mkdir()
        subprocess.run(["git", "init", "-q", str(self.repo)], check=True,
                       env={k: v for k, v in self.env.items() if not k.startswith("GIT_")})
        (self.repo / "harness").mkdir()
        (self.repo / "harness" / "srg_names.json").write_text("{}")   # srg export is not under test
        (self.home / "logs").mkdir()
        self.stub("bun", "#!/bin/sh\nexit 0\n")
        self.stub("just", "#!/bin/sh\nexit 0\n")
        self.inst = self.home / "apps" / "FreesmLauncher" / "instances" / "Monifactory"
        self.inst.mkdir(parents=True)

    def gerda(self, deploys: bool) -> None:
        main = self.inst / "minecraft" / "config" / "jsMacros" / "Macros" / "main.js"
        body = f'mkdir -p "{main.parent}" && touch "{main}"' if deploys else ":"
        self.stub("gerda", f'#!/bin/sh\n[ "$1" = sync ] && {{ {body}; }}\nexit 0\n', self.repo)


class RepoTests(_Repo):
    def test_a_clone_that_is_not_gerda_is_refused(self) -> None:
        r = self.sbx("do_repo")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("has no ./gerda CLI", r.stderr)

    def test_an_unverified_instance_is_never_synced(self) -> None:
        self.gerda(deploys=True)
        r = self.sbx("do_repo")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("has no verified install (no client-files mark)", r.stderr)
        self.assertFalse((self.inst / "minecraft" / "config").exists())

    def test_a_sync_that_deployed_nothing_fails(self) -> None:
        self.gerda(deploys=False)
        self.mark("client-files")
        r = self.sbx("do_repo")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("sync did not deploy main.js", r.stderr)

    def test_a_verified_instance_is_synced(self) -> None:  # known-good
        self.gerda(deploys=True)
        self.mark("client-files")
        r = self.sbx("do_repo")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("repo ready", r.stdout)


# A vanilla server stand-in: says Done into gen.log (its stdout), then waits for `stop` on the
# console FIFO; STUB_LEVEL=1 also writes the world's level.dat.
JAVA = r'''#!/usr/bin/env bash
[ "${STUB_LEVEL:-}" = 1 ] && mkdir -p world && echo level > world/level.dat
echo "[Server thread/INFO]: Done (1.0s)! For help, type \"help\""
while read -r line; do [ "$line" = stop ] && exit 0; done
'''


class WorldGenTests(Sandbox):
    """gen_world: the vanilla server jar is checked against Mojang's sha1, and the world must
    exist afterwards. The version manifest lookup (python3) and java are PATH stubs."""

    JAR = "the server jar"

    def gen(self, sha1: str, level: bool) -> subprocess.CompletedProcess[str]:
        # only the manifest lookup (`python3 - <version>`) is stubbed; the curl stub is python too
        self.stub("python3", f'#!/bin/sh\nif [ "$1" = - ] && [ "$2" = 1.20.1 ]; then cat > /dev/null; '
                  f'echo "https://example.invalid/server.jar {sha1}"; exit 0; fi\nexec "{sys.executable}" "$@"\n')
        self.stub("java", JAVA)
        (self.cache / "dl").mkdir()
        return self.sbx(f"{NO_SLEEP}gen_world 1.20.1", STUB_BODY=self.JAR, STUB_LEVEL="1" if level else "0")

    def test_a_server_jar_with_another_sha1_fails_and_is_dropped(self) -> None:
        r = self.gen(hashlib.sha1(b"another jar").hexdigest(), level=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("sha1 mismatch for the 1.20.1 server jar", r.stderr)
        self.assertFalse((self.cache / "dl" / "minecraft-server-1.20.1.jar").exists())

    def test_a_generation_without_a_world_fails(self) -> None:
        r = self.gen(hashlib.sha1(self.JAR.encode()).hexdigest(), level=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no level.dat after the 1.20.1 world generation", r.stderr)

    def test_a_generated_world_is_cached(self) -> None:  # known-good
        r = self.gen(hashlib.sha1(self.JAR.encode()).hexdigest(), level=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue((self.cache / "worlds" / "1.20.1" / "level.dat").is_file())


class PackZipTests(Sandbox):
    def test_a_local_zip_with_another_sha256_is_refused(self) -> None:
        zip_ = self.tmp / "p.zip"
        zip_.write_text("zip")
        r = self.sbx(f'do_pack MyPack "{zip_}" {hashlib.sha256(b"other").hexdigest()}')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(f"sha256 mismatch for {zip_}", r.stderr)
        self.assertEqual(self.calls(), [])


class AddModsTests(Sandbox):
    def test_a_folder_without_jars_fails(self) -> None:
        (self.home / "apps" / "FreesmLauncher" / "instances" / "P").mkdir(parents=True)
        empty = self.tmp / "jars"
        empty.mkdir()
        (empty / "notes.txt").write_text("no jar here")
        r = self.sbx(f'do_add_mods P "{empty}"')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no *.jar in", r.stderr)

    def test_jars_are_added(self) -> None:  # known-good
        (self.home / "apps" / "FreesmLauncher" / "instances" / "P").mkdir(parents=True)
        jars = self.tmp / "jars"
        jars.mkdir()
        (jars / "a.jar").write_text("a")
        r = self.sbx(f'do_add_mods P "{jars}"')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("1 jar(s) added", r.stdout)


class _Running(Sandbox):
    """start / start-matrix / verify with a stub ./gerda whose `ctl ping` answers pong when
    STUB_PONG=1, and whose `smoke` exits STUB_SMOKE_RC."""

    def setUp(self) -> None:
        super().setUp()
        self.repo = self.home / "gerda"
        self.stub("gerda", '#!/bin/sh\ncase "$1" in\n  ctl) [ "${STUB_PONG:-}" = 1 ] && echo pong ;;\n'
                  '  smoke) echo "smoke: 21/21"; exit "${STUB_SMOKE_RC:-0}" ;;\nesac\nexit 0\n', self.repo)
        (self.home / "logs").mkdir()


class StartMatrixTests(_Running):
    def setUp(self) -> None:
        super().setUp()
        mc = self.home / "apps" / "FreesmLauncher-matrix" / "instances" / "P" / "minecraft"
        (mc / "config" / "jsMacros" / "Macros").mkdir(parents=True)
        (mc / "config" / "jsMacros" / "Macros" / "bridge_port.txt").write_text("55560")
        (mc / "saves" / "New World").mkdir(parents=True)

    def start(self, pong: bool) -> subprocess.CompletedProcess[str]:
        return self.sbx(f"{NO_SLEEP}launch() {{ :; }}; wait_log() {{ return 0; }}; do_start_matrix P",
                        STUB_PONG="1" if pong else "0")

    def test_an_unverified_pack_instance_is_never_started(self) -> None:
        self.mark("pack-P-started")
        r = self.start(pong=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("P has no verified install (no pack-P-files mark)", r.stderr)

    def test_a_bridge_that_never_answers_fails(self) -> None:
        r = self.start(pong=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("bridge 55560 does not answer ping", r.stderr)

    def test_a_verified_pack_instance_starts(self) -> None:  # known-good
        self.mark("pack-P-started", "pack-P-files")
        r = self.start(pong=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("bridge 55560 answers", r.stdout)


class StartTests(_Running, _Server):
    def setUp(self) -> None:
        super().setUp()
        main = (self.home / "apps" / "FreesmLauncher" / "instances" / "Monifactory" / "minecraft"
                / "config" / "jsMacros" / "Macros" / "main.js")
        main.parent.mkdir(parents=True)
        main.write_text("// deployed")
        (self.home / "logs" / "client.log").write_text("launcher output\n")

    def start(self, joined: bool, pong: bool) -> subprocess.CompletedProcess[str]:
        return self.sbx(f"{NO_SLEEP}ensure_x() {{ :; }}; srv_start_wait() {{ :; }}; launch() {{ :; }}; "
                        "wait_log() { [ \"$STUB_JOINED\" = 1 ]; }; do_start",
                        STUB_JOINED="1" if joined else "0", STUB_PONG="1" if pong else "0")

    def test_an_unverified_client_is_never_started(self) -> None:
        r = self.start(joined=True, pong=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("has no verified install (no client-files mark)", r.stderr)

    def test_a_bot_that_did_not_join_fails(self) -> None:  # the bridge answers at the title screen too
        self.mark("client-files")
        r = self.start(joined=False, pong=True)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("the bot did not join the server", r.stderr)

    def test_a_bridge_that_never_answers_fails(self) -> None:
        self.mark("client-files")
        r = self.start(joined=True, pong=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("the bridge does not answer ping after 5 min", r.stderr)

    def test_a_verified_client_starts(self) -> None:  # known-good
        self.mark("client-files")
        r = self.start(joined=True, pong=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("bridge answers", r.stdout)


class VerifyTests(_Running):
    def verify(self, pong: bool, smoke_rc: int = 0) -> subprocess.CompletedProcess[str]:
        return self.sbx(f"{NO_SLEEP}do_verify", STUB_PONG="1" if pong else "0", STUB_SMOKE_RC=str(smoke_rc))

    def test_a_bridge_that_never_settles_fails(self) -> None:
        r = self.verify(pong=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("bridge never answered 3 pings in a row", r.stderr)

    def test_a_failing_smoke_fails(self) -> None:
        r = self.verify(pong=True, smoke_rc=1)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("smoke failed 3 times", r.stderr)

    def test_a_passing_smoke_passes(self) -> None:  # known-good
        r = self.verify(pong=True)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("verify OK", r.stdout)


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "needs ffmpeg + ffprobe")
class RecordTests(Sandbox):
    """record: the take is checked by the REAL motion_probe --min-luma on a REAL clip. Only the
    x11grab capture is a stub: it hands over a clip made here (black, or lit)."""

    def setUp(self) -> None:
        super().setUp()
        real = shutil.which("ffmpeg")
        self.tool("ffprobe")   # the real one, like ffmpeg below: both come from the devShell, not the stub set
        self.stub("ffmpeg", f'#!/bin/sh\ncase " $* " in *" x11grab "*) for a; do out=$a; done; '
                  f'cp "$STUB_CLIP" "$out"; exit 0 ;; esac\nexec "{real}" "$@"\n')
        self.stub("xdotool", '#!/bin/sh\ncase "$1" in\n  search) echo 7 ;;\n'
                  '  getwindowgeometry) printf "WINDOW=7\\nX=0\\nY=0\\nWIDTH=64\\nHEIGHT=36\\n" ;;\nesac\n')

    def clip(self, color: str) -> Path:
        out = self.tmp / f"{color}.mp4"
        subprocess.run([str(shutil.which("ffmpeg")), "-v", "error", "-f", "lavfi", "-i",
                        f"color=c={color}:size=64x36:rate=30:duration=2", "-pix_fmt", "yuv420p",
                        str(out)], check=True)
        return out

    def record(self, color: str) -> subprocess.CompletedProcess[str]:
        return self.sbx(f'REPO_DIR="{REPO}"; game_pids() {{ [ "$1" = "$LDIR" ] && echo 4242; true; }}; do_record 2 take',
                        timeout=120, STUB_CLIP=str(self.clip(color)))

    def test_a_black_take_fails(self) -> None:
        r = self.record("black")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("GATE FAIL: mean luma", r.stdout)
        self.assertIn("the recording failed the check above", r.stderr)

    def test_a_lit_take_passes(self) -> None:  # known-good
        r = self.record("gray")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("recorded", r.stdout)


class ProvisionWaitTests(Sandbox):
    """provision.sh wait: the step's exit code decides, and a step still running is no success."""

    def setUp(self) -> None:
        super().setUp()
        self.stub("sleep", "#!/bin/sh\nexit 0\n")

    def test_a_failed_step_fails(self) -> None:
        r = self.provision("wait", "client", "20", STUB_RUNNING="true", STUB_STEP_RC="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("client exited 1", r.stderr)

    def test_a_step_still_running_is_exit_3(self) -> None:
        r = self.provision("wait", "client", "20", STUB_RUNNING="true")
        self.assertEqual(r.returncode, 3)
        self.assertIn("still running after 20s", r.stdout)

    def test_a_finished_step_passes(self) -> None:  # known-good
        r = self.provision("wait", "client", "20", STUB_RUNNING="true", STUB_STEP_RC="0")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("client finished OK", r.stdout)


if __name__ == "__main__":
    unittest.main()
