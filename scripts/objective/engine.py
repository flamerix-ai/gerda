#!/usr/bin/env python3
"""Objective-engine CLI — drive the bot's objectives over the bridge.

Wires a source adapter (FTB Quests, or our own local goals) + the acquisition resolver
+ the MODE gate, then runs the agnostic ObjectiveEngine. Approve mode (default) asks
before acting on each objective; --dry-run previews the next objective and its
acquisition plan WITHOUT mutating anything (safe to run any time).

Examples:
  python scripts/objective/engine.py --dry-run --chapter genesis
  python scripts/objective/engine.py --once --chapter genesis        # approve 1 quest
  python scripts/objective/engine.py --mode auto --allow-mine        # full autopilot
  python scripts/objective/engine.py --source local                  # our own goals
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE.parent))   # scripts/
sys.path.insert(0, str(_HERE.parent / "dev"))  # scripts/dev/ -> resolve_craft_chain
sys.path.insert(0, str(_HERE))          # scripts/objective/
sys.path.insert(0, str(_HERE.parent.parent / "mcp"))  # mcp/ -> canonical bridge_client

import resolve_craft_chain as rcc  # noqa: E402
from acquire import Acquirer  # noqa: E402
from bridge_client import BridgeClient  # noqa: E402
from core import KIND_HAVE_ITEM, Mode, ObjectiveEngine  # noqa: E402
from sources.ftb_quests import FtbQuestSource  # noqa: E402
from sources.local_goals import LocalGoalSource  # noqa: E402


def _classify_item(bridge, item: str, count: int) -> str:
    have = bridge.send("count_item", {"item": item})
    n = have["data"]["count"] if have.get("ok") else 0
    if n >= count:
        return f"have {n}/{count}"
    try:
        plan = rcc.resolve_full(bridge, item, count, True)
        leaves = ", ".join(f"{k}x{v}" for k, v in plan["leaves"].items())
        return f"craft ({len(plan['chain'])} steps; leaves: {leaves or 'none'}) [have {n}/{count}]"
    except SystemExit:
        return f"gather/mine [have {n}/{count}]"
    except Exception as e:  # noqa: BLE001
        return f"unknown ({e}) [have {n}/{count}]"


def _preview(bridge, engine: ObjectiveEngine, source) -> int:
    objs = source.discover()
    cands = engine.actionable(objs)
    print(f"[{source.name}] {len(objs)} objectives, {len(cands)} actionable")
    if not cands:
        for obj, reason in engine.blocked_objectives(objs)[:5]:
            print(f"  BLOCKED {obj.id} {obj.title!r}: {reason}")
        return 0
    obj = cands[0]
    print(f"\nNEXT: {obj.id}  {obj.title!r}")
    for req in obj.open_requirements:
        if req.kind == KIND_HAVE_ITEM:
            item = req.args.get("item") or f"#{req.args.get('tag')}"
            count = req.args.get("count", 1)
            target = req.args.get("item")
            plan = _classify_item(bridge, target, count) if target else "tag -> resolve at run"
            print(f"  - need {item} x{count}: {plan}")
        else:
            print(f"  - {req.kind} {req.id}")
    if obj.effects:
        print(f"  then submit + claim rewards for {obj.id}")
    print("\nupcoming:", ", ".join(f"{o.id}:{o.title[:24]}" for o in cands[1:6]))
    return 0


class _OnlyQuest:
    """Wrap a source so the engine only ever sees one quest (for targeted runs)."""

    def __init__(self, inner, qid: str) -> None:
        self._inner = inner
        self._qid = qid.upper()
        self.name = inner.name

    def discover(self):
        return [o for o in self._inner.discover() if o.id.upper() == self._qid]

    def refresh(self, objective):
        return self._inner.refresh(objective)

    def mark_satisfied(self, objective, requirement) -> bool:
        return self._inner.mark_satisfied(objective, requirement)

    def finalize(self, objective) -> bool:
        return self._inner.finalize(objective)


def _make_approver(auto_yes: bool):
    def approver(obj) -> bool:
        if auto_yes:
            print(f"[auto-yes] {obj.id} {obj.title!r}")
            return True
        reqs = "; ".join(
            (req.args.get("item") or f"#{req.args.get('tag')}" or req.kind) for req in obj.open_requirements
        )
        ans = input(f"Do quest {obj.id} {obj.title!r}? need: {reqs or 'checkmark'}  [y/N/q] ").strip().lower()
        if ans == "q":
            raise SystemExit("aborted by user")
        return ans == "y"

    return approver


def main() -> int:
    ap = argparse.ArgumentParser(description="Objective-engine autopilot")
    ap.add_argument("--source", choices=["ftb", "local"], default="ftb")
    ap.add_argument("--mode", choices=["approve", "checkpoint", "auto"], default="approve")
    ap.add_argument("--chapter", default=None, help="FTB: scope to one chapter filename")
    ap.add_argument("--quest", default=None, help="FTB: target exactly one quest by 16-hex id")
    ap.add_argument("--max-steps", type=int, default=None)
    ap.add_argument("--once", action="store_true", help="do at most one objective")
    ap.add_argument("--yes", action="store_true", help="auto-approve (no prompt)")
    ap.add_argument("--dry-run", action="store_true", help="preview next objective + plan, no mutation")
    ap.add_argument("--allow-mine", action="store_true", help="enable the mining acquisition tier")
    ap.add_argument("--goals-dir", default=None)
    args = ap.parse_args()

    bridge = BridgeClient()
    acq = Acquirer(bridge, allow_mine=args.allow_mine, log=print)
    resolvers = {KIND_HAVE_ITEM: acq.resolve}

    if args.source == "ftb":
        source = FtbQuestSource(bridge, chapters=[args.chapter] if args.chapter else None)
    else:
        kw = {"goals_dir": Path(args.goals_dir)} if args.goals_dir else {}
        source = LocalGoalSource(bridge, **kw)

    if args.quest:
        source = _OnlyQuest(source, args.quest)

    if args.dry_run:
        eng = ObjectiveEngine(resolvers, mode=Mode.AUTO)
        return _preview(bridge, eng, source)

    eng = ObjectiveEngine(
        resolvers, mode=Mode(args.mode), approver=_make_approver(args.yes), log=print
    )
    max_steps = 1 if args.once else args.max_steps
    results = eng.run(source, max_steps=max_steps)
    print("\n=== run summary ===")
    for r in results:
        oid = r.objective.id if r.objective else "-"
        print(f"  {r.status:8} {oid}  {r.detail}")
    done = sum(1 for r in results if r.status == "done")
    print(f"completed {done} objective(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
