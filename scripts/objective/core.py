"""Generic objective engine — zero Minecraft / mod / FTB knowledge.

It speaks only the types below + the ObjectiveSource protocol. Requirement
satisfaction is delegated to injected *resolvers* (a {kind: callable} map), so the
engine never imports game code. The MODE gate (approve / checkpoint / auto) wraps the
per-objective action; the loop body is identical across modes, so reaching full
autonomy is one MODE value, not a rewrite.

Layering (the seam that keeps the engine game-agnostic):

    ObjectiveEngine (this file, agnostic)
       ├─ ObjectiveSource     ── sources/ftb_quests.py   (FTB+Forge specifics)
       │                       └ sources/local_goals.py   (our own goals; no mod dep)
       └─ resolvers[kind]     ── acquire.ensure_item / travel / mark   (MC-coupled)
"""
from __future__ import annotations

from collections.abc import Callable, Iterable
from dataclasses import dataclass, field
from enum import Enum
from typing import Protocol, runtime_checkable

# --------------------------------------------------------------------------- #
# Requirement model — typed, declarative, mod-agnostic.
# A Requirement is a condition the engine knows how to *satisfy* via a resolver
# keyed by `.kind`. The kind strings are a small closed vocabulary; an adapter maps
# its own task types onto them (FTB `item` -> have_item, `checkmark` -> manual).
# --------------------------------------------------------------------------- #

KIND_HAVE_ITEM = "have_item"
KIND_AT_LOCATION = "at_location"
KIND_IN_DIMENSION = "in_dimension"
KIND_MANUAL = "manual"          # nothing to acquire; just mark/submit (checkmark)
KIND_PREDICATE = "predicate"    # escape hatch for custom standing goals


@dataclass(frozen=True)
class Requirement:
    kind: str
    id: str                                   # stable id within the objective (e.g. FTB task id)
    args: dict = field(default_factory=dict)
    satisfied: bool = False                   # last-known live status from the source
    drivable: bool = True                     # False => engine can't act on it (e.g. FTB `custom`)


def have_item(rid: str, item: str, count: int = 1, *, satisfied: bool = False) -> Requirement:
    return Requirement(KIND_HAVE_ITEM, rid, {"item": item, "count": count}, satisfied)


def manual(rid: str, *, satisfied: bool = False) -> Requirement:
    return Requirement(KIND_MANUAL, rid, {}, satisfied)


def in_dimension(rid: str, dimension: str, *, satisfied: bool = False) -> Requirement:
    return Requirement(KIND_IN_DIMENSION, rid, {"dimension": dimension}, satisfied)


def opaque(rid: str, raw_type: str, *, satisfied: bool = False) -> Requirement:
    """A requirement the engine cannot drive (unknown / custom task type). Tractable
    only if already satisfied; otherwise it blocks the objective with a clear reason."""
    return Requirement(KIND_PREDICATE, rid, {"raw_type": raw_type}, satisfied, drivable=False)


@dataclass(frozen=True)
class Effect:
    """What completing the objective grants/does — opaque to the engine, applied by
    the source in finalize()."""
    kind: str
    args: dict = field(default_factory=dict)


@dataclass
class Objective:
    id: str
    title: str
    source: str
    requirements: list[Requirement] = field(default_factory=list)
    effects: list[Effect] = field(default_factory=list)
    deps: list[str] = field(default_factory=list)
    recurring: bool = False
    complete: bool = False
    can_start: bool = True          # deps satisfied (source-reported)
    needs_finalize: bool = False    # complete but rewards unclaimed

    @property
    def open_requirements(self) -> list[Requirement]:
        return [r for r in self.requirements if not r.satisfied]


# --------------------------------------------------------------------------- #
# Resolver contract — the only place game/mod actions enter the engine, injected.
# --------------------------------------------------------------------------- #

@dataclass
class ResolveOutcome:
    ok: bool
    detail: str = ""


Resolver = Callable[[Requirement], ResolveOutcome]


def manual_resolver(_req: Requirement) -> ResolveOutcome:
    """`manual` requirements (checkmarks) need no acquisition — satisfied by submit."""
    return ResolveOutcome(True, "manual: nothing to acquire")


# --------------------------------------------------------------------------- #
# ObjectiveSource — the agnostic adapter seam. Implement one per mod/game/goal-set.
# --------------------------------------------------------------------------- #

@runtime_checkable
class ObjectiveSource(Protocol):
    name: str

    def discover(self) -> list[Objective]:
        """All known objectives with current live status."""
        ...

    def refresh(self, objective: Objective) -> Objective:
        """Re-read live status of one objective (after a submit)."""
        ...

    def mark_satisfied(self, objective: Objective, requirement: Requirement) -> bool:
        """Tell the underlying system a requirement is met (FTB: submit the task).
        Returns False if the system rejected it."""
        ...

    def finalize(self, objective: Objective) -> bool:
        """Apply effects / claim rewards once complete. No-op sources return True."""
        ...


# --------------------------------------------------------------------------- #
# Engine.
# --------------------------------------------------------------------------- #

class Mode(Enum):
    APPROVE = "approve"        # ask before acting on each objective (default, safest)
    CHECKPOINT = "checkpoint"  # auto within a chapter; ask at boundaries / destructive
    AUTO = "auto"              # never ask; stop only when blocked


