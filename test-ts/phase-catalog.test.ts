import { GERDA_PHASES, STATE } from "@/bot/profile/states";
import {
  LIFECYCLE,
  type PhaseCatalog,
  assertCatalog,
  assertEdgesKnown,
} from "@/shared/kernel/phase";
// The phase-catalog contract. The kernel's phase vocabulary is OPEN
// (`Phase = string`), so the compile-time union no longer guards edge tables — these boot-time
// assertions replace it, and check MORE than the union could: the union accepted an edge to any
// declared phase whether or not anything handled it, while `all` is the catalog's own membership.
import { describe, expect, it } from "vitest";

const base = (over: Partial<PhaseCatalog> = {}): PhaseCatalog => ({
  all: new Set([...Object.values(LIFECYCLE), "WORK"]),
  universalTargets: [LIFECYCLE.RECOVER],
  globalEdges: { [LIFECYCLE.IDLE]: ["WORK"] },
  stallExempt: new Set([LIFECYCLE.IDLE]),
  interruptPhases: [],
  ...over,
});

describe("phase catalog validation", () => {
  it("accepts a well-formed catalog", () => {
    expect(() => assertCatalog(base())).not.toThrow();
  });

  it("rejects a catalog missing a kernel-owned lifecycle phase", () => {
    const cat = base({ all: new Set([LIFECYCLE.IDLE, LIFECYCLE.RECOVER, LIFECYCLE.PAUSED]) });
    expect(() => assertCatalog(cat)).toThrow(/lifecycle phase 'ERROR'/);
  });

  it("rejects a universal target that is not a declared phase", () => {
    expect(() => assertCatalog(base({ universalTargets: ["NOPE"] }))).toThrow(
      /unknown phase 'NOPE' in universalTargets/,
    );
  });

  it("rejects an interrupt phase that is not a declared phase", () => {
    expect(() => assertCatalog(base({ interruptPhases: ["SNACK"] }))).toThrow(
      /unknown phase 'SNACK' in interruptPhases/,
    );
  });

  it("rejects a global edge pointing at an undeclared phase", () => {
    const cat = base({ globalEdges: { [LIFECYCLE.IDLE]: ["GHOST"] } });
    expect(() => assertCatalog(cat)).toThrow(/unknown phase 'GHOST'/);
  });
});

describe("edge-table validation", () => {
  it("accepts edges wholly inside the catalog", () => {
    expect(() => assertEdgesKnown(base(), { [LIFECYCLE.IDLE]: ["WORK"] }, "t")).not.toThrow();
  });

  // The case the old shared State union could NOT catch: every name type-checked, so a
  // mission could legally declare an edge to a phase no mission or capability handled.
  it("rejects an edge TARGET outside the catalog", () => {
    expect(() => assertEdgesKnown(base(), { [LIFECYCLE.IDLE]: ["TYPPO"] }, "mission 'm'")).toThrow(
      /mission 'm': edge 'IDLE' → unknown phase 'TYPPO'/,
    );
  });

  it("rejects an edge SOURCE outside the catalog", () => {
    expect(() => assertEdgesKnown(base(), { MYSTERY: ["WORK"] }, "capability 'c'")).toThrow(
      /capability 'c': edge table declares unknown phase 'MYSTERY'/,
    );
  });
});

describe("the shipped Gerda catalog", () => {
  it("is well-formed", () => {
    expect(() => assertCatalog(GERDA_PHASES)).not.toThrow();
  });

  it("declares every phase in the STATE union — the catalog and the union cannot drift", () => {
    for (const s of Object.values(STATE)) expect(GERDA_PHASES.all.has(s)).toBe(true);
    expect(GERDA_PHASES.all.size).toBe(Object.values(STATE).length);
  });

  it("routes EAT as a resumable interrupt, not a plain universal target", () => {
    expect(GERDA_PHASES.interruptPhases).toContain(STATE.EAT);
  });
});
