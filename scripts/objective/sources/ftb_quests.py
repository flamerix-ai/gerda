"""FTB Quests ObjectiveSource adapter (Monifactory).

ALL FTB/Forge specifics live here: the SNBT chapter files supply static structure
(tasks, item ids, counts, dependencies, reward ids, titles), the live `quests` bridge
primitive supplies status (complete / deps-ready / unclaimed). The two are merged into
generic core.Objective values. mark_satisfied -> `quest_complete` (SubmitTaskMessage);
finalize -> `quest_claim` (ClaimRewardMessage, this quest's rewards only — claiming all
would flood the inventory — a save can hold hundreds of completed-but-unclaimed quests).

`load_graph` + the task->Requirement mapping are PURE (offline, unit-tested vs the real
genesis.snbt). Only FtbQuestSource talks to the bridge.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))  # sources -> objective -> scripts

from core import (  # noqa: E402
    Effect,
    Objective,
    Requirement,
    KIND_HAVE_ITEM,
)
from snbt import loads as snbt_loads  # noqa: E402
import local_config  # noqa: E402

def default_instance() -> Path:
    """The human's pack instance — resolved ON CALL, never at import.

    instance_dir() raises SystemExit when no launcher is installed, so resolving this at
    module scope made merely IMPORTING this file fatal on any machine without Minecraft —
    including a fork author's, and including the clean-machine container, where it took the
    offline SNBT-parsing unit tests down with it. Nothing here needs the path until a
    caller actually reads quest files, so pay for it then.
    """
    return local_config.instance_dir(local_config.get("humanInstance", "Monifactory")) / "minecraft"


# --------------------------------------------------------------------------- #
# Static graph (offline, pure) — parsed from the chapter SNBT + lang.
# --------------------------------------------------------------------------- #

@dataclass
class TaskDef:
    id: str
    type: str
    item: str | None = None       # concrete item id
    tag: str | None = None        # itemfilters:tag value (any member satisfies)
    count: int = 1


@dataclass
class QuestDef:
    id: str
    chapter: str
    title_key: str                 # raw title field (lang key or literal), may be ""
    optional: bool = False
    dependencies: list[str] = field(default_factory=list)
    tasks: list[TaskDef] = field(default_factory=list)
    reward_ids: list[str] = field(default_factory=list)


def _task_def(raw: dict) -> TaskDef:
    ttype = str(raw.get("type", "?"))
    item = raw.get("item")
    item_id: str | None = None
    tag: str | None = None
    count = int(raw.get("count") or 1)
    if isinstance(item, str):
        # shorthand form: item: "rehooked:wood_hook"
        item_id = item
    elif isinstance(item, dict):
        iid = item.get("id")
        if iid == "itemfilters:tag":
            tag = (item.get("tag") or {}).get("value")
        else:
            item_id = iid
        if raw.get("count") is None and item.get("Count") is not None:
            count = int(item["Count"])
    return TaskDef(id=str(raw["id"]), type=ttype, item=item_id, tag=tag, count=count)


def _quest_def(raw: dict, chapter: str) -> QuestDef:
    return QuestDef(
        id=str(raw["id"]),
        chapter=chapter,
        title_key=str(raw.get("title", "")),
        optional=bool(raw.get("optional", False)),
        dependencies=[str(d) for d in raw.get("dependencies", [])],
        tasks=[_task_def(t) for t in raw.get("tasks", [])],
        reward_ids=[str(r["id"]) for r in raw.get("rewards", []) if "id" in r],
    )


def load_graph(instance: Path | None = None) -> dict[str, QuestDef]:
    """Parse every chapter SNBT into {quest_id -> QuestDef}. Pure / offline."""
    chapters_dir = (instance or default_instance()) / "config/ftbquests/quests/chapters"
    graph: dict[str, QuestDef] = {}
    for path in sorted(chapters_dir.glob("*.snbt")):
        doc = snbt_loads(path.read_text(encoding="utf-8"))
        chapter = str(doc.get("filename", path.stem))
        for raw in doc.get("quests", []):
            qd = _quest_def(raw, chapter)
            graph[qd.id] = qd
    return graph


def load_lang(instance: Path | None = None) -> dict[str, str]:
    """Load the FTB Quests lang map (title-key -> text). Tolerant of absence."""
    lang_path = (instance or default_instance()) / "kubejs/assets/ftbquests/lang/en_us.json"
    if not lang_path.exists():
        return {}
    return json.loads(lang_path.read_text(encoding="utf-8"))


def resolve_title(qd: QuestDef, lang: dict[str, str]) -> str:
    raw = qd.title_key.strip()
    if raw.startswith("{") and raw.endswith("}"):
        key = raw[1:-1]
        if key in lang:
            return lang[key]
    if raw:
        return raw
    # fall back to the first task's item/tag id (FTB itself derives an item title)
    for t in qd.tasks:
        if t.item:
            return t.item
        if t.tag:
            return f"#{t.tag}"
    return qd.id


# --------------------------------------------------------------------------- #
# task -> Requirement mapping (pure).
# --------------------------------------------------------------------------- #

def task_requirement(t: TaskDef, *, satisfied: bool) -> Requirement:
    if t.type == "item":
        if t.tag:
            return Requirement(KIND_HAVE_ITEM, t.id, {"tag": t.tag, "count": t.count}, satisfied)
        return Requirement(KIND_HAVE_ITEM, t.id, {"item": t.item, "count": t.count}, satisfied)
    if t.type == "checkmark":
        from core import manual
        return manual(t.id, satisfied=satisfied)
    # dimension / custom / observation / anything we can't drive
    from core import opaque
    return opaque(t.id, t.type, satisfied=satisfied)


# --------------------------------------------------------------------------- #
# Live adapter.
# --------------------------------------------------------------------------- #

class FtbQuestSource:
    """core.ObjectiveSource over the live `quests`/`quest_complete`/`quest_claim`
    bridge primitives, enriched with the offline SNBT graph + lang."""

    name = "ftb"

    def __init__(self, bridge, *, instance: Path | None = None,
                 chapters: list[str] | None = None) -> None:
        self.bridge = bridge
        inst = instance or default_instance()
        self.graph = load_graph(inst)
        self.lang = load_lang(inst)
        self.chapters = chapters  # None = all

    # ---- helpers ---------------------------------------------------------- #

    def _live(self, *, chapter: str | None = None, quest: str | None = None) -> list[dict]:
        payload: dict = {}
        if chapter:
            payload["chapter"] = chapter
        if quest:
            payload["quest"] = quest
        resp = self.bridge.send("quests", payload or None)
        if not resp.get("ok"):
            raise RuntimeError(f"quests command failed: {resp.get('error')}")
        return resp["data"]["quests"]

    def _to_objective(self, live_q: dict) -> Objective:
        qid = live_q["id"]
        qd = self.graph.get(qid)
        live_tasks = {t["id"]: t for t in live_q.get("tasks", [])}
        reqs: list[Requirement] = []
        if qd:
            for t in qd.tasks:
                lt = live_tasks.get(t.id, {})
                reqs.append(task_requirement(t, satisfied=bool(lt.get("complete"))))
            effects = [Effect("claim", {"quest": qid})] if qd.reward_ids else []
            deps = qd.dependencies
            title = resolve_title(qd, self.lang)
        else:
            # quest absent from SNBT (shouldn't happen) — fall back to live shape
            for t in live_q.get("tasks", []):
                from core import manual, opaque
                reqs.append(manual(t["id"], satisfied=bool(t.get("complete")))
                            if t.get("type") == "checkmark"
                            else opaque(t["id"], t.get("type", "?"), satisfied=bool(t.get("complete"))))
            effects, deps, title = [], [], live_q.get("title", qid)
        return Objective(
            id=qid,
            title=title,
            source=self.name,
            requirements=reqs,
            effects=effects,
            deps=deps,
            complete=bool(live_q.get("complete")),
            can_start=bool(live_q.get("can_start")),
            needs_finalize=bool(live_q.get("unclaimed")),
        )

    # ---- ObjectiveSource -------------------------------------------------- #

    def discover(self) -> list[Objective]:
        out: list[Objective] = []
        chapters = self.chapters or [None]  # type: ignore[list-item]
        for ch in chapters:
            for lq in self._live(chapter=ch):
                out.append(self._to_objective(lq))
        # required quests before optional ones (preserve source order within each group)
        req_first = [o for o in out if not self.graph.get(o.id, QuestDef(o.id, "", "")).optional]
        opt = [o for o in out if self.graph.get(o.id, QuestDef(o.id, "", "")).optional]
        return req_first + opt

    def refresh(self, objective: Objective) -> Objective:
        live = self._live(quest=objective.id)
        if not live:
            return objective
        return self._to_objective(live[0])

    def mark_satisfied(self, objective: Objective, requirement: Requirement) -> bool:
        resp = self.bridge.send("quest_complete", {"task": requirement.id})
        return bool(resp.get("ok"))

    def finalize(self, objective: Objective) -> bool:
        resp = self.bridge.send("quest_claim", {"quest": objective.id})
        return bool(resp.get("ok"))
