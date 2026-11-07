"""Unit tests for shoot.py's `during`-driver logging (scripts/demo/shoot.py).

A `during` driver used to run with `stdout=DEVNULL`. On the 05_economy re-shoot that cost the
answer to the only question the take raised — the bot stood still for 42 of 49 seconds and the
one witness to why (did plan_start answer? which phase was the bot in?) had been discarded as
it was produced. The driver's output now lands in `<out_dir>/<id>.during.log`, next to the take,
so the shoot day is auditable after it ends.

These cases pin the properties that make the log trustworthy: it is actually WRITTEN (a driver
whose output is invisible is the bug), it is APPENDED (a re-shoot of the same id must not erase
the previous attempt's evidence), it names the command and the wall-clock time (a log nobody can
line up against the take is useless), it records a driver that died early, and — neg-control — a
shot with no `during` fabricates no log at all. Drivers here are `echo`/`true`, so nothing boots
a game, touches a bridge or takes measurable time.

LIVENESS is a property of its own (`LiveVisibilityTests`): the log is only worth opening DURING a
take if a line is on disk while the driver still runs. Two different mechanisms carry that, and
they are easy to confuse. shoot.py's own header is down because it calls `fh.flush()` explicitly
(shoot.py:192) — NOT because the handle is opened `buffering=1`; dropping the line-buffering and
keeping the flush changes nothing observable here, so the flush is the load-bearing half. The
DRIVER's line, meanwhile, is not shoot.py's property at all: the child gets the raw fd and decides
for itself when to flush. That assumption had no known-bad, so it is tested in both directions
with a real subprocess that outlives the assertion — a driver that flushes is readable mid-take, a
BLOCK-BUFFERED one provably is not until it exits. The second case is what proves the first is
measuring anything, and it is a live footgun rather than a hypothetical: a `during` driver that
forgets to flush (or runs python without `-u`) leaves the operator reading a take-long silence and
concluding the bot was stuck.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -t scripts/tests -v
"""
from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
import tempfile
import textwrap
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "demo"))  # shoot

import shoot  # noqa: E402  — import is side-effect free (constants + defs only)


class DuringLogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.out = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.out, True)

    def run_during(self, shot: dict) -> Path:
        """start_during + let the driver finish + stop_during — the real shoot_one order."""
        procs = shoot.start_during(shot, self.out)
        for p, _fh in procs:
            p.wait(timeout=10)
        shoot.stop_during(procs)
        for _p, fh in procs:
            self.assertTrue(fh.closed, "stop_during must close the log handle it opened")
        return self.out / f"{shot['id']}.during.log"

    def test_driver_stdout_lands_in_the_take_s_log(self) -> None:
        log = self.run_during({"id": "09_probe", "during": ["echo hello"]})
        self.assertTrue(log.is_file(), f"{log} was not created")
        text = log.read_text()
        self.assertIn("hello", text)
        self.assertIn("echo hello", text)          # the header names the command
        self.assertRegex(text, r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d")  # ... and when it ran

    def test_stderr_is_captured_too(self) -> None:
        # A driver that only complains on stderr is precisely the one worth reading.
        log = self.run_during({"id": "10_err", "during": ["echo boom 1>&2"]})
        self.assertIn("boom", log.read_text())

    def test_an_early_exit_is_recorded_in_the_log_not_only_on_the_console(self) -> None:
        log = self.run_during({"id": "11_short", "during": ["true"]})
        self.assertIn("driver already exited", log.read_text())

    def test_a_re_shoot_APPENDS_rather_than_erasing_the_first_attempt(self) -> None:
        self.run_during({"id": "12_retake", "during": ["echo first"]})
        log = self.run_during({"id": "12_retake", "during": ["echo second"]})
        text = log.read_text()
        self.assertIn("first", text)   # the take that failed still has to be explainable
        self.assertIn("second", text)

    def test_a_LIVE_driver_is_killed_and_its_output_kept(self) -> None:
        # Every other case here takes the already-exited branch. This one is the branch that
        # actually matters on a shoot day: a driver still running when the take ends (a
        # sustain_live `loop`) must be killed with its whole process group — one that survives
        # keeps driving the bot through every LATER shot in the list — and whatever it managed
        # to say before dying must still be in the log.
        shot = {"id": "14_live", "during": ["echo alive; sleep 30"]}
        procs = shoot.start_during(shot, self.out)
        (proc, fh), = procs
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:  # let the driver reach its first line
            if "alive" in (self.out / "14_live.during.log").read_text():
                break
            time.sleep(0.05)

        self.assertIsNone(proc.poll(), "fixture must still be RUNNING at stop_during")
        pgid = os.getpgid(proc.pid)  # captured BEFORE the wait reaps the leader
        shoot.stop_during(procs)

        self.assertIsNotNone(proc.poll(), "stop_during left the driver alive")
        self.assertTrue(fh.closed)
        self.assertIn("alive", (self.out / "14_live.during.log").read_text())
        # killpg(0) on a group with ANY surviving member succeeds even once the leader is
        # reaped — so this is the assertion that the `sleep` child died too, not just `sh`.
        with self.assertRaises(ProcessLookupError):
            os.killpg(pgid, 0)

    def test_a_shot_without_during_writes_NOTHING(self) -> None:  # NEG-CONTROL
        # An empty log next to a take would read as "the driver produced no output", which is
        # a different (and much more alarming) claim than "this shot had no driver".
        self.assertEqual(shoot.start_during({"id": "13_bare"}, self.out), [])
        self.assertEqual(list(self.out.iterdir()), [])


class LiveVisibilityTests(unittest.TestCase):
    """Is a driver's line readable while the take is still ROLLING?

    Every case in DuringLogTests reads the log after the driver is gone, so all of them would
    still pass if the output only materialised at exit — and a log that only exists after the
    shoot cannot answer "what is the bot doing RIGHT NOW", which is half of why it was added.
    These two cases are the pair: a flushing driver is visible mid-take, a block-buffered one is
    NOT (and only then appears, whole, at exit).
    """

    SETTLE_S = 1.0    # generous upper bound on "the OS would have shown it by now"
    POLL_S = 0.02
    MARKER = "DRIVER-LINE"

    def setUp(self) -> None:
        self.out = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.out, True)
        self.ready = self.out / "ready"   # driver -> parent: my write() has returned
        self.go = self.out / "go"         # parent -> driver: you may exit now

    def driver(self, *, flush: bool) -> str:
        """A REAL subprocess that writes one line, then blocks — no sleep-based timing.

        The handshake is filesystem-only and one-way each direction, so the parent's assertions
        happen at a moment the driver is provably still alive: it cannot exit before `go`.
        `sys.stdout` here is a pipe-less regular FILE (shoot.py hands the child the log's fd),
        which CPython block-buffers at 8 KiB — so dropping the flush is a faithful reproduction
        of the real footgun, not an artificial one. `env -u PYTHONUNBUFFERED` is not decoration:
        the driver runs under `shell=True` and inherits the caller's environment, so a developer
        (or CI) with PYTHONUNBUFFERED=1 exported would make the unflushed driver visible and the
        neg-control would fail for a reason that has nothing to do with shoot.py.

        The marker is SPLIT across a concatenation on purpose: shoot.py's header echoes the whole
        command into the same log, so a marker that appeared literally in the command line would
        be "found" in the log before the driver had written anything at all — the first draft of
        this pair passed exactly that way, and only the neg-control exposed it. The assert below
        is what keeps it split.
        """
        cut = len(self.MARKER) // 2
        body = textwrap.dedent(f"""
            import os, sys, time
            sys.stdout.write({self.MARKER[:cut]!r} + {self.MARKER[cut:]!r} + "\\n")
            {"sys.stdout.flush()" if flush else "pass  # deliberately NOT flushed"}
            open({str(self.ready)!r}, "w").close()
            while not os.path.exists({str(self.go)!r}):
                time.sleep(0.01)
        """)
        cmd = f"env -u PYTHONUNBUFFERED {shlex.quote(sys.executable)} -c {shlex.quote(body)}"
        self.assertNotIn(self.MARKER, cmd,
                         "the marker must not be readable off the header shoot.py writes")
        return cmd

    def await_file(self, path: Path, timeout: float = 10.0) -> None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if path.exists():
                return
            time.sleep(self.POLL_S)
        self.fail(f"{path.name} never appeared — the driver fixture did not run")

    def log_of(self, shot_id: str) -> str:
        return (self.out / f"{shot_id}.during.log").read_text()

    def test_a_FLUSHED_line_is_on_disk_while_the_driver_is_still_alive(self) -> None:
        shot = {"id": "15_live_flush", "during": [self.driver(flush=True)]}
        procs = shoot.start_during(shot, self.out)
        (proc, _fh), = procs
        try:
            self.await_file(self.ready)
            self.assertIsNone(proc.poll(), "fixture must still be RUNNING at the assertion")
            text = self.log_of("15_live_flush")
            self.assertIn(self.MARKER, text)
            # shoot.py's OWN header must be down too — that one is on the explicit fh.flush()
            # after the write (shoot.py:192), not on the handle's buffering=1; a mid-take reader
            # would otherwise see driver output it cannot attribute to any command.
            self.assertRegex(text, r"\d{4}-\d\d-\d\d \d\d:\d\d:\d\d")
        finally:
            self.go.touch()
            shoot.stop_during(procs)

    def test_an_UNFLUSHED_line_is_INVISIBLE_until_the_driver_exits(self) -> None:  # NEG-CONTROL
        # The falsifier for the case above: same shape, same log, same shoot.py — only the
        # driver's own flush removed. If the assertion above passed for any reason other than
        # the flush (e.g. the file being written by the parent, or the test reading its own
        # buffer) this would pass too, and the pair could not both hold.
        shot = {"id": "16_live_noflush", "during": [self.driver(flush=False)]}
        procs = shoot.start_during(shot, self.out)
        (proc, _fh), = procs
        try:
            self.await_file(self.ready)
            deadline = time.monotonic() + self.SETTLE_S
            while time.monotonic() < deadline:  # give it every chance to show up
                self.assertNotIn(self.MARKER, self.log_of("16_live_noflush"),
                                 "a block-buffered driver cannot be visible mid-take")
                time.sleep(self.POLL_S)
            self.assertIsNone(proc.poll(), "fixture must still be RUNNING at the assertion")
        finally:
            self.go.touch()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                pass
            shoot.stop_during(procs)
        # It exits normally, so the interpreter flushes on the way out — the line was always
        # real, it was simply not OBSERVABLE. Nothing shoot.py can open makes it so.
        self.assertIn(self.MARKER, self.log_of("16_live_noflush"))


if __name__ == "__main__":
    unittest.main()
