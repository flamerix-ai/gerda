#!/usr/bin/env python3
"""motion_probe.py — NUMERIC liveness acceptance for a take: is anything actually MOVING?

WHY THIS EXISTS (the failure it is built to stop)
  "Checked it frame by frame" and a contact sheet have now accepted THREE takes that carry a
  multi-second FREEZE — a bot standing still while the plan never started, or a camera holding
  a dead pose. A contact sheet samples ~1 frame every few seconds, so a 5s freeze can fall
  entirely between two thumbnails and read as a normal cut. File size does not catch it either:
  the shader's per-pixel noise keeps every frame "different" enough that the encoder never
  collapses, so a frozen take is the same weight as a live one. The only honest answer is to
  measure the frames themselves.

METHOD
  Decode the take to a small grayscale sequence (default 10 fps, 192×108) and take the MAD —
  the mean absolute difference, per byte — between EACH pair of neighbouring frames. That single
  number is ~0 for a freeze, small for shader noise, and large for real motion. Frames that clear
  `--thresh` are "live"; live frames merge into windows, gaps SHORTER than `--bridge` are bridged
  (a single dropped frame must not split one continuous move), and a bridged window is kept only
  if it holds at least `--min-live` seconds' worth of ACTUALLY LIVE frames — bridged dead frames
  do not pay towards it. Counting the span instead would let two blinks 0.4 s apart inside a
  6-second freeze merge into a "0.5 s window" that saws the freeze into two passable halves.

  TIME ATTRIBUTION (held consistently everywhere): frame i covers [i/fps, (i+1)/fps), and MAD i —
  the difference between frames i and i+1 — is attributed to that same span [i/fps, (i+1)/fps),
  i.e. "the motion that happened while frame i was up". N frames therefore yield N-1 MADs
  covering [0, (N-1)/fps), which is the interval the windows and static runs are cut out of.

  A STATIC RUN is a maximal interval NOT covered by an accepted live window — so the bridged
  gaps inside a window count as live, and a sub-`--min-live` blip in the middle of a freeze does
  NOT chop the freeze into two shorter halves. That is deliberate: the gate must report the
  freeze a viewer perceives, not the longest run of literally-identical frames.

DUTY — the number to read when the gate says OK
  `--max-static` measures the LONGEST freeze, and that is blind to a take whose motion is a chain
  of blinks: every gap short enough to be bridged, so one window covers the whole take, the
  longest static run is ~0 and the gate passes a picture that was cumulatively dead. DUTY is the
  complementary number — the fraction of samples that were actually live — reported for the whole
  run and per window, never as a gate. GATE OK means "no long freeze", NOT "the take moved".

  MEASURE THE USED RANGE, NOT THE WHOLE TAKE — `--in` / `--out`. Duty over a whole file is
  dominated by the tail the edit throws away: 04_nav reads 40.5 % whole-file but 56.9 % over the
  0.6-5.8s the cut uses; 05_economy reads 35.4 % against 74.3 % over its 20.6-24.2s burst. So probe
  the segment the cut list actually uses: `--in 0.6 --out 5.8` DECODES exactly that half-open
  range out of the ONE existing decode — no ffmpeg trim to a temp file first.

  What is DIFFERENCED is one sample shorter at the tail: N frames yield N-1 MADs, so a probe of
  0.6..5.8 at 10 fps measures motion over 0.6..5.70 and a freeze sitting exactly on the out-point
  is outside it. The report prints that differenced interval next to the requested one rather than
  leaving the operator to infer it from a window table that stops early. A range that lands PARTLY
  past the end of the file is refused outright (exit 2) — see decode().

  REPORTED TIMESTAMPS STAY ABSOLUTE (source seconds), always. The decode hands the classifier a
  series that starts at 0 no matter what `--in` was, so every window and static run is re-based by
  +`--in` before it is printed: "static run 5.80..53.90" means seconds of the SOURCE file, the
  numbers an operator scrubs to in a player. A range-relative report would be a trap — the one
  moment you read it is the moment you are hunting the freeze in the original take.

  READ DUTY RELATIVELY — there is no absolute floor. Over every in/out in
  scenarios/shots/teaser_cut.json (defaults, full frame; three rows re-measured
  later than the rest), the nine ACCEPTED segments span 0-74 %: 74.3 (05_economy 20.6-24.2), 56.9
  (04_nav 0.6-5.8), 50.0 (05_economy 46.0-57.7), 11.8 (02b_shaft 0.3-5.5), 10.4 (03_vein
  6.0-60.0), and 0.0 for four shots the cut list itself calls static — the STATIC in-pit hook
  camera (01_clutch 3.2-5.3: full frame is 0.0 % by construction, its evidence is the
  `--preset static-hook` run — one live window 3.8-4.1), a standing-hero prospect shot, a GUI insert,
  and a pixel-stable 20x timelapse. So a bare percentage proves nothing: what indicts a
  take is a COLLAPSE against a comparable reference — the same shot's known-good take, or the
  crop run beside the full-frame one. (04_nav_bridge2 reading 0.0 % with a 53.9s static run is
  the probe AGREEING with the editor: that take is parked from 5.6s, as the cut list records.)
  Recompute the band after any re-shoot; the recipe is in docs/RIG.md § Take acceptance.

TWO RUNS PER TAKE — one is not enough
  1. FULL FRAME — answers "is the camera/world moving at all". A tracking pan lights this up.
  2. `--crop` AROUND THE BOT — the bot is ~0.3% of the pixels, so its animation is far below
     the full-frame noise floor: a take where the camera pans smoothly over a bot that never
     moved passes run 1 and fails run 2. Crop coordinates are in SOURCE pixels (the crop filter
     runs BEFORE the scale), so read them straight off a full-size still.

  python3 scripts/rig/motion_probe.py release/takes/teaser/05_economy.mp4
  python3 scripts/rig/motion_probe.py release/takes/teaser/05_economy.mp4 \\
      --crop 780,420,360x360 --max-static 2.0
  python3 scripts/rig/motion_probe.py release/takes/teaser/05_economy.mp4 --in 19.9 --out 23.4
  python3 scripts/rig/motion_probe.py take.mp4 --json > probe.json

A STATIC SHOT — `--preset static-hook`
  A still camera whose point is ONE brief event (the in-pit clutch hook) is invisible at the
  defaults: its event is ~0.3 s of MAD 0.5-0.9 against a noise floor of ~0.01, under `--thresh
  1.0` and under the 0.5 s `--min-live`. The preset swaps in a measured threshold and min-live
  (the constants below carry the numbers) and gates on `--min-windows 1` — "the event happened"
  — instead of the longest freeze, which on a static shot is the design, not a defect:
  python3 scripts/rig/motion_probe.py release/takes/teaser/01_clutch.mp4 --in 3.2 --out 5.3 \\
      --preset static-hook

A BLACK TAKE — `--min-luma`
  A recorder that captures a surface nobody draws on writes a valid, correctly sized file of
  black frames (docs/RIG.md: gamescope → PipeWire records black on NVIDIA). Motion cannot see
  that: a black take has MAD 0 everywhere, which reads exactly like a freeze. So the probe also
  reports LUMA, each sampled frame's mean gray level (0..255; the gray decode maps video black
  to 0 — measured: a black h264 clip reads 0.0, a sandbox take of the game ~88), as min / mean /
  max over the frames, and `--min-luma N` fails a take whose MEAN luma is under N. A take that is legitimately dark (a cave at night) has a low mean too, so the gate is
  opt-in and the number is printed either way. `provision.sh record` (scripts/sandbox) gates
  every recording on it.

EXIT CODES — 0 report/pass, 1 gate FAIL, 2 REFUSED
  0  report only (no `--max-static`/`--min-windows`/`--min-luma`), or every given gate passed.
  1  a gate FAILED: the longest static run is longer than `--max-static`, fewer than
     `--min-windows` live windows were accepted, or the mean luma is under `--min-luma`. The
     only exit that means "measured, and the take is bad".
  2  the probe REFUSED — it never measured what it was asked about. Exhaustively, so a wrapper
     reading the code does not have to guess:
       * BAD ARGUMENT — a non-finite bound (`--in nan`), a non-positive `--fps`/`--thresh`, a
         negative `--in`/`--bridge`/`--min-live`, a `--min-windows` under 1, an empty or
         inverted `--out <= --in`, an unknown `--preset`, a `--crop` under a preset calibrated
         on another framing (static-hook: the full frame), a malformed `--scale`/`--crop`, or
         anything argparse itself rejects (`--in start`).
       * ENVIRONMENT — no ffmpeg on PATH, no such video, ffmpeg exited non-zero.
       * FEWER THAN TWO FRAMES, so there is no difference to measure at all: an empty take, a
         range wholly past the end of the file, a range thinner than 2/`--fps`, or an `--fps`
         too low for the take's duration.
       * COVERAGE — the range decoded far fewer frames than it asked for, i.e. it only PARTLY
         fits the take. The live cause is almost always a cut list that outlived its take (a
         re-shoot came back shorter, or its in/out were read off a container whose timestamps
         start late) — `coverage_diagnosis` runs an ffprobe oracle to say WHICH.
       * NOTHING MEASURED — the classifier got 0 frame differences, so `gate_verdict` returns
         `GATE REFUSED` instead of a suspiciously clean "no static runs found". Defence in
         depth, not a path reachable today: decode() already refuses below two frames, so
         nothing downstream can hand the classifier an empty series through this CLI.
     A probe that cannot measure never reports "OK" — that is the whole point.
"""

