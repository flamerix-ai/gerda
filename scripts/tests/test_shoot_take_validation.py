"""Unit tests for take validation (scripts/demo/shoot.py `roll` + scripts/rig/record.sh).

WHY these exist, precisely. Once wf-recorder took a `Bus error (core dumped)`
right after record.sh printed "frames flowing (262192B)". record.sh went on to print
"finalising (SIGINT → moov atom)" and "done → …01_clutch.mp4 (260K)" and exited 0; shoot.py
saw rc=0 and a 260 KB file, printed "[rec] ok (256 KiB)" and filed `01_clutch ok`. ffprobe on
that "take": `moov atom not found`. A dud reported green through two layers — an exit code
masking the real failure.

Both layers are pinned here, and the NEGATIVE cases are the ones that carry the weight: a suite
that only proved "a good take passes" would have passed on the 21:48 dud at every step.

  * record.sh — a recorder that dies MID-ROLL (after the frame guard is satisfied, which is
    exactly where the real crash landed) must exit non-zero and must NOT print "done"; paired
    with a clean recorder that still does. The pairing matters because the fix is a `wait` on
    the recorder pid, and a `wait` that mis-reads a normal SIGINT shutdown would turn every
    good take into a failure — silence in the other direction is just as expensive on a shoot
    day. The SIGKILL backstop (rc 137) shares the `RC -ne 0` predicate with the crash case and
    would only add 15 s of sleep to the suite, so it is deliberately not re-tested.
  * shoot.py — SIZE is not proof: every failing case below writes a file well OVER the
    51200-byte floor that used to be the whole check. The container has to OPEN (ffprobe rc)
    and `format=duration` has to reach MIN_TAKE_RATIO of the seconds rolled.

Fakes, not fixtures: `WFREC` and `ffprobe` are stand-in executables and `RECORD_SH` is patched,
so nothing boots a compositor, a game or an encoder. The record.sh cases DO run the real shell
script end to end — that script is the thing under test.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -t scripts/tests -v
"""
from __future__ import annotations

import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "demo"))  # shoot

import shoot  # noqa: E402  — import is side-effect free (constants + defs only)

RECORD_SH = REPO / "scripts" / "rig" / "record.sh"

# Comfortably over shoot.MIN_TAKE_BYTES: every failure below must be caught by something OTHER
# than the size floor, or these tests are re-testing the check that already existed.
FAKE_TAKE_BYTES = 260_000


def write_exe(path: Path, body: str) -> Path:
    path.write_text(body)
    path.chmod(0o755)
    return path


