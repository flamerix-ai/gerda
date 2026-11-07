#!/usr/bin/env python3
"""bridge_ctl — CLI for the resident mining bridge.

Commands:
    ping       — bridge connectivity test
    services   — list registered services
    status     — container and bot status
    get_state  — full state snapshot (pos, health, phase, ore, tool)
    scan       — read-only ore scan around player (radius optional)
    inventory  — read-only inventory summary
    get_logs   — tail the bot's NDJSON journal (--n lines)
    pause      — pause the bot
    resume     — resume the bot
    halt       — halt immediately
    start      — start managed service
    stop       — graceful stop
    goto x y z — queue a goto
    goto_waypoint [name] — send bot to a known vein (default: nearest), then mine it
    eval CODE  — run JS code in sandbox
    load       — load module code from file or string
    reload     — build bundle + signal bridge
    send TYPE [JSON] — generic escape hatch: any bridge command by type, payload as JSON

Usage:
    python bridge_ctl.py status
    python bridge_ctl.py --port 55545 --wait-ready 90 status  # block until a booting bridge ANSWERS
    python bridge_ctl.py --port 55545 --wait 90 status        # …weaker: only until the port opens
    python bridge_ctl.py get_state
    python bridge_ctl.py scan
    python bridge_ctl.py inventory
    python bridge_ctl.py goto 489 26 1104
    python bridge_ctl.py eval "Player.getPlayer().getHealth()"
    python bridge_ctl.py send chat '{"message": "/spawn"}'
    python bridge_ctl.py send prospect
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1]  # scripts/ root (this file lives in scripts/ops/)
PROJECT_DIR = SCRIPT_DIR.parent

sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(PROJECT_DIR / "mcp"))  # mcp/ -> canonical bridge_client
from bridge_client import DEFAULT_PORT, BridgeClient, BridgeUnreachable  # noqa: E402
import fleet_registry  # noqa: E402  (`--bot <name>` endpoint lookup)


def resolve_endpoint(host: str | None, port: int | None, bot: str | None) -> tuple[str | None, int] | None:
    """The bridge endpoint a host-side tool dials; None (after one stderr line) for an unknown bot.

    Explicit --host / --port win. `--bot <name>` fills what is left from the fleet registry.
    Without --bot, the env the MCP server reads fills it: MC_BRIDGE_HOST (unless "auto") and
    MC_BRIDGE_PORT; a global env must not redirect a named registry endpoint. The port falls back
    to DEFAULT_PORT (55544, the single instance SETUP creates). A None host means auto-resolve.
    `ctl` and `reload-worker` share this, so the two never dial different bots by default.
    """
    if bot:
        resolved = fleet_registry.resolve(bot)
        if resolved is None:
            print(f"Unknown bot '{bot}' — not in {fleet_registry.registry_path()}", file=sys.stderr)
            return None
        r_host, r_port = resolved
        return (host if host is not None else r_host, port if port is not None else r_port)
    if host is None and os.environ.get("MC_BRIDGE_HOST", "auto") != "auto":
        host = os.environ["MC_BRIDGE_HOST"]
    if port is None:
        env_port = os.environ.get("MC_BRIDGE_PORT", "").strip()
        if env_port and not env_port.isdigit():
            print(f"ERR: MC_BRIDGE_PORT={env_port!r} is not a port number", file=sys.stderr)
            return None
        port = int(env_port) if env_port else DEFAULT_PORT
    return host, port


def json_print(obj: dict) -> int:
    print(json.dumps(obj, indent=2, ensure_ascii=False))
    return 0


def cmd_ping(_bc: BridgeClient, _args: argparse.Namespace) -> int:
    return json_print(_bc.ping())


def cmd_diag(_bc: BridgeClient, _args: argparse.Namespace) -> int:
    # main-local topology/health (works even when the worker is dead)
    return json_print(_bc.send("diag"))


def cmd_bridge_diag(_bc: BridgeClient, _args: argparse.Namespace) -> int:
    # stable-layer view answered by bridge.js (works even when main is deaf/stale)
    return json_print(_bc.send("bridge_diag"))


def cmd_restart_service(_bc: BridgeClient, args: argparse.Namespace) -> int:
    # bridge-level ServiceManager restart, bypassing main (recovers a stale/orphaned stack)
    return json_print(_bc.send("restart_service", {"name": args.name}))


def cmd_services(_bc: BridgeClient, _args: argparse.Namespace) -> int:
    return json_print(_bc.services())


WORKER_DOWN = ("load_failed", "fatal")


def cmd_status(_bc: BridgeClient, _args: argparse.Namespace) -> int:
    """Print status; a worker that failed to load or halted on a fatal tick ends in rc 1 + one stderr line.

    A load failure leaves `module: null` and the managed service loaded, so the JSON alone looks
    healthy; `worker.status` / `worker.fatal` (main.js `status`) say why no module runs.
    """
    resp = _bc.status()
    json_print(resp)
    worker = resp.get("worker") if isinstance(resp, dict) else None
    state = worker.get("status") if isinstance(worker, dict) else None
    if state not in WORKER_DOWN:
        return 0
    fatal = worker.get("fatal") if isinstance(worker.get("fatal"), dict) else {}
    print(f"ERR: worker {state}: {fatal.get('error', '(no detail)')} "
          "— get_state / diag carry worker.fatal; fix the bundle, then reload_worker",
          file=sys.stderr)
    return 1


def cmd_get_state(_bc: BridgeClient, _args: argparse.Namespace) -> int:
    return json_print(_bc.get_state())


def cmd_scan(_bc: BridgeClient, args: argparse.Namespace) -> int:
    return json_print(_bc.scan(radius=args.radius))


def cmd_inventory(_bc: BridgeClient, _args: argparse.Namespace) -> int:
    return json_print(_bc.inventory())


def cmd_get_logs(_bc: BridgeClient, args: argparse.Namespace) -> int:
    return json_print(_bc.get_logs(n=args.n))


def cmd_pause(_bc: BridgeClient, _args: argparse.Namespace) -> int:
    return json_print(_bc.pause())


def cmd_resume(_bc: BridgeClient, _args: argparse.Namespace) -> int:
    return json_print(_bc.resume())


def cmd_halt(_bc: BridgeClient, _args: argparse.Namespace) -> int:
    return json_print(_bc.halt())


def cmd_start(_bc: BridgeClient, args: argparse.Namespace) -> int:
    return json_print(_bc.start(args.name))


def cmd_stop(_bc: BridgeClient, _args: argparse.Namespace) -> int:
    return json_print(_bc.stop())


def cmd_goto(_bc: BridgeClient, args: argparse.Namespace) -> int:
    return json_print(_bc.goto(args.x, args.y, args.z))


def cmd_goto_waypoint(_bc: BridgeClient, args: argparse.Namespace) -> int:
    return json_print(_bc.goto_waypoint(args.name))


def cmd_eval(_bc: BridgeClient, args: argparse.Namespace) -> int:
    return json_print(_bc.eval(args.code))


def cmd_load(_bc: BridgeClient, args: argparse.Namespace) -> int:
    code = args.code
    try:
        is_path = Path(code).exists()
    except OSError:  # ENAMETOOLONG & co: a code string no path can be
        is_path = False
    if is_path:
        code = Path(code).read_text(encoding="utf-8")
    return json_print(_bc.load(code))


def cmd_send(_bc: BridgeClient, args: argparse.Namespace) -> int:
    # Generic escape hatch: any bridge command by TYPE without a dedicated subcommand
    # (ext.js plugins, new main.js handlers, worker passthrough). NB the BridgeClient
    # contract: send(cmd_string, payload_dict) — the type goes as a STRING, the payload
    # as a separate dict; passing one merged dict double-wraps the envelope and reads
    # back as `recognized: false`.
    if args.payload is None:
        payload = None
    else:
        try:
            payload = json.loads(args.payload)
        except json.JSONDecodeError as e:
            print(f"ERR: payload is not valid JSON: {e}", file=sys.stderr)
            return 1
        if not isinstance(payload, dict):
            print("ERR: payload must be a JSON object, e.g. '{\"message\": \"/spawn\"}'", file=sys.stderr)
            return 1
    return json_print(_bc.send(args.type, payload))


def cmd_reload(_bc: BridgeClient, _args: argparse.Namespace) -> int:
    # Deploy the prebuilt bundle via scripts/ops/sync.py (gerda sync)
    import subprocess
    sync = PROJECT_DIR / "scripts" / "ops" / "sync.py"
    if not sync.exists():
        print("ERR: sync.py not found at " + str(sync), file=sys.stderr)
        return 1
    result = subprocess.run(
        [sys.executable, str(sync)], capture_output=True, text=True, cwd=PROJECT_DIR
    )
    print(result.stdout)
    if result.returncode != 0:
        print(result.stderr, file=sys.stderr)
        return result.returncode
    # Reload the worker headlessly so the freshly-built bundle takes effect (no GUI):
    # halt drops the running worker, start re-evals dist/__gerda_bot.bundle.js. (main.js
    # changes instead need the `reload_main` command; ext.js changes need `reload_ext`.)
    print("Bundle rebuilt+deployed. Reloading worker…")
    _bc.halt()
    return json_print(_bc.start("worker"))


def main() -> int:
    parser = argparse.ArgumentParser(description="Control the Minecraft bridge")
    parser.add_argument(
        "--host",
        default=None,
        help="Bridge host (default: env MC_BRIDGE_HOST, else auto: loopback, then the WSL gateway)",
    )
    parser.add_argument(
        "--port", type=int, default=None,
        help=f"Bridge TCP port (default: --bot's registry port, else env MC_BRIDGE_PORT, else {DEFAULT_PORT})",
    )
    parser.add_argument(
        "--bot",
        default=None,
        help="Target bot by name from mc-bots.json (fleet registry); sets host+port unless overridden",
    )
    parser.add_argument(
        "--timeout", type=float, default=5.0, help="Request timeout (seconds)"
    )
    parser.add_argument(
        "--wait",
        type=float,
        default=None,
        metavar="SECONDS",
        help="Wait up to SECONDS for the bridge PORT to accept a connection before sending "
        "(for a client that is still booting). --timeout is a per-request SOCKET timeout and "
        "does NOT wait: a closed port is refused instantly",
    )
    parser.add_argument(
        "--wait-ready",
        type=float,
        default=None,
        metavar="SECONDS",
        help="Wait up to SECONDS for the bridge to actually ANSWER (a valid status reply). "
        "Stronger than --wait: the port accepts a connection while the client is still at the "
        "title screen, but the bridge only replies once the player is in the world. Each round "
        "re-probes loopback first, then the auto-resolved host (skipped if --host was given). "
        "0 = probe once = ONE such round at the full --timeout budget, so with an auto-resolved "
        "host it can take up to 2x --timeout, not one",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("ping", help="Bridge connectivity test")
    sub.add_parser("diag", help="Main-local topology/health (live handlers+ext, worker age, deploy drift)")
    sub.add_parser("bridge_diag", help="Stable-layer health from bridge.js (works when main is deaf)")
    p_restart = sub.add_parser("restart_service", help="Restart a jsMacros service via bridge (bypasses main)")
    p_restart.add_argument("name", nargs="?", default="main", help="service: main|worker|bridge (default main)")
    sub.add_parser("services", help="List registered services")
    sub.add_parser("status", help="Container and bot status")
    sub.add_parser("get_state", help="Full state snapshot")
    p_scan = sub.add_parser("scan", help="Read-only ore scan around player")
    p_scan.add_argument("--radius", type=int, default=None, help="Scan radius (default: VEIN_SCAN_RADIUS)")
    sub.add_parser("inventory", help="Read-only inventory summary")
    p_logs = sub.add_parser("get_logs", help="Tail the bot's NDJSON journal")
    p_logs.add_argument("--n", type=int, default=None, help="Number of recent lines (default 100, max 500)")
    sub.add_parser("pause", help="Pause active module")
    sub.add_parser("resume", help="Resume active module")
    sub.add_parser("halt", help="Hard kill managed service")
    p_start = sub.add_parser("start", help="Start managed service")
    p_start.add_argument("name", nargs="?", default="worker", help="Service name (default: worker)")
    sub.add_parser("stop", help="Graceful stop managed service")
    p_goto = sub.add_parser("goto", help="Navigator goto x y z")
    p_goto.add_argument("x", type=int)
    p_goto.add_argument("y", type=int)
    p_goto.add_argument("z", type=int)
    p_gotowp = sub.add_parser("goto_waypoint", help="Send bot to a known vein waypoint, then mine it")
    p_gotowp.add_argument("name", nargs="?", default=None, help="Waypoint name (default: nearest vein)")
    p_eval = sub.add_parser("eval", help="Evaluate JS code in sandbox")
    p_eval.add_argument("code", help="JavaScript code string")
    p_load = sub.add_parser("load", help="Load module code from file or string")
    p_load.add_argument("code", help="JS code string or path to .js file")
    sub.add_parser("reload", help="Build bundle via sync.py")
    p_send = sub.add_parser("send", help="Generic bridge command: TYPE + optional JSON payload")
    p_send.add_argument("type", help="Command type string (main HANDLERS / ext.js / worker passthrough)")
    p_send.add_argument("payload", nargs="?", default=None, help='JSON object payload, e.g. \'{"message": "/spawn"}\'')

    args = parser.parse_args()

    endpoint = resolve_endpoint(args.host, args.port, args.bot)
    if endpoint is None:
        return 1
    host, port = endpoint
    bc = BridgeClient(host=host, port=port, timeout=args.timeout)

    # A negative wait is a typo, not "don't wait" (0 is that) — refuse it rather than probing
    # once and calling a booting bridge dead.
    if args.wait is not None and args.wait < 0:
        print(f"ERR: --wait must be >= 0 seconds (got {args.wait})", file=sys.stderr)
        return 1
    if args.wait_ready is not None and args.wait_ready < 0:
        print(f"ERR: --wait-ready must be >= 0 seconds (got {args.wait_ready})", file=sys.stderr)
        return 1

    # Fail-loud: a bridge that never came up must exit nonzero with a named endpoint, not
    # fall through into a ConnectionRefused traceback from the command itself. Name every host
    # that was PROBED, not just the one we ended on: with an auto-resolved host the waits also
    # retry loopback each round, and a message naming only the gateway sends the reader hunting
    # for a bridge on the wrong box (a real incident read exactly that way).
    probed = ", ".join(bc.wait_hosts())
    if args.wait is not None and not bc.wait_for_port(args.wait):
        print(
            f"ERR: bridge {bc.host}:{bc.port} did not accept a connection within {args.wait}s "
            f"(probed: {probed})",
            file=sys.stderr,
        )
        return 1

    # The stronger wait: an open port is not an answering bridge (a booting client listens from
    # the title screen), so a command issued on --wait alone dies in recv with a TimeoutError.
    # Re-read the candidates: a successful --wait above may have adopted one, collapsing the set.
    probed = ", ".join(bc.wait_hosts())
    if args.wait_ready is not None and not bc.wait_for_ready(args.wait_ready):
        print(
            f"ERR: bridge {bc.host}:{bc.port} did not answer a status request within "
            f"{args.wait_ready}s (probed: {probed}; port may be open — is the player in the world?)",
            file=sys.stderr,
        )
        return 1

    handlers = {
        "ping": cmd_ping,
        "diag": cmd_diag,
        "bridge_diag": cmd_bridge_diag,
        "restart_service": cmd_restart_service,
        "services": cmd_services,
        "status": cmd_status,
        "get_state": cmd_get_state,
        "scan": cmd_scan,
        "inventory": cmd_inventory,
        "get_logs": cmd_get_logs,
        "pause": cmd_pause,
        "resume": cmd_resume,
        "halt": cmd_halt,
        "start": cmd_start,
        "stop": cmd_stop,
        "goto": cmd_goto,
        "goto_waypoint": cmd_goto_waypoint,
        "eval": cmd_eval,
        "load": cmd_load,
        "reload": cmd_reload,
        "send": cmd_send,
    }
    try:
        return handlers[args.command](bc, args)
    except BridgeUnreachable as e:  # names host:port and what to check — one line, no traceback
        print(f"ERR: {e}", file=sys.stderr)
        return 2
    except OSError as e:  # a LOCAL failure (unreadable file, ...) — not the bridge's
        print(f"ERR: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
