// loot-run mission — the inverse of the storage mission: walk the registered chests/barrels, open
// each, TAKE everything (or a whitelist) into the carry, mark the emptied ones `looted` in
// mc_world.json so a later run skips them. Movement is short-circuited by setPos arrival; the chest
// GUI is a spliced fake (like the storage test) — we lock the take-all loop, the truly-empty `looted`
// rule, the whitelist filter, and the persistence write-back, not in-game mechanics.
import { core } from "@/bot/capabilities/core";
import { lootRunMission } from "@/bot/missions/loot-run";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import { type Result, ok } from "@/core/runtime/types";
import { type StorageMarker, emptyModel, putSection } from "@/shared/domain/world-model";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { resetGreedyNav } from "@/shared/nav";
import { describe, expect, it } from "vitest";

const SIG = "local|minecraft:overworld"; // the mock's default worldSig

function seedRegistry(rt: MockRuntime, markers: StorageMarker[]): void {
  const model = putSection(emptyModel(), SIG, {
    waypoints: [],
    resources: [],
    storages: markers,
    hazards: [],
    stats: { dumps: 0, veinsFound: 0, boots: 0 },
    updatedAt: 0,
  });
  rt.fs.write(makeGerdaConfig().worldModelPath, JSON.stringify(model));
}

/** Splice a fake chest GUI onto the mock whose CONTAINER region holds `contents`. useOnBlock opens
 *  it, quick() on a container slot removes that item (take = container→carry), close shuts it. The
 *  contents Map is the test's view of what the chest still holds. */
function spliceChest(rt: MockRuntime, contents: Map<number, { id: string; count: number }>): void {
  let open = false;
  const baseOpen = rt.inv.open;
  rt.interact.useOnBlock = (): Result<void> => {
    open = true;
    return ok(undefined);
  };
  rt.interact.closeScreen = (): Result<void> => {
    open = false;
    return ok(undefined);
  };
  rt.inv.open = () => {
    const r = baseOpen();
    if (!r.ok) return r;
    const c = r.value;
    if (!open) return ok(c);
    return ok({
      ...c,
      regions: () => [...c.regions(), "container"],
      slots: (...regions: string[]) =>
        regions.includes("container") ? [...contents.keys()] : c.slots(...regions),
      slot: (i: number) => {
        const s = contents.get(i);
        return s ? { ...s, durabilityPct: 100 } : c.slot(i);
      },
      quick: (i: number) => {
        if (contents.has(i))
          contents.delete(i); // take it out of the chest (into the carry)
        else c.quick(i);
      },
    });
  };
}

function bot(rt: MockRuntime): { kernel: Kernel; st: BotState; logs: LogRecord[] } {
  const logs: LogRecord[] = [];
  const sink: LogSink = { emit: (line) => logs.push(JSON.parse(line) as LogRecord) };
  const kernel = new Kernel(
    rt,
    new Logger(sink, "INFO"),
    new Bus(),
    makeGerdaConfig(),
    GERDA_PHASES,
  );
  kernel.register(core).registerMission(lootRunMission);
  const state = makeInitialState();
  kernel.init(state);
  return { kernel, st: state, logs };
}

const ev = (logs: LogRecord[], name: string) => logs.find((l) => l.event === name);
function diskMarker(rt: MockRuntime, i = 0): StorageMarker {
  const raw = rt.fs.read(makeGerdaConfig().worldModelPath);
  const after = JSON.parse(raw.ok ? (raw.value ?? "{}") : "{}");
  return after.worlds[SIG].storages[i] as StorageMarker;
}

