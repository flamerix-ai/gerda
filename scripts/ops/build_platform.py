#!/usr/bin/env python3
"""Expand the void-base platform with filler blocks, host-driven.

The greedy navigator CANNOT build into open void (bridgePlace requires real
landfall within cfg.nav.bridgeMaxRun), so base-platform expansion is an ops loop
over the `interact_place` ext primitive instead: fixed-point fill — place any
target cell that already has a solid cardinal neighbor to click against, walk
the bot onto fresh floor when targets fall out of reach, repeat until done.

Usage:
  python3 scripts/ops/build_platform.py --port 55545 \
      --x0 -495 --x1 -483 --z0 -351 --z1 -339 --y 77 \
      --items minecraft:cobblestone,minecraft:cobbled_deepslate
"""

from __future__ import annotations

import argparse
import atexit
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # scripts/ root
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "mcp"))  # mcp/ -> canonical bridge_client
from bridge_client import BridgeClient  # noqa: E402

AIR = {"minecraft:air", "minecraft:cave_air", "minecraft:void_air", None, "?"}
FACES = {(1, 0): "east", (-1, 0): "west", (0, 1): "south", (0, -1): "north"}
REACH = 3.2  # horizontal; eyes sit ~2.1 above the platform plane, so 3.2 horizontal ≈ 3.8 true (survival reach 4.5)


def block_ids(bc: BridgeClient, cells: list[tuple[int, int, int]]) -> list[str]:
    """Read many block ids in one sandboxed eval round-trip."""
    coords = json.dumps(cells)
    code = (
        "(function(){ var cs=%s; var out=[]; for(var i=0;i<cs.length;i++){"
        " var b=World.getBlock(cs[i][0],cs[i][1],cs[i][2]);"
        " out.push(b?b.getId():\"?\"); } return JSON.stringify(out); })()" % coords
    )
    r = bc.send("eval", {"code": code})
    data = r.get("data") or r.get("result")
    if isinstance(data, str):
        return json.loads(data)
    raise RuntimeError(f"block read failed: {r}")


def bot_pos(bc: BridgeClient) -> tuple[float, float, float]:
    r = bc.send("get_state")
    p = r.get("position") or {}
    if isinstance(p, dict) and "x" in p:
        return (p["x"], p["y"], p["z"])
    raise RuntimeError(f"no position in get_state: {r}")


