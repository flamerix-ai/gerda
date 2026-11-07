#!/usr/bin/env bash
# Generic during-trigger: wait for the recording to actually roll, then send ONE
# bridge command to the worker. shoot.py fires "bot" commands BEFORE record.sh
# starts, so any action faster than ~5 s (drill descent ~2 blocks/s, greedy
# sprint-leap) happens off-camera — during + this script is the fix
# (lesson: take 1 of 02b, shoot day 3, bot sank out of frame before frame 1).
# Usage: trigger_bot.sh <sleep_s> <type> <json> [port=55545] [timeout_s]
# timeout_s is bridge_ctl's --timeout (omitted = its default): a command whose reply comes
# after a long in-game wait (ext.js prospect) needs more than the default.
set -eu
sleep "${1:?sleep seconds}"
extra=()
if [ -n "${5:-}" ]; then
    extra=(--timeout "$5")
fi
python3 "$(dirname "$0")/../ops/bridge_ctl.py" --port "${4:-55545}" ${extra[@]+"${extra[@]}"} send "${2:?cmd type}" "${3:?json payload}"
