"""Unit tests for the take-liveness probe (scripts/rig/motion_probe.py).

The probe exists because "I checked it frame by frame" and a contact sheet accepted three
takes containing a multi-second FREEZE, and because shader noise keeps a frozen take's file
size looking healthy. So the cases that matter here are the NEGATIVE ones: a probe that only
proves "a moving take reads as moving" would have passed on all three of those takes too.
Covered, in the order they protect anything:

  * a live take reads as ONE window and the gate passes;
  * NEG-CONTROL a fully frozen take yields NO window, a full-length static run, and a gate
    that actually FAILS (the failing branch is `gate_verdict`, exercised for real — a gate
    whose fail path is never executed is a superstition);
  * NEG-CONTROL shader noise (a real difference, just below the threshold) reads as STATIC,
    not as motion — this is the exact signal that defeats size heuristics;
  * a freeze in the MIDDLE of a live take is located with the right timestamps;
  * the two smoothing knobs cut both ways: `bridge` keeps one dropped frame from splitting a
    window, `min_live` keeps one twitchy frame from inventing one;
  * DUTY reports the blind spot the gate structurally cannot see — a take of bridged BLINKS whose
    longest static run is ~0 (so `--max-static` passes it) but which was live ~20 % of the time —
    and, the paired control, that duty moves NO verdict: the blinking take and a fully live take
    get the same "ok" out of `gate_verdict` while their duty differs 5x;
  * `--in`/`--out` measure a SUB-RANGE while the report keeps ABSOLUTE source timestamps, with
    the neg-controls that matter: dropping the +`--in` offset is caught, no flags stays bit-
    identical to the whole-file behaviour every number in docs/RIG.md was measured with, an
    empty / past-the-end range REFUSES (exit 2) instead of quietly measuring "whatever was there",
    and a range that only PARTLY fits the take is refused too — "at least two frames" is not
    coverage, and 4.9s of an answer to a 9s question is a verdict about a different segment;
  * the seek is INPUT-side, pinned by a FRACTIONAL in-point (at a whole multiple of 1/fps the two
    placements are bit-identical, so an integral `--in` can never catch that mutation), and the
    report says which interval it actually DIFFERENCED (one sample short of the request);
  * a REFUSED range is diagnosed by an ffprobe oracle rather than by a fixed sentence: a take that
    really is short says "re-shoot", a container whose timestamps start late says DO NOT — with
    the neg-control that the two never swap, and that a mute ffprobe produces neither verdict;
  * NEG-CONTROL a non-finite bound (`nan`, `inf`) is refused BY NAME — every guard in main() is a
    comparison, and NaN defeats comparisons silently rather than loudly;
  * GOLDEN SCALARS — the whole decode→MAD→duty pipeline is pinned to LITERAL numbers off a
    deterministic fixture (and, where the takes are checked out, to the very rows docs/RIG.md
    publishes), so a drift in ffmpeg, the filter chain or the metric breaks a test instead of
    silently re-writing the acceptance band;
  * frame_mads returns the arithmetically exact MAD, and refuses ragged input.

Everything above the ffmpeg classes drives the PURE core with synthetic byte frames — no ffmpeg,
no video files.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -t scripts/tests -v
"""
from __future__ import annotations

import contextlib
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "rig"))  # motion_probe
sys.path.insert(0, str(REPO / "scripts"))  # machine_root

import machine_root  # noqa: E402
import motion_probe as mp  # noqa: E402

FPS = 10.0
SIZE = 64  # bytes per synthetic frame — grayscale levels, same units as a real decode


def takes_dir() -> Path | None:
    """The teaser takes docs/RIG.md's acceptance band was measured on, if they are on disk.

    `release/` is gitignored (it holds the raw footage), so the takes exist only in the checkout
    they were shot into — and a git WORKTREE gets its own empty tree. Hence the second lookup:
    the main checkout (`machine_root.root()`), which is where they live. Absent both, the
    real-take pins skip; the synthetic golden below runs everywhere and is not optional.
    """
    for root in (REPO, None):
        if root is None:
            try:
                root = machine_root.root()
            except (machine_root.MachineRootError, OSError):
                return None
        cand = root / "release" / "takes" / "teaser"
        if (cand / "04_nav.mp4").is_file():
            return cand
    return None


TAKES = takes_dir()


def flat(value: int) -> bytes:
    """One synthetic frame, uniformly `value` — MAD between two of them is |v1 - v2|."""
    return bytes([value]) * SIZE


def frames(values: list[int]) -> list[bytes]:
    return [flat(v) for v in values]


def alternating(n: int, high: int = 50, start_high: bool = False) -> list[int]:
    """`n` frame values flipping 0/high — every neighbouring pair differs by `high`."""
    return [high if (i % 2 == 1) != start_high else 0 for i in range(n)]


def blinks(count: int, period: int = 5, high: int = 200) -> list[int]:
    """`count` isolated one-sample blinks, one every `period` samples.

    The value changes at frame index 1, 1+period, 1+2*period, … so MAD index i is live exactly
    when i % period == 0. At FPS=10 and period=5 the dead gap between blinks is 0.4s — UNDER the
    default 0.5s bridge, so every blink merges into ONE window and the take reports no static run
    worth failing, while only 1 sample in `period` ever moved.
    """
    values, level = [0], 0
    for i in range(1, count * period):
        if (i - 1) % period == 0:
            level = high - level
        values.append(level)
    return values


def run(values: list[int], thresh: float = 1.0,
        bridge_s: float = 0.5, min_live_s: float = 0.5) -> dict:
    return mp.classify(mp.frame_mads(frames(values)), FPS, thresh, bridge_s, min_live_s)


class FrameMadsTests(unittest.TestCase):
    def test_exact_mad_of_a_known_pair(self) -> None:
        # 2 bytes differ by 10 and 20 over a 4-byte frame -> (10 + 20 + 0 + 0) / 4 = 7.5
        mads = mp.frame_mads([bytes([0, 0, 0, 0]), bytes([10, 20, 0, 0])])
        self.assertEqual(mads, [7.5])

    def test_mad_is_symmetric_and_absolute(self) -> None:
        # Darkening must count exactly as much as brightening; a signed mean would cancel.
        self.assertEqual(mp.frame_mads([bytes([200, 0]), bytes([0, 200])]), [200.0])

    def test_a_series_yields_n_minus_one_values(self) -> None:
        mads = mp.frame_mads(frames([0, 10, 40, 40]))
        self.assertEqual(mads, [10.0, 30.0, 0.0])

    def test_a_single_frame_measures_nothing(self) -> None:
        self.assertEqual(mp.frame_mads([flat(0)]), [])

    def test_ragged_frames_are_REFUSED(self) -> None:  # NEG-CONTROL
        # Silently dropping/truncating a frame would understate motion — the one direction
        # that ships a frozen take as live.
        with self.assertRaises(ValueError):
            mp.frame_mads([bytes(10), bytes(9)])


class LiveTakeTests(unittest.TestCase):
    def test_a_moving_take_is_one_window_and_passes_the_gate(self) -> None:
        # 20 frames, every pair different -> 19 live MADs covering [0.0, 1.9).
        res = run(alternating(20))
        self.assertEqual(res["windows"], [(0.0, 1.9)])
        self.assertEqual(res["static_runs"], [])
        self.assertIsNone(res["longest_static"])
        self.assertEqual(res["stats"]["min"], 50.0)

        status, verdict, longest = mp.gate_verdict(res, 0.5)
        self.assertEqual(status, "ok")
        self.assertEqual(verdict, "GATE OK")
        self.assertEqual(longest, 0.0)

    def test_honest_intermittent_motion_survives(self) -> None:
        # Every OTHER frame is live (a bot whose animation lights half the frames). Bridging
        # has to happen before the min_live test or this shreds into 0.1s scraps and a take of
        # real work reports as dead — the regression the live-COUNT rule must not reintroduce.
        values = [0, 40, 40, 0, 0, 40, 40, 0, 0, 40, 40, 0, 0, 40, 40, 0]
        res = run(values)
        self.assertEqual(res["windows"], [(0.0, 1.5)])
        self.assertEqual(res["static_runs"], [])


class FrozenTakeTests(unittest.TestCase):
    def test_a_frozen_take_has_no_window_and_FAILS_the_gate(self) -> None:  # NEG-CONTROL
        # 30 identical frames -> 29 MADs of 0.0 covering [0.0, 2.9).
        res = run([100] * 30)
        self.assertEqual(res["windows"], [])
        self.assertEqual(res["static_runs"], [(0.0, 2.9)])
        self.assertEqual(res["longest_static"], (0.0, 2.9))
        self.assertEqual(res["stats"], {"min": 0.0, "median": 0.0, "p90": 0.0, "max": 0.0})

        status, verdict, longest = mp.gate_verdict(res, 2.0)
        self.assertEqual(status, "fail")           # the branch that has to bite
        self.assertAlmostEqual(longest, 2.9, places=6)
        self.assertIn("GATE FAIL", verdict)
        self.assertIn("2.9s", verdict)

    def test_the_same_frozen_take_passes_a_loose_gate(self) -> None:
        # Same input, only the threshold moves — proves the verdict is driven by --max-static
        # and not by some other property of the frozen series.
        status, verdict, _ = mp.gate_verdict(run([100] * 30), 5.0)
        self.assertEqual(status, "ok")
        self.assertEqual(verdict, "GATE OK")

    def test_report_only_never_fails(self) -> None:
        status, verdict, longest = mp.gate_verdict(run([100] * 30), None)
        self.assertEqual(status, "ok")
        self.assertEqual(verdict, "")
        self.assertAlmostEqual(longest, 2.9, places=6)

    def test_two_BLINKS_inside_a_freeze_cannot_saw_it_in_half(self) -> None:  # NEG-CONTROL
        # THE falsifier for the bridge/min_live interaction. 61 frames, 6.0s of measured span,
        # every MAD 0 except i=20 and i=24 — two isolated blinks 0.4s apart. Under a SPAN test
        # they bridge into a 0.5s "live window" that splits the dead take into 2.0s + 3.5s and
        # sails past --max-static 4.0. Live-frame accounting sees 2 live MADs = 0.2s < 0.5s,
        # drops the window, and the take reads as the 6-second freeze it is.
        # One level change at frame 21 and one back at frame 25 => MADs live at exactly 20
        # and 24, everything else identical.
        values = [200 if 21 <= i <= 24 else 0 for i in range(61)]
        mads = mp.frame_mads(frames(values))
        live_idx = [i for i, m in enumerate(mads) if m >= 1.0]
        self.assertEqual(live_idx, [20, 24], "the fixture must produce exactly two blinks")

        res = mp.classify(mads, FPS, 1.0, 0.5, 0.5)
        self.assertEqual(res["windows"], [])
        self.assertEqual(res["static_runs"], [(0.0, 6.0)])
        status, verdict, longest = mp.gate_verdict(res, 4.0)
        self.assertEqual(status, "fail", "a 6s dead take must not pass a 4s static budget")
        self.assertAlmostEqual(longest, 6.0, places=6)
        self.assertIn("GATE FAIL", verdict)


class ShaderNoiseTests(unittest.TestCase):
    """A frozen take under a shader is not byte-identical — it must still read as frozen."""

    @staticmethod
    def noisy(n: int) -> list[bytes]:
        # Two of 64 bytes flip by ±1 each frame: MAD = 2/64 = 0.03125, far below thresh 1.0
        # but far above zero — this is what keeps a frozen take's file size looking healthy.
        out = []
        for i in range(n):
            buf = bytearray(flat(120))
            buf[0] = 120 + (i % 2)
            buf[1] = 120 - (i % 2)
            out.append(bytes(buf))
        return out

    def test_sub_threshold_noise_is_STATIC_not_motion(self) -> None:  # NEG-CONTROL
        mads = mp.frame_mads(self.noisy(30))
        self.assertTrue(all(0 < m < 1.0 for m in mads), mads[:3])  # real, but tiny
        res = mp.classify(mads, FPS, 1.0, 0.5, 0.5)
        self.assertEqual(res["windows"], [])
        self.assertEqual(res["longest_static"], (0.0, 2.9))
        self.assertEqual(mp.gate_verdict(res, 2.0)[0], "fail")

    def test_dropping_the_threshold_under_the_noise_makes_it_live(self) -> None:
        # The mirror image: same frames, thresh below the noise floor -> all live. Confirms
        # the previous case is decided by --thresh, not by an accidental zero somewhere.
        res = mp.classify(mp.frame_mads(self.noisy(30)), FPS, 0.01, 0.5, 0.5)
        self.assertEqual(res["windows"], [(0.0, 2.9)])


