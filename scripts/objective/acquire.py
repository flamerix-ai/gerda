"""Acquisition resolvers — the Minecraft-coupled half, injected into the engine as the
`have_item` resolver so the engine core stays game-agnostic.

ensure_item satisfies a have_item Requirement by a strategy ladder:
    1. HAVE  — already enough in the bag (count_item).            -> ok
    2. CRAFT — EMI has a recipe (resolve_craft_chain): recursively ensure the raw
               leaves, then run the `craft` mission, poll until the count is reached.
    3. MINE  — raw/uncraftable: prospect + travel + `mine` mission (gated by allow_mine;
               honest-blocks with a precise reason until wired/approved).
SMELT (raw ore -> ingot) is a planned next mission; until then a needed ingot that
isn't craftable/holdable honest-blocks rather than pretending.
"""
from __future__ import annotations

import sys
import time
from collections.abc import Callable
from pathlib import Path

_SCRIPTS = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_SCRIPTS))               # scripts/
sys.path.insert(0, str(_SCRIPTS / "dev"))       # scripts/dev/ -> resolve_craft_chain
sys.path.insert(0, str(_SCRIPTS / "objective"))  # scripts/objective/ -> core

import resolve_craft_chain as rcc  # noqa: E402
from core import Requirement, ResolveOutcome  # noqa: E402


class Acquirer:
    def __init__(
        self,
        bridge,
        *,
        allow_craft: bool = True,
        allow_mine: bool = False,
        log: Callable[[str], None] = lambda _m: None,
        poll_s: float = 2.0,
        timeout_s: float = 180.0,
        max_depth: int = 5,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.bridge = bridge
        self.allow_craft = allow_craft
        self.allow_mine = allow_mine
        self.log = log
        self.poll_s = poll_s
        self.timeout_s = timeout_s
        self.max_depth = max_depth
        self.sleep = sleep

    # ---- engine entrypoint ------------------------------------------------ #

    def resolve(self, req: Requirement) -> ResolveOutcome:
        item = req.args.get("item")
        tag = req.args.get("tag")
        count = int(req.args.get("count", 1))
        if not item and tag:
            item = self.resolve_tag(tag)
            if not item:
                return ResolveOutcome(False, f"no concrete item found for tag #{tag}")
            self.log(f"    tag #{tag} -> {item}")
        if not item:
            return ResolveOutcome(False, "requirement has neither item nor tag")
        return self._ensure(item, count, 0)

    # ---- helpers ---------------------------------------------------------- #

    def count(self, item: str) -> int:
        r = self.bridge.send("count_item", {"item": item})
        return int(r["data"]["count"]) if r.get("ok") else 0

    def resolve_tag(self, tag: str) -> str | None:
        """Pick a concrete item satisfying an itemfilters tag via EMI (#tag search)."""
        r = self.bridge.send("emi_search", {"text": f"#{tag}", "limit": 25})
        results = r.get("results") or (r.get("data") or {}).get("results") or []
        return results[0] if results else None

    def _ensure(self, item: str, count: int, depth: int) -> ResolveOutcome:
        have = self.count(item)
        if have >= count:
            return ResolveOutcome(True, f"have {have}/{count} {item}")
        if depth > self.max_depth:
            return ResolveOutcome(False, f"acquisition too deep at {item}")
        self.log(f"    need {item} x{count} (have {have})")
        if self.allow_craft:
            crafted = self._try_craft(item, count, depth)
            if crafted is not None:  # None => not craftable (raw)
                return crafted
        # raw / uncraftable -> mining territory
        if not self.allow_mine:
            return ResolveOutcome(
                False, f"{item}: need {count - have} more by gathering — mining not wired (allow_mine=False)"
            )
        return self._try_mine(item, count)

    def _try_craft(self, item: str, count: int, depth: int) -> ResolveOutcome | None:
        try:
            plan = rcc.resolve_full(self.bridge, item, count, True)
        except SystemExit:
            return None  # raw item: no recipe
        except Exception as e:  # noqa: BLE001 — EMI/bridge hiccup, report and stop this branch
            return ResolveOutcome(False, f"craft-plan failed for {item}: {e}")
        # ensure raw leaves first (recursively), then run the craft
        for leaf, leaf_n in plan["leaves"].items():
            sub = self._ensure(leaf, leaf_n, depth + 1)
            if not sub.ok:
                return ResolveOutcome(False, f"ingredient {leaf}: {sub.detail}")
        self.log(f"    craft {item} x{count} ({len(plan['chain'])} steps)")
        self.bridge.send(
            "mission_start",
            {"name": "craft", "params": {"output": item, "count": count, "chain": plan["chain"]}},
        )
        if self._wait_for(item, count):
            return ResolveOutcome(True, f"crafted {item} x{count}")
        self.bridge.send("mission_abort")
        return ResolveOutcome(False, f"craft of {item} did not reach {count} within {self.timeout_s:.0f}s")

    def _try_mine(self, item: str, count: int) -> ResolveOutcome:
        # Placeholder for the wired mining path (prospect -> travel -> mine -> poll). Kept
        # explicit + honest so a half-built path never silently "succeeds".
        return ResolveOutcome(False, f"{item}: mining path not yet implemented")

    def _wait_for(self, item: str, count: int) -> bool:
        deadline = time.monotonic() + self.timeout_s
        while time.monotonic() < deadline:
            if self.count(item) >= count:
                return True
            self.sleep(self.poll_s)
        return self.count(item) >= count
