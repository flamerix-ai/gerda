#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["fastmcp>=2.0", "httpx>=0.27", "mcp>=1.0"]
# ///
"""mc MCP server — thin proxy for the resident bot bridge + fleet hub.

Self-contained: run it with `uv run mcp/server.py` (uv resolves the inline
dependencies above) or any Python ≥3.11 with fastmcp+httpx installed. See
mcp/README.md for wiring it into Claude Code / other MCP clients.

The container (main.js COMMANDS registry) is the source of truth. This server is
a lean proxy: a few ergonomic typed tools for the hottest paths, plus a generic
escape hatch. Everything else is reached via mc_send — discover the full command
set + params from the mc://api resource (or mc_send("describe")). New container
commands need NO MCP redeploy.

Pure infrastructure — NO game logic. Game actions (goto, mining, waypoints, GUI)
all go through mc_send. Tools here are only dispatch + diagnostics.

Multi-bot fleet: every per-bot tool takes an optional `target=<bot>` — the bot
NAME from the `mc-bots.json` registry. Without it, the default single bridge
(MC_BRIDGE_PORT) is used, so single-bot use is unchanged. `target=` resolves the
bot's bridge endpoint from the registry and connects straight through (no hub
dependency for inspecting/driving one bot — degrades cleanly if the hub is down).
The genuinely-shared fleet state (presence, merged world-map, region claims /
assignments) is owned by the coordinator HUB and reached via the mc_fleet_* tools.

Tools:
  mc_ping     [target]        — bridge connectivity test (survives main down)
  mc_get_state [target]       — state snapshot (pos, health, phase, tool, worker)
  mc_send t args [target]     — generic: send ANY bridge command (the one game-logic path)
  mc_fleet_status             — hub: presence of every registry bot
  mc_fleet_map                — hub: merged world-model (markers union)
  mc_fleet_claims             — hub: active work-claims / region assignments (lease ledger)
  mc_fleet_assign bot allowed — hub: claim a mining region for a bot + re-push disjoint set
  mc_fleet_unassign bot       — hub: drop a bot's region + clear its assignment
  mc_fleet_queue              — hub: the task queue (backlog + in-flight + terminal tail)
  mc_fleet_enqueue m p b ttl  — hub: backlog a mission; the first FREE fleet bot takes it
  mc_fleet_cancel id          — hub: cancel a queued task / abort a running one
  mc_fleet_want res bots      — hub: «I need X» presets (ore→drill, wood→chop, food→hunt)
  mc_fleet path method body   — hub: generic escape hatch for any fleet endpoint

Resources (read-only, poll without a tool call):
  mc://state       — current state snapshot (default bridge)
  mc://logs        — recent NDJSON journal entries (default bridge)
  mc://api         — live command manifest (every command + params)
  mc://bots        — the fleet registry (name → bridge endpoint) for target= discovery
"""
from __future__ import annotations

import json as _json
import logging
import os
import sys
from pathlib import Path
from typing import Any

import httpx
from fastmcp import FastMCP
from fastmcp.exceptions import ToolError

# Same-dir import; the sys.path insert covers clients that exec this file from
# an arbitrary cwd without putting the script dir on the path.
_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))
from bridge_client import BridgeClient  # noqa: E402

# ═══════════════════════════════════════════════════════════════════
#  Constants
# ═══════════════════════════════════════════════════════════════════

BRIDGE_HOST = os.getenv("MC_BRIDGE_HOST", "auto")
BRIDGE_PORT = int(os.getenv("MC_BRIDGE_PORT", "55544"))
BRIDGE_TIMEOUT = float(os.getenv("MC_BRIDGE_TIMEOUT", "5"))

# Coordinator hub: owns shared fleet state. A thin HTTP/JSON daemon.
FLEET_HUB = os.getenv("MC_FLEET_HUB", "http://127.0.0.1:8849").rstrip("/")
FLEET_TIMEOUT = float(os.getenv("MC_FLEET_TIMEOUT", "8"))