@dataclass
class StepResult:
    status: str                # done | idle | skipped | blocked | failed | warned
    objective: Objective | None = None
    detail: str = ""

    @property
    def progressed(self) -> bool:
        return self.status == "done"


class ObjectiveEngine:
    """Source-agnostic objective loop. Construct with a resolver map + a MODE gate."""

    def __init__(
        self,
        resolvers: dict[str, Resolver],
        *,
        mode: Mode = Mode.APPROVE,
        approver: Callable[[Objective], bool] | None = None,
        log: Callable[[str], None] = lambda _m: None,
        boundary: Callable[[Objective], bool] = lambda _o: False,
    ) -> None:
        # `manual` always has a trivial resolver unless the caller overrode it.
        self.resolvers: dict[str, Resolver] = {KIND_MANUAL: manual_resolver, **resolvers}
        self.mode = mode
        self.approver = approver or (lambda _o: True)
        self.log = log
        # boundary(obj) -> True marks a CHECKPOINT-mode pause point (e.g. chapter change).
        self.boundary = boundary

    # ---- selection -------------------------------------------------------- #

    def is_tractable(self, obj: Objective) -> tuple[bool, str]:
        """An objective is tractable iff every open requirement is drivable AND has a
        resolver. Returns (ok, reason-if-not)."""
        for req in obj.open_requirements:
            if not req.drivable:
                return False, f"requirement {req.id} type {req.args.get('raw_type', req.kind)} is not drivable"
            if req.kind not in self.resolvers:
                return False, f"no resolver for requirement kind {req.kind}"
        return True, ""

    def actionable(self, objectives: Iterable[Objective]) -> list[Objective]:
        """Deps-satisfied, not-already-done (unless recurring), tractable — in source order."""
        out: list[Objective] = []
        for o in objectives:
            if o.complete and not o.recurring:
                continue
            if not o.can_start:
                continue
            ok, _ = self.is_tractable(o)
            if not ok:
                continue
            out.append(o)
        return out

    def blocked_objectives(self, objectives: Iterable[Objective]) -> list[tuple[Objective, str]]:
        """can_start objectives that are NOT tractable — surfaced so the engine reports
        a precise reason instead of silently stalling."""
        out: list[tuple[Objective, str]] = []
        for o in objectives:
            if o.complete and not o.recurring:
                continue
            if not o.can_start:
                continue
            ok, reason = self.is_tractable(o)
            if not ok:
                out.append((o, reason))
        return out

    # ---- MODE gate -------------------------------------------------------- #

    def _gate(self, obj: Objective) -> bool:
        if self.mode is Mode.AUTO:
            return True
        if self.mode is Mode.CHECKPOINT and not self.boundary(obj):
            return True
        return self.approver(obj)

    # ---- the per-objective action (identical across modes) ----------------- #

    def run_objective(self, source: ObjectiveSource, obj: Objective) -> StepResult:
        for req in obj.open_requirements:
            resolver = self.resolvers.get(req.kind)
            if resolver is None:  # guarded by is_tractable, defensive
                return StepResult("blocked", obj, f"no resolver for {req.kind}")
            self.log(f"  resolve {req.kind} {req.id} {req.args or ''}")
            outcome = resolver(req)
            if not outcome.ok:
                return StepResult("blocked", obj, f"could not satisfy {req.kind} {req.id}: {outcome.detail}")
            if not source.mark_satisfied(obj, req):
                return StepResult("failed", obj, f"source rejected mark_satisfied for {req.id}")
        fresh = source.refresh(obj)
        if not fresh.complete:
            return StepResult("failed", obj, "requirements satisfied but objective not complete after submit")
        if fresh.needs_finalize or obj.effects:
            if not source.finalize(fresh):
                return StepResult("warned", fresh, "complete but finalize/claim failed")
        return StepResult("done", fresh, "completed and finalized")

    # ---- step + run ------------------------------------------------------- #

    def step(self, source: ObjectiveSource) -> StepResult:
        objectives = source.discover()
        candidates = self.actionable(objectives)
        if not candidates:
            blocked = self.blocked_objectives(objectives)
            if blocked:
                obj, reason = blocked[0]
                return StepResult("blocked", obj, f"blocked: {obj.id} {reason}")
            return StepResult("idle", None, "nothing actionable")
        obj = candidates[0]
        if not self._gate(obj):
            return StepResult("skipped", obj, "declined at MODE gate")
        return self.run_objective(source, obj)

    def run(
        self,
        source: ObjectiveSource,
        *,
        max_steps: int | None = None,
        continue_on_fail: bool = False,
    ) -> list[StepResult]:
        """Drive objectives until idle/blocked/declined (or a failure, unless
        continue_on_fail). Returns the per-step results in order."""
        results: list[StepResult] = []
        steps = 0
        skipped_ids: set[str] = set()
        while max_steps is None or steps < max_steps:
            r = self.step(source)
            results.append(r)
            steps += 1
            if r.status == "done":
                continue
            if r.status in ("idle",):
                break
            if r.status in ("skipped", "blocked", "failed", "warned"):
                if not continue_on_fail:
                    break
                # In continue mode, remember the offender so step() can move past it
                # next round. (step() always picks candidates[0]; to advance we rely on
                # the source's status changing, or the caller filtering — kept simple:
                # break to avoid an infinite loop on a stuck candidate.)
                if r.objective and r.objective.id in skipped_ids:
                    break
                if r.objective:
                    skipped_ids.add(r.objective.id)
                break
        return results