from __future__ import annotations

import argparse
import json
import math
import operator
import shutil
import statistics
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

DEFAULT_FPS = 10
DEFAULT_SCALE = "192x108"
DEFAULT_THRESH = 1.0        # MAD units (0..255 grayscale levels)
DEFAULT_BRIDGE = 0.5        # seconds
DEFAULT_MIN_LIVE = 0.5      # seconds

EPS = 1e-9                  # float slack for the strict </>= comparisons below

# ── presets: NAMED, MEASURED parameter sets for shots the defaults are blind to ─────────────
#
# A preset carries EVERY knob it was calibrated at — fps and scale too, although they equal the
# defaults today, and the FRAMING (`crop`, None = full frame) — so a later change of a DEFAULT_*
# cannot silently de-calibrate it. CALIBRATION_KNOBS below lists what a preset must cover, and a
# test holds every parser option to it. An explicit sensitivity flag still wins over the preset
# (with a WARN: the measurements below no longer vouch for it); a different FRAMING is refused,
# because it changes what the MAD is an average of, so every measured number is in another unit.
#
# static-hook — a STATIC camera whose whole point is ONE brief event: the teaser's in-pit
# water-clutch hook (01_clutch, cut 3.2-5.3). At the defaults the probe finds 0 windows on it, so
# the old recipe was a hand-made crop + `--thresh 0.3` — and even that reads 0 windows (3 live
# samples = 0.3 s, under the default 0.5 s min-live), only a 15 % duty. Measured,
# FULL FRAME @ 10 fps 192x108 (docs/RIG.md § Static hook shots has the table):
#
#   * the EVENT, 01_clutch 3.7-4.1: MAD 0.095 0.704 0.888 0.558 0.135 — the bucket lands, the bot
#     drops, the scoop; the frames either side sit at 0.007-0.022;
#   * DEAD / static noise, loudest single sample per stretch: 01_clutch 4.3-15.5 0.0945 (two
#     isolated spikes, 0.084/0.094; everything else <= 0.017), 01_clutch 0-3.6 0.048,
#     02a_prospect 6.6-11.0 0.050, 04_nav_bridge2 parked 6.0-EOF 0.069, 08_finale_enc 1-121
#     (20x timelapse) 0.255; a looped single frame of 01_clutch and a lavfi gray still read 0.
#
# STATIC_HOOK_THRESH = 0.3 sits between those: 3.2x the loudest dead-footage sample of the
# static takes (0.0945) and 1.9x under the event's third-loudest sample (0.558), so all three
# event samples count — about the geometric mean of 0.0945 and the 0.888 peak (0.29). The take
# still passes up to the second-loudest (0.704); past it one sample is left and it fails. The
# timelapse's 0.255 stays under 0.3 too.
STATIC_HOOK_THRESH = 0.3
# 0.2 s = TWO samples at 10 fps. The event clears the threshold for three (0.3 s), so the default
# 0.5 s min-live drops it; two, not one, so an ISOLATED one-sample spike in dead footage — a single
# step change, the shape of both loud samples in the dead tail (8.2 s, 12.4 s) — cannot count as
# "the event happened". KNOWN LIMIT: one odd FRAME (in and back out) makes two MADs and would
# pass; rejecting it needs 0.3 s, which is the whole measured event (no margin at all). Against
# that shape the threshold is the guard: 3.2x above anything dead footage was measured doing.
STATIC_HOOK_MIN_LIVE = 0.2
# The GATE flips: on a static shot stillness IS the design, so `--max-static` (the longest
# freeze) condemns every good take. What must be certified is that the event happened at all —
# at least one accepted live window.
STATIC_HOOK_MIN_WINDOWS = 1
# Calibrated at the defaults below; pinned as their own numbers on purpose (see above). 10 fps
# is load-bearing, not habit: the world moves on the 20 Hz game tick, so at >= 20 fps neighbouring
# samples often straddle NO tick and the event shreds into spikes with noise between them
# (01_clutch @ 30 fps: 0.444 0.008 1.001 0.881 0.012 0.006 0.469 ...). At 10 fps every
# difference spans two ticks and the event reads as one contiguous run.
STATIC_HOOK_FPS = 10
STATIC_HOOK_SCALE = "192x108"
STATIC_HOOK_BRIDGE = 0.5
# FULL FRAME: every number above was measured on the whole frame. The clutch is ~2 % of it, so a
# crop around it scales the event MAD (and the noise) by up to ~50x, and 0.3 would sit at an
# arbitrary point of that other scale. Hence `--crop` under this preset is REFUSED.
STATIC_HOOK_CROP = None

