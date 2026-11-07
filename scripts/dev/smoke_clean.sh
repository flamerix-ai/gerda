#!/usr/bin/env bash
# smoke_clean.sh — clean-machine bring-up smoke, in a rootless container.
#
# Proves that the README/SETUP host-side path works on a stock distro with NONE of
# this machine's state: install bun + python + ffmpeg, clone the repo, run the full check
# (tsc + biome + defensive + vitest + python unit tests), build the bundle, and
# deploy it into a fake launcher instance via sync.py with MC_INSTANCES_ROOT set.
# It cannot boot Minecraft — the in-game layers stay covered by `just gate-live`.
#
#   just smoke-clean                 # ubuntu:24.04 (default)
#   just smoke-clean archlinux       # alt distro
#
# Needs podman (rootless is fine). The repo is cloned from the local checkout
# (file://), so only COMMITTED state is smoked — a dirty tree won't leak in.
set -euo pipefail

# -h/--help prints the header above and touches nothing (no podman, no git).
case "${1:-}" in
  -h|--help) awk 'NR > 1 && /^set -euo/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"; exit 0 ;;
esac

IMAGE="${1:-ubuntu:24.04}"
# SMOKE_REPO lets a caller point the smoke at a different repo — the private fork smoke aims
# it at a materialized public snapshot so the same bring-up runs against the published tree.
REPO="${SMOKE_REPO:-$(git rev-parse --show-toplevel)}"

case "$IMAGE" in
  ubuntu*|debian*)
    BOOTSTRAP='apt-get update -qq && apt-get install -y -qq curl git unzip ca-certificates python3 ffmpeg >/dev/null'
    ;;
  archlinux*)
    BOOTSTRAP='pacman -Sy --noconfirm --quiet curl git unzip python ffmpeg >/dev/null'
    ;;
  *)
    echo "smoke_clean: unknown image family '$IMAGE' (teach me its bootstrap line)" >&2
    exit 2
    ;;
esac

# In a git WORKTREE, $REPO/.git is a one-line file pointing at an absolute path under the
# main checkout's .git/worktrees/ — which is outside the bind mount, so the container's
# clone dies with "not a git repository". Mount the common git dir at its own absolute path
# so that pointer resolves inside the container too. In a normal checkout the common dir IS
# $REPO/.git, already covered by the mount above, and this adds nothing.
COMMON_GIT=$(cd "$REPO" && git rev-parse --path-format=absolute --git-common-dir)
EXTRA_MOUNT=()
case "$COMMON_GIT" in
  "$REPO"/.git) ;;
  *) EXTRA_MOUNT=(-v "$COMMON_GIT:$COMMON_GIT:ro") ;;
esac

echo "== smoke-clean: $IMAGE =="
podman run --rm \
  -v "$REPO:/repo:ro" \
  "${EXTRA_MOUNT[@]}" \
  -e BOOTSTRAP="$BOOTSTRAP" \
  "$IMAGE" \
  bash -eu -o pipefail /repo/scripts/dev/smoke_clean_inner.sh

echo "== smoke-clean: PASS ($IMAGE) =="
