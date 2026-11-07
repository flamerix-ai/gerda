"""local_goals — our OWN objectives, with zero mod dependency.

This adapter exists to prove the engine is mod-agnostic: it drives the exact same
ObjectiveEngine + Acquirer as the FTB adapter, but its objectives come from our own
JSON (config/objectives/*.json) — e.g. a recurring "keep 32 iron stocked" goal — not
from any mod's quest system. Status is read from the generic `count_item` inventory
primitive; mark_satisfied/finalize are no-ops (acquisition IS the work, there's nothing
to submit/claim). Swapping to a new modpack or vanilla MC leaves this file untouched.

Goal file shape (JSON):
  {"objectives": [
     {"id": "keep-iron-stocked", "title": "...", "recurring": true,
      "requirements": [{"kind": "have_item", "item": "minecraft:iron_ingot", "count": 32}]}
  ]}
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from core import Objective, Requirement, have_item  # noqa: E402

DEFAULT_GOALS_DIR = Path(__file__).resolve().parents[3] / "config/objectives"


def load_goals(goals_dir: Path = DEFAULT_GOALS_DIR) -> list[dict]:
    out: list[dict] = []
    if not goals_dir.exists():
        return out
    for path in sorted(goals_dir.glob("*.json")):
        doc = json.loads(path.read_text(encoding="utf-8"))
        out.extend(doc.get("objectives", []))
    return out


class LocalGoalSource:
    name = "local"

    def __init__(self, bridge, *, goals_dir: Path = DEFAULT_GOALS_DIR) -> None:
        self.bridge = bridge
        self.defs = {g["id"]: g for g in load_goals(goals_dir)}

    def _count(self, item: str) -> int:
        r = self.bridge.send("count_item", {"item": item})
        return int(r["data"]["count"]) if r.get("ok") else 0

    def _view(self, gdef: dict) -> Objective:
        reqs: list[Requirement] = []
        for r in gdef.get("requirements", []):
            item = r["item"]
            n = int(r.get("count", 1))
            reqs.append(have_item(r.get("id", item), item, n, satisfied=self._count(item) >= n))
        complete = all(rq.satisfied for rq in reqs) if reqs else False
        return Objective(
            id=gdef["id"],
            title=gdef.get("title", gdef["id"]),
            source=self.name,
            requirements=reqs,
            recurring=bool(gdef.get("recurring", False)),
            complete=complete,
            can_start=True,
            needs_finalize=False,
        )

    def discover(self) -> list[Objective]:
        return [self._view(g) for g in self.defs.values()]

    def refresh(self, objective: Objective) -> Objective:
        return self._view(self.defs[objective.id])

    def mark_satisfied(self, objective: Objective, requirement: Requirement) -> bool:
        return True  # nothing to submit — acquisition already satisfied it

    def finalize(self, objective: Objective) -> bool:
        return True  # no rewards to claim
