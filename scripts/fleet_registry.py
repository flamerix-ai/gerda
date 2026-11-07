"""fleet_registry — the multi-bot bridge registry (`mc-bots.json`).

Fleet coordination step 1. The registry is the host-side SSOT mapping a
bot NAME → its bridge endpoint, so the coordinator hub, the MCP server, and `bridge_ctl.py
--bot <name>` all dial the right instance. `sync.py` (re)writes it on deploy: it preserves an
existing instance's assigned port and only hands a fresh port to a newly-seen instance, so a
bot's port is stable across deploys (the hub can cache it).

The file lives at the root of the MAIN checkout (`machine_root.root()`, resolved via
`git rev-parse --git-common-dir`), so every git worktree of this repo shares the ONE registry and a
sync from a worktree cannot renumber a pinned port. Env `MC_BOTS_REGISTRY` overrides the path (the
same variable `mcp/server.py` honours) — tests point it at a scratch file so they never touch the
live registry. Resolved lazily (`registry_path()`), so importing this module spawns no git.

Schema (repo-root `mc-bots.json`, gitignored — host-specific):
    {
      "version": 1,
      "bots": [
        {"name": "<instance dir>", "host": "127.0.0.1", "port": 55544,
         "instanceDir": "<abs path to instance>", "account": null}
      ]
    }

`account` is null until the fleet/account wiring lands (a later fleet-coordination step); the registry
records the slot now so nothing else has to change shape later.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import machine_root

DEFAULT_BASE_PORT = 55544
DEFAULT_HOST = "127.0.0.1"

# The naming contract of docs/BOT_INSTANCE_SETUP.md § "Naming, accounts and ports — the contract": every fleet bot instance name
# contains this; the human's own client (also a registry row, port 55544) does not.
BOT_NAME_MARK = "_bot_"


class RegistryUnreadable(ValueError):
    """`mc-bots.json` exists but cannot be read or is not a registry. The message names the path
    and the cause, so a caller can report the real failure instead of "port N not found"."""


def extra_fleet_instances() -> frozenset[str]:
    """Instances named in local.config.json `fleetInstances` (env MC_FLEET_INSTANCES, comma-
    separated): fleet bots whose name does not follow `*_bot_*`. A one-instance setup runs the
    bot in the instance SETUP created (`Monifactory`); listing it there lets the hub dispatch to
    it. Read lazily, never at import (local_config resolves the machine root on first use)."""
    import local_config  # noqa: PLC0415 — lazy: see the docstring

    raw = local_config.get("fleetInstances")
    if raw is None:
        return frozenset()
    items = raw.split(",") if isinstance(raw, str) else raw
    if not isinstance(items, list):
        raise SystemExit(f"fleetInstances must be a list of instance names, got {raw!r}")
    return frozenset(str(n).strip() for n in items if str(n).strip())


def is_bot_instance(name: str) -> bool:
    """True for a fleet bot instance: a `*_bot_*` name, or one listed in `fleetInstances` — the
    one home of that rule, shared by the hub (never push to the human's client) and the tuner
    (never tune it)."""
    return BOT_NAME_MARK in name or name in extra_fleet_instances()


def registry_path() -> Path:
    """`mc-bots.json`: env `MC_BOTS_REGISTRY` if set, else the MAIN checkout's file."""
    override = os.environ.get("MC_BOTS_REGISTRY")
    return Path(override) if override else machine_root.root() / "mc-bots.json"


def tasks_path() -> Path:
    """`mc-tasks.json` (fleet_hub's queue store) — always the sibling of the registry."""
    return registry_path().with_name("mc-tasks.json")


def load_strict(path: Path | None = None) -> dict:
    """Read the registry; an ABSENT file is an empty one, an unreadable or invalid one raises
    `RegistryUnreadable` naming the path and the cause."""
    path = registry_path() if path is None else path
    if not path.exists():
        return {"version": 1, "bots": []}
    try:
        data = json.loads(path.read_text("utf-8"))
    except OSError as e:
        raise RegistryUnreadable(f"{path} is unreadable: {e}") from e
    except ValueError as e:
        raise RegistryUnreadable(f"{path} is not valid JSON: {e}") from e
    if not isinstance(data, dict) or not isinstance(data.get("bots"), list):
        raise RegistryUnreadable(f'{path} is not a registry: expected an object with a "bots" list')
    # A non-object row (a hand edit gone wrong) is dropped HERE, once, so no reader — sync's
    # assign(), resolve(), the hub's poll loop — crashes on `.get` of a string mid-operation.
    data["bots"] = [b for b in data["bots"] if isinstance(b, dict)]
    return data


def load(path: Path | None = None) -> dict:
    """Read the registry, returning an empty one if absent/corrupt (never raises). For a lookup
    whose "not found" answer would mislead on a corrupt file, use `load_strict`."""
    try:
        return load_strict(path)
    except RegistryUnreadable:
        return {"version": 1, "bots": []}


def save(reg: dict, path: Path | None = None) -> None:
    path = registry_path() if path is None else path
    path.write_text(json.dumps(reg, indent=2, ensure_ascii=False) + "\n", "utf-8")


def resolve(name: str, path: Path | None = None) -> tuple[str, int] | None:
    """Look up a bot by name → (host, port), or None if unknown."""
    for bot in load(path).get("bots", []):
        if bot.get("name") == name:
            return bot.get("host", DEFAULT_HOST), int(bot["port"])
    return None


def game_dir_for_port(port: int, path: Path | None = None) -> Path | None:
    """Bridge port → the `minecraft` game dir of the instance registered on it, or None.

    The live-test runners (gate_live.py, navbench.py `--port`) seed arena markers host-side into
    the bot's OWN mc_world.json; without this they default to the main instance, so a fleet bot
    (55545+) reads a store the seed never reached and the drill finds no vein.

    Raises `RegistryUnreadable` on a corrupt or unreadable registry: through the forgiving
    `load()` that file reads as empty, and the caller would report the port as unregistered
    while it is there."""
    for bot in load_strict(path)["bots"]:
        if bot.get("port") == port and bot.get("instanceDir"):
            return Path(bot["instanceDir"]) / "minecraft"
    return None


def assign(
    instances: list[tuple[str, Path]],
    base_port: int = DEFAULT_BASE_PORT,
    path: Path | None = None,
) -> dict[str, int]:
    """Reconcile the registry against the current instances → {instanceDir: port}.

    `instances` is a list of (name, instance_dir). A known instanceDir keeps its existing
    port; a new one gets the lowest free port at/above base_port. The rebuilt registry is
    saved and the name→/dir→port map is returned for the caller to drop `bridge_port.txt`.
    """
    path = registry_path() if path is None else path
    existing = load(path)
    by_dir = {b.get("instanceDir"): b for b in existing.get("bots", [])}
    used_ports = {int(b["port"]) for b in existing.get("bots", []) if "port" in b}

    def next_free() -> int:
        p = base_port
        while p in used_ports:
            p += 1
        used_ports.add(p)
        return p

    bots: list[dict] = []
    dir_port: dict[str, int] = {}
    for name, inst_dir in sorted(instances, key=lambda t: t[0]):
        key = str(inst_dir)
        prev = by_dir.get(key)
        port = int(prev["port"]) if prev and "port" in prev else next_free()
        bots.append(
            {
                "name": name,
                "host": prev.get("host", DEFAULT_HOST) if prev else DEFAULT_HOST,
                "port": port,
                "instanceDir": key,
                "account": prev.get("account") if prev else None,
            }
        )
        dir_port[key] = port

    # Keep every entry whose instance is NOT in this sync but still exists on disk — another
    # launcher root (MC_INSTANCES_ROOT pointed elsewhere for one sync), a second launcher data dir.
    # Rebuilding from `instances` alone deleted those entries and handed their ports to the next
    # new instance, renumbering a live bot (docs/PORTABILITY.md). Only an instance
    # whose directory is gone leaves the registry.
    seen = {str(d) for _, d in instances}
    for prev in existing.get("bots", []):
        inst = prev.get("instanceDir")
        if inst and inst not in seen and Path(inst).is_dir():
            bots.append(prev)
            seen.add(inst)

    save({"version": 1, "bots": bots}, path)
    for line in duplicate_name_warnings(bots):
        print(line, file=sys.stderr)
    return dir_port


def duplicate_name_warnings(bots: list[dict]) -> list[str]:
    """One WARN line per bot NAME that more than one instance carries.

    Two launcher roots can each hold an instance with the same directory name (`Monifactory`).
    Both stay in the registry under their own port, but every lookup by name (`resolve`, `--bot`,
    MCP `target=`) reaches only the FIRST row, so the other bot is unreachable by name. Warned, not
    refused: a sync must still deploy, and the port of each row stays right."""
    rows: dict[str, list[dict]] = {}
    for b in bots:
        rows.setdefault(b.get("name", ""), []).append(b)
    out = []
    for name, same in rows.items():
        if len(same) < 2:
            continue
        where = ", ".join(f"{b.get('instanceDir')} (port {b.get('port')})" for b in same)
        out.append(
            f"WARN: {len(same)} instances are named {name!r}: {where}. A lookup by that name "
            f"(--bot, target=) reaches only port {same[0].get('port')}; rename one instance."
        )
    return out
