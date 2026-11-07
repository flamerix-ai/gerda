// Maintenance tier — resumable interrupts + RECOVER backoff. The headline property: an
// EAT interrupt suspends the EXACT phase and resumes it (not the mission's initial phase),
// which is what separates a maintenance interrupt from a safety RECOVER.
import { maintenance } from "@/bot/capabilities/maintenance";
import type { Mission } from "@/shared/kernel/mission";
import { describe, expect, it } from "vitest";
import { type BotHarness, makeBot } from "./harness";

// A no-handler mission with a MINE phase we can park in and interrupt from.
const workMission: Mission = {
  name: "work",
  edges: { SCAN: ["MINE"], MINE: ["SCAN"] },
  initialPhase: "SCAN",
  movementPhases: new Set(),
  handlers: {},
};

function bot(foodInBag: number): BotHarness {
  const h = makeBot({ missions: [workMission], caps: [maintenance] });
  h.kernel.startMission(h.st, "work");
  h.st.phase = "MINE"; // park in a working phase
  if (foodInBag > 0) {
    h.rt.state.slots.set(36, { id: "minecraft:bread", count: foodInBag, durabilityPct: 100 });
  }
  return h;
}

describe("maintenance EAT interrupt (resumable)", () => {
  it("low food + food in bag → interrupt to EAT, then resume the EXACT phase", () => {
    const { rt, kernel, st } = bot(5);
    rt.state.food = 4; // ≤ cfg.safety.lowFoodLevel

    kernel.tick(st); // maintenance guard interrupts (short-circuits; handler runs next tick)
    expect(st.phase).toBe("EAT");
    expect(st.resumePhase).toBe("MINE");

    kernel.tick(st); // EAT handler equips + takes a bite (eat) — food still low
    expect(rt.state.eatCalls).toBe(1);
    expect(rt.state.lastEat).toBe("minecraft:bread");

    rt.state.food = 20; // simulate the meal completing
    kernel.tick(st); // EAT handler sees fed → resume
    expect(st.phase).toBe("MINE"); // resumed the suspended phase, NOT SCAN (the start)
    expect(st.resumePhase).toBeNull();
  });

  it("paces bites cfg.safety.eatBiteTicks apart (re-firing eat every tick would drain the stack)", () => {
    const { rt, kernel, st } = bot(8);
    rt.state.food = 4;
    kernel.tick(st); // interrupt → EAT
    kernel.tick(st); // first bite
    expect(rt.state.eatCalls).toBe(1);
    // Within the bite window: no new bite.
    for (let i = 0; i < 10; i++) kernel.tick(st);
    expect(rt.state.eatCalls).toBe(1);
    // Past the window (default cfg.safety.eatBiteTicks=35): a second bite.
    for (let i = 0; i < 30; i++) kernel.tick(st);
    expect(rt.state.eatCalls).toBeGreaterThanOrEqual(2);
  });

  it("low food but NO food in bag → never interrupts (nothing to do)", () => {
    const { rt, kernel, st } = bot(0);
    rt.state.food = 1;
    kernel.tick(st);
    expect(st.phase).toBe("MINE");
  });

  it("runs out of food mid-meal → resumes the suspended phase", () => {
    const { rt, kernel, st } = bot(1);
    rt.state.food = 4;
    kernel.tick(st);
    expect(st.phase).toBe("EAT");
    rt.state.slots.clear(); // bread gone (ate it / dropped)
    kernel.tick(st);
    expect(st.phase).toBe("MINE"); // out_of_food → resume, not stuck in EAT
  });

  it("a safety reflex preempts an in-progress meal", () => {
    const { rt, kernel, st } = bot(5);
    rt.state.food = 4;
    kernel.tick(st);
    expect(st.phase).toBe("EAT");
    rt.state.health = 2; // emergency mid-meal
    kernel.tick(st);
    expect(st.phase).toBe("RECOVER"); // vitals wins over eating
  });
});

describe("RECOVER backoff", () => {
  it("repeated recoveries in the window escalate to ERROR", () => {
    const { rt, kernel, st } = makeBot({
      missions: [workMission],
      config: {
        teleportWaitTicks: 2,
        safety: { recoverMaxAttempts: 2, recoverBackoffWindow: 100000 },
      },
    });
    kernel.startMission(st, "work");
    rt.state.health = 2; // vitals re-fires every time we resume → recovery loop

    for (let i = 0; i < 40 && st.phase !== "ERROR"; i++) kernel.tick(st);
    expect(st.phase).toBe("ERROR");
  });
});
