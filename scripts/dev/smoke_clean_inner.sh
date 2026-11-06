#!/usr/bin/env bash
# Inner half of smoke_clean.sh — runs INSIDE the container. Expects $BOOTSTRAP
# (distro package-install line) from the wrapper, and the host checkout mounted
# read-only at /repo. Clones COMMITTED state to /work and brings it up from zero.
set -euo pipefail

eval "$BOOTSTRAP"

# Bun via the official installer (same command SETUP.md gives non-Nix users).
curl -fsSL https://bun.sh/install | bash >/dev/null 2>&1
export PATH="$HOME/.bun/bin:$PATH"
echo "bun $(bun --version), $(python3 --version), $(git --version | cut -d' ' -f3)"

git clone -q file:///repo /work
cd /work

bun install --frozen-lockfile
bun run check
python3 -m unittest discover -q -s scripts/tests -t scripts/tests
python3 -m unittest discover -q -s scripts/objective/tests -t scripts/objective/tests
bun run build

# Deploy into a fake launcher instance — proves sync.py's env-tier config path
# (driven through the gerda CLI, so the dispatcher gets smoked too).
mkdir -p /tmp/instances/SmokePack/minecraft/config/jsMacros/Macros
MC_INSTANCES_ROOT=/tmp/instances ./gerda sync

MACROS=/tmp/instances/SmokePack/minecraft/config/jsMacros/Macros
for f in __gerda_bot.bundle.js main.js bridge.js worker.js ext.js bridge_port.txt; do
  test -f "$MACROS/$f" || { echo "MISSING after deploy: $f" >&2; exit 1; }
done
echo "deploy OK: bundle + harness landed in the fake instance"
