import { drillMission } from "@/bot/missions/drill";
import { mineMission } from "@/bot/missions/mine";
import type { MiningMem } from "@/bot/missions/mine/mining-mem";
// Multi-bot coordination v2: peer-as-obstacle in the navigator, vein-claim
// deconfliction in the drill, and fleet-shared hazards in scan+drill. Kernel-side seams only —
// the hub (scripts/ops/fleet_hub.py) is host-side Python; here we assert the bot honours what it
// pushes down (assignment.claimedVeins / assignment.hazards) and plans around live peers.
import { makeGerdaConfig } from "@/bot/profile/config";
import { encodePos } from "@/core/prim/pos";
import type { Peer } from "@/core/runtime/Runtime";
import type { MockRuntime } from "@/core/runtime/mock";
import { GoalBlock } from "@/shared/domain/goal";
import { columnKey, neighbors } from "@/shared/domain/movement-types";
import { DEFAULT_PLANNER_OPTS, planPath } from "@/shared/domain/planner";
import type { BlockReader } from "@/shared/domain/senses";
import { peerAvoidColumns } from "@/shared/nav";
import { describe, expect, it } from "vitest";
import { makeBot } from "./harness";

/** A mutable voxel world + a reader (planner.test.ts pattern). */
function world() {
  const m = new Map<string, string>();
  const set = (x: number, y: number, z: number, id: string) => m.set(encodePos(x, y, z), id);
  const reader: BlockReader = (x, y, z) => m.get(encodePos(x, y, z)) ?? null;
  const stand = (x: number, y: number, z: number) => {
    set(x, y - 1, z, "minecraft:stone");
    set(x, y, z, "minecraft:air");
    set(x, y + 1, z, "minecraft:air");
    set(x, y + 2, z, "minecraft:air");
  };
  return { set, reader, stand };
}

const peer = (x: number, z: number, name = "bot_2"): Peer => ({
  x,
  y: 64,
  z,
  name,
  uuid: `uuid-${name}`,
  health: 20,
  distance: Math.hypot(x, z),
});

describe("neighbors honours PlanOpts.avoid (peer-as-obstacle post-filter)", () => {
  it("drops every move TARGETING an avoided column, keeps the rest", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.stand(1, 64, 0); // will be avoided
    w.stand(0, 64, 1); // stays open
    const avoid = new Set([columnKey(1, 0)]);
    const ns = neighbors(w.reader, { x: 0, y: 64, z: 0 }, { maxDrop: 4, maxFallDamage: 0, avoid });
    expect(ns.some((n) => n.to.x === 1 && n.to.z === 0)).toBe(false);
    expect(ns.some((n) => n.to.x === 0 && n.to.z === 1)).toBe(true);
  });

  it("still offers moves OUT of an avoided from-column (a peer walked into us)", () => {
    const w = world();
    w.stand(0, 64, 0);
    w.stand(1, 64, 0);
    const avoid = new Set([columnKey(0, 0)]); // we stand IN the avoided column
    const ns = neighbors(w.reader, { x: 0, y: 64, z: 0 }, { maxDrop: 4, maxFallDamage: 0, avoid });
    expect(ns.some((n) => n.to.x === 1 && n.to.z === 0)).toBe(true);
  });

  it("planPath detours around an avoided column blocking the straight line", () => {
    const w = world();
    for (let x = 0; x <= 4; x++) for (let z = -1; z <= 1; z++) w.stand(x, 64, z);
    const start = { x: 0, y: 64, z: 0 };
    const opts = { ...DEFAULT_PLANNER_OPTS, avoid: new Set([columnKey(2, 0)]) };
    const r = planPath(w.reader, start, new GoalBlock({ x: 4, y: 64, z: 0 }), opts);
    expect(r).not.toBeNull();
    // The route reaches the goal without ever stepping into the avoided column.
    const path = r?.path ?? [];
    expect(path[path.length - 1]).toMatchObject({ x: 4, z: 0 });
    expect(path.some((p) => p.x === 2 && p.z === 0)).toBe(false);
  });
});

describe("peerAvoidColumns — the live peer snapshot → avoid set", () => {
  it("returns undefined when cfg.nav.peerObstacle is off (single-bot path unchanged)", () => {
    const { rt } = makeBot();
    rt.setPeers([peer(5, 5)]);
    expect(peerAvoidColumns(rt, makeGerdaConfig({ nav: { peerObstacle: false } }))).toBeUndefined();
  });

  it("returns undefined with no peer in range (zero planner overhead)", () => {
    const { rt } = makeBot();
    expect(peerAvoidColumns(rt, makeGerdaConfig())).toBeUndefined();
  });

  it("blocks the clearance square around each peer's feet column", () => {
    const { rt } = makeBot();
    rt.setPeers([peer(10.6, -3.2)]); // feet column (10,-4)
    const avoid = peerAvoidColumns(rt, makeGerdaConfig({ nav: { peerClearance: 1 } }));
    expect(avoid).toBeDefined();
    // the 3×3 around (10,-4)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        expect(avoid?.has(columnKey(10 + dx, -4 + dz))).toBe(true);
      }
    }
    expect(avoid?.has(columnKey(13, -4))).toBe(false);
    expect(avoid?.size).toBe(9);
  });
});