class RollValidationTests(unittest.TestCase):
    """`roll` — the layer that decides whether a landed file is a take."""

    SECONDS = 12  # matches the real 01_clutch shot; floor = 0.8 * 12 = 9.60s

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.out = self.tmp / "takes" / "01_clutch.mp4"
        # A record.sh that lands a plausibly-sized file and exits 0 — i.e. exactly what the
        # 21:48 dud looked like from here.
        self.record = write_exe(self.tmp / "fake_record.sh", textwrap.dedent(f"""\
            #!/usr/bin/env bash
            mkdir -p "$(dirname "$1")"
            head -c {FAKE_TAKE_BYTES} /dev/zero > "$1"
            exit ${{FAKE_RECORD_RC:-0}}
            """))

    def ffprobe(self, body: str) -> None:
        """Install a fake ffprobe as the FIRST thing on PATH for this test."""
        write_exe(self.bin / "ffprobe", body)
        self.enterContext(mock.patch.dict(os.environ, {"PATH": f"{self.bin}:{os.environ['PATH']}"}))

    def ffprobe_says(self, duration: str) -> None:
        self.ffprobe(f"#!/usr/bin/env bash\necho {duration}\n")

    def roll(self, seconds: int | None = None) -> tuple[str, str]:
        """Run `roll` against the fakes; returns (reason, console output)."""
        buf = io.StringIO()
        with mock.patch.object(shoot, "RECORD_SH", self.record), \
                mock.patch.dict(os.environ, {"WAYLAND_DISPLAY": "wayland-fake"}), \
                contextlib.redirect_stdout(buf):
            reason = shoot.roll({"id": "01_clutch", "seconds": seconds or self.SECONDS},
                                self.out, 60)
        return reason, buf.getvalue()

    # ── the take that is real ────────────────────────────────────────────────────────────

    def test_a_take_as_long_as_the_roll_is_ok(self) -> None:
        self.ffprobe_says("12.05")
        reason, log = self.roll()
        self.assertEqual(reason, "", f"a good take was rejected: {reason}")
        self.assertIn("[rec] ok", log)
        self.assertIn("12.05s of 12s", log)   # the duration is REPORTED, not just checked

    def test_the_floor_is_INCLUSIVE_at_exactly_the_ratio(self) -> None:
        # 0.8 * 12 = 9.60 exactly. Pinned because the comparison is the whole check: flipped to
        # `<=` this take would be rejected, and a shoot day would lose good footage to rounding.
        self.ffprobe_says("9.60")
        self.assertEqual(self.roll()[0], "")

    # ── NEG-CONTROLS: the ways a fat file is not a take ──────────────────────────────────

    def test_a_take_ffprobe_cannot_OPEN_is_failed_and_says_moov_atom(self) -> None:  # NEG-CONTROL
        # THE 21:48 dud, reproduced: rc=0 out of record.sh, 260 KB on disk, unreadable. This is
        # the case the old `size >= 51200` check called "[rec] ok (256 KiB)".
        self.ffprobe(textwrap.dedent("""\
            #!/usr/bin/env bash
            echo "[mov,mp4,m4a,3gp,3g2,mj2 @ 0x5581] moov atom not found" >&2
            echo "${@: -1}: Invalid data found when processing input" >&2
            exit 1
            """))
        reason, log = self.roll()
        self.assertIn("could not open the take", reason)
        self.assertIn("moov atom not found", reason,
                      "the reason must name the cause, not only ffprobe's parting consequence")
        self.assertIn("rc=1", reason)
        self.assertIn("[rec] FAILED", log)
        self.assertNotIn("[rec] ok", log)
        self.assertGreater(self.out.stat().st_size, shoot.MIN_TAKE_BYTES,
                           "the fixture must be OVER the size floor, or this proves nothing")

    def test_a_take_CUT_SHORT_is_failed_and_names_the_shortfall(self) -> None:  # NEG-CONTROL
        # 3.6s of a 12s roll — a recorder that died a quarter of the way in, finalised, and left
        # a perfectly readable file. Nothing but the duration can catch this one.
        self.ffprobe_says("3.60")
        reason, log = self.roll()
        self.assertIn("only 3.60s of the 12s rolled", reason)
        self.assertIn("9.60s floor", reason)
        self.assertIn("[rec] FAILED", log)
        self.assertNotIn("[rec] ok", log)

    def test_a_take_a_HAIR_under_the_floor_is_failed(self) -> None:  # NEG-CONTROL
        # The pairing for the inclusive-floor case: the boundary must actually bite, or "9.60
        # passes" is satisfied by a check that passes everything.
        self.ffprobe_says("9.59")
        self.assertIn("only 9.59s", self.roll()[0])

    def test_a_container_that_opens_with_NO_duration_is_failed(self) -> None:  # NEG-CONTROL
        # ffprobe rc=0 and "N/A" on stdout. Coercing that to 0.0 (or to a pass) is how a
        # duration check quietly stops checking; it must be a REFUSAL that says what it saw.
        self.ffprobe_says("N/A")
        reason = self.roll()[0]
        self.assertIn("no usable duration", reason)
        self.assertIn("N/A", reason)

    def test_a_ZERO_second_container_is_failed(self) -> None:  # NEG-CONTROL
        self.ffprobe_says("0.000000")
        self.assertIn("nothing was encoded", self.roll()[0])

    def test_a_MISSING_ffprobe_refuses_instead_of_passing_the_take(self) -> None:  # NEG-CONTROL
        # Fail-loud over convenience: on a box without ffprobe the validation cannot run, and the
        # tempting behaviour ("nothing to check, so it's fine") reinstates the exact bug — an
        # unvalidated dud filed green. It must be a failure the operator can read.
        self.enterContext(mock.patch.object(shoot.shutil, "which", return_value=None))
        reason = self.roll()[0]
        self.assertIn("ffprobe is not on PATH", reason)
        self.assertIn("NOT be validated", reason)

    def test_a_FAILED_record_sh_is_reported_before_ffprobe_is_consulted(self) -> None:
        # The layers stack: a loud record.sh must not need ffprobe to be believed. The fake
        # ffprobe here would call the take good, so if it ran the test would go green wrongly.
        self.ffprobe_says("12.0")
        self.enterContext(mock.patch.dict(os.environ, {"FAKE_RECORD_RC": "1"}))
        reason, log = self.roll()
        self.assertIn("record.sh rc=1", reason)
        self.assertIn("see record.sh output above", log)

    # ── the summary line the operator actually reads ─────────────────────────────────────

    def test_the_SUMMARY_marks_the_shot_failed_and_carries_the_reason(self) -> None:
        # `shoot_one`'s return value is what `main` prints per shot AND what it counts against
        # "did NOT produce a take" (anything that is not exactly "ok"). A bare "failed" would
        # make the operator re-read a whole take's scrollback to learn which layer complained.
        self.ffprobe_says("3.60")
        buf = io.StringIO()
        shot = {"id": "01_clutch", "seconds": self.SECONDS, "settle": 0}
        with mock.patch.object(shoot, "RECORD_SH", self.record), \
                mock.patch.dict(os.environ, {"WAYLAND_DISPLAY": "wayland-fake"}), \
                contextlib.redirect_stdout(buf):
            res = shoot.shoot_one(shot, self.out.parent, 60)
        self.assertNotEqual(res, "ok")
        self.assertTrue(res.startswith("failed: "), res)
        self.assertIn("only 3.60s of the 12s rolled", res)