# The knobs that change WHAT is measured — every preset must carry each one (a knob it left out
# would silently run at whatever its default is today). The other options (the video, the
# --in/--out range, --max-static, --json, --preset itself) say where to look or how to report.
CALIBRATION_KNOBS = frozenset({"fps", "scale", "crop", "thresh", "bridge", "min_live",
                               "min_windows"})
# The subset an explicit flag may NOT override: framing. A sensitivity knob off its calibrated
# value is a WARN (the operator is tuning); a different framing is a different measurement.
FRAMING_KNOBS = frozenset({"crop"})

PRESETS: dict[str, dict[str, float | int | str | None]] = {
    "static-hook": {"fps": STATIC_HOOK_FPS, "scale": STATIC_HOOK_SCALE, "crop": STATIC_HOOK_CROP,
                    "thresh": STATIC_HOOK_THRESH, "bridge": STATIC_HOOK_BRIDGE,
                    "min_live": STATIC_HOOK_MIN_LIVE, "min_windows": STATIC_HOOK_MIN_WINDOWS},
}


def die(msg: str) -> NoReturn:
    print(f"motion_probe.py: {msg}", file=sys.stderr)
    raise SystemExit(2)


def warn(msg: str) -> None:
    """Advisory on stderr — stdout stays the report (or the single --json object)."""
    print(f"motion_probe.py: WARN {msg}", file=sys.stderr)


# ── the pure core (no ffmpeg — this is what the unit tests drive) ───────────────────────

def frame_mads(frames: list[bytes]) -> list[float]:
    """Mean absolute difference between each pair of neighbouring frames.

    `frames` are equal-length grayscale byte buffers. Returns len(frames)-1 values in
    0..255; MAD i is the difference between frames i and i+1. Fail-loud on ragged or
    empty input — a silently-skipped frame would understate motion, which is exactly the
    direction that ships a frozen take.
    """
    if len(frames) < 2:
        return []
    size = len(frames[0])
    if size == 0:
        raise ValueError("frame_mads: zero-length frames")
    for i, f in enumerate(frames):
        if len(f) != size:
            raise ValueError(f"frame_mads: frame {i} is {len(f)}B, expected {size}B")
    # map() keeps both loops in C: ~20k bytes/pair is far too many for a Python-level zip.
    return [sum(map(abs, map(operator.sub, a, b))) / size
            for a, b in zip(frames, frames[1:])]


def frame_luma(frames: list[bytes]) -> dict:
    """Brightness of the decoded frames: min / mean / max of each frame's mean gray level.

    0..255 per frame; an all-black take reads 0 on all three (the gray decode maps video black
    to 0). Fail-loud on no frames — "no brightness measured" is not "dark".
    """
    if not frames:
        raise ValueError("frame_luma: no frames")  # gate:luma-no-frames
    means = [sum(f) / len(f) for f in frames]
    return {"min": round(min(means), 2), "mean": round(statistics.fmean(means), 2),  # not-a-gate: the measured luma of the frames
            "max": round(max(means), 2)}


def _runs(flags: list[bool]) -> list[tuple[int, int]]:
    """Maximal runs of True as inclusive (start, end) index pairs."""
    out: list[tuple[int, int]] = []
    start: int | None = None
    for i, on in enumerate(flags):
        if on and start is None:
            start = i
        elif not on and start is not None:
            out.append((start, i - 1))
            start = None
    if start is not None:
        out.append((start, len(flags) - 1))
    return out


def _percentile(values: list[float], q: float) -> float:
    """Nearest-rank percentile (defined for n == 1, unlike statistics.quantiles)."""
    ordered = sorted(values)
    rank = max(1, math.ceil(q * len(ordered)))
    return ordered[rank - 1]


def _complement(windows: list[tuple[float, float]], span: float) -> list[tuple[float, float]]:
    """The parts of [0, span) that no window covers."""
    gaps: list[tuple[float, float]] = []
    cursor = 0.0
    for start, end in windows:
        if start > cursor + EPS:
            gaps.append((round(cursor, 6), round(start, 6)))
        cursor = max(cursor, end)
    if span > cursor + EPS:
        gaps.append((round(cursor, 6), round(span, 6)))
    return gaps


def _duty(live_n: int, total_n: int) -> float | None:
    """live/total as a 0..1 fraction — None when nothing was measured (never a cheerful 0.0)."""
    return round(live_n / total_n, 4) if total_n > 0 else None


def classify(mads: list[float], fps: float, thresh: float,
             bridge_s: float, min_live_s: float) -> dict:
    """Turn a MAD series into live windows + static runs (timestamps in seconds).

    See the module docstring for the time attribution and the static-run definition. The
    order is load-bearing: mark live -> merge into runs -> BRIDGE short gaps -> keep only the
    windows carrying min_live_s of LIVE frames -> static runs are whatever is left uncovered.

    Why the acceptance counts live frames instead of the merged window's SPAN: bridging has to
    run first (honest intermittent motion — a bot whose animation lights every other frame — is
    one live shot, and filtering before the bridge would shred it into sub-min_live scraps). But
    a span test after bridging is trivially defeated: two lone live frames 0.4s apart inside a
    6-second freeze merge into a 0.5s "window" that splits the freeze into two 2.7s halves, and
    a --max-static 4.0 gate then passes a completely dead take. Carrying the live COUNT through
    the merge keeps both properties: the intermittent take still passes, the blinking freeze
    still fails.

    `duty` rides along as OBSERVABILITY ONLY — it is reported, never gated (see the module
    docstring). It carries the live-sample fraction over the whole run (counting live samples in
    windows that were DROPPED — they are motion the take really contained) and per KEPT window,
    index-aligned with `windows`. It exists because a long chain of bridged blinks yields
    longest_static ~0 and a GATE OK over a take nobody would call alive; duty is the number that
    still says 20 %. Nothing below reads it back — adding it cannot move a verdict.
    """
    if fps <= 0:
        raise ValueError(f"classify: fps must be positive, got {fps}")
    span = len(mads) / fps
    if not mads:
        # No measurements at all. Nothing here may read as "fine" — gate_verdict REFUSES on
        # samples == 0 rather than reporting an empty, perfectly clean take.
        return {"samples": 0, "windows": [], "static_runs": [], "longest_static": None,
                "duty": {"overall": None, "live_samples": 0, "samples": 0, "windows": []},
                "stats": {"min": 0.0, "median": 0.0, "p90": 0.0, "max": 0.0}}

    live = [m >= thresh for m in mads]

    # (start_s, end_s, live_mad_count) — the third field is what survives bridging.
    merged: list[tuple[float, float, int]] = []
    for i, j in _runs(live):
        start, end, live_n = i / fps, (j + 1) / fps, j - i + 1
        if merged and (start - merged[-1][1]) < bridge_s - EPS:
            prev = merged[-1]
            merged[-1] = (prev[0], end, prev[2] + live_n)
        else:
            merged.append((start, end, live_n))

    kept: list[tuple[float, float]] = []
    kept_duty: list[float] = []
    for a, b, live_n in merged:
        if (live_n / fps) < min_live_s - EPS:
            continue
        kept.append((round(a, 6), round(b, 6)))
        # The window's own sample count, back from its timestamps — live_n of these were live,
        # the rest were bridged dead frames. A kept window always holds at least one sample, so
        # this duty is always defined (unlike `overall`, which has no samples to divide by on an
        # empty series).
        kept_duty.append(round(live_n / max(1, round((b - a) * fps)), 4))
    statics = _complement(kept, span)
    longest = max(statics, key=lambda r: r[1] - r[0]) if statics else None
    live_total = sum(live)

    return {
        "samples": len(mads),
        "windows": kept,
        "static_runs": statics,
        "longest_static": longest,
        "duty": {"overall": _duty(live_total, len(mads)), "live_samples": live_total,
                 "samples": len(mads), "windows": kept_duty},
        "stats": {"min": round(min(mads), 4), "median": round(statistics.median(mads), 4),
                  "p90": round(_percentile(mads, 0.90), 4), "max": round(max(mads), 4)},
    }


