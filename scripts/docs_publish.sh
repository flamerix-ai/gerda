#!/usr/bin/env bash
# docs_publish.sh — `just docs-publish`: push the MkDocs site to the `public` remote's gh-pages.
#
# The gh-pages commit is PUBLIC metadata, so it names nothing private: a fixed message (mkdocs'
# default `Deployed <sha> …` carries the source commit), and `--no-history` makes every deploy ONE
# parentless commit — the local gh-pages branch it would otherwise chain onto may hold older
# deploys with exactly those messages and another author. The deploy build is `--strict` (a
# warning, e.g. a broken link, aborts it), so the site that ships is the one that is checked.
#
# In the repo the public snapshot is cut from (marker: `scripts/private/` exists) the release
# guards are NOT optional: the working tree must be clean (the guards read their config from the
# working copy, the tree from HEAD — an uncommitted allowlist edit would excuse a committed leak),
# and the guard script and the public identity must exist and pass, or nothing is deployed. The
# guard writes the leak-scanned public tree into a temp dir and the site is built FROM THAT — so
# the deployed pages are exactly the scanned files (no working-copy edits, no untracked or
# private-named file the scan stripped, and no symlink out of the tree: the materialiser refuses
# every link). A fork has no `scripts/private/` and builds its own checkout.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"

CONFIG=mkdocs.yml
if [ -d scripts/private ]; then
  if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "docs_publish: working tree is dirty — commit first (the site is built from HEAD)" >&2
    exit 1
  fi
  SRC=$(mktemp -d)
  trap 'rm -rf "$SRC"' EXIT
  bash scripts/private/docs_publish_guard.sh "$SRC"
  . scripts/private/public_identity.sh
  CONFIG=$SRC/mkdocs.yml
fi
uvx --with mkdocs-material mkdocs gh-deploy --strict --config-file "$CONFIG" --remote-name public \
  --force --no-history -m "Deploy docs"