class MidTakeFreezeTests(unittest.TestCase):
    def test_a_freeze_in_the_middle_is_located_exactly(self) -> None:
        # frames  0..9   alternate            -> MADs 0..8 live
        # frames 10..19  all 100 (frozen)     -> MAD 9 = |50-100| live, MADs 10..18 = 0 dead
        # frames 20..29  alternate from 0     -> MAD 19 = |100-0| live, MADs 20..28 live
        values = alternating(10) + [100] * 10 + alternating(10)
        res = run(values)
        # dead MADs 10..18 -> [10/10, 19/10) = 1.0 .. 1.9 ; the 0.9s gap outlives bridge=0.5
        self.assertEqual(res["windows"], [(0.0, 1.0), (1.9, 2.9)])
        self.assertEqual(res["static_runs"], [(1.0, 1.9)])
        self.assertEqual(res["longest_static"], (1.0, 1.9))

        self.assertEqual(mp.gate_verdict(res, 0.5)[0], "fail")  # 0.9s freeze > 0.5s budget
        self.assertEqual(mp.gate_verdict(res, 1.0)[0], "ok")    # 0.9s freeze <= 1.0s budget

    def test_the_longest_of_two_freezes_wins(self) -> None:
        values = (alternating(6) + [100] * 5      # ~0.4s freeze
                  + alternating(6, start_high=True) + [7] * 9)  # ~0.8s freeze
        res = run(values)
        longest = res["longest_static"]
        self.assertIsNotNone(longest)
        assert longest is not None  # narrow for the type checker
        self.assertEqual(longest, max(res["static_runs"], key=lambda r: r[1] - r[0]))
        self.assertGreater(longest[1] - longest[0], 0.5)


class BridgeAndMinLiveTests(unittest.TestCase):
    def test_ONE_dead_frame_does_not_split_a_live_window(self) -> None:
        # Frames 10 and 11 are identical -> exactly one dead MAD (index 10) = a 0.1s gap,
        # under bridge=0.5, so the window must stay whole.
        values = alternating(10) + [0, 0] + alternating(8, start_high=True)
        res = run(values)
        self.assertEqual(res["windows"], [(0.0, 1.9)])
        self.assertEqual(res["static_runs"], [])

    def test_a_shorter_bridge_DOES_split_it(self) -> None:  # the knob cuts both ways
        values = alternating(10) + [0, 0] + alternating(8, start_high=True)
        res = run(values, bridge_s=0.05, min_live_s=0.1)
        self.assertEqual(res["windows"], [(0.0, 1.0), (1.1, 1.9)])
        self.assertEqual(res["static_runs"], [(1.0, 1.1)])

    def test_ONE_live_frame_in_a_freeze_does_not_invent_a_window(self) -> None:
        # A single odd frame mid-freeze lights two MADs (in and out of it) = 0.2s < min_live,
        # so it is discarded — AND it must not chop the freeze into two shorter runs, which
        # would let a blip smuggle a 3s freeze past a 2s gate as two 1.5s ones.
        values = [0] * 10 + [200] + [0] * 9
        res = run(values)
        self.assertEqual(res["windows"], [])
        self.assertEqual(res["static_runs"], [(0.0, 1.9)])
        self.assertEqual(res["longest_static"], (0.0, 1.9))
        self.assertEqual(mp.gate_verdict(res, 1.0)[0], "fail")

    def test_a_lower_min_live_accepts_that_blip(self) -> None:
        res = run([0] * 10 + [200] + [0] * 9, min_live_s=0.1)
        self.assertEqual(res["windows"], [(0.9, 1.1)])
        self.assertEqual(res["static_runs"], [(0.0, 0.9), (1.1, 1.9)])


class DutyTests(unittest.TestCase):
    """DUTY: the observability number for takes the `--max-static` gate structurally cannot see.

    The gate measures the LONGEST freeze. A take whose motion is a chain of blinks has no long
    freeze at all — every gap is bridged — so it passes with longest_static ~0 while a viewer
    sees a dead picture. Duty is reported, never gated; these cases pin BOTH halves of that
    sentence (it exposes the blind spot, and it changes no verdict).
    """

    def test_a_take_of_BLINKS_passes_the_gate_with_a_DEAD_duty(self) -> None:
        # 30 blinks, one live sample every 5 -> 149 MADs, 30 live. Every 0.4s gap is under the
        # 0.5s bridge, so the whole take merges into ONE window and the only static run is the
        # 0.3s tail after the last blink. The gate cannot fail this; duty says 20 %.
        res = run(blinks(30))
        self.assertEqual(res["windows"], [(0.0, 14.6)])
        self.assertEqual(res["duty"]["samples"], 149)
        self.assertEqual(res["duty"]["live_samples"], 30)

        status, _verdict, longest = mp.gate_verdict(res, 1.0)
        self.assertEqual(status, "ok", "the blink take must PASS — that is the blind spot")
        self.assertAlmostEqual(longest, 0.3, places=6)

        self.assertAlmostEqual(res["duty"]["overall"], 30 / 149, places=4)
        self.assertAlmostEqual(res["duty"]["windows"][0], 30 / 146, places=4)

    def test_a_genuinely_live_take_reports_a_FULL_duty(self) -> None:
        # The control the blink case is read against: same gate verdict, 5x the duty. Without
        # this pairing "duty 20 %" is a number with no scale.
        res = run(alternating(150))
        self.assertEqual(res["duty"]["overall"], 1.0)
        self.assertEqual(res["duty"]["windows"], [1.0])
        self.assertEqual(mp.gate_verdict(res, 1.0)[0], "ok")

    def test_duty_moves_NO_verdict(self) -> None:  # NEG-CONTROL
        # The acceptance semantics must be untouched. Same measured take, duty overwritten with
        # a fabricated 0 % and 100 %: gate_verdict must return the IDENTICAL triple, at every
        # budget. If duty ever leaks into the decision, this is the case that catches it.
        base = run(blinks(30))
        for budget in (None, 0.1, 0.3, 1.0, 100.0):
            expected = mp.gate_verdict(run(blinks(30)), budget)
            for fake in ({"overall": 0.0, "live_samples": 0, "samples": 149, "windows": [0.0]},
                         {"overall": 1.0, "live_samples": 149, "samples": 149, "windows": [1.0]},
                         {"overall": None, "live_samples": 0, "samples": 0, "windows": []}):
                with self.subTest(max_static=budget, duty=fake["overall"]):
                    forged = {**base, "duty": fake}
                    self.assertEqual(mp.gate_verdict(forged, budget), expected)

    def test_duty_counts_live_samples_in_DROPPED_windows_too(self) -> None:
        # One blip mid-freeze lights 2 MADs, its window is discarded (below min_live) and the
        # take reads as one long static run. Duty still reports those 2 samples: they are motion
        # the take really contained, and hiding them would make duty a second gate.
        res = run([0] * 10 + [200] + [0] * 9)
        self.assertEqual(res["windows"], [])
        self.assertEqual(res["duty"]["windows"], [])   # no window survived to have a duty
        self.assertEqual(res["duty"]["live_samples"], 2)
        self.assertAlmostEqual(res["duty"]["overall"], 2 / 19, places=4)

    def test_duty_over_nothing_is_None_not_a_confident_zero(self) -> None:  # NEG-CONTROL
        # 0.0 would read as "measured, and dead". Nothing was measured — gate_verdict REFUSES.
        res = mp.classify([], FPS, 1.0, 0.5, 0.5)
        self.assertIsNone(res["duty"]["overall"])
        self.assertEqual(res["duty"], {"overall": None, "live_samples": 0, "samples": 0,
                                       "windows": []})
        self.assertEqual(mp.pct(None), "n/a")


class RangeShiftTests(unittest.TestCase):
    """`--in`/`--out`: the classifier measures a sub-range, the REPORT stays on source seconds.

    The decode hands classify() a series starting at 0 whatever `--in` was, so every timestamp
    has to be re-based by +in exactly once. That offset is the whole point of the feature — a
    freeze located at "0.00..0.10" out of a probe of 19.9-23.4 s sends the operator scrubbing to
    the wrong end of the take — so these cases pin each field it must move, and the zero case
    pins that it is the exact identity when no range was asked for.
    """

    # A freeze in the MIDDLE of a live take: windows (0.0, 1.0) + (1.9, 2.9), static (1.0, 1.9).
    FIXTURE = alternating(10) + [100] * 10 + alternating(10)
    OFFSET = 19.9   # a fractional, non-zero `--in`, the shape a real in-point takes

    def shifted(self) -> dict:
        return mp.shift_times(run(self.FIXTURE), self.OFFSET)

    def test_static_runs_are_reported_in_ABSOLUTE_source_seconds(self) -> None:
        # Drop the +in offset and this reads (1.0, 1.9) — the mutation the feature exists to
        # make impossible, and the one a range-relative report would ship silently.
        self.assertEqual(self.shifted()["static_runs"], [(20.9, 21.8)])

    def test_live_windows_are_shifted_too(self) -> None:
        self.assertEqual(self.shifted()["windows"], [(19.9, 20.9), (21.8, 22.8)])

    def test_longest_static_is_shifted_too(self) -> None:
        # Its own field, not a view of static_runs — a partial mutation that shifts the list but
        # not this would print a correct table under a wrong headline.
        res = self.shifted()
        self.assertEqual(res["longest_static"], (20.9, 21.8))
        self.assertIn(res["longest_static"], res["static_runs"])

    def test_the_shift_moves_TIMESTAMPS_ONLY(self) -> None:
        # Duty/stats/samples are counts and levels, not points on a timeline. Shifting them
        # would corrupt the one number the report tells you to read when the gate says OK.
        before = run(self.FIXTURE)
        after = mp.shift_times(run(self.FIXTURE), self.OFFSET)
        for key in ("samples", "duty", "stats"):
            self.assertEqual(after[key], before[key], key)

    def test_the_gate_verdict_is_unchanged_by_the_shift(self) -> None:  # NEG-CONTROL
        # The gate measures a DURATION; re-basing the timeline must not move a verdict, or
        # `--in` would quietly become a second acceptance knob.
        for budget in (None, 0.5, 1.0, 100.0):
            with self.subTest(max_static=budget):
                plain = mp.gate_verdict(run(self.FIXTURE), budget)
                moved = mp.gate_verdict(self.shifted(), budget)
                self.assertEqual(plain[0], moved[0])
                self.assertAlmostEqual(plain[2], moved[2], places=6)

    def test_a_zero_offset_is_the_EXACT_identity(self) -> None:  # NEG-CONTROL
        # This is what makes "no --in/--out behaves exactly as before" true at the pure level:
        # not approximately, not modulo float dust — the identical dict.
        self.assertEqual(mp.shift_times(run(self.FIXTURE), 0.0), run(self.FIXTURE))

    def test_an_empty_result_survives_the_shift(self) -> None:
        # The shape a past-the-end range produces upstream: nothing to move, and still a REFUSE.
        res = mp.shift_times(mp.classify([], FPS, 1.0, 0.5, 0.5), self.OFFSET)
        self.assertEqual(res["windows"], [])
        self.assertEqual(res["static_runs"], [])
        self.assertIsNone(res["longest_static"])
        self.assertEqual(mp.gate_verdict(res, 100.0)[0], "refuse")


