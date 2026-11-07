"""machine_root — the directory that owns this repo's machine STATE files.

`mc-bots.json` / `mc-tasks.json` (fleet_registry, fleet_hub) and `local.config.json` (local_config)
are host-specific and gitignored, so they exist ONLY in the main checkout. Not every gitignored
file is machine state: generated artifacts (`srg_names.json`, …) stay tree-local by design — see
docs/RIG.md for the list. Deriving the state files' directory from `__file__` gives the root of
whatever tree the caller happens to be in — so a `just sync` from a git WORKTREE found no
registry, `assign()` rebuilt a fresh one there, and the camera instance lost its pinned 55546
(renumbered to 55549 → every cinema tool got `Connection refused`; measured twice).
Every such file resolves through `root()` instead.

`root()` is LAZY: importing this module (or any importer — `sync.py --validate-only`, `local_config`,
`sustain_live.py`) spawns no git and cannot raise; the probe runs on the first call.
"""

from __future__ import annotations

import os
import subprocess
from functools import cache
from pathlib import Path

#: The directory this module lives in (`<repo>/scripts`). The git probe runs with THIS as its cwd,
#: so the resolved root never depends on the caller's cwd.
_HERE = Path(__file__).resolve().parent

#: git's repo-local env vars — exactly `git rev-parse --local-env-vars` (a test pins this list to
#: git's own answer). git EXPORTS `GIT_DIR` / `GIT_INDEX_FILE` / `GIT_WORK_TREE` into every hook, and
#: any of them overrides a subprocess's cwd: a probe run under a hook would answer for the hook's
#: repo, and a test fixture's `git init`/`commit` would write into the REAL index and config.
GIT_LOCAL_ENV_VARS = (
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG",
    "GIT_CONFIG_PARAMETERS",
    "GIT_CONFIG_COUNT",
    "GIT_OBJECT_DIRECTORY",
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_IMPLICIT_WORK_TREE",
    "GIT_GRAFT_FILE",
    "GIT_INDEX_FILE",
    "GIT_NO_REPLACE_OBJECTS",
    "GIT_REPLACE_REF_BASE",
    "GIT_PREFIX",
    "GIT_SHALLOW_FILE",
    "GIT_COMMON_DIR",
)


def clean_git_env() -> dict[str, str]:
    """`os.environ` minus git's repo-local vars, so a git subprocess answers for its OWN cwd."""
    env = dict(os.environ)
    for key in GIT_LOCAL_ENV_VARS:
        env.pop(key, None)
    return env


class MachineRootError(RuntimeError):
    """The shared repo root could not be resolved from inside a git worktree.

    Falling back to the tree-local root there is exactly the bug this guard exists to prevent
    (see `repo_root`), so we refuse loudly instead of silently renumbering pinned ports.
    """


def _under_claude_worktrees(path: Path) -> bool:
    """True if `path` sits under a `.claude/worktrees/` checkout (agent worktree convention)."""
    parts = path.parts
    return any(a == ".claude" and b == "worktrees" for a, b in zip(parts, parts[1:]))


def _shared_root(anchor: Path) -> Path | None:
    """The main checkout's root if git vouches that `anchor.parent` is a checkout of it, else None.

    Accepted ONLY when both hold:
    - `--show-toplevel` IS `anchor.parent`. A vendored copy nested inside ANOTHER repo answers with
      that repo's toplevel — not ours, so rejected.
    - the common dir is a plain `<root>/.git`. A submodule's (`<super>/.git/modules/<n>`) or a bare
      clone's (`<x>.git`) has no main working tree beside it, so its parent is not a checkout root.

    A `--separate-git-dir` clone or a symlinked `.git` is UNSUPPORTED: its common dir's parent is
    not the checkout, and nothing here detects that.
    """
    try:
        proc = subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"],
            cwd=str(anchor),
            env=clean_git_env(),
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None
    lines = proc.stdout.splitlines()
    if proc.returncode != 0 or len(lines) != 2:
        return None
    top, common = (Path(ln) for ln in lines)
    if not (top.is_absolute() and common.is_absolute()):
        return None
    if top.resolve() != anchor.parent:
        return None
    common = common.resolve()
    if common.name != ".git" or not common.parent.is_dir():
        return None
    return common.parent


def repo_root(anchor: Path = _HERE) -> Path:
    """Resolve the repo root a normal clone's main checkout and its linked worktrees share.

    `git rev-parse --git-common-dir` answers with the MAIN `.git` from inside a linked worktree,
    so its parent is the shared repo root — one set of machine-local files per clone (clone
    layouts `_shared_root` marks UNSUPPORTED excepted). The probe runs with git's repo-local env
    stripped, so an inherited `GIT_DIR` (every git hook exports one) cannot redirect it to another
    repo.

    The tree-local root (`anchor.parent`) is used when git gives no usable answer (`_shared_root`):
    git is not installed, the tree is not a checkout of its own (a tarball, or a vendored copy
    inside another repo), or it is a submodule / bare-clone worktree — there the tree-local root IS
    the answer. Fail-loud carve-out: from INSIDE a `.claude/worktrees/` path we are provably in an
    agent worktree of a normal clone, where the fallback would silently rebuild the registry and
    renumber pinned ports — so that case raises `MachineRootError` instead.
    """
    anchor = anchor.resolve()
    root = _shared_root(anchor)
    if root is not None:
        return root
    if _under_claude_worktrees(anchor):
        raise MachineRootError(
            f"cannot resolve the shared repo root from the worktree path {anchor} "
            "(`git rev-parse --show-toplevel --git-common-dir` gave no usable answer); "
            f"refusing to fall back to the tree-local root {anchor.parent} — a tree-local root would split "
            "machine state (fleet registry, task queue, local.config.json) per worktree"
        )
    return anchor.parent


@cache
def root() -> Path:
    """This repo's machine root, resolved on FIRST USE (never at import) and cached.

    Raises `MachineRootError` at that first use, so the caller that actually needs a machine-local
    file is the one that fails — not every importer.
    """
    return repo_root()