def shift_times(result: dict, offset: float) -> dict:
    """Re-base a classify() result from RANGE-relative onto SOURCE seconds, in place.

    decode() hands classify() a frame series that starts at 0 whatever `--in` was, so the
    windows and static runs come back relative to the sub-range. This is the single place the
    `--in` offset is added, and it must be added to EVERY timestamp the result carries: a report
    that says "static run 0.00..0.10" for a probe of 5.80..53.90 sends the operator scrubbing to
    the wrong second of the source, which is worse than not reporting it at all.

    `offset == 0.0` is the exact identity (the timestamps are already rounded to 6 places and
    rounding is idempotent), which is what keeps a no-`--in` run bit-identical to the old one.
    `stats`/`duty`/`samples` carry no timestamps and are deliberately untouched.
    """
    def shift(pair: tuple[float, float]) -> tuple[float, float]:
        return (round(pair[0] + offset, 6), round(pair[1] + offset, 6))

    result["windows"] = [shift(w) for w in result["windows"]]
    result["static_runs"] = [shift(r) for r in result["static_runs"]]
    if result["longest_static"] is not None:
        result["longest_static"] = shift(result["longest_static"])
    return result


def gate_verdict(result: dict, max_static: float | None,
                 min_windows: int | None = None,
                 min_luma: float | None = None) -> tuple[str, str, float]:
    """The gate decision, as a pure function: (status, verdict line, longest run).

    status is "ok" | "fail" | "refuse", which main() maps to exit 0 / 1 / 2. Lives here rather
    than inline in main() so the FAILING branch is unit-testable without a subprocess — a gate
    whose fail path is only ever exercised by hand is a gate nobody has seen fail.
    With neither gate given it is report-only: it cannot fail, but it can still REFUSE.

    Three gates, independent and composable: `max_static` fails a take whose LONGEST freeze is too
    long (a moving shot that stalled); `min_windows` fails a take with too FEW accepted live
    windows (a static shot whose one event never happened — `--preset static-hook`); `min_luma`
    fails a take whose mean brightness is under the bound (a black recording — it needs
    `result["luma"]`, see frame_luma). Several failing report each; one failing reports exactly
    its own line.

    REFUSE is the floor: zero measurements never reads as "OK". A probe that measured nothing
    knows nothing about the take, and "no static runs found" out of an empty series is the most
    confident-sounding lie this tool could tell.
    """
    if int(result.get("samples", 0)) < 1:  # gate:probe-refuses-empty
        return ("refuse",  # gate:probe-refuses-empty
                "GATE REFUSED: 0 frame differences measured — this probe cannot certify "
                "anything about the take", 0.0)
    ls = result["longest_static"]
    longest = (ls[1] - ls[0]) if ls else 0.0
    if max_static is None and min_windows is None and min_luma is None:  # gate:min-luma-gates
        return "ok", "", longest  # not-a-gate: the pass verdict of the gates
    failures: list[str] = []
    if max_static is not None and longest > max_static + EPS:  # gate:max-static-gate
        failures.append(f"GATE FAIL: longest static run {longest:.1f}s "  # gate:max-static-gate
                        f"({ls[0]:.1f}..{ls[1]:.1f}) > {max_static:g}s")
    windows = len(result["windows"])
    if min_windows is not None and windows < min_windows:  # gate:min-windows-gate
        failures.append(f"GATE FAIL: {windows} live window(s) < {min_windows} required — "  # gate:min-windows-gate
                        f"nothing in this range held motion long enough to count as an event")
    if min_luma is not None:
        luma = result.get("luma")
        if luma is None:
            return ("refuse", "GATE REFUSED: --min-luma given but no luma was measured", longest)  # gate:min-luma-needs-measurement
        if luma["mean"] < min_luma:  # gate:min-luma-gates
            failures.append(f"GATE FAIL: mean luma {luma['mean']:.1f} < {min_luma:g} — the take "  # gate:min-luma-gates
                            f"is black or nearly so (brightest frame {luma['max']:.1f})")
    if failures:
        return "fail", "\n".join(failures), longest  # gate:verdict-fail
    return "ok", "GATE OK", longest  # not-a-gate: the pass verdict of the gates


# ── decode (the one ffmpeg call) ────────────────────────────────────────────────────────

def parse_scale(value: str) -> tuple[int, int]:
    try:
        w, h = (int(p) for p in value.lower().split("x", 1))
    except ValueError:
        die(f"--scale must look like 192x108, got {value!r}")
    if w <= 0 or h <= 0:
        die(f"--scale must be positive, got {value!r}")
    return w, h


def parse_crop(value: str) -> tuple[int, int, int, int]:
    """'X,Y,WxH' -> (x, y, w, h), in SOURCE pixels (crop runs before the scale)."""
    try:
        x_s, y_s, wh = value.split(",", 2)
        w, h = (int(p) for p in wh.lower().split("x", 1))
        x, y = int(x_s), int(y_s)
    except ValueError:
        die(f"--crop must look like X,Y,WxH (e.g. 780,420,360x360), got {value!r}")
    if w <= 0 or h <= 0 or x < 0 or y < 0:
        die(f"--crop needs a positive size and a non-negative origin, got {value!r}")
    return x, y, w, h