class RangeArgTests(unittest.TestCase):
    """`--in`/`--out` validation — rejected at the CLI, before anything is decoded."""

    def test_a_degenerate_or_negative_range_is_REFUSED(self) -> None:  # NEG-CONTROL
        # A silent clamp ("measure whatever falls inside") is the failure mode to kill: the
        # caller asked about a specific segment, and an answer about a different one is a lie
        # with a passing exit code. Every case here dies before decode() is ever reached.
        for bad in (["v.mp4", "--in", "-1"],
                    ["v.mp4", "--in", "5", "--out", "5"],      # empty
                    ["v.mp4", "--in", "5", "--out", "3"],      # inverted
                    ["v.mp4", "--out", "0"],                   # empty against the implicit in=0
                    ["v.mp4", "--out", "-2"]):
            with self.subTest(argv=bad), self.assertRaises(SystemExit) as cm:
                with contextlib.redirect_stderr(io.StringIO()):
                    mp.main(bad)
            self.assertEqual(cm.exception.code, 2)

    def test_the_refusal_NAMES_the_offending_flag(self) -> None:
        # "died with 2" is not an error message; a shoot-day operator needs the flag back — and
        # this is also what makes the case above load-bearing. `v.mp4` does not exist, so a
        # CLAMPING implementation (silently widening the range instead of refusing) would still
        # exit 2, just with "no such video". Asserting on the TEXT is what tells the two apart.
        for bad, needle in ((["v.mp4", "--in", "-1"], "--in must not be negative"),
                            (["v.mp4", "--in", "5", "--out", "5"], "--out must be greater"),
                            (["v.mp4", "--in", "5", "--out", "3"], "--out must be greater"),
                            (["v.mp4", "--out", "0"], "--out must be greater")):
            err = io.StringIO()
            with self.subTest(argv=bad), self.assertRaises(SystemExit) as cm, \
                    contextlib.redirect_stderr(err):
                mp.main(bad)
            self.assertEqual(cm.exception.code, 2)
            self.assertIn(needle, err.getvalue())

    def test_a_NON_FINITE_bound_is_REFUSED_by_name(self) -> None:  # NEG-CONTROL
        # argparse's type=float happily builds nan/inf, and every guard in main() is a
        # COMPARISON — `nan < 0` and `nan <= 0` are both False — so a NaN used to walk through
        # the whole block untouched. Measured on a real clip: `--in nan` emitted no
        # seek, produced NaN windows and static runs, printed "GATE FAIL: longest static run
        # nans (nan..nan)" and exited 1, with bare `NaN` tokens in the --json object (which
        # RFC-8259 forbids and strict parsers reject). `inf` reached ffmpeg and died there with
        # "Invalid duration for option ss", naming neither the flag nor the probe. Both must be
        # a named refusal at the CLI, like every other bad bound.
        for bad, needle in ((["v.mp4", "--in", "nan"], "--in must be a finite number"),
                            (["v.mp4", "--in", "inf"], "--in must be a finite number"),
                            (["v.mp4", "--out", "nan"], "--out must be a finite number"),
                            # `--out -inf` alone would be swallowed by argparse as an option
                            # token ("expected one argument"), so the =form is what reaches main.
                            (["v.mp4", "--out=-inf"], "--out must be a finite number"),
                            (["v.mp4", "--fps", "nan"], "--fps must be a finite number"),
                            (["v.mp4", "--thresh", "nan"], "--thresh must be a finite number"),
                            (["v.mp4", "--max-static", "nan"],
                             "--max-static must be a finite number")):
            err = io.StringIO()
            with self.subTest(argv=bad), self.assertRaises(SystemExit) as cm, \
                    contextlib.redirect_stderr(err):
                mp.main(bad)
            self.assertEqual(cm.exception.code, 2)
            self.assertIn(needle, err.getvalue())

    def test_a_non_numeric_bound_is_an_ARGPARSE_error(self) -> None:  # NEG-CONTROL
        # type=float, so argparse refuses before main() gets a chance to coerce anything.
        for bad in (["v.mp4", "--in", "start"], ["v.mp4", "--out", "1,5"]):
            err = io.StringIO()
            with self.subTest(argv=bad), self.assertRaises(SystemExit) as cm, \
                    contextlib.redirect_stderr(err):
                mp.main(bad)
            self.assertEqual(cm.exception.code, 2)
            self.assertIn("invalid float value", err.getvalue())


class CoverageDiagnosisTests(unittest.TestCase):
    """WHY a range was refused — the ffprobe oracle, driven with literal numbers (no ffmpeg).

    A shortfall has two very different causes and they need OPPOSITE actions: a take that really
    is shorter than the segment (re-shoot, or probe less), and a container whose timestamps start
    late, where every frame is present and only the operator's in/out are offset (re-muxing or
    subtracting the offset fixes it; a re-shoot costs a shoot day and changes nothing). The old
    message asserted the first one unconditionally. These cases pin that the two never swap, that
    the "thinner than two samples" case is not misfiled as either, and — the fail-loud one — that
    a mute ffprobe yields NEITHER verdict instead of the likelier-sounding story.
    """

    DUR, SHIFT = 5.0, 12.0

    def test_a_take_that_really_IS_short_says_re_shoot(self) -> None:
        msg = mp.coverage_diagnosis(self.DUR, 0.0, 0.0, 9.0, FPS)
        self.assertIn("SHORTER than the segment", msg)
        self.assertIn("or re-shoot it", msg)
        self.assertIn("5.00s", msg)                       # names what the oracle actually read
        self.assertNotIn("timestamps START", msg)         # ... and claims no offset it never saw

    def test_a_SHIFTED_container_is_not_reported_as_a_short_take(self) -> None:  # NEG-CONTROL
        # The false verdict this oracle exists to kill. Measured on a
        # `-output_ts_offset 12` re-mux of a 5s clip: `--in 12.5 --out 16` (the numbers a player
        # shows) decodes NOTHING, while `--in 0.5 --out 4` decodes the right 3.5s. The footage is
        # complete — "re-shoot it" would be a lie with a refusing exit code.
        msg = mp.coverage_diagnosis(self.DUR, self.SHIFT, 12.5, 16.0, FPS)
        self.assertIn("timestamps START at 12.00s", msg)
        self.assertIn("DO NOT", msg)
        self.assertIn("0.5..4", msg)                      # the corrected range, computed for them
        self.assertNotIn("SHORTER than the segment", msg)
        self.assertNotIn("or re-shoot it", msg)

    def test_a_shifted_container_whose_range_STILL_does_not_fit_says_so(self) -> None:  # NEG-CTL
        # The paired control for the sentence above, and the bug it was written against: the
        # message used to print "DO NOT re-shoot: the frames are there" whenever start_time was
        # late, with "though even shifted it does not fit" as a SUBORDINATE CLAUSE in the same
        # sentence — two halves that cannot both be true. 40s of range against 5s of take is a
        # short take that happens to sit in a shifted container: the frames are NOT all there,
        # and the offset is an aside, not the verdict.
        msg = mp.coverage_diagnosis(self.DUR, self.SHIFT, 12.0, 52.0, FPS)
        self.assertIn("SHORTER than the segment", msg)
        self.assertIn("or re-shoot it", msg)
        self.assertNotIn("DO NOT", msg)               # the false absolution
        self.assertNotIn("the frames are there", msg)
        # ... while the offset it DID see stays on the page, demoted to an aside.
        self.assertIn("also STARTS at 12.00s", msg)
        self.assertIn("does not explain", msg)

    def test_a_SMALL_offset_that_explains_nothing_is_an_aside_too(self) -> None:  # NEG-CONTROL
        # The mirror of the case above, and the one magnitude alone gets wrong: 1.4s is far over
        # the dust floor, so a "is start_time big enough to be real?" test promotes it — but
        # 9s of range against 5s of take is still short with the 1.4s subtracted (7.6s). The
        # decision is "does subtracting it account for the shortfall", never "is it large".
        msg = mp.coverage_diagnosis(self.DUR, 1.4, 0.0, 9.0, FPS)
        self.assertIn("SHORTER than the segment", msg)
        self.assertNotIn("DO NOT", msg)
        self.assertIn("also STARTS at 1.40s", msg)
        self.assertIn("7.6s", msg)                    # the shifted edge, still past the take

    def test_an_offset_LARGER_than_the_take_cannot_ABSOLVE_an_overrun(self) -> None:  # NEG-CONTROL
        # NEG-CONTROL — kills the unbounded-below shifted_edge (a 12s offset on a 5s take
        # "fits" -6.0 <= 5.1).
        msg = mp.coverage_diagnosis(self.DUR, self.SHIFT, 0.0, 6.0, FPS)
        self.assertIn("SHORTER than the segment", msg)
        self.assertNotIn("DO NOT", msg)
        self.assertIn("also STARTS at 12.00s", msg)

    def test_the_offset_story_is_taken_EXACTLY_when_the_shift_explains_the_gap(self) -> None:
        # The two verdicts side by side on ONE varying number, so neither can be reached by a
        # branch that ignores the arithmetic: same take, same offset, same in-point — an out of
        # 17.0 lands the shifted range on the take's last second (offset explains it), 18.0 lands
        # it a second past the end (it does not). The sentences must swap at that boundary.
        fits = mp.coverage_diagnosis(self.DUR, self.SHIFT, 12.0, 17.0, FPS)
        self.assertIn("DO NOT", fits)
        self.assertIn("this range becomes 0..5", fits)
        self.assertNotIn("SHORTER than the segment", fits)

        over = mp.coverage_diagnosis(self.DUR, self.SHIFT, 12.0, 18.0, FPS)
        self.assertIn("SHORTER than the segment", over)
        self.assertNotIn("DO NOT", over)

    def test_an_in_point_BELOW_the_container_start_is_not_clamped_into_fiction(self) -> None:
        # The corrected range used to be max(0.0, in - start_time), which for an in-point under
        # the container's own start prints a range the caller never asked about ("0..4") as if
        # it were theirs. Such an in-point cannot have been read off the shifted timeline at all
        # — the honest answer says so instead of inventing one.
        msg = mp.coverage_diagnosis(self.DUR, self.SHIFT, 0.5, 16.0, FPS)
        self.assertIn("timestamps START at 12.00s", msg)
        self.assertIn("BELOW that start", msg)
        self.assertNotIn("this range becomes", msg)   # no manufactured correction
        self.assertNotIn("0..4", msg)

    def test_a_shifted_container_whose_range_FITS_ANYWAY_blames_neither(self) -> None:
        # The residual case with an offset present: 0..4 fits the 5s take without subtracting
        # anything, so the shortfall is neither story — and the message must not claim the
        # container starts "at ~0s" when ffprobe just said 12.00s.
        msg = mp.coverage_diagnosis(self.DUR, self.SHIFT, 0.0, 4.0, FPS)
        self.assertIn("range FITS", msg)
        self.assertIn("starting at 12.00s", msg)
        self.assertNotIn("~0s", msg)
        self.assertNotIn("DO NOT", msg)
        self.assertNotIn("SHORTER than the segment", msg)

    def test_an_open_ended_range_is_diagnosed_on_its_IN_point(self) -> None:
        # `--in` only (no `--out`): the range "reaches" its in-point, and the correction the
        # message offers has to stay open-ended rather than inventing an out.
        msg = mp.coverage_diagnosis(self.DUR, self.SHIFT, 13.0, None, FPS)
        self.assertIn("1..EOF", msg)
        self.assertIn("timestamps START at 12.00s", msg)

    def test_a_MUTE_ffprobe_yields_NEITHER_verdict(self) -> None:  # NEG-CONTROL
        # Fail-loud. With no duration there is no oracle, and guessing "re-shoot" here would
        # reintroduce exactly the false verdict — under a nicer sentence.
        msg = mp.coverage_diagnosis(None, None, 0.0, 9.0, FPS)
        self.assertIn("could not read this file's duration", msg)
        self.assertIn("CANNOT tell", msg)
        self.assertNotIn("SHORTER than the segment", msg)
        self.assertNotIn("re-shoot it", msg)

    def test_an_unknown_start_time_is_HEDGED_not_assumed_to_be_zero(self) -> None:
        # duration known, start_time not: the short-take reading is the honest default, but the
        # message must not pretend the container was checked.
        msg = mp.coverage_diagnosis(self.DUR, None, 0.0, 9.0, FPS)
        self.assertIn("SHORTER than the segment", msg)
        self.assertIn("not fully ruled out", msg)

    def test_a_range_thinner_than_two_samples_is_its_OWN_diagnosis(self) -> None:
        # Neither a short take nor an offset: 0.05s at 10 fps cannot hold two frames, whatever
        # the file is. Misfiling this as "the take is short" would send an operator re-shooting
        # a perfectly good take over a typo in --out.
        msg = mp.coverage_diagnosis(self.DUR, 0.0, 1.0, 1.05, FPS)
        self.assertIn("thinner than the two samples", msg)
        self.assertIn("0.2s", msg)                        # 2/fps, named in the caller's units
        self.assertNotIn("SHORTER than the segment", msg)

    def test_a_range_that_FITS_a_zero_based_take_admits_it_explains_nothing(self) -> None:
        # The residual case: the oracle exonerates both suspects. Saying "re-shoot" here would be
        # a guess; the message has to send the operator at the stream instead.
        msg = mp.coverage_diagnosis(self.DUR, 0.0, 0.0, 4.0, FPS)
        self.assertIn("range FITS", msg)
        self.assertIn("variable-rate", msg)
        self.assertNotIn("SHORTER than the segment", msg)

    def test_a_start_time_UNDER_one_sample_is_not_an_offset(self) -> None:
        # Real containers carry timestamp dust (a first PTS of 0.03s). Treating that as "your
        # in/out are off by 0.03s" would bury the real diagnosis under noise.
        msg = mp.coverage_diagnosis(self.DUR, 1.0 / FPS - 0.01, 0.0, 9.0, FPS)
        self.assertIn("SHORTER than the segment", msg)
        self.assertNotIn("timestamps START", msg)


