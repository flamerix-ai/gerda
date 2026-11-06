set shell := ["bash", "-c"]
# Git Bash's bash on Windows. just searches System32 before PATH, so a bare `bash` is WSL's
# bash.exe whenever WSL is installed, from Git Bash too. Windows has no `env` of its own: just
# finds Git's on PATH (Git Bash's, or Git's usr\bin when added to the system PATH), and it runs
# Git's /usr/bin/bash; without it, just reports that it cannot find the shell `env`.
set windows-shell := ["env", "/usr/bin/bash", "-c"]

# `just --list` shows only the comment line directly above a recipe, so each recipe's one-line
# summary is that LAST line; any longer rationale sits above it. `[private]` hides release tooling
# of the private repo from the list (the recipes still run). No `[doc]`/`[group]`: Ubuntu 24.04
# ships just 1.21, which predates them.

# just starts every recipe in the justfile's directory (in the given one under
# `--working-directory`), so none `cd`s there: an interpolated Windows path (`C:\Users\…`) loses
# its backslashes under bash. On Windows `python3` is the Microsoft
# Store stub (exit 49), and a piped cp1252 stdout cannot encode the tools' arrows; an empty
# PYTHONUTF8 is the same as unset, and elsewhere the export passes an inherited value on.
python := if os_family() == "windows" { "python" } else { "python3" }
export PYTHONUTF8 := if os_family() == "windows" { "1" } else { env_var_or_default("PYTHONUTF8", "") }

# Bare `just` lists every recipe (the umbrella script CLI is `./gerda`)
default:
    @just --list --unsorted

# Build the TS bundle (tsup → dist/__gerda_bot.bundle.js)
build:
    bun run build

# Build + deploy to game instances; extra args pass through (e.g. `just sync -s yourbot.js -n yourbot.js`)
sync *args: build
    {{python}} gerda sync {{args}}

# What it rejects: validate_bundle() in scripts/ops/sync.py; which hook runs it: docs/TESTING.md.
# Extra args pass through (e.g. `just validate-bundle path/to/other.js`).
# Run the deploy-time bundle check without deploying (needs no game)
validate-bundle *args:
    {{python}} scripts/ops/sync.py --validate-only {{args}}

# Needs `fd` and `entr` (Ubuntu: apt install fd-find entr, and link fdfind to fd)
# Rebuild + redeploy on every change under src/ (needs fd + entr)
watch:
    fd . src | entr -rsh -c 'bun run build && {{python}} gerda sync'

# Point git at the versioned hooks (.githooks/); what each hook runs: docs/TESTING.md
hooks:
    git config core.hooksPath .githooks

# Which hook runs what: docs/TESTING.md. The TS half, plus the python host-tool suites (they
# used to run ONLY in the hook, so `just check` could go green on a commit the hook then rejected),
# plus the mutants of the host-tool guards.
# The full offline gate (TS half + python suites + mutants), run by pre-push
check: check-ts test-py mutants

# The python suites take over a minute, so they wait for pre-push.
# The TS half of `check` (tsc + biome + defensive checker + vitest) + the gate-tag lint, run by pre-commit
check-ts: gate-tags
    bun run check

# What it checks: scripts/dev/mutants.py (lint); the rule: docs/TESTING.md § Mutants of the host-tool guards.
# Every die-shaped line of the tagged host tools is `# gate:<id>` (with a mutant) or `# not-a-gate:`
gate-tags:
    {{python}} scripts/dev/mutants.py lint

# One mutant: `just mutants sandbox <name>`; the list: `python3 scripts/dev/mutants.py list`.
# Break each tagged guard in a temp copy; its tests must fail with the expected message
mutants *args:
    {{python}} scripts/dev/mutants.py run {{args}}

# Edit the source rows (main.js META_COMMANDS, ext.js plugin metas, WORKER_COMMAND_DOCS), never
# the output: the same test file fails the commit while docs/COMMANDS.md differs from a fresh render.
# Regenerate docs/COMMANDS.md, the bridge command reference, from the command source tables
commands-ref:
    GERDA_WRITE_COMMANDS=1 bun run test test-ts/commands-ref.test.ts

# Unit tests only (vitest)
test:
    bun run test

