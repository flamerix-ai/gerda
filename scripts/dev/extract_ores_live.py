#!/usr/bin/env python3
"""Regenerate config/ores_live.json from the LIVE game's Forge block registry.

Runtime ore discovery: instead of scraping GTCEu's GitHub source
(scripts/dev/extract_gtceu_ores.py — a future pack profile, dimension-shaped), this asks a
running client for the actual ore-block ids via the `ore_registry` ext command
(forge:ores tag ∪ *_ore id-suffix scan) and writes them flat. The TS kernel imports the
json at BUILD time (src/bot/profile/pack.ts → cfg.ore.ids), so the generated file
is committed — the build stays hermetic, no bot needed to compile.

Also derives HARVEST TIERS ("not every ore breaks with any pickaxe"): ore_registry now ships
each ore block's `needs_<material>_tool` tag memberships (the vanilla/Forge harvest-level
convention — GTCEu registers its tiers the same way). This script maps material→rank on
the vanilla ladder, folds per-block ranks into ore-GROUP ranks (`group_ranks`, keyed by
every token-suffix of the ore path so "gold", "certus_quartz" and "quartz" all resolve),
and writes them into ores_live.json — consumed by cfg.ore.minPickRank, with the
static table in domain/tooling.ts as fallback. Per-block detail goes to
config/ore_tool_tiers.json (audit only, NOT imported — keeps the bundle small).

Usage:
    python3 scripts/dev/extract_ores_live.py [--port 55545] [--out config/ores_live.json]

Re-run after a modpack update, then `just build` + commit the diff.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))  # scripts/ root
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "mcp"))  # mcp/ -> canonical bridge_client
from bridge_client import BridgeClient  # noqa: E402

REPO = pathlib.Path(__file__).resolve().parents[2]  # repo root (this file lives in scripts/dev/)

# Vanilla harvest ladder (mirrors toolTierRank in src/shared/domain/tooling.ts). Unknown modded
# materials rank 3 (diamond-ish): better to warn "need a big pickaxe" than to stay silent
# on an endgame ore.
TIER_MATERIAL_RANK = {
    "wood": 0,
    "wooden": 0,
    "stone": 1,
    "gold": 1,
    "golden": 1,
    "copper": 1,
    "flint": 1,
    "iron": 2,
    "bronze": 2,
    "diamond": 3,
    "steel": 3,
    "tungsten": 3,
    "netherite": 4,
    "duranium": 4,
    "neutronium": 4,
}
TAG_RE = re.compile(r"^needs_(.+)_tool$")


def tag_rank(tag: str, unknown: set[str]) -> int:
    """`namespace:needs_<material>_tool` → harvest rank."""
    path = tag.split(":", 1)[-1]
    m = TAG_RE.match(path)
    if not m:
        return 0
    material = m.group(1)
    rank = TIER_MATERIAL_RANK.get(material)
    if rank is None:
        unknown.add(tag)
        return 3
    return rank


def derive_group_ranks(tiers: dict[str, int]) -> dict[str, int]:
    """Per-block ranks → ore-GROUP ranks. The group vocabulary (drill's `ore` param,
    PROSPECT_ORE_GROUPS) is name-based, so register every token-suffix of the ore path
    ("deepslate_certus_quartz_ore" → certus_quartz, quartz — but NOT the stone-prefix
    combos), keeping the MAX rank across variants: a warning that over-asks beats one
    that stays silent while the drop is impossible."""
    groups: dict[str, int] = {}
    for bid, rank in tiers.items():
        path = bid.split(":", 1)[-1]
        if not path.endswith("_ore"):
            continue
        tokens = path[: -len("_ore")].split("_")
        for i in range(len(tokens)):
            group = "_".join(tokens[i:])
            groups[group] = max(groups.get(group, 0), rank)
    # Prune redundant longer names ("deepslate_gold" when "gold" already answers the same
    # rank) — the raw suffix expansion is ~2.7k entries and the json is INLINED into the
    # bundle; only keep a longer name where it genuinely disambiguates. Longest-first so
    # chains collapse transitively.
    for group in sorted(groups, key=lambda g: -g.count("_")):
        if "_" not in group:
            continue
        parent = group.split("_", 1)[1]
        if parent in groups and groups[parent] == groups[group]:
            del groups[group]
    return groups


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=None, help="bridge port (default: probe)")
    ap.add_argument("--host", default=None, help="bridge host (default: probe loopback)")
    ap.add_argument(
        "--out", default=str(REPO / "config" / "ores_live.json"), help="output json path"
    )
    args = ap.parse_args()

    kw: dict = {"timeout": 30.0}
    if args.port is not None:
        kw["port"] = args.port
    if args.host is not None:
        kw["host"] = args.host
    resp = BridgeClient(**kw).send("ore_registry")
    if not resp.get("ok"):
        print(f"ore_registry failed: {resp.get('error', resp)}", file=sys.stderr)
        return 1

    ids = resp["ids"]
    if not ids or not isinstance(ids, list):
        print(f"ore_registry returned no ids: {resp}", file=sys.stderr)
        return 1

    # Harvest tiers: raw needs_*_tool tag names per block → ranks → group ranks.
    tool_tags: dict[str, list[str]] = resp.get("tool_tags") or {}
    unknown: set[str] = set()
    tiers = {
        bid: max(tag_rank(t, unknown) for t in tags)
        for bid, tags in tool_tags.items()
        if tags
    }
    group_ranks = derive_group_ranks(tiers)
    if unknown:
        print(
            f"note: unmapped tier materials (ranked 3): {sorted(unknown)}", file=sys.stderr
        )

    out = pathlib.Path(args.out)
    payload = {
        "_comment": "GENERATED by scripts/dev/extract_ores_live.py from the live Forge registry "
        "(ore_registry ext command: forge:ores tag + *_ore id scan + needs_*_tool tier tags). "
        "Commit after regen; imported at build time by src/bot/profile/pack.ts.",
        "sources": resp.get("sources", {}),
        "count": len(ids),
        "group_ranks": dict(sorted(group_ranks.items())),
        "ids": sorted(ids),
    }
    out.write_text(json.dumps(payload, indent=2) + "\n")

    # Per-block audit detail — NOT imported by the TS build (keeps the bundle small).
    audit = out.parent / "ore_tool_tiers.json"
    audit.write_text(
        json.dumps(
            {
                "_comment": "GENERATED audit companion to ores_live.json: per-block "
                "needs_*_tool tags and the derived rank. Not imported by the build.",
                "tiers": dict(sorted(tiers.items())),
                "tags": dict(sorted(tool_tags.items())),
            },
            indent=2,
        )
        + "\n"
    )
    print(
        f"wrote {out} — {len(ids)} ore ids, {len(tiers)} tiered, "
        f"{len(group_ranks)} groups (sources: {payload['sources']}); audit → {audit}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