class ReportTests(unittest.TestCase):
    """The human-facing print path — the only place duty is actually read on a shoot day."""

    @staticmethod
    def rendered(values: list[int] | None, rng: dict | None = None) -> str:
        res = mp.classify([] if values is None else mp.frame_mads(frames(values)),
                          FPS, 1.0, 0.5, 0.5)
        res["meta"] = {"video": "t.mp4", "frames": 0 if values is None else len(values),
                       "fps": FPS, "duration": 0.0, "covered": 0.0, "scale": "192x108",
                       "crop": None, "thresh": 1.0, "bridge": 0.5, "min_live": 0.5}
        if rng is not None:
            res["meta"]["range"] = rng
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            mp.report(res)
        return buf.getvalue()

    def test_the_report_NAMES_the_analysed_range(self) -> None:
        text = self.rendered(alternating(20), {"in": 19.9, "out": 23.4,
                                               "source_duration": 48.95})
        self.assertIn("range 19.9..23.4 of 48.95s", text)
        # ... and says whose seconds the table underneath is in.
        self.assertIn("ABSOLUTE source seconds", text)

    def test_an_open_ended_range_says_EOF_not_a_made_up_number(self) -> None:
        text = self.rendered(alternating(20), {"in": 5.8, "out": None, "source_duration": None})
        self.assertIn("range 5.8..EOF of unknown length", text)

    def test_a_whole_file_report_says_NOTHING_about_a_range(self) -> None:  # NEG-CONTROL
        # Half of "no flags behaves exactly as before": the extra line must not appear at all.
        self.assertNotIn("range", self.rendered(alternating(20)))

    def test_the_report_states_the_duty_overall_and_per_window(self) -> None:
        text = self.rendered(blinks(30))
        self.assertIn("duty  20.1% of samples live (30/149)", text)
        self.assertIn("duty 20.5%", text)      # ... and on the window line

    def test_a_report_over_NOTHING_says_n_a_rather_than_crashing(self) -> None:  # NEG-CONTROL
        # The empty-series result has duty None and no windows: the format path must survive the
        # one shape a probe that measured nothing produces (a report that raises tells the
        # operator nothing at all).
        text = self.rendered(None)
        self.assertIn("duty  n/a of samples live (0/0)", text)
        self.assertIn("live windows: NONE", text)

    def test_a_ZERO_COVERAGE_range_report_admits_it_differenced_NOTHING(self) -> None:
        # covered == 0.0 with a RANGE — the shape a used-range wholly past EOF would produce, and
        # the one arithmetic path in the header that reads `covered` (diff_end = in + covered).
        # The line must collapse to a zero-width interval and say n/a, not print "differenced
        # 19.9..23.4" as though the segment had been measured. Two failure modes it pins at once:
        # a crash (an operator learns nothing) and a confident-looking header over no data.
        text = self.rendered(None, {"in": 19.9, "out": 23.4, "source_duration": 48.95})
        self.assertIn("range 19.9..23.4 of 48.95s (differenced 19.9..19.9)", text)
        self.assertIn("duty  n/a of samples live (0/0)", text)
        self.assertIn("live windows: NONE", text)
        self.assertIn("static runs: none", text)

    def test_the_ZERO_COVERAGE_result_REFUSES_at_every_budget(self) -> None:  # NEG-CONTROL
        # The pair to the case above: nothing measured is never a verdict, whatever the report
        # managed to print. Zero coverage over a range is the most dangerous shape there is —
        # "no static runs found" out of it would be a GATE OK about a segment nobody saw. Note
        # this is defence in depth rather than a live path: decode() refuses below two frames, so
        # the CLI cannot hand the classifier an empty series today. It is pinned so that it stays
        # a refusal if some later caller ever can.
        res = mp.shift_times(mp.classify([], FPS, 1.0, 0.5, 0.5), 19.9)
        self.assertEqual(res["samples"], 0)
        for budget in (None, 0.0, 1.0, 100.0):
            with self.subTest(max_static=budget):
                status, verdict, longest = mp.gate_verdict(res, budget)
                self.assertEqual(status, "refuse")
                self.assertIn("0 frame differences measured", verdict)
                self.assertEqual(longest, 0.0)


class StatsAndEdgeTests(unittest.TestCase):
    def test_stats_describe_the_mad_series(self) -> None:
        res = mp.classify([0.0, 1.0, 2.0, 3.0, 100.0], FPS, 1.0, 0.5, 0.5)
        s = res["stats"]
        self.assertEqual((s["min"], s["max"]), (0.0, 100.0))
        self.assertEqual(s["median"], 2.0)
        self.assertEqual(s["p90"], 100.0)  # nearest-rank over 5 samples

    def test_an_empty_series_REFUSES_rather_than_reporting_a_clean_take(self) -> None:
        # NEG-CONTROL for the most dangerous shape of all: no data at all. "No static runs
        # found" out of zero measurements would be a GATE OK nobody could argue with.
        res = mp.classify([], FPS, 1.0, 0.5, 0.5)
        self.assertEqual(res["samples"], 0)
        self.assertEqual(res["windows"], [])
        self.assertEqual(res["static_runs"], [])
        self.assertIsNone(res["longest_static"])
        for budget in (None, 0.0, 100.0):
            with self.subTest(max_static=budget):
                status, verdict, _ = mp.gate_verdict(res, budget)
                self.assertEqual(status, "refuse")
                self.assertIn("REFUSED", verdict)

    def test_a_non_positive_fps_is_REFUSED_not_silently_zeroed(self) -> None:  # NEG-CONTROL
        # It used to fall back to span 0.0, which reports "no static runs" — i.e. a clean bill
        # of health computed from a nonsense timebase.
        for bad in (0.0, -10.0):
            with self.subTest(fps=bad), self.assertRaises(ValueError):
                mp.classify([0.0, 5.0], bad, 1.0, 0.5, 0.5)


class ArgParsingTests(unittest.TestCase):
    def test_scale_and_crop_parse(self) -> None:
        self.assertEqual(mp.parse_scale("192x108"), (192, 108))
        # Crop is in SOURCE pixels and reaches ffmpeg as crop=W:H:X:Y — order matters.
        self.assertEqual(mp.parse_crop("780,420,360x360"), (780, 420, 360, 360))

    def test_a_malformed_crop_dies_LOUDLY(self) -> None:  # NEG-CONTROL
        # Never guess: a silently-defaulted crop probes the wrong pixels and reports the
        # wrong verdict about the bot with full confidence.
        for bad in ("360x360", "780,420", "780,420,0x360", "-1,0,10x10", "a,b,cxd"):
            with self.subTest(bad=bad), self.assertRaises(SystemExit) as cm:
                mp.parse_crop(bad)
            self.assertEqual(cm.exception.code, 2)

    def test_a_malformed_scale_dies_LOUDLY(self) -> None:  # NEG-CONTROL
        for bad in ("192", "192x0", "x108"):
            with self.subTest(bad=bad), self.assertRaises(SystemExit) as cm:
                mp.parse_scale(bad)
            self.assertEqual(cm.exception.code, 2)

    def test_a_gate_defeating_threshold_is_REFUSED(self) -> None:  # NEG-CONTROL
        # --thresh 0 marks every frame live (MAD >= 0 always), so a frozen take reports 100 %
        # live and --max-static can never fail. Rejected at the CLI, before any decoding: an
        # unfalsifiable gate is worse than no gate, because it reports GATE OK.
        #
        # The TEXT is what makes this case load-bearing, not the exit code. `v.mp4` does not
        # exist, so an implementation with these guards CUT OUT would still exit 2 — just from
        # decode()'s "no such video" one layer down. Exit-code-only assertions are therefore
        # vacuous here: they pass whether or not the validation exists. Match the message.
        for bad, needle in ((["v.mp4", "--thresh", "0"], "--thresh must be positive"),
                            (["v.mp4", "--thresh", "-1"], "--thresh must be positive"),
                            (["v.mp4", "--fps", "0"], "--fps must be positive"),
                            (["v.mp4", "--bridge", "-0.5"], "--bridge must not be negative"),
                            (["v.mp4", "--min-live", "-1"], "--min-live must not be negative")):
            err = io.StringIO()
            with self.subTest(argv=bad), self.assertRaises(SystemExit) as cm, \
                    contextlib.redirect_stderr(err):
                mp.main(bad)
            self.assertEqual(cm.exception.code, 2)
            self.assertIn(needle, err.getvalue())


class NonFiniteLumaTests(unittest.TestCase):
    def test_a_non_finite_min_luma_is_REFUSED(self) -> None:  # NEG-CONTROL
        # `nan` compares False both ways, so `mean < nan` never fails a black take. The message
        # is what is load-bearing: v.mp4 does not exist, so without the guard the probe still
        # exits 2 — from decode()'s "no such video".
        for value in ("nan", "inf"):
            with self.subTest(value=value):
                err = io.StringIO()
                with self.assertRaises(SystemExit) as cm, contextlib.redirect_stderr(err):
                    mp.main(["v.mp4", "--min-luma", value])
                self.assertEqual(cm.exception.code, 2)
                self.assertIn("--min-luma must be a finite number", err.getvalue())


class PresetCoverageTests(unittest.TestCase):
    """A preset must carry EVERY knob that changes what is measured — the framing included.

    The finding this pins: static-hook carried fps/scale/thresh/bridge/min-live/min-windows but
    not `crop`, so a --crop ran silently off-calibration. The class of bug is "a measurement knob
    the preset forgot", so the check is structural: every parser option is either a calibration
    knob (and then every preset carries it) or one of the REPORTING options named here.
    """

    # Where to look and how to report — they never change what a MAD means. `min_luma` gates
    # brightness, a separate axis from motion, so no motion preset has to carry it.
    REPORTING = frozenset({"help", "video", "in_s", "out_s", "max_static", "min_luma", "preset",
                           "json"})

    @staticmethod
    def uncovered(preset: dict) -> set[str]:
        return set(mp.CALIBRATION_KNOBS) - set(preset)

    def test_every_parser_option_is_CLASSIFIED(self) -> None:
        # A new knob added to the parser without a decision fails HERE, not on a shoot day.
        dests = {a.dest for a in mp.build_parser()._actions}
        self.assertEqual(dests - self.REPORTING, set(mp.CALIBRATION_KNOBS))

    def test_every_preset_carries_every_calibration_knob(self) -> None:
        for name, preset in mp.PRESETS.items():
            with self.subTest(preset=name):
                self.assertEqual(self.uncovered(preset), set())
                self.assertEqual(set(preset) - set(mp.CALIBRATION_KNOBS), set())

    def test_a_preset_WITHOUT_its_framing_is_caught(self) -> None:  # NEG-CONTROL
        # The pre-fix shape of static-hook: every knob but crop. The check must name it.
        pre_fix = {k: v for k, v in mp.PRESETS["static-hook"].items() if k != "crop"}
        self.assertEqual(self.uncovered(pre_fix), {"crop"})

    def test_framing_is_a_calibration_knob_that_REFUSES(self) -> None:
        self.assertLessEqual(set(mp.FRAMING_KNOBS), set(mp.CALIBRATION_KNOBS))
        self.assertIn("crop", mp.FRAMING_KNOBS)
        self.assertIsNone(mp.PRESETS["static-hook"]["crop"])      # calibrated FULL FRAME


HOOK = mp.PRESETS["static-hook"]


def hook_classify(mads: list[float], **over: float) -> dict:
    """classify() under the static-hook preset's knobs (any of them overridable per case)."""
    knobs = {"fps": float(HOOK["fps"]), "thresh": float(HOOK["thresh"]),
             "bridge_s": float(HOOK["bridge"]), "min_live_s": float(HOOK["min_live"]), **over}
    return mp.classify(mads, knobs["fps"], knobs["thresh"], knobs["bridge_s"], knobs["min_live_s"])


def hook_gate(result: dict) -> str:
    return mp.gate_verdict(result, None, int(HOOK["min_windows"]))[0]


# The REAL take's MAD series — 01_clutch.mp4, full frame, 10 fps 192x108, samples 3.2..5.1
# (the cut's 3.2-5.3), measured. A fixture off live footage varies on the axes the live
# data does: a noise floor that is not 0, an event that ramps up and down instead of saturating.
REAL_HOOK_MADS = [0.007, 0.010, 0.008, 0.009, 0.008, 0.095, 0.704, 0.888, 0.558, 0.135,
                  0.022, 0.015, 0.013, 0.013, 0.013, 0.010, 0.011, 0.010, 0.009, 0.010]
# The same take's dead tail around its loudest isolated noise sample (8.2 s, MAD 0.094) — the
# ceiling of what dead static footage was measured to produce.
REAL_DEAD_MADS = [0.011, 0.010, 0.012, 0.011, 0.009, 0.094, 0.011, 0.010, 0.013, 0.011,
                  0.012, 0.010, 0.011, 0.009, 0.010, 0.011, 0.012, 0.010, 0.011, 0.010]


