#!/usr/bin/env bash
# Film trigger (teaser 01_clutch): once the take is rolling, tap W just long enough for the
# bot to step off the ledge. Run by shoot.py as a `during` driver, cwd = repo root.
# BOT_PORT: the worker bridge (55545 = bot_1).
#
# WHY a short IN-GAME-timed tap and an explicit key reset:
#   * The old 1.4 s host-side hold kept the bot walking through the whole ~1 s fall, so it
#     cleared the 4-wide pit under the ledge (x -342..-339, air-mapped from the camera
#     client) and landed on the east ground at x=-334.7 / y79 (take 21:17).
#   * A host-side "0.35 s" tap is really ~0.8 s: each bridge_ctl call is a fresh python
#     start-up (~0.4 s). It still landed on the east rim step at x=-338.06 / y78 (take
#     21:24). So the tap is timed inside the game: ONE jeval presses W and a background
#     Java thread releases it after 500 ms (same thread pattern CLAUDE.md prescribes for
#     timed actions — never Thread.sleep on the render thread).
#   * Physics floor of the SHIPPED tap (measured, supersedes the host-timed numbers above):
#     the ledge edge is 1.8 blocks east of the spawn, and 300 ms moved the bot only 1.3
#     blocks (x -341.5 → -340.2, take 21:48) — short of the edge, so it never left the
#     ledge. 500 ms ≈ 10 ticks clears it and, unlike the host-timed taps, does NOT carry the
#     bot across the pit: it drops INSIDE the 4-wide shaft (x -342..-339) and lands at
#     x≈-338.8..-339.3 / y72 (measured 21:58 and 22:07, WATER_CLUTCH_PLACE +
#     WATER_CLUTCH_RETRIEVED in the journal) — i.e. on the pad, ~20 blocks down, not on the
#     east rim. The camera pose in teaser.json 01_clutch is framed on THAT landing: static,
#     low and close on the pit's WEST column (-341.5, 73.8, yaw -90), 1.8 over the pad.
#   * A latched sprint from an earlier navigator run makes the overshoot worse, so sprint
#     and forward are released before the tap.
set -e
cd "$(dirname "$0")/../.."
sleep 2
python3 scripts/ops/bridge_ctl.py --port "${BOT_PORT:-55545}" send jeval '{"code":"KeyBind.keyBind(\"key.sprint\", false); KeyBind.keyBind(\"key.forward\", false); new java.lang.Thread(JavaWrapper.methodToJava(function(){ java.lang.Thread.sleep(500); KeyBind.keyBind(\"key.forward\", false); })).start(); KeyBind.keyBind(\"key.forward\", true); \"tapped\""}' >/dev/null 2>&1
sleep 1.5
echo "walk-off trigger done"
