// storage mission — the kernel-native storage-network deposit. Reads the `storages` registry
// (mc_world.json on the mock fs), routes each bag item (domain/storage), then walks + deposits:
// a DRAWER via hold→aim→useOnBlock (slot the player looks at), a CHEST via open+shift-click.
// Movement is short-circuited by setPos arrival; the deposit interactions are spliced fakes
// (like the stash/smelt tests) — we lock the routing + visit + deposit-loop logic, not in-game
// mechanics (those are live-verified; a headless client reads only server-synced contents).
import { core } from "@/bot/capabilities/core";
import { storageMission } from "@/bot/missions/storage";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import type { ContainerView } from "@/core/runtime/Runtime";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import { type Result, ok } from "@/core/runtime/types";
import { type StorageMarker, emptyModel, putSection } from "@/shared/domain/world-model";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { resetGreedyNav } from "@/shared/nav";
import { describe, expect, it } from "vitest";

const SIG = "local|minecraft:overworld"; // the mock's default worldSig

/** Write a world-model file to the mock fs whose section carries these storage markers. */
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

function bot(rt: MockRuntime): {
  kernel: Kernel;
  st: BotState;
  logs: LogRecord[];
} {
  const logs: LogRecord[] = [];
  const sink: LogSink = { emit: (line) => logs.push(JSON.parse(line) as LogRecord) };
  const kernel = new Kernel(
    rt,
    new Logger(sink, "INFO"),
    new Bus(),
    makeGerdaConfig(),
    GERDA_PHASES,
  );
  kernel.register(core).registerMission(storageMission);
  const state = makeInitialState();
  kernel.init(state);
  return { kernel, st: state, logs };
}

const ev = (logs: LogRecord[], name: string) => logs.find((l) => l.event === name);
const drawer = (slots: ({ id: string; count: number } | null)[]): ContainerView => ({
  kind: "drawer",
  facing: "west",
  slots: slots.map((s) => (s ? { ...s, durabilityPct: 100 } : null)),
});

describe("storage mission", () => {
  it("routes an item to the drawer that already homes it, then deposits the held stack", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    // Two drawers: one already homes raw_copper (type-match), one empty + nearer.
    seedRegistry(rt, [
      { kind: "drawer", x: 6, y: 64, z: 0, facing: "west" },
      { kind: "drawer", x: 3, y: 64, z: 0, facing: "west" },
    ]);
    rt.setContainer(
      { x: 6, y: 64, z: 0 },
      drawer([{ id: "minecraft:raw_copper", count: 8 }, null]),
    );
    rt.setContainer({ x: 3, y: 64, z: 0 }, drawer([null, null]));
    rt.state.slots.set(36, { id: "minecraft:raw_copper", count: 16, durabilityPct: 100 }); // held

    // Splice the drawer deposit: a useOnBlock with a held stack removes it from the bag (the
    // drawer absorbs the whole held stack — verified live).
    const deposited: string[] = [];
    rt.interact.useOnBlock = (): Result<void> => {
      const heldIdx = 36 + rt.state.hotbar;
      const s = rt.state.slots.get(heldIdx);
      if (s) {
        deposited.push(s.id);
        rt.state.slots.delete(heldIdx);
      }
      return ok(undefined);
    };

    const { kernel, st: state, logs } = bot(rt);
    rt.setPos({ x: 5, y: 64, z: 0 }); // in front of the type-match drawer (x=6, west face)
    kernel.startMission(state, "storage", { items: ["minecraft:raw_copper"] });
    expect(state.phase).toBe("GOTO");

    // arrive → STORE drawer → hold/aim/use → grace → verify → done.
    for (let i = 0; i < 40 && kernel.activeMission() !== null; i++) kernel.tick(state);

    expect(deposited).toContain("minecraft:raw_copper");
    // routed to the type-match drawer at x=6, NOT the nearer empty one at x=3.
    expect(ev(logs, "STORAGE_PLAN")?.fields).toMatchObject({ visits: 1 });
    expect(ev(logs, "STORAGE_DONE")?.fields).toMatchObject({ deposited: 16 });
    expect(rt.state.slots.get(36)).toBeUndefined(); // bag emptied of copper
    expect(state.phase).toBe("IDLE");
  });

  it("routes to a recorded chest and deposits via open + shift-click", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    seedRegistry(rt, [
      {
        kind: "chest",
        x: 6,
        y: 64,
        z: 0,
        recorded: [{ id: "minecraft:raw_iron", count: 20 }],
      },
    ]);
    rt.state.slots.set(36, { id: "minecraft:raw_iron", count: 10, durabilityPct: 100 });

    // Fake chest GUI (stash pattern): useOnBlock opens, quick() routes carry→chest, close shuts.
    const chest = new Map<number, { id: string; count: number; durabilityPct: number }>();
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
        quick: (i: number) => {
          const s = rt.state.slots.get(i);
          if (s) {
            chest.set(300 + chest.size, s);
            rt.state.slots.delete(i);
          }
        },
      });
    };

    const { kernel, st: state, logs } = bot(rt);
    rt.setPos({ x: 6, y: 64, z: 0 });
    kernel.startMission(state, "storage", { items: ["minecraft:raw_iron"] });
    for (let i = 0; i < 40 && kernel.activeMission() !== null; i++) kernel.tick(state);

    expect([...chest.values()].some((s) => s.id === "minecraft:raw_iron")).toBe(true);
    expect(ev(logs, "STORAGE_DONE")?.fields).toMatchObject({ deposited: 10 });
    expect(state.phase).toBe("IDLE");

    // chest "memory" write-back: the deposited 10 merged into the recorded 20 → 30 on disk (chests
    // are headless-blind, so the registry snapshot IS their truth across runs; drawers self-heal).
    expect(ev(logs, "STORAGE_RECORDED")?.fields).toMatchObject({ ids: 1 });
    const raw = rt.fs.read(makeGerdaConfig().worldModelPath);
    const after = JSON.parse(raw.ok ? (raw.value ?? "{}") : "{}");
    const rec = after.worlds[SIG].storages[0].recorded as { id: string; count: number }[];
    expect(rec).toEqual([{ id: "minecraft:raw_iron", count: 30 }]);
  });

  it("finishes 'nothing' when the bag holds none of the whitelist", () => {
    resetGreedyNav();
    const rt = createMockRuntime();
    seedRegistry(rt, [{ kind: "drawer", x: 3, y: 64, z: 0, facing: "west" }]);
    rt.setContainer({ x: 3, y: 64, z: 0 }, drawer([null, null]));
    rt.state.slots.set(36, { id: "minecraft:diamond_pickaxe", count: 1, durabilityPct: 100 });
    const { kernel, st: state, logs } = bot(rt);
    rt.setPos({ x: 0, y: 64, z: 0 });
    kernel.startMission(state, "storage", { items: ["minecraft:raw_iron"] });
    for (let i = 0; i < 10 && kernel.activeMission() !== null; i++) kernel.tick(state);
    expect(ev(logs, "STORAGE_NOTHING")).toBeDefined();
    expect(rt.state.slots.get(36)?.id).toBe("minecraft:diamond_pickaxe"); // untouched
    expect(kernel.activeMission()).toBeNull();
  });
});