class StaticHookPresetTests(unittest.TestCase):
    """`--preset static-hook` on the pure core: the real hook passes, every dead shape fails.

    The preset's two numbers each get a known-good that a mutation in one direction breaks and a
    known-bad that a mutation in the other direction breaks: STATIC_HOOK_THRESH raised past the
    event's SECOND-loudest sample (0.704) loses the real hook, lowered to the noise ceiling (~0.094) lets
    a flicker through; STATIC_HOOK_MIN_LIVE raised to the default 0.5 loses the hook, lowered to
    one sample lets an isolated spike through. STATIC_HOOK_MIN_WINDOWS dropped makes every
    known-bad pass.
    """

    def test_the_DEFAULTS_are_blind_to_the_real_hook(self) -> None:
        # The bug this preset exists for, pinned so it cannot be quietly "fixed" by moving a
        # default instead: a real event, 0 windows.
        res = mp.classify(REAL_HOOK_MADS, FPS, mp.DEFAULT_THRESH, mp.DEFAULT_BRIDGE,
                          mp.DEFAULT_MIN_LIVE)
        self.assertEqual(res["windows"], [])

    def test_the_old_footnote_thresh_ALONE_still_finds_nothing(self) -> None:
        # `--thresh 0.3` was the whole recipe the doc footnote gave — and it reads 3 live
        # samples (15 % duty) but 0 windows: 0.3 s of motion under the default 0.5 s min-live.
        res = mp.classify(REAL_HOOK_MADS, FPS, 0.3, mp.DEFAULT_BRIDGE, mp.DEFAULT_MIN_LIVE)
        self.assertEqual(res["duty"]["live_samples"], 3)
        self.assertEqual(res["windows"], [])

    def test_the_preset_finds_EXACTLY_the_event_and_passes(self) -> None:
        res = mp.shift_times(hook_classify(REAL_HOOK_MADS), 3.2)
        self.assertEqual(res["windows"], [(3.8, 4.1)])   # the 0.704/0.888/0.558 samples
        self.assertEqual(hook_gate(res), "ok")

    def test_the_real_DEAD_tail_FAILS(self) -> None:  # NEG-CONTROL
        res = hook_classify(REAL_DEAD_MADS)
        self.assertEqual(res["windows"], [])
        self.assertEqual(hook_gate(res), "fail")

    def test_a_FROZEN_take_FAILS(self) -> None:  # NEG-CONTROL
        self.assertEqual(hook_gate(hook_classify([0.0] * 20)), "fail")

    def test_ONE_isolated_spike_is_not_an_event(self) -> None:  # NEG-CONTROL (pins min-live)
        # Far above the threshold, but one sample: a single step change in dead footage.
        mads = [0.01] * 10 + [1.5] + [0.01] * 9
        self.assertEqual(hook_gate(hook_classify(mads)), "fail")
        # ... and the knob it pins: at a one-sample min-live the same spike WOULD pass.
        self.assertEqual(hook_gate(hook_classify(mads, min_live_s=0.1)), "ok")

    def test_a_flicker_at_the_NOISE_CEILING_is_not_an_event(self) -> None:  # NEG-CONTROL
        # Sustained, every sample, at the loudest dead-footage level measured — pins the
        # threshold ABOVE the noise: a threshold at the noise ceiling makes this pass.
        mads = [0.0945] * 20
        self.assertEqual(hook_gate(hook_classify(mads)), "fail")
        self.assertEqual(hook_gate(hook_classify(mads, thresh=0.09)), "ok")

    def test_the_default_min_live_would_LOSE_the_real_hook(self) -> None:  # the knob, other way
        self.assertEqual(hook_gate(hook_classify(REAL_HOOK_MADS, min_live_s=0.5)), "fail")

    def test_a_threshold_above_the_events_SECOND_sample_loses_it(self) -> None:
        self.assertEqual(hook_gate(hook_classify(REAL_HOOK_MADS, thresh=0.75)), "fail")

    def test_the_preset_is_pinned_at_its_OWN_calibration_not_the_defaults(self) -> None:
        # A DEFAULT_* moving must not drag the preset along: it was measured at these.
        self.assertEqual((HOOK["fps"], HOOK["scale"], HOOK["bridge"]), (10, "192x108", 0.5))
        self.assertEqual((HOOK["thresh"], HOOK["min_live"], HOOK["min_windows"]), (0.3, 0.2, 1))


class MinWindowsGateTests(unittest.TestCase):
    """`gate_verdict`'s second gate, and that adding it moved nothing about the first."""

    LIVE = run(alternating(30))          # one window over the whole take
    DEAD = run([100] * 30)               # no window, one 2.9s static run

    def test_too_few_windows_FAILS_by_name(self) -> None:  # NEG-CONTROL
        status, verdict, _ = mp.gate_verdict(self.DEAD, None, 1)
        self.assertEqual(status, "fail")
        self.assertEqual(verdict, "GATE FAIL: 0 live window(s) < 1 required — nothing in this "
                                  "range held motion long enough to count as an event")

    def test_enough_windows_pass(self) -> None:
        self.assertEqual(mp.gate_verdict(self.LIVE, None, 1)[:2], ("ok", "GATE OK"))

    def test_both_gates_failing_report_BOTH(self) -> None:
        status, verdict, _ = mp.gate_verdict(self.DEAD, 1.0, 1)
        self.assertEqual(status, "fail")
        self.assertEqual(verdict.count("GATE FAIL"), 2, verdict)

    def test_the_max_static_verdict_is_UNCHANGED_without_min_windows(self) -> None:  # NEG-CONTROL
        # The exact line every earlier caller parsed, and report-only still reports only.
        self.assertEqual(mp.gate_verdict(self.DEAD, 1.0)[:2],
                         ("fail", "GATE FAIL: longest static run 2.9s (0.0..2.9) > 1s"))
        self.assertEqual(mp.gate_verdict(self.DEAD, None)[:2], ("ok", ""))

    def test_an_empty_series_still_REFUSES_under_min_windows(self) -> None:  # NEG-CONTROL
        self.assertEqual(mp.gate_verdict(run([7]), None, 1)[0], "refuse")

    def test_a_min_windows_of_ZERO_is_REFUSED_at_the_CLI(self) -> None:  # NEG-CONTROL
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stderr(io.StringIO()) as err:
            mp.main(["whatever.mp4", "--min-windows", "0"])
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("--min-windows", err.getvalue())

    def test_an_unknown_preset_is_an_ARGPARSE_error(self) -> None:  # NEG-CONTROL
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stderr(io.StringIO()):
            mp.main(["whatever.mp4", "--preset", "nope"])
        self.assertEqual(cm.exception.code, 2)