def _ffprobe_field(video: Path, args: list[str]) -> str | None:
    """One `ffprobe -show_entries` scalar, or None if ffprobe is missing or unhappy."""
    if not shutil.which("ffprobe"):
        return None
    r = subprocess.run(["ffprobe", "-v", "error", *args, "-of",
                        "default=noprint_wrappers=1:nokey=1", str(video)],
                       capture_output=True, text=True, check=False)
    return r.stdout.strip() if r.returncode == 0 else None


def source_fps(video: Path) -> float | None:
    """The take's real frame rate, or None if ffprobe cannot say (advisory only)."""
    raw = _ffprobe_field(video, ["-select_streams", "v:0",
                                 "-show_entries", "stream=r_frame_rate"])
    if raw is None:
        return None
    try:
        num, _, den = raw.partition("/")
        rate = float(num) / float(den or 1)
    except (ValueError, ZeroDivisionError):
        return None
    return rate if rate > 0 else None


def source_duration(video: Path) -> float | None:
    """The take's full length in seconds, or None if ffprobe cannot say (report cosmetics)."""
    raw = _ffprobe_field(video, ["-show_entries", "format=duration"])
    if raw is None:
        return None
    try:
        seconds = float(raw)
    except ValueError:
        return None
    return seconds if seconds > 0 else None


def source_start_time(video: Path) -> float | None:
    """The container's FIRST timestamp, or None if ffprobe cannot say.

    Normally 0. When it is not — a re-mux with `-output_ts_offset`, a stream copy out of a
    longer recording, some capture muxers — a player and a cut list built from it show the take
    running at start_time..start_time+duration, while this probe's `--in`/`--out` are MEDIA
    seconds: ffmpeg's input seek is relative to the container start (measured on a
    `-output_ts_offset 12` re-mux — `--in 0.5 --out 4.0` decoded the right 3.5s, `--in 12.5
    --out 16.0` decoded NOTHING). That gap is the second thing a refused range can mean, and it
    is the one where re-shooting the take fixes nothing at all.
    """
    raw = _ffprobe_field(video, ["-show_entries", "format=start_time"])
    if raw is None:
        return None
    try:
        return float(raw)          # "N/A" (and any other non-number) -> unknown, never 0.0
    except ValueError:
        return None


def coverage_diagnosis(duration: float | None, start_time: float | None,
                       start_s: float, end_s: float | None, fps: float) -> str:
    """WHY a requested range came up short — the sentence appended to every range refusal.

    Two different failures produce the same shortfall and call for OPPOSITE actions, and the
    message used to name only the first one:

      * the take really IS shorter than the segment — the cut list outlived its footage, so the
        answer is a shorter range or a re-shoot;
      * the take is long enough but its container's timestamps START LATE, so an in/out read off
        a player is offset by exactly that much. Here the frames are all present and "re-shoot
        it" is a lie that costs a shoot day.

    So the numbers decide, not the phrasing: ffprobe's duration/start_time are the oracle, and
    when ffprobe cannot answer this says SO rather than picking the likelier story. Pure and
    fully unit-testable — the caller does the two ffprobe reads and passes them in.

    A late start_time is NOT on its own the second story: it is promoted to the verdict only when
    subtracting it actually ACCOUNTS for the shortfall (the shifted range fits the take). A range
    that overruns the take on the shifted scale too is a short take that merely happens to sit in
    a shifted container — "the frames are there, DO NOT re-shoot" would be false about it — so
    that case falls through to the short-take verdict and carries the offset only as an aside.

    `end_s is None` is the open-ended (`--in` only) case: the range then "reaches" its in-point.
    """
    slack = 1.0 / fps                       # one sample: the same unit the coverage check forgives
    edge = end_s if end_s is not None else start_s
    if end_s is not None and (end_s - start_s) < 2.0 / fps - EPS:
        # Nothing to do with the take's length: two samples is the floor for ONE difference.
        return (f"that range is only {end_s - start_s:g}s wide — thinner than the two samples "
                f"--fps {fps:g} needs ({2.0 / fps:g}s). Widen the range or raise --fps.")
    if duration is None:
        # Fail-loud: no oracle, no verdict. Guessing "re-shoot" here is how the false verdict
        # this whole branch exists to kill would come back under a nicer sentence. DELIBERATE
        # even when start_time IS known: a start_time without a duration cannot say whether the
        # shifted range would fit, so it cannot pick either story either.
        return ("ffprobe could not read this file's duration, so the probe CANNOT tell a take "
                "that is genuinely shorter than the range from a container whose timestamps "
                "start late — read them by hand (ffprobe -show_entries "
                "format=duration,start_time) before re-shooting anything.")
    short = edge > duration + slack
    # A start_time under one sample is container dust (a first PTS of 0.03s), never a story —
    # that is what `offset` being None below means. Above the dust floor it still only EXPLAINS
    # the shortfall when the shifted range fits; magnitude alone never promotes it.
    offset = start_time if start_time is not None and start_time > slack else None
    shifted_edge = edge - offset if offset is not None else edge
    # A negative shifted edge means the offset is LARGER than the asked range end — subtracting
    # it explains nothing, so it must not absolve an overrun (found by review:
    # coverage_diagnosis(5.0, 12.0, 0.0, 6.0, 10.0) printed DO-NOT-re-shoot for a genuine overrun).
    if offset is not None and short and 0.0 <= shifted_edge <= duration + slack:
        if start_s < offset:
            # No clamp to 0.0 here: a corrected in-point BELOW the container's own start is not
            # a range anybody could have read off the shifted timeline, and printing it as
            # "this range becomes 0..x" would invent an in-point the caller never asked for.
            advice = (f"Subtract it — but note --in {start_s:g} is itself BELOW that start, so "
                      f"it cannot have been read off the shifted timeline: check where the "
                      f"in-point came from. Or re-mux the take to a zero start_time.")
        else:
            asked = (f"{start_s - offset:g}.."
                     f"{'EOF' if end_s is None else f'{shifted_edge:g}'}")
            advice = (f"Subtract it (this range becomes {asked}) or re-mux the take to a zero "
                      f"start_time.")
        return (f"this container's timestamps START at {offset:.2f}s while --in/--out are MEDIA "
                f"seconds (0..{duration:.2f}s), and the SHIFTED range fits — so an in/out read "
                f"off a player or a cut list built on that timeline is {offset:.2f}s too high. "
                f"{advice} DO NOT re-shoot on this evidence: the frames are there, the "
                f"timestamps are offset.")
    hedge = ("" if start_time is not None else
             " (ffprobe reported no start_time, so a shifted container is not fully ruled out)")
    if short:
        # The offset, when there is one, survives only as an aside: it is real, it is just not
        # what made this range fall short.
        aside = ("" if offset is None else
                 f" (This container also STARTS at {offset:.2f}s, but even subtracting that the "
                 f"range still reaches {shifted_edge:g}s, so the offset does not explain the "
                 f"shortfall.)")
        return (f"the take is SHORTER than the segment: ffprobe reads {duration:.2f}s of source "
                f"against a range reaching {edge:g}s{hedge}. Probe the range the take really "
                f"has, or re-shoot it: a verdict over the first fraction of a segment certifies "
                f"nothing about the rest.{aside}")
    starts = ("starting at ~0s" if offset is None else
              f"starting at {offset:.2f}s — which the range fits under too")
    return (f"ffprobe reads {duration:.2f}s of source, {starts}, so the range FITS this take on "
            f"paper — the shortfall is neither a short take nor a timestamp offset. Suspect a "
            f"damaged or variable-rate stream{hedge}; inspect the file before re-shooting it.")