# The bot registry (`mc-bots.json`) is host-specific + gitignored — it lives at the
# repo root (one level above this file). Env override first, then repo root, then cwd.
_REGISTRY_CANDIDATES = [
    os.getenv("MC_BOTS_REGISTRY", ""),
    str(_HERE.parent / "mc-bots.json"),
    "mc-bots.json",
]

# All logging to stderr — stdout carries the MCP JSON-RPC framing.
logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(name)s %(levelname)s %(message)s")
_LOG = logging.getLogger("mcp_mc")

mcp = FastMCP("mc-bridge")


# -------------------------------------------------------------------
#  Utility
# -------------------------------------------------------------------


# (Host resolution lives in mcp/bridge_client.py — _resolve_host there is the ONE loopback-first
# probe. The byte-identical private copy that used to sit here is gone with its only call site.)


def _registry_path() -> Path | None:
    for cand in _REGISTRY_CANDIDATES:
        if cand and Path(cand).is_file():
            return Path(cand)
    return None


def _load_registry() -> dict[str, tuple[str, int]]:
    """name → (host, port) from mc-bots.json. Empty if the registry is absent/corrupt."""
    path = _registry_path()
    if path is None:
        return {}
    try:
        data = _json.loads(path.read_text("utf-8"))
        bots = data.get("bots", []) if isinstance(data, dict) else []
    except (OSError, ValueError):
        return {}
    out: dict[str, tuple[str, int]] = {}
    for b in bots:
        name = b.get("name")
        port = b.get("port")
        if isinstance(name, str) and isinstance(port, int):
            out[name] = (b.get("host") or "127.0.0.1", port)
    return out


def _client(target: str | None = None) -> BridgeClient:
    """A bridge client for `target` (registry name) or the default single bridge."""
    if target is None:
        # host= ONLY for the explicit MC_BRIDGE_HOST override. On "auto" we pass None and let
        # BridgeClient run its own (identical) loopback-first resolution: handing it the
        # auto-GUESS would mark it as an explicit caller choice, and the waits (wait_for_port /
        # wait_for_ready) would then treat that one guess as the only candidate instead of
        # re-trying loopback every round.
        host = None if BRIDGE_HOST == "auto" else BRIDGE_HOST
        return BridgeClient(host=host, port=BRIDGE_PORT, timeout=BRIDGE_TIMEOUT)
    reg = _load_registry()
    if target not in reg:
        known = ", ".join(sorted(reg)) or "<registry empty / not found>"
        raise ValueError(f"unknown bot target {target!r}; known: {known}")
    host, port = reg[target]
    return BridgeClient(host=host, port=port, timeout=BRIDGE_TIMEOUT)