class LumaGateTests(unittest.TestCase):
    """`--min-luma`: a black take (valid file, every frame at the black level) must FAIL, and a
    black take that MOVES is still black — brightness and motion are separate axes."""

    @staticmethod
    def with_luma(values: list[int]) -> dict:
        res = run(values)
        res["luma"] = mp.frame_luma(frames(values))
        return res

    def test_luma_is_min_mean_max_of_the_frame_means(self) -> None:
        self.assertEqual(mp.frame_luma([flat(16), flat(100), flat(40)]),
                         {"min": 16.0, "mean": 52.0, "max": 100.0})
        self.assertEqual(mp.frame_luma([bytes([0, 255])]), {"min": 127.5, "mean": 127.5, "max": 127.5})

    def test_no_frames_is_an_error_not_a_dark_take(self) -> None:  # NEG-CONTROL
        with self.assertRaisesRegex(ValueError, "frame_luma: no frames"):
            mp.frame_luma([])

    def test_a_black_take_FAILS_by_name(self) -> None:  # NEG-CONTROL
        status, verdict, _ = mp.gate_verdict(self.with_luma([16] * 30), None, None, 30)
        self.assertEqual(status, "fail")
        self.assertIn("mean luma 16.0 < 30", verdict)

    def test_a_black_take_that_moves_still_FAILS(self) -> None:  # NEG-CONTROL: motion ≠ picture
        res = self.with_luma([16, 18] * 15)  # MAD 2 every frame: live, but black
        self.assertEqual(mp.gate_verdict(res, 1.0)[0], "ok")
        self.assertEqual(mp.gate_verdict(res, 1.0, None, 30)[0], "fail")

    def test_a_lit_take_passes(self) -> None:  # positive control
        self.assertEqual(mp.gate_verdict(self.with_luma([90, 120] * 15), None, None, 30)[:2],
                         ("ok", "GATE OK"))

    def test_a_mean_exactly_at_the_bound_passes(self) -> None:  # the bound is the lowest mean that passes
        self.assertEqual(mp.gate_verdict(self.with_luma([30] * 30), None, None, 30)[0], "ok")
        self.assertEqual(mp.gate_verdict(self.with_luma([29] * 30), None, None, 30)[0], "fail")

    def test_min_luma_without_a_measurement_REFUSES(self) -> None:  # NEG-CONTROL
        self.assertEqual(mp.gate_verdict(run([90, 120] * 15), None, None, 30)[0], "refuse")

    def test_the_other_verdicts_are_UNCHANGED_without_min_luma(self) -> None:
        dead = self.with_luma([100] * 30)
        self.assertEqual(mp.gate_verdict(dead, 1.0)[:2],
                         ("fail", "GATE FAIL: longest static run 2.9s (0.0..2.9) > 1s"))
        self.assertEqual(mp.gate_verdict(dead, None)[:2], ("ok", ""))


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not on PATH (dev shell provides it)")
class EndToEndTests(unittest.TestCase):
    """The real pipeline — ffmpeg decode included — on clips whose truth we synthesised.

    Everything above drives the pure core; these cases are what proves the ffmpeg invocation
    (filter order, raw-frame slicing, exit codes) matches it. `main()` is called IN-PROCESS
    with an argv list rather than through a subprocess, so the exit code under test is the one
    the CLI actually returns.
    """

    tmp: Path
    frozen_mid: Path
    half_dead: Path
    one_frame: Path

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp())
        # A: 2s of motion, then 3s frozen — the temporal case the gate exists for.
        cls.frozen_mid = cls._ffmpeg([
            "-f", "lavfi", "-i", "testsrc=size=320x180:rate=30:duration=2",
            "-f", "lavfi", "-i", "color=c=gray:size=320x180:rate=30:duration=3",
            "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]",
        ], "live_freeze.mp4")
        # B: left half static black, right half moving — the case ONLY --crop can see.
        cls.half_dead = cls._ffmpeg([
            "-f", "lavfi", "-i", "color=c=black:size=320x180:rate=30:duration=5",
            "-f", "lavfi", "-i", "testsrc=size=160x180:rate=30:duration=5",
            "-filter_complex", "[0:v][1:v]overlay=x=160:y=0[v]", "-map", "[v]",
        ], "half_dead.mp4")
        # C: a single frame — nothing to difference, so the probe must refuse to certify it.
        cls.one_frame = cls._ffmpeg(["-f", "lavfi", "-i",
                                     "testsrc=size=320x180:rate=30:duration=1",
                                     "-frames:v", "1"], "one_frame.mp4")

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp, ignore_errors=True)

    # ── fixtures D/E/F are built LAZILY ─────────────────────────────────────────────────
    #
    # A/B/C are synthesised up front because nearly every case needs them. D (lossless ffv1)
    # and the E/F re-muxes (`-output_ts_offset`) lean on ffmpeg features the plain x264 clips do
    # not, so an ffmpeg that cannot produce one of THEM must take down only the handful of cases
    # that read it. Built in setUpClass they would raise out of the fixture and mark all 24 cases
    # of this class skipped — a gate run that prints "OK (skipped=24)" while the 20 x264
    # cases were never executed. Cached by filename, so each is synthesised at most once.

    @property
    def golden(self) -> Path:
        """D, THE GOLDEN: 3s of a full-swing flicker, then 2s frozen.

        Built so every number the pipeline produces is arithmetic rather than an encoder's
        opinion, because the scalars in the golden cases are pinned as LITERALS:

          * LOSSLESS ffv1, so no x264 build ever moves a pixel;
          * UNIFORM frames (geq writes a flat luma), so the 320x180 -> 192x108 downscale is
            exact and swscale cannot drift the MAD by a thousandth;
          * limited-range luma 16 and 235, which map to full-range gray 0 and 255 EXACTLY, so
            the range conversion dithers nothing (levels 40/200 measured 186.0093 with a
            fractional tail — dither — and were rejected for that);
          * the level toggles at 0.05, 0.15, … — HALFWAY between the probe's 10 fps sample
            points, so no sample sits on a boundary and the alternation cannot alias.

        Result: 30 MADs of exactly 255.0 then 19 of exactly 0.0 (verified).
        """
        return self._ffmpeg([
            "-f", "lavfi", "-i",
            "color=c=black:s=320x180:r=30:d=3,format=yuv420p,"
            "geq=lum='if(eq(mod(floor(T*10+0.5),2),0),16,235)':cb=128:cr=128",
            "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=2",
            "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]", "-map", "[v]",
        ], "golden.mkv", codec="ffv1")

    @property
    def shifted(self) -> Path:
        """E: the SAME 5s of footage re-muxed so its timestamps start at 12s.

        A container whose player timeline (12..17) and media seconds (0..5) disagree by MORE
        than the take is long — so the numbers an operator reads off a player decode NOTHING.
        Nothing is missing from the file; that is the whole point.
        """
        return self._ffmpeg(["-i", str(self.golden), "-output_ts_offset", "12"], "shifted.mp4")

    @property
    def shifted_small(self) -> Path:
        """F: the same re-mux with a 1s offset — the shift that still leaves frames to decode.

        E's 12s offset puts every player-timeline range past the end of a 5s take, so it can
        only ever reach the "fewer than two frames" refusal. A 1s offset is the other half: a
        range read off its player (1..6) decodes the 4s that exist and falls short of the 5s it
        asked for, which is the COVERAGE refusal — the one branch E cannot exercise.
        """
        return self._ffmpeg(["-i", str(self.golden), "-output_ts_offset", "1"], "shifted_1s.mp4")

    @classmethod
    def _ffmpeg(cls, args: list[str], name: str, codec: str = "libx264") -> Path:
        """Synthesise `name` under the class tmpdir once; a failure here is an ERROR, not a skip.

        The class is already skipped wholesale when ffmpeg is off PATH, so by the time this runs
        ffmpeg EXISTS and could not build the clip — a real failure of the environment the gate
        depends on. Skipping it instead would hide a broken fixture behind a green "OK".
        """
        out = cls.tmp / name
        if out.is_file():
            return out
        r = subprocess.run(["ffmpeg", "-v", "error", "-y", *args,
                            "-c:v", codec, "-pix_fmt", "yuv420p", str(out)],
                           capture_output=True, text=True, check=False)
        if r.returncode != 0 or not out.is_file():
            raise RuntimeError(f"could not synthesise {name} with the ffmpeg on PATH: "
                               f"{r.stderr.strip()}")
        return out

    def probe(self, *argv: str) -> tuple[int, dict]:
        """Run the CLI in-process, returning (exit code, the --json result)."""
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            rc = mp.main([*argv, "--json"])
        return rc, json.loads(buf.getvalue())

    def test_min_luma_fails_a_black_take_through_the_CLI(self) -> None:  # NEG-CONTROL
        # The flag's whole path: argparse -> the luma measurement -> gate_verdict -> exit code.
        black = self._ffmpeg(["-f", "lavfi", "-i", "color=c=black:size=320x180:rate=30:duration=2"],
                             "black.mp4")
        rc, res = self.probe(str(black), "--min-luma", "30")
        self.assertEqual(rc, 1, res)
        self.assertLess(res["luma"]["mean"], 30)

    def test_min_luma_passes_a_lit_take_through_the_CLI(self) -> None:  # positive control
        rc, res = self.probe(str(self.frozen_mid), "--min-luma", "30")
        self.assertEqual(rc, 0, res)
        self.assertGreaterEqual(res["luma"]["mean"], 30)

    def test_a_take_with_a_3s_freeze_FAILS_a_1s_gate(self) -> None:
        rc, res = self.probe(str(self.frozen_mid), "--max-static", "1.0")
        self.assertEqual(rc, 1)
        self.assertEqual(res["gate"]["status"], "fail")
        # The freeze is the last ~3s of a 5s clip; allow slack for the encoder's first
        # gray frame still carrying motion.
        self.assertGreater(res["gate"]["longest_static_s"], 2.0)
        self.assertLess(res["gate"]["longest_static_s"], 3.5)

    def test_the_same_take_passes_a_budget_that_admits_the_freeze(self) -> None:
        rc, res = self.probe(str(self.frozen_mid), "--max-static", "5.0")
        self.assertEqual(rc, 0)
        self.assertEqual(res["gate"]["status"], "ok")

    def test_the_CROP_run_changes_the_verdict_on_the_SAME_clip(self) -> None:
        # THE reason two runs are prescribed, on one clip whose halves are known: left half
        # dead black, right half moving. Averaging over the whole frame DILUTES the moving half
        # below the threshold, so the full-frame run condemns a clip whose subject is plainly
        # alive; cropping to the subject clears it. The mirror holds too — cropping to the dead
        # half is the only framing that can prove a region never moved. Neither run is the
        # answer on its own, which is exactly why RIG.md prescribes both.
        rc_full, res_full = self.probe(str(self.half_dead), "--max-static", "1.5")
        rc_live, res_live = self.probe(str(self.half_dead), "--crop", "160,0,160x180",
                                       "--max-static", "1.5")
        rc_dead, res_dead = self.probe(str(self.half_dead), "--crop", "0,0,160x180",
                                       "--max-static", "1.5")

        self.assertEqual(rc_live, 0, "a crop over the moving half must PASS")
        self.assertEqual(res_live["gate"]["status"], "ok")

        self.assertEqual(rc_dead, 1, "a crop over the black half must FAIL")
        self.assertGreater(res_dead["gate"]["longest_static_s"], 4.0)
        # Not exactly 0.0: x264 ringing from the moving half bleeds a few thousandths across
        # the boundary. That IS the shader-noise phenomenon in miniature — real, and two
        # orders of magnitude under the threshold.
        self.assertLess(res_dead["stats"]["max"], 0.01, "black half must read as static")

        self.assertEqual(rc_full, 1, "diluted over the whole frame the motion falls under thresh")
        self.assertLess(res_full["stats"]["max"], res_live["stats"]["max"],
                        "the full frame must read WEAKER than the crop on the same motion")

    def test_a_single_frame_take_is_REFUSED(self) -> None:  # NEG-CONTROL
        with self.assertRaises(SystemExit) as cm, \
                contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            mp.main([str(self.one_frame), "--max-static", "10"])
        self.assertEqual(cm.exception.code, 2)  # never a cheerful GATE OK

    def test_a_missing_file_dies_before_anything_else(self) -> None:  # NEG-CONTROL
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stderr(io.StringIO()):
            mp.main([str(self.tmp / "nope.mp4")])
        self.assertEqual(cm.exception.code, 2)

    # ── --in / --out over the real decode ───────────────────────────────────────────────
    #
    # `frozen_mid` is 2s of testsrc motion followed by 3s of flat gray, so its truth is known
    # per SOURCE second — which is what makes it the fixture that can catch a lost offset.

    def test_the_range_bounds_reach_ffmpeg_EXACTLY(self) -> None:
        # Version canary. The seek is `-ss`/`-to` BEFORE `-i` with `-accurate_seek`, which makes
        # `-to` an absolute source timestamp and anchors the fps grid at `--in`; [1.0, 3.0) at
        # 10 fps is therefore exactly 20 samples. A keyframe-rounded seek, or an ffmpeg that
        # reinterprets `-to` as a duration, changes this count — and every timestamp the probe
        # prints with it — so it must fail loudly here rather than drift in a report.
        _rc, res = self.probe(str(self.frozen_mid), "--in", "1.0", "--out", "3.0")
        self.assertEqual(res["meta"]["frames"], 20)
        rng = res["meta"]["range"]
        self.assertEqual((rng["in"], rng["out"]), (1.0, 3.0))
        self.assertAlmostEqual(rng["source_duration"], 5.0, delta=0.2)

    def test_a_freeze_is_located_in_SOURCE_seconds_under_an_in_point(self) -> None:
        # THE offset case, end to end. The freeze starts at source ~2.0s; probed from --in 1.0
        # the classifier sees it 1.0s into its own series, so a report that forgot +in would
        # place it at ~1.0 — a second that, in this clip, is plainly moving.
        rc, res = self.probe(str(self.frozen_mid), "--in", "1.0", "--max-static", "1.0")
        self.assertEqual(rc, 1)
        start, end = res["longest_static"]
        self.assertGreater(start, 1.5, "the freeze must be reported where it is in the SOURCE")
        self.assertLess(start, 2.5)
        self.assertAlmostEqual(end, 4.9, delta=0.2)   # the decode ends with the 5s clip
        # ... and every window it does report is on the same timeline.
        self.assertTrue(all(a >= 1.0 - 1e-6 for a, _ in res["windows"]), res["windows"])

    def test_an_in_out_over_the_LIVE_half_passes_a_gate_the_whole_file_FAILS(self) -> None:
        # The positive: same clip, same budget, and the range is the only thing that moves.
        rc_all, _ = self.probe(str(self.frozen_mid), "--max-static", "1.0")
        rc_cut, res = self.probe(str(self.frozen_mid), "--out", "1.8", "--max-static", "1.0")
        self.assertEqual(rc_all, 1, "the whole file carries the 3s freeze")
        self.assertEqual(rc_cut, 0, "the used range does not")
        # `--out` alone still reports the range it measured, with the implicit in=0.
        self.assertEqual((res["meta"]["range"]["in"], res["meta"]["range"]["out"]), (0.0, 1.8))

    def test_NO_range_flags_is_bit_identical_to_the_old_whole_file_run(self) -> None:  # NEG-CTL
        # Every duty/static number recorded in docs/RIG.md was measured by the whole-file path.
        # If adding --in/--out perturbs it — an always-applied offset, a stray seek option, an
        # extra meta key — that band silently stops being reproducible. So: the no-flag result
        # must equal the pre-change pipeline (decode -> frame_mads -> classify) exactly, and
        # carry no `range` at all.
        _rc, res = self.probe(str(self.frozen_mid))
        expected = mp.classify(mp.frame_mads(mp.decode(self.frozen_mid, mp.DEFAULT_FPS,
                                                       mp.parse_scale(mp.DEFAULT_SCALE), None)),
                               mp.DEFAULT_FPS, mp.DEFAULT_THRESH,
                               mp.DEFAULT_BRIDGE, mp.DEFAULT_MIN_LIVE)
        # json.loads gives lists where classify() builds tuples — normalise, compare everything.
        self.assertEqual({k: res[k] for k in expected},
                         json.loads(json.dumps(expected)))
        self.assertNotIn("range", res["meta"])

    def test_a_range_PAST_THE_END_refuses_rather_than_measuring_what_is_there(self) -> None:
        # NEG-CONTROL. A clamp to "the last frames of the file" would answer a question nobody
        # asked, with exit 0. The probe must decline: it saw nothing of the requested segment.
        # The exit code alone cannot say that — ffmpeg failing on its own, or the file going
        # missing, exits 2 as well — so match OUR message and the range it names. Both cases
        # decode 0 frames, so they die on the "at least 2" floor rather than the coverage check
        # below it; that ordering is deliberate (the more specific message wins).
        for argv in ([str(self.frozen_mid), "--in", "60", "--max-static", "10"],
                     [str(self.frozen_mid), "--in", "60", "--out", "65"]):
            err = io.StringIO()
            with self.subTest(argv=argv), self.assertRaises(SystemExit) as cm, \
                    contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(err):
                mp.main(argv)
            self.assertEqual(cm.exception.code, 2)   # never a cheerful GATE OK
            self.assertIn("--in 60", err.getvalue())          # names the range it could not fill
            self.assertIn("at least 2 to measure motion", err.getvalue())

    def test_a_range_that_only_PARTLY_fits_the_take_is_REFUSED(self) -> None:  # NEG-CONTROL
        # The hole `count >= 2` leaves wide open, and the one a past-the-end case cannot reach.
        # This clip is 5s, so `--out 9.0` still decodes 50 REAL frames — plenty to difference —
        # and before the coverage check the probe answered a 9s question with a duty, a 2.9s
        # longest static run and GATE OK measured over 4.9s (verified on this fixture:
        # exit 0, frames 50, covered 4.9). That is the same lie a clamp tells, just one layer
        # further down: a cut list asking about 0..9 gets a confident verdict about 0..4.9.
        err = io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(err):
            mp.main([str(self.frozen_mid), "--out", "9.0", "--max-static", "10"])
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("--out 9", err.getvalue())     # the message names the range it could not fill
        self.assertIn("SHORTER than the segment", err.getvalue())

    def test_the_coverage_check_does_not_refuse_a_range_the_take_REALLY_HAS(self) -> None:
        # The paired control for the case above — without it the check could be a blanket
        # "any --out refuses" and the neg-control would still be green. Same clip, a range that
        # fits, and the fractional bounds where ffmpeg's fps grid is least tidy: all must pass.
        # (The slack is one frame, measured: over ranges fully inside a file, across fps
        # 3/5/10/24, the worst shortfall against ceil((out-in)*fps) was exactly 1.)
        for in_s, out_s in (("0", "4.9"), ("0.33", "4.95"), ("2.37", "5.0"), ("0.07", "4.83")):
            with self.subTest(in_s=in_s, out_s=out_s):
                rc, res = self.probe(str(self.frozen_mid), "--in", in_s, "--out", out_s,
                                     "--max-static", "10")
                self.assertEqual(rc, 0)
                self.assertGreater(res["meta"]["frames"], 2)

    def test_a_FRACTIONAL_in_point_anchors_the_fps_GRID_at_the_in_point(self) -> None:
        # NEG-CONTROL for the INPUT-side seek. Every other range case here uses `--in 1.0`, a
        # whole multiple of 1/fps — and at such a point an input-side and an output-side seek are
        # bit-identical, as decode()'s own docstring says. So none of them can catch `-ss/-to`
        # drifting after `-i`: moving it there (and dropping -accurate_seek) leaves the ENTIRE
        # suite green, verified by mutation. A fractional in-point separates the two.
        # Measured on this fixture: input-side `--in 1.05 --out 3.05` decodes 20 frames and puts
        # the freeze onset at 2.05; the output-side form (grid anchored at source 0, head dropped
        # afterwards) decodes 19 and reports the onset a whole sample early, at 1.95 — one bucket
        # of lie in every timestamp the probe prints, on a take whose truth is known per second.
        _rc, res = self.probe(str(self.frozen_mid), "--in", "1.05", "--out", "3.05")
        self.assertEqual(res["meta"]["frames"], 20)                  # 19 output-side
        self.assertAlmostEqual(res["meta"]["covered"], 1.9, places=6)
        (w_start, w_end), = res["windows"]
        self.assertAlmostEqual(w_start, 1.35, delta=1e-6)
        self.assertAlmostEqual(w_end, 2.05, delta=1e-6)              # 1.95 output-side
        self.assertAlmostEqual(res["longest_static"][0], 2.05, delta=1e-6)
        # ... and every boundary sits on the `--in`-anchored grid. Not the discriminator above
        # (a source-0 grid re-based by +1.05 lands on 1.05 + k/fps too) — the paired check that
        # catches a shift that was dropped, doubled or applied to only some of the fields.
        for a, b in res["windows"] + res["static_runs"]:
            for t in (a, b):
                off = ((t - 1.05) * mp.DEFAULT_FPS) % 1.0
                self.assertLess(min(off, 1.0 - off), 1e-6, f"{t} is off the --in 1.05 grid")

    def test_the_report_names_the_interval_it_actually_DIFFERENCED(self) -> None:
        # N frames yield N-1 differences, so the windows and static runs are cut out of an
        # interval ending one sample BEFORE the requested out-point — a freeze sitting exactly
        # on that out-point is outside everything the table can show. The header used to print
        # only the request, and nothing tested the relation at all; both halves are pinned here.
        rc, res = self.probe(str(self.frozen_mid), "--in", "1.0", "--out", "3.0")
        self.assertEqual(rc, 0)
        self.assertAlmostEqual(res["meta"]["covered"], 3.0 - 1.0 - 1 / mp.DEFAULT_FPS, places=6)
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            mp.main([str(self.frozen_mid), "--in", "1.0", "--out", "3.0"])
        self.assertIn("range 1..3 of", buf.getvalue())
        self.assertIn("(differenced 1..2.9)", buf.getvalue())

    def test_an_EMPTY_range_refuses_on_a_file_that_really_exists(self) -> None:  # NEG-CONTROL
        # The same refusal as in RangeArgTests, but over a decodable clip — so "exit 2" here can
        # only be the range, never a missing file. A clamp (widening an empty --out to something
        # measurable) turns this into a confident exit 0 about a segment nobody asked about.
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(io.StringIO()):
            mp.main([str(self.frozen_mid), "--in", "1.0", "--out", "1.0", "--max-static", "10"])
        self.assertEqual(cm.exception.code, 2)

    def test_a_range_TOO_THIN_to_difference_refuses(self) -> None:  # NEG-CONTROL
        # 0.05s at 10 fps cannot hold two samples, so there is no difference to measure — the
        # same refusal as a one-frame take, reached through the new flags.
        err = io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(err):
            mp.main([str(self.frozen_mid), "--in", "1.0", "--out", "1.05"])
        self.assertEqual(cm.exception.code, 2)
        self.assertIn("--in", err.getvalue())   # the message names the range it could not fill

    # ── the refusal DIAGNOSIS over real containers ──────────────────────────────────────
    #
    # CoverageDiagnosisTests pins the sentence for literal numbers; these pin that the numbers
    # reaching it are the file's own, through both refusal branches.

    def refused(self, *argv: str) -> str:
        """Run the CLI expecting exit 2; return what it said on stderr."""
        err = io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(io.StringIO()), \
                contextlib.redirect_stderr(err):
            mp.main(list(argv))
        self.assertEqual(cm.exception.code, 2)
        return err.getvalue()

    def test_a_SHIFTED_container_is_NOT_diagnosed_as_a_short_take(self) -> None:  # NEG-CONTROL
        # End to end on a real re-mux: `shifted` holds all 5s of `golden`, timestamped 12..17.
        # An operator reading 12.5..16 off a player gets an empty decode — and the old message
        # would have blamed the take. Every frame is on disk; a re-shoot fixes nothing.
        msg = self.refused(str(self.shifted), "--in", "12.5", "--out", "16.0")
        self.assertIn("timestamps START at 12.00s", msg)
        self.assertIn("DO NOT", msg)
        self.assertIn("0.5..4", msg)                       # the corrected range
        self.assertNotIn("SHORTER than the segment", msg)

    def test_the_COVERAGE_branch_carries_the_oracle_too(self) -> None:
        # The other refusal branch, on fixture F (a 1s offset): `--in 1 --out 6` is exactly what
        # a player showing 1..6 hands the operator. It decodes the 40 frames that exist — so the
        # "at least 2" floor passes — and only then falls short of the ~50 the range asked for.
        # Both branches must diagnose, or the operator's answer depends on which one their typo
        # happened to hit. The in-point is at/above the container start here on purpose: this is
        # the branch that computes a corrected range, and it can only do that honestly when the
        # in-point is one the shifted timeline could actually have produced.
        msg = self.refused(str(self.shifted_small), "--in", "1", "--out", "6")
        self.assertIn("asks for ~50", msg)                 # i.e. we are past the count<2 floor
        self.assertIn("timestamps START at 1.00s", msg)
        self.assertIn("this range becomes 0..5", msg)      # the corrected range, off real ffprobe
        self.assertIn("DO NOT", msg)
        self.assertNotIn("SHORTER than the segment", msg)

    def test_an_in_point_UNDER_the_container_start_gets_no_invented_correction(self) -> None:
        # Same branch, an in-point BELOW the container's own start (3 < 12): subtracting the
        # offset would put it at -9, and the old message clamped that to 0 and printed "0..4" as
        # though the operator had asked about it. They cannot have — a player on this file never
        # shows 3s — so the message says so instead of manufacturing a range.
        msg = self.refused(str(self.shifted), "--in", "3", "--out", "16")
        self.assertIn("asks for ~130", msg)                # i.e. we are past the count<2 floor
        self.assertIn("timestamps START at 12.00s", msg)
        self.assertIn("BELOW that start", msg)
        self.assertNotIn("this range becomes", msg)
        self.assertNotIn("SHORTER than the segment", msg)

    def test_a_genuinely_SHORT_take_still_says_re_shoot(self) -> None:
        # The paired control. Same coverage branch, same code path, a container that starts at 0
        # — here the take really IS shorter than the segment and re-shooting is the right advice.
        # Without this pairing the case above is satisfied by an oracle that never says "short".
        msg = self.refused(str(self.golden), "--out", "9.0")
        self.assertIn("SHORTER than the segment", msg)
        self.assertIn("or re-shoot it", msg)
        self.assertIn("5.00s of source", msg)              # the real ffprobe duration
        self.assertNotIn("timestamps START", msg)

    def test_a_MUTE_ffprobe_refuses_to_pick_a_story(self) -> None:  # NEG-CONTROL
        # Fail-loud through the CLI: with the duration oracle blinded, the same refusal must stop
        # naming a cause. This is the case that keeps "re-shoot" from being the default sentence
        # dressed up as a diagnosis on any machine where ffprobe is missing or unhappy.
        with mock.patch.object(mp, "source_duration", return_value=None), \
                mock.patch.object(mp, "source_start_time", return_value=None):
            msg = self.refused(str(self.golden), "--out", "9.0")
        self.assertIn("could not read this file's duration", msg)
        self.assertNotIn("SHORTER than the segment", msg)
        self.assertNotIn("re-shoot it", msg)

    # ── zero coverage: the range that measured NOTHING ──────────────────────────────────

    def test_a_range_starting_AT_EOF_measures_nothing_and_prints_NO_report(self) -> None:
        # covered == 0.0 end to end: `golden` is exactly 5s, so [5.0, 6.0) decodes zero frames.
        # The exit code is only half the requirement — stdout must stay EMPTY. A report printed
        # over zero coverage ("live windows: NONE, static runs: none, longest static run: none")
        # reads like a clean take to anything that scrapes stdout, whatever the exit code said.
        out, err = io.StringIO(), io.StringIO()
        with self.assertRaises(SystemExit) as cm, contextlib.redirect_stdout(out), \
                contextlib.redirect_stderr(err):
            mp.main([str(self.golden), "--in", "5.0", "--out", "6.0", "--max-static", "10"])
        self.assertEqual(cm.exception.code, 2)
        self.assertEqual(out.getvalue(), "", "a probe that measured nothing must report nothing")
        self.assertIn("--in 5..--out 6", err.getvalue())
        self.assertIn("SHORTER than the segment", err.getvalue())

    def test_the_LAST_half_second_of_the_same_take_still_measures(self) -> None:
        # The pairing: the refusal above must be about EOF, not about "any range near the end".
        # [4.5, 5.0) is the last five samples the file really has and must come back measured.
        rc, res = self.probe(str(self.golden), "--in", "4.5", "--out", "5.0")
        self.assertEqual(rc, 0)
        self.assertGreater(res["meta"]["covered"], 0.0)
        self.assertGreater(res["samples"], 0)

    # ── GOLDEN SCALARS ──────────────────────────────────────────────────────────────────
    #
    # Everything else in this file compares the probe against itself (the bit-identity case
    # recomputes the same functions) or against a relation ("more than", "on the grid"). That
    # can hold while the whole pipeline drifts in lockstep — a changed default, an ffmpeg whose
    # fps filter samples elsewhere, a MAD divided by the wrong count — and the acceptance band in
    # docs/RIG.md silently stops meaning what it says. These two cases are the absolute anchor:
    # LITERAL numbers off fixture D, whose construction (lossless, uniform, exactly-mapping
    # levels, off-grid toggles) makes every one of them arithmetic rather than an encoder's
    # opinion. Re-derive them with:
    #   python3 scripts/rig/motion_probe.py <the fixture> --json
    # If one of them fails, check `ffmpeg -version` FIRST — a toolchain bump is the likelier
    # cause than a metric change.
    #
    # What they do NOT catch, because D's MADs SATURATE (0.0 and 255.0, decades away from any
    # threshold): the classifier's own defaults. DEFAULT_THRESH, DEFAULT_BRIDGE and
    # DEFAULT_MIN_LIVE moved to any other sane value leave every literal below untouched, so
    # those mutations SURVIVE this anchor. Only a fixture with graded motion can see them —
    # PublishedBandTests, which needs the gitignored footage on disk.

    def test_the_GOLDEN_whole_file_numbers_are_EXACTLY_these(self) -> None:
        rc, res = self.probe(str(self.golden))
        self.assertEqual(rc, 0)
        self.assertEqual(res["meta"]["frames"], 50)          # 5.0s at the default 10 fps
        self.assertEqual(res["meta"]["duration"], 5.0)
        self.assertEqual(res["meta"]["covered"], 4.9)        # N frames -> N-1 differences
        self.assertEqual(res["samples"], 49)
        # 30 live differences over the 3s flicker, 19 dead over the 2s freeze.
        self.assertEqual(res["duty"], {"overall": 0.6122, "live_samples": 30,
                                       "samples": 49, "windows": [1.0]})
        self.assertEqual(res["windows"], [[0.0, 3.0]])
        self.assertEqual(res["static_runs"], [[3.0, 4.9]])
        self.assertEqual(res["longest_static"], [3.0, 4.9])
        self.assertEqual(res["gate"]["longest_static_s"], 1.9)
        # Luma 16 vs 235 -> full-range gray 0 vs 255: the MAD is 255.0, not 254.997.
        self.assertEqual(res["stats"], {"min": 0.0, "median": 255.0,
                                        "p90": 255.0, "max": 255.0})
        # ... and the same numbers as the operator reads them.
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            mp.main([str(self.golden)])
        self.assertIn("5.00s  50 frames @ 10fps  192x108  full frame", buf.getvalue())
        self.assertIn("duty  61.2% of samples live (30/49)", buf.getvalue())
        self.assertIn("longest static run: 1.90s (3.00..4.90)", buf.getvalue())

    def test_the_GOLDEN_sub_range_numbers_are_EXACTLY_these(self) -> None:
        # The same anchor for the `--in/--out` path, on a range wholly inside the live half. The
        # in-point is FRACTIONAL on purpose: at a whole multiple of 1/fps the grid lands in the
        # same place however the seek is built, so an integral golden would be blind to the seek
        # moving after `-i` (19 frames) or the fps filter rounding differently. 0.52 also sits
        # 0.02s clear of every 0.1s toggle in the fixture, so no sample straddles a level change.
        rc, res = self.probe(str(self.golden), "--in", "0.52", "--out", "2.52")
        self.assertEqual(rc, 0)
        self.assertEqual(res["meta"]["frames"], 20)
        self.assertEqual(res["meta"]["covered"], 1.9)
        self.assertEqual(res["samples"], 19)
        self.assertEqual(res["duty"], {"overall": 1.0, "live_samples": 19,
                                       "samples": 19, "windows": [1.0]})
        self.assertEqual(res["windows"], [[0.52, 2.42]])     # absolute source seconds
        self.assertEqual(res["static_runs"], [])
        self.assertIsNone(res["longest_static"])
        self.assertEqual(res["stats"], {"min": 255.0, "median": 255.0,
                                        "p90": 255.0, "max": 255.0})
        self.assertEqual(res["meta"]["range"], {"in": 0.52, "out": 2.52, "source_duration": 5.0})


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not on PATH (dev shell provides it)")
class StaticHookEndToEndTests(unittest.TestCase):
    """`--preset static-hook` through the real CLI + ffmpeg decode, on synthesised clips.

    Every clip is the SAME still frame (320x180 black, a 28x14 box in the middle — ~0.7 % of the
    frame, the scale of a bot in a wide static shot) with one thing varied, lossless ffv1 so no
    encoder moves a pixel, and every change timed halfway between the probe's 10 fps samples:

      ramp     the box brightens in THREE steps (16 -> 89 -> 162 -> 235 at 2.05/2.15/2.25 s):
               three MADs of ~0.50-0.53 — the real hook's shape (three samples, ~0.56-0.89) at
               the low end of its amplitude. THE KNOWN-GOOD.
      still    the box never changes — MAD 0 (the frozen take).
      step     the box jumps 16 -> 235 ONCE at 2.05 s: one MAD of ~1.56 — loud, but one sample.
      flicker  the box toggles 16 <-> 29 every sample for the whole clip: MAD ~0.094, the
               loudest noise sample measured on dead static footage, sustained.

    Plus the lavfi gray still the brief named, x264 like a real take.
    """

    BOX = "lt(abs(X-160),14)*lt(abs(Y-90),7)"
    LUMA = {
        "ramp": f"if({BOX},16+73*clip(floor((T-1.95)*10),0,3),16)",
        "still": f"if({BOX},235,16)",
        "step": f"if({BOX},if(gte(T,2.05),235,16),16)",
        "flicker": f"if({BOX},if(eq(mod(floor(T*10+0.5),2),0),16,29),16)",
    }

    tmp: Path
    # Borrowed, not copied: the same build-once-or-ERROR synthesiser the class above uses.
    _ffmpeg = EndToEndTests.__dict__["_ffmpeg"]

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp())

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def clip(self, kind: str) -> Path:
        if kind == "gray":
            return self._ffmpeg(["-f", "lavfi", "-i", "color=gray:s=1920x1080:d=3"], "gray.mp4")
        return self._ffmpeg([
            "-f", "lavfi", "-i",
            f"color=c=black:s=320x180:r=30:d=4,format=yuv420p,"
            f"geq=lum='{self.LUMA[kind]}':cb=128:cr=128",
        ], f"hook_{kind}.mkv", codec="ffv1")

    def probe(self, *argv: str) -> tuple[int, dict, str]:
        """In-process CLI run: (exit code, the --json result, stderr)."""
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = mp.main([*argv, "--json"])
        return rc, json.loads(out.getvalue()), err.getvalue()

    def test_the_DEFAULTS_are_blind_to_the_synthetic_hook(self) -> None:
        # The fixture reproduces the bug before it certifies the fix.
        rc, res, _ = self.probe(str(self.clip("ramp")))
        self.assertEqual(rc, 0)                               # report-only: it cannot fail
        self.assertEqual(res["windows"], [])
        self.assertLess(res["stats"]["max"], mp.DEFAULT_THRESH)

    def test_the_preset_PASSES_the_hook_and_finds_it_where_it_is(self) -> None:
        rc, res, err = self.probe(str(self.clip("ramp")), "--preset", "static-hook")
        self.assertEqual(rc, 0)
        self.assertEqual(res["gate"]["status"], "ok")
        self.assertEqual(res["gate"]["min_windows"], 1)
        self.assertEqual(res["windows"], [[2.0, 2.3]])
        self.assertEqual(res["duty"]["live_samples"], 3)
        self.assertEqual(res["meta"]["preset"], "static-hook")
        self.assertEqual((res["meta"]["thresh"], res["meta"]["min_live"]), (0.3, 0.2))
        self.assertNotIn("WARN", err)                         # nothing overridden

    def test_every_STILL_shape_FAILS_the_preset(self) -> None:  # NEG-CONTROL
        for kind in ("still", "gray", "step", "flicker"):
            with self.subTest(kind=kind):
                rc, res, _ = self.probe(str(self.clip(kind)), "--preset", "static-hook")
                self.assertEqual(rc, 1, f"{kind}: {res['stats']} {res['windows']}")
                self.assertEqual(res["gate"]["status"], "fail")
                self.assertEqual(res["windows"], [])

    def test_the_known_bads_really_carry_the_signal_they_claim(self) -> None:
        # A known-bad that is flat zero everywhere would pass as "still" for any threshold and
        # prove nothing about the flicker/step lanes; pin that each one moves the way it says.
        _rc, step, _ = self.probe(str(self.clip("step")), "--preset", "static-hook")
        self.assertEqual(step["duty"]["live_samples"], 1)     # loud, above thresh, ONE sample
        _rc, flick, _ = self.probe(str(self.clip("flicker")), "--preset", "static-hook")
        self.assertGreater(flick["stats"]["min"], 0.09)       # sustained, every sample ...
        self.assertLess(flick["stats"]["max"], mp.STATIC_HOOK_THRESH)   # ... all under it

    def test_an_explicit_flag_WINS_over_the_preset_and_says_so(self) -> None:
        rc, res, err = self.probe(str(self.clip("ramp")), "--preset", "static-hook",
                                  "--thresh", "1.0")
        self.assertEqual(rc, 1)                               # the default threshold is blind
        self.assertEqual(res["meta"]["thresh"], 1.0)
        self.assertIn("WARN --thresh 1.0 overrides the static-hook preset's 0.3", err)

    def test_a_CROP_under_the_preset_is_REFUSED_not_run(self) -> None:  # NEG-CONTROL
        # The preset is calibrated FULL FRAME. Before the fix a --crop slid past it silently — no
        # WARN, since crop was no preset knob — and the tight crop below read the 0.7 % box as
        # MADs ~150x the calibrated scale and certified GATE OK. The crops vary on the axes a
        # real one does: tight on the event, off it, and the whole frame spelled as a crop
        # (numerically full frame, still refused: the preset owns the framing, not the flag).
        for crop in ("146,83,28x14", "0,0,160x90", "0,0,320x180"):
            err = io.StringIO()
            with self.subTest(crop=crop), self.assertRaises(SystemExit) as cm, \
                    contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
                mp.main([str(self.clip("ramp")), "--preset", "static-hook", "--crop", crop,
                         "--json"])
            self.assertEqual(cm.exception.code, 2)
            self.assertIn(f"--crop {crop} under the static-hook preset", err.getvalue())
            self.assertIn("calibrated on the FULL frame", err.getvalue())

    def test_the_same_crop_WITHOUT_the_preset_still_runs(self) -> None:
        # The pair: the refusal is the preset's, not a general ban on --crop.
        rc, res, err = self.probe(str(self.clip("ramp")), "--crop", "146,83,28x14")
        self.assertEqual(rc, 0)
        self.assertEqual(res["meta"]["crop"], "146,83,28x14")
        self.assertNotIn("under the", err)

    def test_no_preset_leaves_the_meta_and_gate_UNCHANGED(self) -> None:  # NEG-CONTROL
        rc, res, _ = self.probe(str(self.clip("still")))
        self.assertEqual(rc, 0)
        self.assertNotIn("preset", res["meta"])
        self.assertIsNone(res["gate"]["min_windows"])
        self.assertEqual(res["meta"]["thresh"], mp.DEFAULT_THRESH)


