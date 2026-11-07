#!/usr/bin/env bash
# Example: a first driving session over the TCP bridge — run each block by hand.
# Prerequisites: docs/SETUP.md done (services registered, bridge on 127.0.0.1:55544).
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
CTL="python3 scripts/ops/bridge_ctl.py"

# 1. Is anything listening? (answered by bridge.js itself — works even if main is down)
# No bridge → one `ERR: no bridge at <host>:<port> …` line saying what to check, rc 2.
# The host comes from MC_BRIDGE_HOST (default: loopback, then the WSL gateway).
$CTL ping

# 2. What state is the bot in? (position, health, held tool, worker liveness)
$CTL get_state

# 3. Look around: block scan + inventory.
$CTL send scan '{"radius": 16}'
$CTL inventory

# 4. Move: the navigator walks there (terrain-aware — bridges, ladders, parkour).
# Pick coordinates near the bot's current position from get_state.
# $CTL goto 100 64 200

# 5. Start a real mission: prospect → shaft → strip-mine the vein.
# $CTL send mission_start '{"name": "drill", "params": {"ore": "iron"}}'
# $CTL send mission_status      # poll progress (phase, vein target, bands)

# 6. Take over / hand back at any time (walking manually also auto-PAUSEs it).
# $CTL pause
# $CTL resume

# 7. Watch the bot think: tail the NDJSON journal (state transitions + events).
$CTL get_logs