def _hub(method: str, path: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
    """Call the coordinator hub's HTTP/JSON fleet API."""
    url = f"{FLEET_HUB}{path if path.startswith('/') else '/' + path}"
    try:
        r = httpx.request(method.upper(), url, json=body, timeout=FLEET_TIMEOUT)
        try:
            data = r.json()
        except Exception:
            data = {"ok": r.is_success, "status": r.status_code, "text": r.text}
        if isinstance(data, dict):
            data.setdefault("ok", r.is_success)
            return data
        return {"ok": r.is_success, "data": data}
    except Exception as e:
        return {"ok": False, "error": f"hub {method} {path}: {e}", "hub": FLEET_HUB}


# -------------------------------------------------------------------
#  Resources: read-only "look, don't poke" surface
# -------------------------------------------------------------------


@mcp.resource("mc://state")
def _state_resource() -> str:
    """Current bot state snapshot (phase, position, health, tool, worker liveness)."""
    try:
        return _json.dumps(_client().get_state(), ensure_ascii=False, indent=2)
    except Exception as e:
        return _json.dumps({"ok": False, "error": str(e)})


@mcp.resource("mc://logs")
def _logs_resource() -> str:
    """Recent NDJSON journal entries (state transitions + events)."""
    try:
        return _json.dumps(_client().get_logs(), ensure_ascii=False, indent=2)
    except Exception as e:
        return _json.dumps({"ok": False, "error": str(e)})


@mcp.resource("mc://api")
def _api_resource() -> str:
    """Live command manifest from the container (`describe`): every bridge command
    with its params + where it runs. The container is the source of truth, so this
    reflects the running build — no MCP redeploy when commands change."""
    try:
        return _json.dumps(_client().send("describe"), ensure_ascii=False, indent=2)
    except Exception as e:
        return _json.dumps({"ok": False, "error": str(e)})


@mcp.resource("mc://bots")
def _bots_resource() -> str:
    """The fleet registry (`mc-bots.json`): bot name → bridge endpoint. These names are
    the valid `target=` values for the per-bot tools. Empty if no registry is found."""
    reg = _load_registry()
    bots = [{"name": n, "host": h, "port": p} for n, (h, p) in sorted(reg.items())]
    out = {"registry": str(_registry_path()), "bots": bots}
    return _json.dumps(out, ensure_ascii=False, indent=2)


# -------------------------------------------------------------------
#  Tools — per-bot (optional target=)
# -------------------------------------------------------------------


@mcp.tool()
def mc_ping(target: str | None = None) -> dict[str, Any]:
    """Ping a bot's bridge to verify connectivity (answered by the bridge itself).
    `target` = a bot name from the mc-bots.json registry (mc://bots); omit for the
    default single bridge."""
    try:
        return _client(target).ping()
    except Exception as e:  # isError: true — a client must not render this as success
        raise ToolError(str(e)) from e


@mcp.tool()
def mc_get_state(target: str | None = None) -> dict[str, Any]:
    """Current bot state: phase, position, health, tool, dimension, worker liveness.
    `target` = a bot name from the registry (mc://bots); omit for the default bridge."""
    try:
        return _client(target).get_state()
    except Exception as e:  # isError: true — a client must not render this as success
        raise ToolError(str(e)) from e


@mcp.tool()
def mc_send(
    type: str,  # noqa: A002
    args: dict[str, Any] | None = None,
    target: str | None = None,
) -> dict[str, Any]:
    """Send any bridge command generically — the single path for ALL game logic and
    everything without a dedicated tool: goto, scan, inventory, get_logs,
    start/pause/resume/halt, goto_waypoint, screenshot, read_screen, click, key,
    close_screen, eval, load, add/remove_waypoint, … Discover the full set + params
    via the `mc://api` resource or mc_send("describe").

    `target` routes to a specific bot by name (registry mc://bots); omit for the
    default single bridge. Examples:
    mc_send("scan", {"radius": 16}, target="bot_2") /
    mc_send("goto", {"x": 1, "y": 64, "z": 2}) / mc_send("pause", target="bot_1")."""
    try:
        return _client(target).send(type, args)
    except Exception as e:  # isError: true — a client must not render this as success
        raise ToolError(str(e)) from e


# -------------------------------------------------------------------
#  Tools — fleet level (via the coordinator hub)
# -------------------------------------------------------------------


@mcp.tool()
def mc_fleet_status() -> dict[str, Any]:
    """Fleet presence from the coordinator hub: one row per registry bot (online flag +
    last pos/health/dimension snapshot; offline bots degrade to an error row)."""
    return _hub("GET", "/fleet/status")


@mcp.tool()
def mc_fleet_map() -> dict[str, Any]:
    """Merged fleet world-model from the hub: the union of every bot's markers (veins /
    waypoints), deduped by (ore, x, z) — the shared map the bots mine from."""
    return _hub("GET", "/fleet/map")


@mcp.tool()
def mc_fleet_claims() -> dict[str, Any]:
    """Active work-claims / region assignments from the hub's lease ledger (who holds
    which region, with TTL). The deconfliction state that keeps two bots off one vein."""
    return _hub("GET", "/fleet/claims")


@mcp.tool()
def mc_fleet_assign(
    bot: str,
    allowed: dict[str, Any],
    ttl: float | None = None,
) -> dict[str, Any]:
    """Claim a mining region for `bot` and re-push the disjoint assignment set to every
    region-claimed bot (each gets {allowed, forbidden=the others}). `allowed` is a box
    {minX, maxX, minZ, maxZ}. The bot's mine mission then only scans/mines inside it.
    Returns 409 from the hub if the region collides with another live lease."""
    body: dict[str, Any] = {"bot": bot, "allowed": allowed}
    if ttl is not None:
        body["ttl"] = ttl
    return _hub("POST", "/fleet/assign", body)


@mcp.tool()
def mc_fleet_unassign(bot: str) -> dict[str, Any]:
    """Drop `bot`'s region claim and clear its in-world assignment (it mines anywhere
    again). The hub re-pushes the now-smaller disjoint set to the remaining bots."""
    return _hub("POST", "/fleet/unassign", {"bot": bot})


@mcp.tool()
def mc_fleet_queue() -> dict[str, Any]:
    """The hub task queue: backlog + in-flight + a bounded terminal tail. Tasks are
    mission specs FREE fleet bots pick up themselves (dispatch + settle is the hub
    poller's job — bots never call in)."""
    return _hub("GET", "/fleet/queue")


@mcp.tool()
def mc_fleet_enqueue(
    mission: str,
    params: dict[str, Any] | None = None,
    bot: str | None = None,
    ttl: float | None = None,
) -> dict[str, Any]:
    """Backlog a mission on the hub task queue; the first FREE fleet bot takes it (FIFO).
    `bot` pins it to one instance (must be a *_bot_* name — the human's client can never
    be tasked), `ttl` bounds the run (seconds; default 1800 = runaway backstop).
    Example: mc_fleet_enqueue("drill", {"ore": "iron"})."""
    body: dict[str, Any] = {"mission": mission}
    if params is not None:
        body["params"] = params
    if bot is not None:
        body["bot"] = bot
    if ttl is not None:
        body["ttl"] = ttl
    return _hub("POST", "/fleet/enqueue", body)


@mcp.tool()
def mc_fleet_cancel(id: str) -> dict[str, Any]:
    """Cancel a queued task, or abort a running one (the hub also frees its bot via
    mission_abort). `id` is the task id from mc_fleet_queue / mc_fleet_enqueue ("tN")."""
    return _hub("POST", "/fleet/cancel", {"id": id})


@mcp.tool()
def mc_fleet_want(
    resource: str,
    bots: int = 1,
    bot: str | None = None,
    ttl: float | None = None,
) -> dict[str, Any]:
    """The «I need X» front door: map a resource word to the mission that PRODUCES it
    and enqueue it on `bots` free fleet bots. Ore words → drill {ore} (drill is already
    the full prospect→shaft→mine chain); "wood" → chop; "food" → hunt. Unknown words
    fall through to drill {ore:<word>} and end, at worst, in a graceful no-vein skip.
    Example: mc_fleet_want("iron", bots=2)."""
    body: dict[str, Any] = {"resource": resource, "bots": bots}
    if bot is not None:
        body["bot"] = bot
    if ttl is not None:
        body["ttl"] = ttl
    return _hub("POST", "/fleet/want", body)


@mcp.tool()
def mc_fleet(
    path: str,
    method: str = "GET",
    body: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Generic escape hatch to the coordinator hub's HTTP/JSON fleet API — for any
    endpoint without a dedicated tool (e.g. /fleet/claim, /fleet/release, /healthz).
    Examples: mc_fleet("/fleet/claim", "POST", {"bot": "bot_1", "key": "vein:123"}) /
    mc_fleet("/healthz")."""
    return _hub(method, path, body)


# ═══════════════════════════════════════════════════════════════════
#  Entrypoint
# ═══════════════════════════════════════════════════════════════════


def main() -> None:
    """Run the MCP server via stdio."""
    mcp.run()


if __name__ == "__main__":
    main()