class TakesDirTests(unittest.TestCase):
    """takes_dir()'s two lookups: this tree first, then the main checkout via machine_root."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tree = Path(tmp.name) / "tree"          # a worktree: no release/ at all
        self.main = Path(tmp.name) / "main"
        self.tree.mkdir()
        take = self.main / "release" / "takes" / "teaser" / "04_nav.mp4"
        take.parent.mkdir(parents=True)
        take.write_bytes(b"")
        patcher = mock.patch.object(sys.modules[__name__], "REPO", self.tree)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_falls_back_to_the_main_checkout(self) -> None:
        # Neg-control for the lanes below: the fallback DOES find takes where they live.
        with mock.patch.object(machine_root, "root", return_value=self.main):
            self.assertEqual(takes_dir(), self.main / "release" / "takes" / "teaser")

    def test_no_takes_and_no_main_checkout_is_none_not_a_crash(self) -> None:
        for err in (machine_root.MachineRootError("no git"), OSError("git missing")):
            with self.subTest(err=type(err).__name__), \
                    mock.patch.object(machine_root, "root", side_effect=err):
                self.assertIsNone(takes_dir())

    def test_a_main_checkout_without_the_takes_is_none(self) -> None:
        with mock.patch.object(machine_root, "root", return_value=self.tree):
            self.assertIsNone(takes_dir())


@unittest.skipUnless(shutil.which("ffmpeg"), "ffmpeg not on PATH (dev shell provides it)")
@unittest.skipUnless(TAKES is not None, "release/takes/teaser not checked out (gitignored)")
class PublishedBandTests(unittest.TestCase):
    """The rows docs/RIG.md publishes, pinned to the takes they were measured on.

    The golden above proves the pipeline is arithmetically stable; it cannot prove the numbers
    printed in the acceptance table still come out of it, because its frames are uniform and its
    MADs saturate — a drift in the downscale of REAL pixels would not move them. This case reads
    the actual take. It skips where the (gitignored) footage is not on disk, so it is a pin, not
    a gate: where the band's own evidence exists, the band cannot drift unnoticed.

    Re-measure and update BOTH places together after a re-shoot — the doc says so in the same
    words: "recompute the band after any re-shoot; never copy the old numbers".
    """

    def test_the_04_nav_row_still_reads_56_9_percent(self) -> None:
        assert TAKES is not None                              # narrow for the type checker
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            rc = mp.main([str(TAKES / "04_nav.mp4"), "--in", "0.6", "--out", "5.8", "--json"])
        self.assertEqual(rc, 0)
        res = json.loads(buf.getvalue())
        # docs/RIG.md § Take acceptance, row `climb`: 04_nav, 0.6-5.8, 56.9 %, longest static 0.1s.
        self.assertEqual(res["duty"]["live_samples"], 29)
        self.assertEqual(res["duty"]["samples"], 51)
        self.assertEqual(res["duty"]["overall"], 0.5686)      # -> "56.9%" in the report
        self.assertEqual(mp.pct(res["duty"]["overall"]), "56.9%")
        self.assertEqual(res["gate"]["longest_static_s"], 0.1)
        self.assertEqual(res["meta"]["frames"], 52)
        self.assertEqual(res["windows"], [[0.7, 5.6]])

    def clutch(self, *argv: str) -> tuple[int, dict]:
        assert TAKES is not None
        take = TAKES / "01_clutch.mp4"
        if not take.is_file():
            self.skipTest(f"{take} not on disk")
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf), contextlib.redirect_stderr(io.StringIO()):
            rc = mp.main([str(take), *argv, "--json"])
        return rc, json.loads(buf.getvalue())

    def test_the_hook_clutch_row_is_BLIND_at_the_defaults(self) -> None:
        # The static-hook calibration take (docs/RIG.md § Static hook shots): 01_clutch
        # 3.2-5.3 at the defaults finds 0 windows — the case the static-hook preset exists for.
        rc, res = self.clutch("--in", "3.2", "--out", "5.3")
        self.assertEqual(rc, 0)
        self.assertEqual((res["windows"], res["duty"]["live_samples"]), ([], 0))

    def test_the_hook_clutch_row_PASSES_the_static_hook_preset(self) -> None:
        rc, res = self.clutch("--in", "3.2", "--out", "5.3", "--preset", "static-hook")
        self.assertEqual(rc, 0)
        self.assertEqual(res["windows"], [[3.8, 4.1]])
        self.assertEqual((res["duty"]["live_samples"], res["duty"]["samples"]), (3, 20))

    def test_the_clutch_takes_DEAD_tail_FAILS_the_preset(self) -> None:  # NEG-CONTROL
        rc, res = self.clutch("--in", "5.0", "--out", "15.5", "--preset", "static-hook")
        self.assertEqual(rc, 1)
        self.assertEqual(res["windows"], [])
        self.assertLess(res["stats"]["max"], 0.1)             # the measured noise ceiling


if __name__ == "__main__":
    unittest.main()
