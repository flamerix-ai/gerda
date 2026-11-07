#!/usr/bin/env python3
"""Reload the worker bundle SAFELY over the bridge.

Sends ONE idempotent `reload_worker` command (main.js does halt+start off-thread and
flushes the ack first), instead of a manual `halt` then `start` from the host.

WHY: a bare `halt` calls SM.stopService() synchronously on main's Tick thread; if the
worker is stuck (e.g. a stale LocalPlayer ref after a respawn) that BLOCKS main's Tick
dispatch and the whole bridge goes DEAF. Then a blind retry of halt/start piles a second
service cycle on top and wedges it harder — exactly what deaf-locked bot_1 (id=156 halt
queued, never acked). This helper:
  • uses the off-thread `reload_worker` command (main never blocks on the stop),
  • uses a generous timeout,
  • NEVER blind-retries a mutating command on ack timeout (it may have executed) — it
    reports and lets you decide.

It dials the same bridge `./gerda ctl` does: --host/--port, else --bot from the fleet
registry, else MC_BRIDGE_HOST / MC_BRIDGE_PORT, else port 55544 (bridge_ctl.resolve_endpoint).

Usage:  python scripts/ops/reload_worker.py [--port N | --bot NAME] [--delay-ms 1500] [--timeout 30]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # scripts/ops/ -> bridge_ctl
from bridge_ctl import resolve_endpoint  # noqa: E402  (also puts scripts/ + mcp/ on sys.path)
from bridge_client import BridgeClient, BridgeUnreachable  # noqa: E402


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=None)
    ap.add_argument("--host", default=None)
    ap.add_argument("--bot", default=None, help="Target bot by name from mc-bots.json (fleet registry)")
    ap.add_argument("--delay-ms", type=int, default=1500)
    ap.add_argument("--timeout", type=float, default=30.0)
    args = ap.parse_args(argv)

    endpoint = resolve_endpoint(args.host, args.port, args.bot)
    if endpoint is None:
        return 1
    host, port = endpoint
    b = BridgeClient(host=host, port=port, timeout=args.timeout)
    try:
        resp = b.send("reload_worker", {"delay": args.delay_ms})
    except TimeoutError:
        # DO NOT retry: reload_worker flushes its ack before doing any work, so a timeout
        # here means main's dispatch is not answering (not that the command was dropped).
        # Retrying a halt/start now only wedges it harder.
        print(
            "reload_worker: %s:%d accepted but sent no ack within %.0fs — main.js dispatch is busy "
            "or likely DEAF.\nCheck with `./gerda ctl --port %d bridge_diag`: main's tick count still "
            "rising = busy (e.g. right after reload_main) and the reload is queued — see "
            "get_state.worker.build before you run this again. Do NOT retry halt/start. If main "
            "is deaf, restart the bot's MC instance in the launcher."
            % (b.host, port, args.timeout, port),
            file=sys.stderr,
        )
        return 2
    except BridgeUnreachable as e:
        # Refused: nothing listens there (a wrong port, or a client that is not up) — not a deaf
        # main. After TimeoutError: a silent bridge (BridgeSilent) is both, and it IS the deaf case.
        print(f"reload_worker: {e}", file=sys.stderr)
        return 2
    if not resp.get("ok"):
        print("reload_worker failed: %s" % resp.get("error", resp), file=sys.stderr)
        return 1
    print("reload_worker acked: %s" % resp.get("note", "ok"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
