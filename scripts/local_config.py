"""local_config — the one place machine-specific paths/settings come from.

Precedence (highest wins):
  1. Environment variables (`MC_INSTANCES_ROOT`, …)
  2. `local.config.json` at the MAIN checkout's root (gitignored, shared by worktrees; copy local.config.json.example)
  3. Launcher autodetection (FreesmLauncher / Prism / MultiMC on Linux, Windows, macOS)

Nothing here is required on a dev box that only builds/tests: the loader is lazy
and only fails (loudly, with a how-to-fix message) when something actually asks
for a game path. Also runnable as a CLI for shell scripts:

    python3 scripts/local_config.py instances_root
    python3 scripts/local_config.py instance_dir Monifactory
    python3 scripts/local_config.py server_dir            # <serverRoot>/<server> (may not exist yet)
    python3 scripts/local_config.py server_ctl            # <serverRoot>/<server>/server-ctl.sh
    python3 scripts/local_config.py camera_account_name   # the OP camera account's name
"""
from __future__ import annotations

import json
import os
import re
import sys
from functools import cache
from pathlib import Path

import machine_root


def config_path() -> Path:
    """`local.config.json` — gitignored + machine-local, so it exists only in the MAIN checkout.

    Resolved through `machine_root.root()` so a worktree finds it too (a tree-local root would
    silently miss it and fall through to autodetect), and lazily, so importing stays git-free.
    An unresolvable root surfaces as `SystemExit` like every other failure here, so callers that
    degrade on `except SystemExit` (sustain_live's optional instance lookup) keep degrading.
    """
    try:
        return machine_root.root() / "local.config.json"
    except machine_root.MachineRootError as e:
        raise SystemExit(f"local.config.json: {e}") from e


# Launcher data dirs that hold an `instances/` folder, per OS. FreesmLauncher and
# PrismLauncher are MultiMC-format forks — the instance layout is identical.
_LAUNCHER_DIRS = ["FreesmLauncher", "PrismLauncher", "prismlauncher", "MultiMC"]


def _candidate_roots() -> list[Path]:
    home = Path.home()
    bases: list[Path] = [home / ".local" / "share"]  # Linux
    if sys.platform == "darwin":
        bases.insert(0, home / "Library" / "Application Support")
    appdata = os.environ.get("APPDATA")
    if appdata:  # native Windows
        bases.insert(0, Path(appdata))
    bases.append(home / ".var" / "app" / "org.prismlauncher.PrismLauncher" / "data" / "PrismLauncher")  # flatpak
    out: list[Path] = []
    for base in bases:
        for launcher in _LAUNCHER_DIRS:
            out.append(base / launcher / "instances")
        out.append(base / "instances")  # flatpak base already ends at the data dir
    return out


@cache
def load() -> dict:
    """The parsed local.config.json ({} if absent). Malformed JSON is a hard error."""
    path = config_path()
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text("utf-8"))
    except ValueError as e:
        raise SystemExit(f"local.config.json is not valid JSON: {e}") from e
    if not isinstance(data, dict):
        raise SystemExit("local.config.json must be a JSON object")
    return data


@cache
def instances_root() -> Path:
    """The launcher `instances/` dir. Env > local.config.json > autodetect > loud error."""
    env = os.environ.get("MC_INSTANCES_ROOT")
    if env:
        p = Path(env).expanduser()
        if p.is_dir():
            return p
        raise SystemExit(f"MC_INSTANCES_ROOT={env} does not exist")

    cfg = load().get("instancesRoot")
    if cfg:
        p = Path(str(cfg)).expanduser()
        if p.is_dir():
            return p
        raise SystemExit(f"local.config.json instancesRoot={cfg} does not exist")

    for cand in _candidate_roots():
        if cand.is_dir():
            return cand

    raise SystemExit(
        "No Minecraft launcher instances dir found.\n"
        "Set it explicitly: copy local.config.json.example to local.config.json and put\n"
        '  {"instancesRoot": "/path/to/<launcher>/instances"}\n'
        "or export MC_INSTANCES_ROOT=/path/to/instances"
    )


def instance_dir(name: str) -> Path:
    """`<instancesRoot>/<name>` (the launcher instance folder; the game dir is
    `<instance>/minecraft` for MultiMC-format launchers). Loud error if missing."""
    p = instances_root() / name
    if not p.is_dir():
        known = ", ".join(sorted(e.name for e in instances_root().iterdir() if e.is_dir())) or "<none>"
        raise SystemExit(f"instance {name!r} not found under {instances_root()} (known: {known})")
    return p


