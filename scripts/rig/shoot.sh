#!/usr/bin/env bash
# shoot.sh — the body of `just shoot`: roll shot-list takes against the RUNNING rig.
#
#   just shoot 01_clutch [more ids]                       # ids from scenarios/shots/teaser.json
#   SHOTLIST=scenarios/shots/other.json just shoot 03_vein
#   CAM_WAYLAND=wayland-3 just shoot 01_clutch            # pin the display instead of resolving it
#
# `just shoot` runs this INSIDE `nix develop .#capture`, which is the whole point: once
# scripts/demo/shoot.py was run from a plain shell, wf-recorder was not on PATH, and a shot was
# staged and driven (the bot command fired) before record.sh found it had nothing to record
# with — a lost take. Two things a raw invocation got wrong, and this wrapper removes:
#
#   * the TOOLS — wf-recorder/swaymsg exist only in the capture devShell;
#   * the DISPLAY — WAYLAND_DISPLAY has to name the CAMERA's headless sway. The operator's
#     terminal carries the DESKTOP's (no HEADLESS-1 there), and a shoot day runs two headless
#     sways (worker and camera boot their own), so the inherited value is ignored on purpose.
#     It is resolved from the client listening on the camera bridge port (sway_windows.py
#     display), or taken from CAM_WAYLAND — the name capture_rig.sh gives it in `-H` hooks.
#
# Every precondition fails loudly BEFORE shoot.py stages anything. shoot.py boots nothing — the
# worker and camera must already be up (docs/RIG.md § Shot runner).
set -euo pipefail
cd "$(dirname "$0")/../.."

SHOTLIST="${SHOTLIST:-scenarios/shots/teaser.json}"
# No port here: sway_windows.py owns it (DEFAULT_CAM_PORT), and SHOOT_CAM_PORT reaches its
# --port default through the environment.

die() { echo "just shoot: $*" >&2; exit 1; }

[ "$#" -ge 1 ] || die "name the shot id(s) to roll, e.g. 'just shoot 01_clutch' — list them with 'python3 scripts/demo/shoot.py list $SHOTLIST'"
[ -f "$SHOTLIST" ] || die "no shot list at $SHOTLIST (SHOTLIST=<path> picks another)"
for bin in wf-recorder swaymsg ffprobe; do
  command -v "$bin" >/dev/null || die "'$bin' is not on PATH — this must run inside 'nix develop .#capture' (the 'just shoot' recipe does that; do not call this script bare)"
done

if [ -n "${CAM_WAYLAND:-}" ]; then
  # A pin is VERIFIED, not trusted: a live sway with HEADLESS-1 that holds the window of the
  # client listening on the camera port. A stale name (a SIGKILL'd sway leaves its wayland-N file
  # behind), the desktop's own display and the WORKER's headless sway all fail here.
  DISPLAY_NAME="$(python3 scripts/rig/sway_windows.py display --check "$CAM_WAYLAND")" \
    || die "CAM_WAYLAND=$CAM_WAYLAND is not the camera's recordable headless sway (reason above)"
else
  DISPLAY_NAME="$(python3 scripts/rig/sway_windows.py display)" \
    || die "could not resolve the camera's headless display (reason above) — boot the camera, or pin it with CAM_WAYLAND=wayland-N"
fi

export WAYLAND_DISPLAY="$DISPLAY_NAME"
echo "just shoot: $SHOTLIST [$*] → recording $WAYLAND_DISPLAY"
exec python3 scripts/demo/shoot.py shoot "$SHOTLIST" "$@"