def goto_and_wait(bc: BridgeClient, x: int, y: int, z: int, timeout: float = 45.0) -> bool:
    # greedy_drive = the worker's per-tick greedy navigator (idle-only diag drive) — the
    # container `goto` is legacy Baritone #goto and must not be used (Baritone removed).
    bc.send("greedy_drive", {"x": x, "y": y, "z": z})
    deadline = time.time() + timeout
    ok = False
    while time.time() < deadline:
        time.sleep(1.0)
        px, _, pz = bot_pos(bc)
        if abs(px - (x + 0.5)) < 1.6 and abs(pz - (z + 0.5)) < 1.6:
            ok = True
            break
    bc.send("greedy_drive_stop")
    return ok


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--x0", type=int, required=True)
    ap.add_argument("--x1", type=int, required=True)
    ap.add_argument("--z0", type=int, required=True)
    ap.add_argument("--z1", type=int, required=True)
    ap.add_argument("--y", type=int, required=True)
    ap.add_argument(
        "--items",
        default="minecraft:cobblestone,minecraft:cobbled_deepslate",
        help="filler item ids, in consumption order",
    )
    args = ap.parse_args()

    bc = BridgeClient(port=args.port, timeout=15.0)
    items = [s for s in args.items.split(",") if s]
    y = args.y

    # goto_and_wait demands <1.6 of the stand cell, but the navigator's default arrival
    # distance is ~2.5 — it would stop short and every goto would "not settle". Tighten
    # for the build, restore the default (dist<=0 clears the override) on every exit path.
    bc.send("set_arrival", {"dist": 1.0})
    atexit.register(lambda: bc.send("set_arrival", {"dist": 0}))

    targets = [
        (x, y, z)
        for x in range(args.x0, args.x1 + 1)
        for z in range(args.z0, args.z1 + 1)
    ]
    ids = block_ids(bc, targets)
    todo = {(c[0], c[2]) for c, bid in zip(targets, ids) if bid in AIR}
    solid = {(c[0], c[2]) for c, bid in zip(targets, ids) if bid not in AIR}
    print(f"grid {len(targets)} cells: {len(solid)} solid, {len(todo)} to place")

    placed_total = 0
    item_idx = 0
    bad_stands: set[tuple[int, int]] = set()
    deferred: set[tuple[int, int]] = set()
    placed_at_requeue = -1
    while todo or deferred:
        if not todo:
            # Re-queue the deferred cells: the ring has grown since, so a fresh route/stand
            # may exist now. Clearing the stand blacklist matters — new cells ARE new stands.
            if placed_total == placed_at_requeue:
                print(f"STUCK: {len(deferred)} deferred cells made no progress", file=sys.stderr)
                return 1
            placed_at_requeue = placed_total
            todo, deferred = deferred, set()
            bad_stands.clear()
            print(f"re-queueing {len(todo)} deferred cells")
        # Frontier = todo cells with a solid cardinal neighbor to click against.
        frontier = [
            (tx, tz)
            for (tx, tz) in todo
            if any((tx + dx, tz + dz) in solid for (dx, dz) in FACES)
        ]
        if not frontier:
            print(f"STUCK: {len(todo)} cells left with no solid neighbor", file=sys.stderr)
            return 1
        px, _, pz = bot_pos(bc)
        # Nearest frontier cell to the bot; walk closer if out of reach.
        frontier.sort(key=lambda c: (c[0] + 0.5 - px) ** 2 + (c[1] + 0.5 - pz) ** 2)
        tx, tz = frontier[0]
        if ((tx + 0.5 - px) ** 2 + (tz + 0.5 - pz) ** 2) ** 0.5 > REACH:
            # Stand on a solid cell near the target (never on a todo cell). A "solid" cell can
            # still be unreachable — an isolated island beyond a wall of chests, or capped by a
            # block — so try the nearest few and blacklist the ones the navigator can't settle
            # on, instead of retrying the same dead stand forever.
            stands = [
                c
                for c in sorted(solid, key=lambda c: (c[0] - tx) ** 2 + (c[1] - tz) ** 2)
                if c not in bad_stands
            ][:6]
            settled = False
            for sx, sz in stands:
                if goto_and_wait(bc, sx, y + 1, sz):
                    settled = True
                    break
                bad_stands.add((sx, sz))
                print(f"goto ({sx},{sz}) did not settle; blacklisted", file=sys.stderr)
            if not settled:
                # Every nearby stand is unreachable from here — deprioritize this frontier
                # cell (the ring will creep around to it from another side) and move on.
                todo.discard((tx, tz))
                deferred.add((tx, tz))
                print(f"deferring ({tx},{tz}): no reachable stand", file=sys.stderr)
                continue
            px, _, pz = bot_pos(bc)
        # Click against the solid neighbor closest to the bot (best line of sight).
        against = sorted(
            [
                ((tx + dx, tz + dz), FACES[(-dx, -dz)])
                for (dx, dz) in FACES
                if (tx + dx, tz + dz) in solid
            ],
            key=lambda a: (a[0][0] + 0.5 - px) ** 2 + (a[0][1] + 0.5 - pz) ** 2,
        )
        (ax, az), face = against[0]
        r = bc.send(
            "interact_place",
            {"pos": [ax, y, az], "face": face, "item": items[item_idx], "verify": "consumed"},
        )
        if not r.get("ok"):
            err = str(r.get("error", ""))
            if "no " in err and "inventory" in err and item_idx + 1 < len(items):
                item_idx += 1
                print(f"switching filler → {items[item_idx]}")
                continue
            print(f"place ({tx},{tz}) failed: {err}", file=sys.stderr)
            return 1
        # Effect-verify by world read — `consumed` alone can lie (e.g. click ate a
        # different interaction). One cell per iteration keeps this simple.
        bid = block_ids(bc, [(tx, y, tz)])[0]
        if bid in AIR:
            if not r.get("placed"):
                # Genuine miss (reach/LOS) — walk right next to the against-block and retry.
                if not goto_and_wait(bc, ax, y + 1, az):
                    print(f"retry-goto ({ax},{az}) failed", file=sys.stderr)
                time.sleep(0.3)
                continue
            time.sleep(0.5)
            bid = block_ids(bc, [(tx, y, tz)])[0]
            if bid in AIR:
                print(f"verify failed at ({tx},{tz}) after consumed place", file=sys.stderr)
                return 1
        todo.discard((tx, tz))
        solid.add((tx, tz))
        placed_total += 1
        if placed_total % 20 == 0:
            print(f"placed {placed_total}, {len(todo)} left")
        time.sleep(0.15)
    print(f"DONE: placed {placed_total} blocks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