# In the private repo (marker: scripts/private/ exists) the public-snapshot guard suite is part of
# it — a missing guard suite there fails instead of skipping. `-b` (public suites) hides
# the output of PASSING tests (the sync.py cases print ERROR/FAILED lines on purpose); a failure
# still shows it.
# Python host-tool unit tests (stdlib unittest; host tooling + the objective engine)
test-py:
    {{python}} -m unittest discover -b -s scripts/tests -t scripts/tests && {{python}} -m unittest discover -b -s scripts/objective/tests -t scripts/objective/tests
    @if test -d scripts/private; then {{python}} -m unittest discover -s scripts/private/tests -t scripts/private/tests; fi

# Clean-machine bring-up smoke in a rootless container (podman; IMAGE=archlinux for the alt distro)
smoke-clean IMAGE="ubuntu:24.04":
    bash scripts/dev/smoke_clean.sh {{IMAGE}}

# Same smoke, but against the PUBLIC snapshot tree — private release tooling, absent from a fork
[private]
fork-smoke IMAGE="ubuntu:24.04":
    @test -f scripts/private/smoke_fork.sh || { echo "fork-smoke is release tooling of the private repo — it is stripped from the public snapshot, and there is nothing for a fork to verify here (use 'just smoke-clean')"; exit 2; }
    bash scripts/private/smoke_fork.sh {{IMAGE}}

# Pre-push runs it (docs/TESTING.md). Private release tooling, absent from a fork. The scan reads
# its guard config from the checkout, so that config must match HEAD.
# Leak-scan the PUBLIC snapshot of HEAD — the tree a publish would ship — without publishing
[private]
pubsim:
    @test -f scripts/private/public_tree.sh || { echo "pubsim is release tooling of the private repo — it is stripped from the public snapshot, and a fork has no snapshot to scan"; exit 2; }
    @git diff --quiet HEAD -- scripts/private || { echo "pubsim: scripts/private/ differs from HEAD — the scan reads its guard config from the checkout, so an uncommitted edit there could excuse a committed leak; commit or revert it first"; exit 1; }
    bash scripts/private/public_tree.sh --release

# Docs site preview at http://127.0.0.1:8000 (MkDocs Material via uvx, zero install)
docs-serve:
    uvx --with mkdocs-material mkdocs serve

# Build the docs site into site/ (gitignored) — the strict flag fails on broken links
docs-build:
    uvx --with mkdocs-material mkdocs build --strict

# Serving needs github.com/flamerix-ai/gerda to be public. In the private repo the release guards
# (remote pin, leak scan) are mandatory and the site is built from the scanned tree, not the
# working copy; the deploy build itself is --strict — see scripts/docs_publish.sh.
# Publish the docs site to the PUBLIC repo's gh-pages (maintainer release tooling)
[private]
docs-publish:
    bash scripts/docs_publish.sh

# Build+run the in-game arenas vs a connected OPPED test bot (default core set; --all / names). Local pre-merge gate, not CI — see docs/TESTING.md; de-op after
gate-live *arenas:
    {{python}} gerda gate {{arenas}}

# Runs inside the capture devShell (wf-recorder/swaymsg/ffprobe), recording the CAMERA's headless
# sway — resolved from the client on the camera bridge port, never the inherited WAYLAND_DISPLAY.
# Ids pass through to shoot.py; SHOTLIST=<json> (default teaser.json), CAM_WAYLAND=wayland-N,
# SHOOT_CAM_PORT override.
# Roll shot-list takes against the RUNNING film rig (docs/RIG.md § Shot runner; Nix only)
shoot +ids:
    nix develop .#capture -c bash scripts/rig/shoot.sh {{ids}}

# Extract GTCEu ore list from GitHub source (legacy/future pack profile — see extract-ores-live)
extract-ores:
    {{python}} gerda extract-ores

# Then `just build` and commit the diff — the json is imported at build time
# (src/bot/profile/pack.ts → cfg.ore.ids).
# Regenerate config/ores_live.json from the LIVE Forge registry (needs a running bot)
extract-ores-live *args:
    {{python}} gerda extract-ores-live {{args}}

# Full pipeline: extract ores + build + sync
all: extract-ores sync