def mc_inst_override() -> Path | None:
    """The `MC_INST` override: an ABSOLUTE path to ONE instance's `minecraft` dir, or None.

    The single home for that env var — arena.py's `marker` op (which instance's world store to
    write) and mc_shot.py (which instance's screenshots/ to read) both resolve it here, so
    "point this at the bot instance" means the same thing everywhere and cannot drift into one
    tool validating the path and another silently accepting a typo. Fail-loud on a path that is
    not a directory: the alternative is a tool that quietly operates on the HUMAN instance while
    the caller believes it is driving a bot (a stale screenshot, or a marker written where nobody
    reads it)."""
    env = os.environ.get("MC_INST")
    if not env:
        return None
    p = Path(env).expanduser()
    if not p.is_dir():
        print(f"ERR: MC_INST={env} is not a directory", file=sys.stderr)
        raise SystemExit(2)
    return p


def get(key: str, default=None):
    """Free-form setting from local.config.json. Env override wins: camelCase key →
    MC_SNAKE_CASE (humanInstance → MC_HUMAN_INSTANCE)."""
    env_name = "MC_" + re.sub(r"(?<=[a-z0-9])(?=[A-Z])", "_", key).upper()
    env = os.environ.get(env_name)
    if env is not None:
        return env
    return load().get(key, default)


# The dedicated server's folder under the server root, and that root's default — the ONE home of
# both: docs/SERVER_SETUP.md installs into `python3 scripts/local_config.py server_dir`.
SERVER_DIR_NAME = "monifactory-0.13.4"
DEFAULT_SERVER_ROOT = "~/mc-servers"


def server_dir() -> Path:
    """`<serverRoot>/monifactory-0.13.4` — where the dedicated server is (or gets) installed.

    The root comes from env `MC_SERVER_ROOT` > local.config.json `serverRoot` > the default
    `~/mc-servers`. Existence is NOT checked here: setup calls this before the dir exists. A root
    that is SET but empty (`export MC_SERVER_ROOT=`) is a loud error, not the default: it is a
    half-done override, and guessing past it would aim console commands at the wrong server."""
    root = get("serverRoot")
    if root is None:
        root = DEFAULT_SERVER_ROOT
    elif not str(root).strip():
        raise SystemExit("serverRoot / MC_SERVER_ROOT is set but empty — set a dir or unset it")
    return Path(str(root)).expanduser() / SERVER_DIR_NAME


def server_ctl() -> Path:
    """`server_dir()/server-ctl.sh` — the dedicated server's console wrapper.

    A missing script is a loud error (naming the resolved path and how to move the root), so a
    default root never sends console commands nowhere. Call it lazily (at the first console
    command), never at import time."""
    ctl = server_dir() / "server-ctl.sh"
    if not ctl.is_file():
        raise SystemExit(
            f"server-ctl.sh not found at {ctl} — install the server there (docs/SERVER_SETUP.md) "
            "or point \"serverRoot\" in local.config.json / MC_SERVER_ROOT at the dir holding "
            f"{SERVER_DIR_NAME}/"
        )
    return ctl


def camera_account_name() -> str:
    """The OP camera account's player name (env `MC_CAMERA_ACCOUNT_NAME` > local.config.json
    `cameraAccountName`) — the spectator camera of docs/RIG.md and the op that drops the
    sustain demo's starter kit. Machine-specific, so it has no default: a loud error beats
    console commands aimed at a player who is not online."""
    name = get("cameraAccountName")
    if not name:
        raise SystemExit(
            "camera account unknown: set \"cameraAccountName\" in local.config.json (copy "
            "local.config.json.example) or export MC_CAMERA_ACCOUNT_NAME=<op player name> — "
            "the OP account the camera client logs in as (docs/RIG.md § Shared topology)."
        )
    return str(name)


if __name__ == "__main__":
    cmds = ("instances_root", "instance_dir", "server_dir", "server_ctl", "camera_account_name",
            "get")
    usage = ("usage: local_config.py instances_root | instance_dir <name> | server_dir"
             " | server_ctl | camera_account_name | get <key>")
    if len(sys.argv) >= 2 and sys.argv[1] in ("-h", "--help"):
        print(usage)
        raise SystemExit(0)
    if len(sys.argv) < 2 or sys.argv[1] not in cmds:
        raise SystemExit(usage)
    if sys.argv[1] == "instances_root":
        print(instances_root())
    elif sys.argv[1] == "instance_dir":
        print(instance_dir(sys.argv[2]))
    elif sys.argv[1] == "server_dir":
        print(server_dir())
    elif sys.argv[1] == "server_ctl":
        print(server_ctl())
    elif sys.argv[1] == "camera_account_name":
        print(camera_account_name())
    else:
        val = get(sys.argv[2])
        if val is None:
            raise SystemExit(f"key {sys.argv[2]!r} not set")
        print(val)