// --- drill vein-claim deconfliction + fleet-shared hazards -------------------------------------

function seedVeins(rt: MockRuntime, resources: { kind: string; x: number; z: number }[]): void {
  const model = {
    version: 1,
    worlds: {
      [rt.state.worldSig]: {
        waypoints: [],
        resources,
        stats: { dumps: 0, veinsFound: 0, boots: 0 },
        updatedAt: 0,
      },
    },
  };
  rt.fs.write(makeGerdaConfig().worldModelPath, JSON.stringify(model));
}

describe("drill honours peer vein claims (assignment.claimedVeins)", () => {
  it("skips the nearest vein when a peer claims it, targeting the next-nearest", () => {
    const bot = makeBot({ missions: [drillMission] });
    seedVeins(bot.rt, [
      { kind: "iron", x: 5, z: 0 }, // nearest — but claimed by a peer
      { kind: "iron", x: 20, z: 0 },
    ]);
    bot.rt.setAssignment({ allowed: null, forbidden: [], claimedVeins: [{ x: 6, z: 1 }] }); // ~1.4 blocks off the marker — within fleetVeinClaimRadius slack
    bot.kernel.startMission(bot.st, "drill");
    const mem = bot.st.bb["mining"] as MiningMem;
    expect(mem.standPos).toMatchObject({ x: 20, z: 0 });
  });

  it("targets the nearest vein when the claim is far away (radius bound)", () => {
    const bot = makeBot({ missions: [drillMission] });
    seedVeins(bot.rt, [
      { kind: "iron", x: 5, z: 0 },
      { kind: "iron", x: 20, z: 0 },
    ]);
    bot.rt.setAssignment({ allowed: null, forbidden: [], claimedVeins: [{ x: 100, z: 100 }] });
    bot.kernel.startMission(bot.st, "drill");
    const mem = bot.st.bb["mining"] as MiningMem;
    expect(mem.standPos).toMatchObject({ x: 5, z: 0 });
  });

  it("fleetVeinClaimRadius:0 disables claim filtering", () => {
    const bot = makeBot({ missions: [drillMission], config: { fleetVeinClaimRadius: 0 } });
    seedVeins(bot.rt, [
      { kind: "iron", x: 5, z: 0 },
      { kind: "iron", x: 20, z: 0 },
    ]);
    bot.rt.setAssignment({ allowed: null, forbidden: [], claimedVeins: [{ x: 5, z: 0 }] });
    bot.kernel.startMission(bot.st, "drill");
    const mem = bot.st.bb["mining"] as MiningMem;
    expect(mem.standPos).toMatchObject({ x: 5, z: 0 });
  });
});

describe("drill honours fleet-shared hazards (assignment.hazards)", () => {
  it("skips a vein on a PEER-recorded drowned column exactly like its own", () => {
    const bot = makeBot({ missions: [drillMission] });
    seedVeins(bot.rt, [
      { kind: "iron", x: 5, z: 0 }, // sits on a hazard a PEER recorded (no local marker)
      { kind: "iron", x: 20, z: 0 },
    ]);
    bot.rt.setAssignment({
      allowed: null,
      forbidden: [],
      hazards: [{ kind: "drowned", x: 5, z: 0 }],
    });
    bot.kernel.startMission(bot.st, "drill");
    const mem = bot.st.bb["mining"] as MiningMem;
    expect(mem.standPos).toMatchObject({ x: 20, z: 0 });
  });
});

describe("mine scan honours fleet-shared hazards (assignment.hazards)", () => {
  const ORE = { x: 3, y: 64, z: 0 }; // within the first spiral rings of the start pos

  function runScan(hazards?: { kind: string; x: number; z: number }[]) {
    const bot = makeBot({ missions: [mineMission] });
    bot.rt.setBlock(ORE.x, ORE.y, ORE.z, "gtceu:iron_ore"); // air world ⇒ exposed
    if (hazards) bot.rt.setAssignment({ allowed: null, forbidden: [], hazards });
    bot.kernel.startMission(bot.st, "mine");
    for (let i = 0; i < 40 && bot.st.phase === "SCAN"; i++) bot.kernel.tick(bot.st);
    return bot;
  }

  it("finds the ore with no fleet hazards (control)", () => {
    const bot = runScan();
    expect(bot.st.phase).not.toBe("SCAN"); // escalated out of SCAN → found something
  });

  it("does NOT find ore near a fleet-shared hazard column (no local marker at all)", () => {
    const bot = runScan([{ kind: "drowned", x: ORE.x, z: ORE.z }]);
    const mem = bot.st.bb["mining"] as MiningMem | undefined;
    expect(mem?.target ?? null).toBeNull();
  });
});