describe("loot-run mission", () => {
  it("takes everything from a chest, marks it looted, persists the empty memory", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    seedRegistry(rt, [{ kind: "chest", x: 6, y: 64, z: 0 }]);
    const chest = new Map([
      [100, { id: "minecraft:gold_ingot", count: 5 }],
      [101, { id: "minecraft:emerald", count: 3 }],
    ]);
    spliceChest(rt, chest);

    const { kernel, st, logs } = bot(rt);
    rt.setPos({ x: 6, y: 64, z: 0 }); // at the chest → GOTO arrives immediately
    kernel.startMission(st, "loot-run", {});
    expect(ev(logs, "LOOT_PLAN")?.fields).toMatchObject({ containers: 1, want: "all" });
    for (let i = 0; i < 30 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(chest.size).toBe(0); // chest emptied
    expect(ev(logs, "LOOT_TOOK")?.fields).toMatchObject({ n: 8 });
    expect(ev(logs, "LOOT_DONE")?.fields).toMatchObject({ taken: 8 });
    expect(st.phase).toBe("IDLE");

    const marker = diskMarker(rt);
    expect(marker.looted).toBe(true); // persisted so a later run skips it
    expect(marker.recorded).toEqual([]); // memory now empty
  });

  it("whitelist takes only listed ids; leaves the rest and does NOT mark looted", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    seedRegistry(rt, [{ kind: "chest", x: 6, y: 64, z: 0 }]);
    const chest = new Map([
      [100, { id: "minecraft:gold_ingot", count: 5 }],
      [101, { id: "minecraft:dirt", count: 12 }],
    ]);
    spliceChest(rt, chest);

    const { kernel, st, logs } = bot(rt);
    rt.setPos({ x: 6, y: 64, z: 0 });
    kernel.startMission(st, "loot-run", { items: "minecraft:gold_ingot" });
    for (let i = 0; i < 30 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(ev(logs, "LOOT_TOOK")?.fields).toMatchObject({ n: 5 }); // only the gold
    expect([...chest.values()][0]).toEqual({ id: "minecraft:dirt", count: 12 }); // dirt left
    const marker = diskMarker(rt);
    expect(marker.looted).toBeUndefined(); // NOT looted — still holds dirt for a take-all later
    expect(marker.recorded).toEqual([{ id: "minecraft:dirt", count: 12 }]);
  });

  it("skips a container already marked looted, finishing with nothing to do", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    seedRegistry(rt, [{ kind: "chest", x: 6, y: 64, z: 0, looted: true }]);
    const { kernel, st, logs } = bot(rt);
    rt.setPos({ x: 0, y: 64, z: 0 });
    kernel.startMission(st, "loot-run", {});
    for (let i = 0; i < 10 && kernel.activeMission() !== null; i++) kernel.tick(st);
    expect(ev(logs, "LOOT_NONE")).toBeDefined();
    expect(kernel.activeMission()).toBeNull();
  });

  it("skips a chest capped by a solid block (isChestBlockedAt) without opening it", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    seedRegistry(rt, [{ kind: "chest", x: 6, y: 64, z: 0 }]);
    const chest = new Map([[100, { id: "minecraft:gold_ingot", count: 5 }]]);
    spliceChest(rt, chest);
    rt.setBlock(6, 65, 0, "minecraft:gray_terracotta"); // solid full cube on top → unopenable

    const { kernel, st, logs } = bot(rt);
    rt.setPos({ x: 6, y: 64, z: 0 }); // at the chest → GOTO arrives immediately
    kernel.startMission(st, "loot-run", {});
    for (let i = 0; i < 30 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(ev(logs, "LOOT_BLOCKED")?.fields).toMatchObject({ pos: { x: 6, y: 64, z: 0 } });
    expect(ev(logs, "LOOT_TOOK")).toBeUndefined(); // never opened
    expect(chest.size).toBe(1); // loot untouched
    expect(diskMarker(rt).looted).toBeUndefined(); // not marked looted — it just couldn't open
  });

  it("a non-blocking block above (slab/glass) still loots the chest", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    seedRegistry(rt, [{ kind: "chest", x: 6, y: 64, z: 0 }]);
    const chest = new Map([[100, { id: "minecraft:gold_ingot", count: 5 }]]);
    spliceChest(rt, chest);
    rt.setBlock(6, 65, 0, "minecraft:stone_slab"); // standable, not a full cube → does NOT block

    const { kernel, st, logs } = bot(rt);
    rt.setPos({ x: 6, y: 64, z: 0 });
    kernel.startMission(st, "loot-run", {});
    for (let i = 0; i < 30 && kernel.activeMission() !== null; i++) kernel.tick(st);

    expect(ev(logs, "LOOT_BLOCKED")).toBeUndefined();
    expect(ev(logs, "LOOT_TOOK")?.fields).toMatchObject({ n: 5 });
  });

  it("with breakBlocked, mines off the capping block then loots the chest", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    seedRegistry(rt, [{ kind: "chest", x: 6, y: 64, z: 0 }]);
    const chest = new Map([[100, { id: "minecraft:gold_ingot", count: 5 }]]);
    spliceChest(rt, chest);
    rt.setBlock(6, 65, 0, "minecraft:gray_terracotta"); // cap → blocked until mined off

    const { kernel, st, logs } = bot(rt);
    rt.setPos({ x: 6, y: 64, z: 0 });
    kernel.startMission(st, "loot-run", { breakBlocked: true });
    for (let i = 0; i < 80 && kernel.activeMission() !== null; i++) {
      kernel.tick(st);
      rt.flushBreak(); // resolve the cap-break the mission issues
    }

    expect(ev(logs, "LOOT_UNCAPPED")).toBeDefined(); // broke the cap
    expect(ev(logs, "LOOT_BLOCKED")).toBeUndefined(); // did NOT skip
    const cap = rt.world.blockId({ x: 6, y: 65, z: 0 });
    expect(cap.ok && cap.value).toBe("minecraft:air"); // cap gone
    expect(ev(logs, "LOOT_TOOK")?.fields).toMatchObject({ n: 5 }); // then looted
    expect(diskMarker(rt).looted).toBe(true);
  });

  it("cap-break gets the HAND-BREAK budget (cfg.loot.capBreakTimeoutTicks), not the mining one", () => {
    // A loot bot often carries NO tool (non-op honest economy) — a terracotta cap takes ~125 ticks
    // by hand, past the 80-tick mining budget. The cap break must run on its own budget: at the old
    // budget's expiry the mission is still working; only past cfg.loot.capBreakTimeoutTicks does it skip.
    resetGreedyNav();
    const rt = createMockRuntime();
    seedRegistry(rt, [{ kind: "chest", x: 6, y: 64, z: 0 }]);
    spliceChest(rt, new Map([[100, { id: "minecraft:gold_ingot", count: 5 }]]));
    rt.setBlock(6, 65, 0, "minecraft:gray_terracotta"); // cap that never resolves (no flushBreak)

    const { kernel, st, logs } = bot(rt);
    const cfg = makeGerdaConfig({});
    rt.setPos({ x: 6, y: 64, z: 0 });
    kernel.startMission(st, "loot-run", { breakBlocked: true });

    const oldBudget = cfg.nav.mineAimTicks + cfg.nav.mineBreakTimeoutTicks;
    for (let i = 0; i <= oldBudget + 5; i++) kernel.tick(st); // never flushBreak — cap stays solid
    expect(ev(logs, "LOOT_BLOCKED")).toBeUndefined(); // still hand-breaking, NOT skipped

    const capBudget = cfg.nav.mineAimTicks + cfg.loot.capBreakTimeoutTicks;
    for (let i = 0; i <= capBudget; i++) kernel.tick(st);
    expect(ev(logs, "LOOT_BLOCKED")?.fields).toMatchObject({ note: "cap unbreakable" }); // backstop intact
  });

  it("honours the `near` radius, looting only the close chest", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    seedRegistry(rt, [
      { kind: "chest", x: 4, y: 64, z: 0 },
      { kind: "chest", x: 80, y: 64, z: 0 }, // far away
    ]);
    const { kernel, st, logs } = bot(rt);
    rt.setPos({ x: 0, y: 64, z: 0 });
    kernel.startMission(st, "loot-run", { near: 10 });
    expect(ev(logs, "LOOT_PLAN")?.fields).toMatchObject({ containers: 1, near: 10 });
  });

  it("excludes drawers (base storage), never looting them back into the bag", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    seedRegistry(rt, [{ kind: "drawer", x: 4, y: 64, z: 0, facing: "west" }]);
    const { kernel, st, logs } = bot(rt);
    rt.setPos({ x: 0, y: 64, z: 0 });
    kernel.startMission(st, "loot-run", {});
    for (let i = 0; i < 10 && kernel.activeMission() !== null; i++) kernel.tick(st);
    expect(ev(logs, "LOOT_NONE")).toBeDefined(); // drawer is not lootable
  });
});
