"""scripts/ops/server-ctl.sh: start / cmd / stop against a fake `java` on PATH.

The wrapper used to live only as a code block in docs/SERVER_SETUP.md, and its `stop` returned
the moment it had written `stop` to the console — a `start` right after it then raced the world
save. Pinned here: the console FIFO delivers `cmd` text to the server's stdin; `stop` returns only
once the server process is gone (the fake takes a second to "save"), removes the pid file and
says `stopped`; `status` agrees. Known-bad side: a `stop` that does not wait finds the fake still
alive, so the pid file stays and `status` right after says `running`.

Dead-server side: a `java` that exits at once makes `start` fail loud (rc 1, "java exited")
instead of printing "started"; `cmd` with no server refuses (rc 1) instead of blocking forever on
a FIFO nobody reads; a server that outlives the stop wait keeps its console holder (killing it
would hand the live server an EOF, which stops it without a word in the log).

POSIX sh + mkfifo; skipped where either is missing. Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import os
import shutil
import signal
import stat
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "ops" / "server-ctl.sh"
SAVE_S = 1  # how long the fake server takes to exit after `stop`


@unittest.skipUnless(shutil.which("sh") and shutil.which("mkfifo"), "needs sh + mkfifo")
class ServerCtlTests(unittest.TestCase):
    def setUp(self) -> None:
        self.srv = Path(tempfile.mkdtemp(prefix="srvctl-"))
        self.addCleanup(shutil.rmtree, self.srv, True)
        shutil.copy(SCRIPT, self.srv / "server-ctl.sh")
        bindir = self.srv / "bin"
        bindir.mkdir()
        java = bindir / "java"
        # Echo every console line to got.txt; on `stop`, "save" for SAVE_S and exit.
        # FAKE_JAVA=die exits at once (a bad JVM arg, a missing jar); FAKE_JAVA=deaf never
        # exits on `stop` (a save that outlasts the wait).
        java.write_text("#!/bin/sh\n[ \"$FAKE_JAVA\" = die ] && exit 1\n"
                        "while read -r l; do echo \"$l\" >> got.txt\n"
                        f"  [ \"$l\" = stop ] && [ \"$FAKE_JAVA\" != deaf ] && "
                        f"{{ sleep {SAVE_S}; exit 0; }}\ndone\n", "utf-8")
        java.chmod(java.stat().st_mode | stat.S_IXUSR)
        self.env = {**os.environ, "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}"}
        self.addCleanup(self.kill_leftovers)
        # Never leave a fake server or holder behind: a polite stop, then SIGKILL what is left
        # (the `deaf` fake outlives any stop wait).
        self.addCleanup(self.ctl, "stop", env={"SERVER_STOP_WAIT_S": "3"})

    def kill_leftovers(self) -> None:
        for name in ("server.pid", "holder.pid"):
            pidf = self.srv / name
            if pidf.exists():
                try:
                    os.kill(int(pidf.read_text().strip()), signal.SIGKILL)
                except (ProcessLookupError, ValueError):
                    pass

    def ctl(self, *args: str, timeout: float = 60,
            env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        # Output to a FILE, not a pipe: `start` leaves the FIFO holder running with the caller's
        # stderr, and a pipe would then never reach EOF.
        out = self.srv / "ctl.out"
        with out.open("w") as f:
            res = subprocess.run(["sh", str(self.srv / "server-ctl.sh"), *args],
                                 env={**self.env, **(env or {})},
                                 stdout=f, stderr=subprocess.STDOUT, timeout=timeout)
        return subprocess.CompletedProcess(res.args, res.returncode, out.read_text("utf-8"), "")

    @staticmethod
    def pid_alive(pidf: Path) -> bool:
        try:
            os.kill(int(pidf.read_text().strip()), 0)
        except (OSError, ValueError):
            return False
        return True

    def test_a_java_that_dies_at_once_fails_start(self) -> None:
        res = self.ctl("start", env={"FAKE_JAVA": "die"})
        self.assertEqual(res.returncode, 1, res.stdout)
        self.assertIn("java exited", res.stdout)
        self.assertNotIn("started", res.stdout)
        self.assertFalse((self.srv / "holder.pid").exists(), "the FIFO holder outlived the failure")
        self.assertEqual(self.ctl("status").stdout.strip(), "stopped")

    def test_cmd_without_a_server_refuses_instead_of_blocking(self) -> None:
        res = self.ctl("cmd", "list", timeout=10)  # pre-fix: blocks on the reader-less FIFO
        self.assertEqual(res.returncode, 1, res.stdout)
        self.assertIn("not running", res.stdout)

    def test_a_server_outliving_the_wait_keeps_its_console(self) -> None:
        self.assertIn("started", self.ctl("start", env={"FAKE_JAVA": "deaf"}).stdout)
        res = self.ctl("stop", env={"SERVER_STOP_WAIT_S": "1"})
        self.assertEqual(res.returncode, 1, res.stdout)
        self.assertIn("still running", res.stdout)
        self.assertTrue(self.pid_alive(self.srv / "server.pid"), "the server died")
        self.assertTrue(self.pid_alive(self.srv / "holder.pid"), "the console holder was killed")

    def test_cmd_reaches_the_console_and_stop_waits_for_the_save(self) -> None:
        self.assertIn("started", self.ctl("start").stdout)
        self.assertIn("running", self.ctl("status").stdout)
        self.assertIn("sent: list", self.ctl("cmd", "list").stdout)
        t0 = time.monotonic()
        res = self.ctl("stop")
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertIn("stopped", res.stdout)
        self.assertGreaterEqual(time.monotonic() - t0, SAVE_S * 0.9)  # it waited for the save
        self.assertFalse((self.srv / "server.pid").exists())
        self.assertEqual(self.ctl("status").stdout.strip(), "stopped")
        self.assertEqual((self.srv / "got.txt").read_text("utf-8").split(), ["list", "stop"])

    @staticmethod
    def kill_quietly(pid: int) -> None:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass

    @staticmethod
    def proc_alive(pid: int) -> bool:
        """Alive and not a zombie (a dead holder reparented to a slow reaper still answers kill 0)."""
        try:
            status = Path(f"/proc/{pid}/status").read_text("utf-8")
        except OSError:
            return False
        return "\nState:\tZ" not in status

    def wait_dead(self, pid: int, within_s: float = 3) -> bool:
        deadline = time.monotonic() + within_s
        while time.monotonic() < deadline:
            if not self.proc_alive(pid):
                return True
            time.sleep(0.05)
        return False

    @unittest.skipUnless(Path("/proc/self/cmdline").exists(), "needs /proc (Linux)")
    def test_a_start_after_a_crash_ends_the_old_console_holder(self) -> None:
        self.assertIn("started", self.ctl("start").stdout)
        old_holder = int((self.srv / "holder.pid").read_text().strip())
        self.addCleanup(self.kill_quietly, old_holder)  # a failing run must not leak it either
        os.kill(int((self.srv / "server.pid").read_text().strip()), signal.SIGKILL)  # the crash
        self.assertEqual(self.ctl("status").stdout.strip(), "stopped")
        self.assertTrue(self.proc_alive(old_holder))  # the leak the next start must clean up
        self.assertIn("started", self.ctl("start").stdout)
        new_holder = int((self.srv / "holder.pid").read_text().strip())
        self.assertNotEqual(new_holder, old_holder)
        self.assertTrue(self.wait_dead(old_holder), "the old FIFO holder outlived the restart")
        self.assertTrue(self.proc_alive(new_holder))
        self.assertIn("sent: list", self.ctl("cmd", "list").stdout)  # the new console works

    @unittest.skipUnless(Path("/proc/self/cmdline").exists(), "needs /proc (Linux)")
    def test_a_stale_holder_pid_of_another_process_is_not_killed(self) -> None:
        bystander = subprocess.Popen(["sleep", "30"])
        self.addCleanup(bystander.kill)
        (self.srv / "holder.pid").write_text(f"{bystander.pid}\n")
        self.assertIn("started", self.ctl("start").stdout)
        self.assertIsNone(bystander.poll(), "start killed a process that was not its holder")

    def test_help_prints_usage_and_runs_nothing(self) -> None:
        res = self.ctl("-h")
        self.assertEqual(res.returncode, 0)
        self.assertIn("usage:", res.stdout)
        self.assertFalse((self.srv / "console.in").exists())


if __name__ == "__main__":
    unittest.main()
