#!/usr/bin/env python3
"""mc_shot.py — get a screenshot of the live Minecraft window for the AI to read.

Two routes to a PNG, both writing the SAME single file (default /tmp/mc_shot.png,
overwritten every call — never an accumulating pile):

  grim  (default) — capture from the niri/Wayland compositor via `grim`. Works for
        ANY GUI, including custom-rendered ones (FTB Quests, GTCEu machine UIs) the
        in-game text scrape can't see. niri composites only the visible workspace
        and can't grab an off-screen toplevel (tested: `grim -T` unsupported), so MC
        must be the visible window. If it isn't, we REFUSE by default (no flicker);
        --force allows a brief focus switch (we save + restore your focus, ~0.5s).

  --latest / --file — read a PNG MC itself wrote to its screenshots/ folder, resized
        via ffmpeg. Zero flicker, works while MC is unfocused (it renders its own
        framebuffer — needs vsync OFF so it keeps rendering off-screen). --latest =
        newest file (you pressed F2); --file [NAME] = a specific one (default
        ai_shot.png, written by the `screenshot` bridge command, which the AI can
        trigger itself via jsMacros Player.takeScreenshot). Sources are never deleted.

WHICH INSTANCE the file modes read: the human one by default, or the instance whose
absolute `minecraft` dir is in `MC_INST` (same env as arena.py's `marker` op) — set it
when the shot came from a bot/camera client, or `--file` hands you the HUMAN instance's
stale ai_shot.png instead of the frame you just triggered.

The bot screenshots itself: the `screenshot` bridge command (docs/EYES_HANDS.md § Eyes)
calls jsMacros Player.takeScreenshot on the render thread and writes ai_shot.png, which
`--file` then reads. What fails is only triggering vanilla's F2 key binding
programmatically from jsMacros; a real F2 press works (read it with --latest).

TOKEN COST scales with PIXELS, not bytes. --scale downsizes: 0.5→1280x720≈1200tok,
0.33→844x475≈530, 0.25→640x360≈300. --crop grabs one region (~100tok). Downscale/
crop apply in BOTH modes (grim natively; --latest via ffmpeg).

Usage:
    python scripts/ops/mc_shot.py [-o OUT] [-s SCALE] [-g "X,Y WxH"] [--force]
    python scripts/ops/mc_shot.py --latest [-s SCALE] [-g "X,Y WxH"]
Prints the output path on success; non-zero exit + stderr otherwise.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # scripts/ root
import local_config  # noqa: E402

APP_ID_NEEDLE = "minecraft"
DEFAULT_OUT = "/tmp/mc_shot.png"


def _resolve_instance() -> str:
    """The game dir whose `screenshots/` we read. `MC_INST` (an ABSOLUTE path to an instance's
    `minecraft` dir, resolved by `local_config.mc_inst_override` — the same env, and the same
    fail-loud check, as arena.py's `marker` op) WINS, else the human instance. Without it a
    bot/camera client's shot could only be pulled by hand-running ffmpeg, and `--file` would
    silently hand back the HUMAN instance's stale ai_shot.png (exactly how it once burned us)."""
    override = local_config.mc_inst_override()
    if override is not None:
        return str(override)
    return str(local_config.instance_dir(local_config.get("humanInstance", "Monifactory")) / "minecraft")


# `-h` must work on a machine with no launcher yet, so help skips the lookup (fail-loud stays
# for every real run).
if __name__ == "__main__" and {"-h", "--help"} & set(sys.argv[1:]):
    INSTANCE = "MC_INST, else the human instance — resolved when the tool runs"
else:
    INSTANCE = _resolve_instance()
SCREENSHOTS_DIR = os.path.join(INSTANCE, "screenshots")


def _niri(*args: str) -> str:
    return subprocess.check_output(["niri", "msg", *args], text=True)


def _find_mc() -> dict | None:
    for w in json.loads(_niri("--json", "windows")):
        if APP_ID_NEEDLE in (w.get("app_id") or "").lower():
            return w
    return None


def _parse_crop(crop: str) -> tuple[int, int, int, int]:
    """'X,Y WxH' -> (x, y, w, h)."""
    m = re.fullmatch(r"\s*(\d+),(\d+)\s+(\d+)x(\d+)\s*", crop)
    if not m:
        raise ValueError(f"bad --crop {crop!r}; expected 'X,Y WxH' e.g. '730,320 1100x800'")
    x, y, w, h = (int(g) for g in m.groups())
    return x, y, w, h


def _grab_grim(out: str, scale: float, crop: str | None, force: bool) -> int:
    if os.environ.get("MC_INST"):
        # MC_INST selects an instance's screenshots/ DIR; grim captures whatever the compositor
        # is showing. Say so rather than let a caller who set it believe they got that instance's
        # frame — an off-screen client is not on any visible output at all.
        print(
            "WARN: grim ignores MC_INST (it captures the visible window, not an instance's "
            "screenshots/) — use --file/--latest to read that instance's own shot.",
            file=sys.stderr,
        )
    mc = _find_mc()
    if not mc:
        print("ERR: no Minecraft window found (is the game running?)", file=sys.stderr)
        return 2
    switched, prev = False, None
    if not mc.get("is_focused", False):
        if not force:
            print(
                "ERR: MC is not the active window — capture would flicker. Focus MC "
                "yourself, pass --force, or use --latest (read an F2 shot).",
                file=sys.stderr,
            )
            return 3
        prev = json.loads(_niri("--json", "focused-window")).get("id")
        _niri("action", "focus-window", "--id", str(mc["id"]))
        switched = True
        time.sleep(0.45)
    try:
        cmd = ["grim", "-s", str(scale)]
        if crop:
            cmd += ["-g", crop]
        cmd.append(out)
        subprocess.check_call(cmd)
    finally:
        if switched and prev is not None:
            time.sleep(0.15)
            try:
                _niri("action", "focus-window", "--id", str(prev))
            except Exception:
                pass
    return 0


def _grab_file(out: str, scale: float, crop: str | None, fname: str | None) -> int:
    """Resize/crop an existing PNG from the MC screenshots dir into `out`.

    fname=None → newest file (an F2 press). fname set → that exact file (e.g.
    "ai_shot.png" written by the `screenshot` bridge command). Source is never
    deleted — they're the user's shots.
    """
    if fname:
        src = os.path.join(SCREENSHOTS_DIR, fname)
        if not os.path.exists(src):
            print(f"ERR: {src} not found (trigger the `screenshot` bridge command first).", file=sys.stderr)
            return 2
    else:
        shots = glob.glob(os.path.join(SCREENSHOTS_DIR, "*.png"))
        if not shots:
            print(f"ERR: no screenshots in {SCREENSHOTS_DIR} (press F2 in-game first).", file=sys.stderr)
            return 2
        src = max(shots, key=os.path.getmtime)
    filters = []
    if crop:
        x, y, w, h = _parse_crop(crop)
        filters.append(f"crop={w}:{h}:{x}:{y}")
    if scale != 1.0:
        filters.append(f"scale=iw*{scale}:ih*{scale}")
    if not filters:  # straight copy, no re-encode needed beyond container
        filters.append("null")
    subprocess.check_call(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", src, "-vf", ",".join(filters), out]
    )
    print(f"(from {os.path.basename(src)})", file=sys.stderr)
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Screenshot the Minecraft window for the AI to read.")
    ap.add_argument("-o", "--out", default=DEFAULT_OUT, help=f"output PNG (default {DEFAULT_OUT}, overwritten)")
    ap.add_argument("-s", "--scale", type=float, default=0.5, help="downscale factor (default 0.5)")
    ap.add_argument("-g", "--crop", default=None, help='region "X,Y WxH", e.g. "730,320 1100x800"')
    ap.add_argument("--force", action="store_true", help="(grim) allow a focus switch if MC is tabbed away")
    ap.add_argument(
        "--latest",
        action="store_true",
        help="read newest in-game shot (F2) instead of grim — no flicker; obeys MC_INST like --file",
    )
    ap.add_argument(
        "--file",
        nargs="?",
        const="ai_shot.png",
        default=None,
        help=(
            "read a specific shot from screenshots/ (default ai_shot.png, written by the `screenshot` "
            "bridge cmd) — no flicker; env MC_INST=<abs path to an instance's minecraft dir> picks "
            f"WHICH instance (current: {INSTANCE})"
        ),
    )
    args = ap.parse_args()

    if args.crop:
        _parse_crop(args.crop)  # validate early

    if args.file is not None:
        rc = _grab_file(args.out, args.scale, args.crop, args.file)
    elif args.latest:
        rc = _grab_file(args.out, args.scale, args.crop, None)
    else:
        rc = _grab_grim(args.out, args.scale, args.crop, args.force)
    if rc == 0:
        print(args.out)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