def decode(video: Path, fps: float, scale: tuple[int, int],
           crop: tuple[int, int, int, int] | None,
           start_s: float = 0.0, end_s: float | None = None) -> list[bytes]:
    """One ffmpeg call -> a list of equal-sized grayscale frames.

    The filter order is fixed: crop (source pixels) -> fps -> scale -> gray. A trailing
    partial frame (ffmpeg cut mid-write) is dropped LOUDLY; anything worse is fatal.

    `start_s`/`end_s` (`--in`/`--out`) restrict the decode to the half-open source range,
    inside this SAME ffmpeg call — no trim to a temp file, which is what the acceptance band in
    docs/RIG.md used to cost per row. Two things about that seek are load-bearing:

      * It is an INPUT-side seek (`-ss`/`-to` BEFORE `-i`) with `-accurate_seek` stated
        EXPLICITLY rather than left to the default. Input-side seek jumps to the keyframe
        before `start_s`; `-accurate_seek` then decodes and DISCARDS up to the exact requested
        timestamp, so the first frame handed to the fps filter is the one at `start_s` and not
        whatever the last keyframe happened to be — up to a whole GOP (seconds, here) of
        silently mis-attributed timeline.
      * The `fps` sampling grid therefore anchors at `start_s`, so sample k covers exactly
        [start_s + k/fps, start_s + (k+1)/fps) and the report offset is exactly +start_s
        (shift_times). Moving `-ss` AFTER `-i` is also frame-exact, but it anchors the grid at
        source 0 and drops the head afterwards, so a `--in` that is not a whole multiple of
        1/fps lands the first sample up to one frame late and +start_s becomes a lie. Measured
        both ways on 04_nav: identical bytes at `--in 0.6`, 52 vs 51 frames at
        `--in 0.65`.

    A closed range (`--out` given) is also checked for COVERAGE, not just for "at least two
    frames": a range that runs past the end of the file is refused instead of being answered
    over the fraction that happened to exist. Both range refusals carry an ffprobe oracle
    (`coverage_diagnosis`) so the operator is told WHICH failure it was — a take shorter than the
    segment, or a container whose timestamps start late — instead of a blanket "re-shoot it".
    """
    if not video.is_file():
        die(f"no such video: {video}")
    if not shutil.which("ffmpeg"):
        die("ffmpeg not on PATH — run under the dev shell ('nix develop -c ...')")
    src = source_fps(video)
    if src is not None and fps > src + 1e-6:
        # ffmpeg's fps filter UPSAMPLES by duplicating frames, and a duplicated frame has
        # MAD 0.0 — asking for more frames than the take has manufactures freezes that are
        # pure arithmetic. Warn rather than die: the caller may know what they are doing.
        warn(f"--fps {fps:g} is above the take's own {src:g} fps — the fps filter will "
             f"DUPLICATE frames and those duplicates read as static (MAD 0)")
    w, h = scale
    vf = f"{'crop=%d:%d:%d:%d,' % (crop[2], crop[3], crop[0], crop[1]) if crop else ''}" \
         f"fps={fps},scale={w}:{h},format=gray"
    seek: list[str] = []
    if start_s > 0.0:
        seek += ["-accurate_seek", "-ss", f"{start_s:.6f}"]
    if end_s is not None:
        seek += ["-to", f"{end_s:.6f}"]
    # -nostdin: without it ffmpeg grabs the PARENT's stdin to poll for its interactive keys and
    # swallows whatever a wrapper script was piping in there (bit a heredoc-driven write loop).
    cmd = ["ffmpeg", "-nostdin", "-v", "error", *seek, "-i", str(video), "-vf", vf,
           "-f", "rawvideo", "-"]
    r = subprocess.run(cmd, capture_output=True, check=False)
    if r.returncode != 0:
        die(f"ffmpeg exited {r.returncode} on {video}:\n{r.stderr.decode(errors='replace').strip()}")
    size = w * h
    raw = r.stdout
    count = len(raw) // size
    remainder = len(raw) % size
    if count < 2:
        # REFUSE, never a clamp to "whatever was in range". A range that lands past the end of
        # the file, or is thinner than two samples, has told us nothing about the take — and the
        # exit code has to say so, because the caller asked for a specific segment.
        where = (f" over --in {start_s:g}..--out {end_s:g}" if end_s is not None
                 else f" from --in {start_s:g}" if start_s > 0.0 else "")
        # A RANGE that came back empty gets the same duration/start_time oracle as a partly-covered
        # one below: "past its end" and "your in/out are 12s off because the container starts at
        # 12s" both land here, and only ffprobe can tell them apart. A whole-file run has no range
        # to be wrong about, so it is spared the two extra ffprobe calls.
        why = ("" if not where else
               " " + coverage_diagnosis(source_duration(video), source_start_time(video),
                                        start_s, end_s, fps))
        die(f"decoded {count} whole frame(s) (+{remainder}B partial) from {video}{where} — need "
            f"at least 2 to measure motion (is the take empty, the range past its end, or --fps "
            f"too low for its duration?).{why}")
    if end_s is not None:
        # A range can land PARTLY past the end of the file, and `count >= 2` is blind to it: a 4s
        # take probed `--in 0.6 --out 5.8` hands back 34 frames, sails through here, and earns a
        # duty and a GATE OK over 3.4s of the 5.2s segment the cut actually uses. That verdict is
        # about a DIFFERENT segment than the one asked about, delivered with a passing exit code —
        # the exact failure `--in`/`--out` exists to prevent, and the degenerate end of it is a
        # 2-frame decode certifying a 51-sample request on the strength of one MAD.
        #
        # ffmpeg's fps filter yields ceil((end-start)*fps) samples — MEASURED on synthesised clips:
        # 2.00..2.25 @10fps -> 3 frames, 0.33..1.77 -> 15, 3.00..4.999 -> 20; round()
        # gets the first two wrong. One frame of slack absorbs the fractional-boundary jitter: over
        # a sweep of ranges that ARE fully inside the file, across fps 3/5/10/24 and both integral
        # and fractional bounds, the worst shortfall observed was exactly 1 (and some ranges come
        # back one frame OVER). Past-the-end ranges miss by far more — 8 and 40 frames in the two
        # cases above — so the slack cannot swallow a real shortfall.
        expected = math.ceil((end_s - start_s) * fps - EPS)
        if count < expected - 1:
            # WHY it came up short is a second question, and answering it with a fixed sentence
            # was wrong half the time: "re-shoot it" is false when the footage is all there and
            # only the container's timestamps are offset (see coverage_diagnosis). The numbers
            # from ffprobe decide, and when ffprobe cannot answer the message says that instead.
            die(f"decoded {count} frame(s) over --in {start_s:g}..--out {end_s:g}, but that range "
                f"asks for ~{expected} @ {fps:g}fps — its frames run out around "
                f"{start_s + count / fps:.2f}s. "
                + coverage_diagnosis(source_duration(video), source_start_time(video),
                                     start_s, end_s, fps))
    if remainder:
        # Never silent: a truncated stream means the probe saw less of the take than the
        # report claims, and the direction of that error is "missed the freeze".
        warn(f"ffmpeg stream ended mid-frame — discarded {remainder}B of a {size}B frame "
             f"after {count} whole frames")
    return [raw[i * size:(i + 1) * size] for i in range(count)]


