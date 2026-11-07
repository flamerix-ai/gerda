#!/usr/bin/env bash
# fullscreen.sh — pick WHICH Minecraft client the headless capture actually sees.
#
#   scripts/rig/fullscreen.sh --list                  # every MC window sway knows about
#   scripts/rig/fullscreen.sh Monifactory_bot_1       # make that instance the recorded one
#
# WHY this exists: wf-recorder records an OUTPUT, not a window. When both clients end up on
# one headless sway output (the usual shoot-day layout), the output shows whichever con is
# FULLSCREEN — so the GUI insert of shot 02a_prospect (the prospector GUI is drawn on the
# BOT's client and is invisible to the camera) needs the bot's window fullscreened for the
# insert take, and the camera's put back for the next one. That flip is this script.
#
# NOT an options.txt setting. `fullscreen:` in options.txt is MC's own borderless-vs-window
# mode inside its output; it does not decide which of two windows a headless output composites,
# and toggling it on Xwayland is exactly the glfwSetWindowPos ground the modded client crashes
# on (see capture_rig.sh's header). The compositor is the only honest lever, so capture_profile.py
# stays purely about options.txt and the window choice lives here.
#
# The window resolution (instance by PID, never by window title) lives in sway_windows.py, which
# `just shoot` also uses to find the camera's display — one copy, two callers.
#
# Searches every live sway-ipc socket unless SWAYSOCK is set (capture_rig exports the camera's
# as CAM_SWAYSOCK). swaymsg must be on PATH — run under `nix develop .#capture`.
set -uo pipefail
[ "$#" -ge 1 ] || { echo "usage: fullscreen.sh {--list|<instance>}" >&2; exit 2; }
if [ "$1" = "--list" ]; then
  exec python3 "$(dirname "$0")/sway_windows.py" list
fi
exec python3 "$(dirname "$0")/sway_windows.py" fullscreen "$1"