class RecordShExitStatusTests(unittest.TestCase):
    """scripts/rig/record.sh — does a crashed recorder still report a finished take?"""

    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.out = self.tmp / "take.mp4"

    def fake_recorder(self, tail: str) -> Path:
        """A stand-in wf-recorder: writes frames past record.sh's warmup guard, then `tail`.

        It parses its own `-f` argument exactly as record.sh passes it, so the file record.sh
        stats is the file this writes — the warmup guard has to pass for real or the test would
        exercise the OLD "died immediately" branch instead of the mid-roll one that shipped the
        dud take.
        """
        head = textwrap.dedent(f"""\
            #!{sys.executable}
            import os, signal, sys, time
            argv = sys.argv[1:]
            out = argv[argv.index("-f") + 1]
            with open(out, "wb") as fh:
                fh.write(b"\\0" * {FAKE_TAKE_BYTES})
            sys.stderr.write("fake wf-recorder: frames\\n")
            sys.stderr.flush()
            """)
        # Concatenated, NOT interpolated: substituting a multi-line `tail` into an indented
        # template leaves every line but the first at column 0, which defeats the outer dedent
        # and turns the shebang into an indented comment — the fake then runs as a SHELL script.
        return write_exe(self.tmp / "fake_wf", head + textwrap.dedent(tail))

    def run_record(self, recorder: Path, seconds: str) -> subprocess.CompletedProcess[str]:
        env = {**os.environ, "WFREC": str(recorder), "WAYLAND_DISPLAY": "wayland-fake"}
        return subprocess.run([str(RECORD_SH), str(self.out), seconds, "HEADLESS-1", "60"],
                              capture_output=True, text=True, check=False, timeout=120, env=env)

    def test_a_recorder_that_CRASHES_mid_roll_fails_loud(self) -> None:  # NEG-CONTROL
        # SIGBUS after the frame guard is satisfied — the real crash sequence exactly.
        # Before the fix this printed "finalising", then "done → … (260K)", and exited 0.
        # Timing, because it is load-bearing: record.sh clears its warmup guard at ~4 s and
        # rolls for `seconds` after that, so the crash at 6 s lands INSIDE the roll with margin
        # on both sides. Crashing earlier would take the pre-existing "died during warmup"
        # branch — the one that was already loud — and prove nothing about this fix.
        r = self.run_record(self.fake_recorder(textwrap.dedent("""
            time.sleep(6)
            os.kill(os.getpid(), signal.SIGBUS)
            time.sleep(30)
        """)), "8")
        self.assertNotEqual(r.returncode, 0, "a crashed recorder reported a successful take")
        self.assertNotIn("done →", r.stdout, "a dud must NEVER be announced as a finished take")
        self.assertIn("RECORDER FAILED", r.stderr)
        self.assertIn("rc=135", r.stderr)                    # 128 + SIGBUS(7), named for the operator
        self.assertIn("ALREADY GONE", r.stderr)              # ... and WHEN it died
        self.assertIn("moov atom not found", r.stderr)       # ... and what the file will do
        self.assertIn("fake wf-recorder: frames", r.stderr)  # the recorder's own stderr is kept
        self.assertGreater(self.out.stat().st_size, 51200,
                           "the fixture must leave a FAT file — that is what made this silent")

    def test_a_CLEAN_recorder_still_reports_done(self) -> None:
        # The pairing. The fix is a `wait` on the recorder pid, and a `wait` read wrongly would
        # fail every good take instead — which on a shoot day costs as much as the dud did.
        # This fake behaves like the real wf-recorder: it HANDLES SIGINT and exits 0.
        r = self.run_record(self.fake_recorder(textwrap.dedent("""
            done = []
            signal.signal(signal.SIGINT, lambda *_: done.append(1))
            while not done:
                time.sleep(0.05)
            sys.exit(0)
        """)), "1")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("finalising", r.stdout)
        self.assertIn("done →", r.stdout)
        self.assertNotIn("RECORDER FAILED", r.stderr)


if __name__ == "__main__":
    unittest.main()