# ── report ──────────────────────────────────────────────────────────────────────────────

def pct(fraction: float | None) -> str:
    """A 0..1 duty as a percentage — 'n/a' when it is undefined, never a confident '0%'.

    Only the OVERALL duty can be undefined (nothing measured); a kept window always has samples,
    so the window lines below format their value directly.
    """
    return "n/a" if fraction is None else f"{fraction * 100:.1f}%"


def report(result: dict) -> None:
    m = result["meta"]
    s = result["stats"]
    d = result["duty"]
    crop = m["crop"] or "full frame"
    print(f"motion_probe: {m['video']}")
    print(f"  {m['duration']:.2f}s  {m['frames']} frames @ {m['fps']}fps  "
          f"{m['scale']}  {crop}")
    rng = m.get("range")
    if rng:
        # Say the range out loud, and say whose seconds the rest of the report is in: a window
        # printed as "19.90..23.40" is only actionable if the operator knows it is the SOURCE
        # timeline and not an offset into a segment that exists nowhere on disk.
        end = "EOF" if rng["out"] is None else f"{rng['out']:g}"
        total = ("unknown length" if rng["source_duration"] is None
                 else f"{rng['source_duration']:.2f}s")
        # ... and say which interval was actually DIFFERENCED, which is one sample shorter at the
        # tail: N frames yield N-1 MADs, so a probe of 0.6..5.8 @10fps cuts its windows and static
        # runs out of 0.6..5.70 and a freeze landing exactly on the out-point is invisible to it.
        # Printing only the request would leave an operator to read the missing 1/fps off the
        # window table as a bug. Observability only — the measurement itself is unchanged.
        diff_end = round(rng["in"] + m["covered"], 6)
        print(f"  range {rng['in']:g}..{end} of {total} (differenced {rng['in']:g}..{diff_end:g})"
              f"   [timestamps below are ABSOLUTE source seconds]")
    if m.get("preset"):
        print(f"  preset {m['preset']}  (live >= {m['thresh']}, min-live {m['min_live']:g}s)")
    print(f"  MAD  min={s['min']:.3f}  median={s['median']:.3f}  "
          f"p90={s['p90']:.3f}  max={s['max']:.3f}   (live >= {m['thresh']})")
    # Not a gate — the number to read WHEN THE GATE PASSES. A low duty under a clean verdict is
    # a take of blinks: no freeze long enough to fail, and nothing a viewer would call motion.
    print(f"  duty  {pct(d['overall'])} of samples live "
          f"({d['live_samples']}/{d['samples']})   [not gated — see --max-static]")
    if "luma" in result:
        lu = result["luma"]
        print(f"  luma  min={lu['min']:.1f}  mean={lu['mean']:.1f}  max={lu['max']:.1f}"
              f"   (per-frame mean gray, 0..255 — see --min-luma)")

    if result["windows"]:
        live = sum(b - a for a, b in result["windows"])
        print(f"  live windows ({live:.2f}s of {m['covered']:.2f}s):")
        # strict: the two lists are built in one pass and MUST stay index-aligned; a silent
        # zip truncation would print one window's duty next to another window's timestamps.
        for (a, b), wd in zip(result["windows"], d["windows"], strict=True):
            print(f"    {a:7.2f} .. {b:7.2f}  ({b - a:.2f}s, duty {wd * 100:.1f}%)")
    else:
        print("  live windows: NONE — nothing in this take clears the threshold")

    if result["static_runs"]:
        print("  static runs:")
        for a, b in result["static_runs"]:
            print(f"    {a:7.2f} .. {b:7.2f}  ({b - a:.2f}s)")
    else:
        print("  static runs: none")

    ls = result["longest_static"]
    if ls:
        print(f"  longest static run: {ls[1] - ls[0]:.2f}s ({ls[0]:.2f}..{ls[1]:.2f})")
    else:
        print("  longest static run: none")


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("video", type=Path)
    ap.add_argument("--fps", type=float, default=DEFAULT_FPS,
                    help=f"sampling rate for the probe (default {DEFAULT_FPS})")
    ap.add_argument("--scale", default=DEFAULT_SCALE,
                    help=f"WxH the frames are reduced to (default {DEFAULT_SCALE})")
    ap.add_argument("--crop", help="X,Y,WxH in SOURCE pixels — the second run, around the bot")
    ap.add_argument("--in", dest="in_s", type=float, metavar="SEC",
                    help="measure only from this second of the SOURCE (default: its start). "
                         "Reported timestamps stay ABSOLUTE source seconds")
    ap.add_argument("--out", dest="out_s", type=float, metavar="SEC",
                    help="measure only up to this second of the SOURCE, exclusive "
                         "(default: its end)")
    ap.add_argument("--thresh", type=float, default=DEFAULT_THRESH,
                    help=f"MAD at/above which a frame counts as live (default {DEFAULT_THRESH})")
    ap.add_argument("--bridge", type=float, default=DEFAULT_BRIDGE,
                    help=f"seconds: dead gaps shorter than this stay inside a live window "
                         f"(default {DEFAULT_BRIDGE})")
    ap.add_argument("--min-live", type=float, default=DEFAULT_MIN_LIVE,
                    help=f"seconds of ACTUALLY LIVE frames a window must hold to count "
                         f"(bridged dead frames do not pay towards it; default "
                         f"{DEFAULT_MIN_LIVE})")
    ap.add_argument("--max-static", type=float,
                    help="GATE: fail (exit 1) if the longest static run exceeds this many seconds")
    ap.add_argument("--min-windows", type=int, metavar="N",
                    help="GATE: fail (exit 1) if fewer than N live windows are accepted — the "
                         "gate for a STATIC shot, where the event happening is what counts")
    ap.add_argument("--min-luma", type=float, metavar="N",
                    help="GATE: fail (exit 1) if the mean luma (0..255) is under N — a black take")
    ap.add_argument("--preset", choices=sorted(PRESETS),
                    help="a MEASURED parameter set for a shot class the defaults are blind to; "
                         "explicit sensitivity flags still win (with a WARN), a --crop is "
                         "REFUSED. static-hook = a still camera with one brief event: --thresh "
                         f"{STATIC_HOOK_THRESH} --min-live {STATIC_HOOK_MIN_LIVE} "
                         f"--min-windows {STATIC_HOOK_MIN_WINDOWS}, full frame")
    ap.add_argument("--json", action="store_true", help="machine-readable result on stdout")
    return ap


