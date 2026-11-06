#!/usr/bin/env python3
"""Resolve a CraftChainStep[] for the craft mission from EMI — offline, against a running bot.

The mission plane (the TS bundle) is pull-only and cannot call bridge/ext commands, so the
craft chain can't be resolved at mission runtime. Instead this offline
tool queries the running bot's `recipe` ext command (EMI, pack-correct) RECURSIVELY, does the
quantity math, and emits the same `{grid, times}[]` shape the craft mission accepts as its
`chain` param (or that seeds cfg.craft.defaultChain). So a hand-authored chain becomes a
derived one: regenerate instead of hardcode.

Algorithm: build the craft DAG from the target down (an ingredient with no crafting recipe is
RAW — a leaf the bot gathers, e.g. logs/ores), topologically order it (consumers first),
accumulate unit demand top-down computing crafts = ceil(demand / yield) per item, then emit
the craftable steps leaves-first (so sub-crafts precede the final). With --table, a 3×3 final
(cells > 4) also demands one crafting_table (the mission places it for the 3×3 step) — which
reproduces the built-in oak-logs→planks→table→chest chain exactly.

Usage:
  python scripts/dev/resolve_craft_chain.py minecraft:chest [--count N] [--table] [--no-table]
The bot must be running with EMI loaded (the `recipe` ext command). Prints JSON to stdout.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # scripts/ root
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "mcp"))  # mcp/ -> canonical bridge_client
from bridge_client import BridgeClient  # noqa: E402


def compact_grid(grid: list) -> list:
    """Shrink a square recipe grid to its non-null bounding box (row-major).

    EMI flattens shaped recipes to their category's display grid — a 2×2 table recipe comes
    back as a 9-cell 3×3 with the pattern in the top-left. The craft mission runs every
    pre-craft in the player's 2×2 (4-slot) grid and waits for `gridSize >= grid.length`, so a
    9-cell pre-craft hangs forever (PRE/PLACE timeout). Compacting a 2×2-fitting recipe to 4
    cells lets it run in the player grid; a genuine 3×3 (the chest) stays 9 and goes to a table.
    Only square grids (1/4/9) are reshaped; anything else is passed through untouched.
    """
    n = len(grid)
    side = round(n**0.5)
    if side * side != n:
        return grid
    rows = [grid[r * side : (r + 1) * side] for r in range(side)]
    filled_rows = [r for r in range(side) if any(rows[r][c] for c in range(side))]
    filled_cols = [c for c in range(side) if any(rows[r][c] for r in range(side))]
    if not filled_rows:
        return grid
    minr, maxr = filled_rows[0], filled_rows[-1]
    minc, maxc = filled_cols[0], filled_cols[-1]
    h, w = maxr - minr + 1, maxc - minc + 1
    t = max(h, w)  # square output so the mission can place it in a t×t grid
    return [
        rows[minr + i][minc + j] if (i < h and j < w) else None
        for i in range(t)
        for j in range(t)
    ]


def first_recipe(client: BridgeClient, item: str, cache: dict) -> dict | None:
    """First ≤3×3 crafting recipe for `item` as {grid, output}, or None if it's raw."""
    if item in cache:
        return cache[item]
    resp = client.send("recipe", {"item": item, "limit": 1, "craftOnly": True})
    rec = None
    if resp.get("ok") and resp.get("recipes"):
        r = resp["recipes"][0]
        rec = {"grid": r["grid"], "output": r.get("output", {"id": item, "count": 1})}
    cache[item] = rec
    return rec


def resolve_full(client: BridgeClient, target: str, count: int, want_table: bool) -> dict:
    """Plan the craft. Returns {"chain": [{grid,times}], "leaves": {raw_item: demand}}.

    `chain` is exactly what resolve() returns (the craft mission's param). `leaves` is the
    raw/gatherable items the bot must already hold (with total demand) — what the
    acquisition layer must recursively ensure (mine/smelt) before running the craft.
    Raises SystemExit if `target` itself is raw."""
    cache: dict = {}
    roots = {target: count}

    final = first_recipe(client, target, cache)
    if final is None:
        raise SystemExit(f"{target} has no crafting recipe (it's a raw/gatherable item)")
    # A 3×3 final needs a placed table — the mission crafts+places one, so demand it too.
    if want_table and len([c for c in final["grid"]]) > 4:
        roots["minecraft:crafting_table"] = roots.get("minecraft:crafting_table", 0) + 1

    # Topological order (consumers before producers) over the craftable DAG via post-order DFS.
    order: list[str] = []
    seen: set[str] = set()

    def visit(item: str, stack: tuple[str, ...]) -> None:
        if item in seen:
            return
        if item in stack:  # recipe cycle — treat as raw to break it
            return
        rec = first_recipe(client, item, cache)
        if rec is None:
            return  # raw leaf
        for cell in rec["grid"]:
            if cell:
                visit(cell, stack + (item,))
        seen.add(item)
        order.append(item)  # producers appended after their ingredients → leaves-first

    # Visit the target LAST so it lands last in `order` (leaves-first): the mission crafts
    # all pre-steps in the 2×2 grid, then the target as the final (possibly 3×3) step. Any
    # injected pre-req (the crafting_table for a 3×3 final) must precede it.
    for root in roots:
        if root != target:
            visit(root, ())
    visit(target, ())

    # order is leaves-first; accumulate demand consumers-first (reverse) so an ingredient's
    # total is known before we size its crafts.
    demand: dict[str, int] = dict(roots)
    crafts: dict[str, int] = {}
    for item in reversed(order):
        rec = cache[item]
        if rec is None:
            continue
        yield_per = max(1, int(rec["output"].get("count", 1)))
        n = math.ceil(demand.get(item, 0) / yield_per)
        crafts[item] = n
        per_cell: dict[str, int] = {}
        for cell in rec["grid"]:
            if cell:
                per_cell[cell] = per_cell.get(cell, 0) + 1
        for ing, k in per_cell.items():
            demand[ing] = demand.get(ing, 0) + n * k

    # Emit craftable steps leaves-first (== `order`); raw items are gathered, not crafted.
    # compact_grid shrinks EMI's flattened display grid so 2×2 recipes run in the player grid.
    chain = [
        {"grid": compact_grid(cache[i]["grid"]), "times": crafts[i]}
        for i in order
        if crafts.get(i, 0) > 0
    ]
    # Raw leaves = demanded items that are never crafted (no recipe) — gathered, not made.
    leaves = {i: demand[i] for i in demand if crafts.get(i, 0) == 0}
    return {"chain": chain, "leaves": leaves}


def resolve(client: BridgeClient, target: str, count: int, want_table: bool) -> list[dict]:
    """The craft mission's `chain` param (list of {grid,times}). Thin wrapper over
    resolve_full for backward compatibility."""
    return resolve_full(client, target, count, want_table)["chain"]


def main() -> None:
    ap = argparse.ArgumentParser(description="Resolve a craft chain from EMI via the running bot")
    ap.add_argument("item", help="target item id, e.g. minecraft:chest")
    ap.add_argument("--count", type=int, default=1, help="how many of the target (default 1)")
    ap.add_argument("--table", dest="table", action="store_true", default=True,
                    help="prepend a crafting_table craft for a 3×3 final (default on)")
    ap.add_argument("--no-table", dest="table", action="store_false",
                    help="do not provision a table (final crafts in the 2×2 grid)")
    args = ap.parse_args()

    chain = resolve(BridgeClient(), args.item, args.count, args.table)
    print(json.dumps(chain, indent=2))


if __name__ == "__main__":
    main()
