#!/usr/bin/env python3
"""fleet_ctl.py — operator CLI for the fleet coordinator hub (stdlib, no deps).

The hub (scripts/ops/fleet_hub.py, `gerda hub`) exposes a JSON HTTP API on
MC_FLEET_HUB (default http://127.0.0.1:8849). This is the human/no-MCP client
for it — the same surface the MCP `mc_fleet_*` tools wrap.

  fleet_ctl.py status                     # presence: every registry bot, online flag
  fleet_ctl.py map                        # merged vein map across the fleet
  fleet_ctl.py claims                     # active work-claim leases
  fleet_ctl.py queue                      # task backlog + in-flight + terminal tail
  fleet_ctl.py want ore --bots 2          # "I need X": ore→drill, wood→chop, food→hunt…
  fleet_ctl.py enqueue drill '{"ore":"iron"}' [--bot NAME] [--ttl 600]
  fleet_ctl.py cancel <task-id>
  fleet_ctl.py assign <bot> <minX> <maxX> <minZ> <maxZ> [--ttl 600]
  fleet_ctl.py unassign <bot>
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

HUB = os.environ.get("MC_FLEET_HUB", "http://127.0.0.1:8849")


def call(route: str, payload: dict | None = None) -> dict:
    url = f"{HUB}{route}"
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(
        url, data=data, headers={"Content-Type": "application/json"} if data else {}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as e:  # hub answers errors as JSON too — show them
        body = e.read().decode(errors="replace")
        sys.exit(f"fleet_ctl: {url} → HTTP {e.code}: {body}")
    except (urllib.error.URLError, TimeoutError) as e:
        sys.exit(f"fleet_ctl: hub unreachable at {HUB} ({e}) — start it with `gerda hub`")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)

    for name in ("status", "map", "claims", "queue"):
        sub.add_parser(name, help=f"GET /fleet/{name}")

    p = sub.add_parser("want", help="POST /fleet/want — produce a resource")
    p.add_argument("resource")
    p.add_argument("--bots", type=int, default=None, help="how many bots to put on it")
    p.add_argument("--bot", default=None, help="pin to one specific bot")
    p.add_argument("--ttl", type=int, default=None)

    p = sub.add_parser("enqueue", help="POST /fleet/enqueue — backlog a mission")
    p.add_argument("mission")
    p.add_argument("params", nargs="?", default=None, help="mission params as JSON")
    p.add_argument("--bot", default=None, help="pin to one specific bot")
    p.add_argument("--ttl", type=int, default=None)

    p = sub.add_parser("cancel", help="POST /fleet/cancel — cancel/abort a task")
    p.add_argument("id")

    p = sub.add_parser("assign", help="POST /fleet/assign — lease a mining region")
    p.add_argument("bot")
    p.add_argument("minX", type=int)
    p.add_argument("maxX", type=int)
    p.add_argument("minZ", type=int)
    p.add_argument("maxZ", type=int)
    p.add_argument("--ttl", type=int, default=None)

    p = sub.add_parser("unassign", help="POST /fleet/unassign — drop a bot's region")
    p.add_argument("bot")

    a = ap.parse_args()

    if a.cmd in ("status", "map", "claims", "queue"):
        out = call(f"/fleet/{a.cmd}")
    elif a.cmd == "want":
        body = {"resource": a.resource}
        if a.bots is not None:
            body["bots"] = a.bots
        if a.bot:
            body["bot"] = a.bot
        if a.ttl is not None:
            body["ttl"] = a.ttl
        out = call("/fleet/want", body)
    elif a.cmd == "enqueue":
        body = {"mission": a.mission}
        if a.params:
            body["params"] = json.loads(a.params)
        if a.bot:
            body["bot"] = a.bot
        if a.ttl is not None:
            body["ttl"] = a.ttl
        out = call("/fleet/enqueue", body)
    elif a.cmd == "cancel":
        out = call("/fleet/cancel", {"id": a.id})
    elif a.cmd == "assign":
        out = call(
            "/fleet/assign",
            {
                "bot": a.bot,
                "allowed": {"minX": a.minX, "maxX": a.maxX, "minZ": a.minZ, "maxZ": a.maxZ},
                **({"ttl": a.ttl} if a.ttl is not None else {}),
            },
        )
    else:  # unassign
        out = call("/fleet/unassign", {"bot": a.bot})

    json.dump(out, sys.stdout, indent=2, ensure_ascii=False)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