def main(argv: list[str] | None = None) -> int:
    ap = build_parser()
    # Two-phase parse: the preset replaces the DEFAULTS, so a flag the operator typed still wins.
    # The first pass only needs --preset; argparse errors surface identically in the second.
    pre, _ = ap.parse_known_args(argv)
    preset = PRESETS.get(pre.preset) if pre.preset else None
    if preset is not None:
        ap.set_defaults(**preset)
    args = ap.parse_args(argv)
    if preset is not None:
        for key, calibrated in preset.items():
            given = getattr(args, key)
            if given == calibrated:
                continue
            if key in FRAMING_KNOBS:
                framing = calibrated if calibrated is not None else "the FULL frame"
                die(f"--{key} {given} under the {args.preset} preset: it was calibrated on "
                    f"{framing}, and another framing puts every measured MAD in a different "
                    f"unit (docs/RIG.md § Static hook shots) — drop --{key}, or drop the preset "
                    f"and choose --thresh/--min-live for that framing yourself")
            warn(f"--{key.replace('_', '-')} {given} overrides the "
                 f"{args.preset} preset's {calibrated} — its calibration (docs/RIG.md "
                 f"§ Static hook shots) no longer vouches for this run")

    # FINITENESS FIRST — every guard below is a comparison, and NaN defeats comparisons silently:
    # `nan < 0` and `nan <= 0` are both False, so a NaN walks past the whole block, emits no seek,
    # and surfaces as NaN timestamps, a "longest static run nans" verdict and a --json object
    # carrying bare `NaN` (which RFC-8259 does not allow and strict parsers reject) — measured
    # with `--in nan`, exit 1. An infinity gets as far as ffmpeg and dies there with
    # "Invalid duration for option ss", naming neither the flag nor the probe.
    for flag, value in (("--fps", args.fps), ("--thresh", args.thresh),
                        ("--bridge", args.bridge), ("--min-live", args.min_live),
                        ("--in", args.in_s), ("--out", args.out_s),
                        ("--max-static", args.max_static), ("--min-luma", args.min_luma)):  # gate:min-luma-finite
        if value is not None and not math.isfinite(value):
            die(f"{flag} must be a finite number, got {value}")
    if args.fps <= 0:
        die(f"--fps must be positive, got {args.fps}")
    if args.thresh <= 0:
        # thresh=0 marks EVERY frame live (MAD >= 0 always), so a frozen take reports 100 %
        # live and --max-static can never fail. A gate that cannot fail is not a gate.
        die(f"--thresh must be positive, got {args.thresh} — a zero threshold marks every "
            f"frame live and makes --max-static unfalsifiable")
    if args.bridge < 0:
        die(f"--bridge must not be negative, got {args.bridge}")
    if args.min_live < 0:
        die(f"--min-live must not be negative, got {args.min_live}")
    if args.in_s is not None and args.in_s < 0:
        die(f"--in must not be negative, got {args.in_s}")
    if args.min_windows is not None and args.min_windows < 1:
        # "at least 0 windows" holds for every take ever recorded — a gate that cannot fail.
        die(f"--min-windows must be at least 1, got {args.min_windows} — a lower bound of 0 "
            f"passes every take and gates nothing")
    # `ranged` is "a flag was passed", not "the range is non-trivial": --in 0 is still a range
    # the operator asked about and must be echoed back. start_s is the offset every reported
    # timestamp is re-based by, so it is the ONE place the implicit default lives.
    ranged = args.in_s is not None or args.out_s is not None
    start_s = args.in_s if args.in_s is not None else 0.0
    if args.out_s is not None and args.out_s <= start_s:
        # An empty or inverted range would decode nothing and the probe would then have to
        # invent a verdict about a segment it never saw. Refuse at the CLI instead of clamping
        # to something measurable: the answer would be about a different segment.
        die(f"--out must be greater than --in, got --in {start_s:g} --out {args.out_s:g}")
    scale = parse_scale(args.scale)
    crop = parse_crop(args.crop) if args.crop else None

    frames = decode(args.video, args.fps, scale, crop, start_s, args.out_s)
    mads = frame_mads(frames)
    result = classify(mads, args.fps, args.thresh, args.bridge, args.min_live)
    result["luma"] = frame_luma(frames)  # gate:min-luma-wired
    # The one re-basing onto the source timeline; everything printed below is absolute.
    shift_times(result, start_s)

    result["meta"] = {
        "video": str(args.video), "frames": len(frames), "fps": args.fps,
        "duration": round(len(frames) / args.fps, 4),
        "covered": round(len(mads) / args.fps, 4),
        "scale": f"{scale[0]}x{scale[1]}", "crop": args.crop,
        "thresh": args.thresh, "bridge": args.bridge, "min_live": args.min_live,
    }
    if ranged:
        # Only when a range was actually asked for: a whole-file run stays byte-identical to
        # what every recorded number in docs/RIG.md was produced by.
        result["meta"]["range"] = {"in": start_s, "out": args.out_s,
                                   "source_duration": source_duration(args.video)}
    if args.preset:
        # Same rule as `range`: only when asked, so a preset-free run's meta is unchanged.
        result["meta"]["preset"] = args.preset

    status, verdict, longest = gate_verdict(result, args.max_static, args.min_windows,
                                            args.min_luma)  # gate:min-luma-wired
    result["gate"] = {"max_static": args.max_static, "min_windows": args.min_windows,
                      "min_luma": args.min_luma,
                      "status": status, "ok": status == "ok",
                      "longest_static_s": round(longest, 4)}

    if args.json:
        print(json.dumps(result))
    else:
        report(result)

    if verdict:
        # With --json, stdout stays a single parseable object: the verdict goes to stderr.
        print(verdict, file=sys.stderr if args.json else sys.stdout)
    return {"ok": 0, "fail": 1, "refuse": 2}[status]


if __name__ == "__main__":
    raise SystemExit(main())
