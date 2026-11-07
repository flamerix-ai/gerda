import { PERSIST_SLICE, persistence } from "@/bot/capabilities/persistence";
import { MINING_SLICE, initMiningMem } from "@/bot/missions/mine/mining-mem";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { createMockRuntime } from "@/core/runtime/mock";
import type { ConfigOverrides } from "@/shared/config/schema";
import {
  type Waypoint,
  makeWaypoint,
  markDepletedNear,
  nearestWaypoint,
  parseWaypoints,
  removeWaypoint,
  serializeWaypoints,
  toJourneyMapWaypoint,
  upsertWaypoint,
} from "@/shared/domain/waypoints";
import { Bus } from "@/shared/kernel/bus";
import { type BotState, Kernel, makeInitialState } from "@/shared/kernel/capability";
import { type LogSink, Logger } from "@/shared/kernel/logger";
import { describe, expect, it } from "vitest";

const sink: LogSink = { emit: () => {} };

describe("waypoints domain", () => {
  it("upsert replaces by name; remove drops it", () => {
    let list = [makeWaypoint("home", { x: 0, y: 64, z: 0 }, "home")];
    list = upsertWaypoint(list, makeWaypoint("home", { x: 10, y: 70, z: 10 }, "home"));
    expect(list.length).toBe(1);
    expect(list[0]).toMatchObject({ x: 10, y: 70, z: 10 });
    list = removeWaypoint(list, "home");
    expect(list.length).toBe(0);
  });

  it("nearest filters by kind", () => {
    const list = [
      makeWaypoint("a", { x: 0, y: 0, z: 0 }, "vein"),
      makeWaypoint("b", { x: 100, y: 0, z: 0 }, "vein"),
      makeWaypoint("home", { x: 1, y: 0, z: 0 }, "home"),
    ];
    expect(nearestWaypoint(list, { x: 90, y: 0, z: 0 }, "vein")?.name).toBe("b");
  });

  it("serialize/parse round-trips and rejects junk", () => {
    const list = [makeWaypoint("x", { x: 1, y: 2, z: 3 }, "custom")];
    expect(parseWaypoints(serializeWaypoints(list))).toEqual(list);
    expect(parseWaypoints("not json")).toEqual([]);
    expect(parseWaypoints(null)).toEqual([]);
  });

  it("markDepletedNear greys out only in-range veins", () => {
    const list = [
      makeWaypoint("near", { x: 5, y: 64, z: 0 }, "vein"),
      makeWaypoint("far", { x: 500, y: 64, z: 0 }, "vein"),
      makeWaypoint("home", { x: 0, y: 64, z: 0 }, "home"),
    ];
    const { waypoints, changed } = markDepletedNear(list, { x: 0, y: 64, z: 0 }, 32);
    expect(changed.map((w) => w.name)).toEqual(["near"]);
    expect(waypoints.find((w) => w.name === "near")?.kind).toBe("depleted");
    expect(waypoints.find((w) => w.name === "far")?.kind).toBe("vein");
    expect(waypoints.find((w) => w.name === "home")?.kind).toBe("home");
  });

  it("JourneyMap formatter encodes id/color/dimension + render-critical icon fields", () => {
    const jm = toJourneyMapWaypoint(makeWaypoint("home", { x: 5, y: 64, z: -7 }, "home"));
    // JM's own id scheme: name_x,y,z with runs of non-word chars → "-" (so ",-7" collapses
    // to "-7"). Matching it keeps re-writes idempotent instead of duplicating JM's file.
    expect(jm.id).toBe("home_5-64-7");
    expect(jm.dimensions).toEqual(["minecraft:overworld"]);
    expect({ r: jm.r, g: jm.g, b: jm.b }).toEqual({ r: 0, g: 200, b: 0 });
    // These four were missing/wrong before and made JourneyMap's waypoint manager flicker:
    // `waypoint-normal.png` doesn't exist, and JM does not regenerate the icon caches.
    expect(jm.icon).toBe("journeymap:ui/img/waypoint-icon.png");
    expect(jm.colorizedIcon).toBe("fake:color--16726016-waypoint-icon.png"); // 0xFF00C800
    expect(jm.iconColor).toBe(-1);
    expect(jm.customIconColor).toBe(false);
  });
});

// The mock's default world signature; persistence scopes its section under it.
const SIG = "local|minecraft:overworld";

// Build a world-model seed file with one section under SIG.
function seedModel(section: { waypoints?: unknown[]; stats?: object }): string {
  return JSON.stringify({
    version: 1,
    worlds: {
      [SIG]: {
        waypoints: section.waypoints ?? [],
        resources: [],
        stats: section.stats ?? { dumps: 0, veinsFound: 0, boots: 0 },
        updatedAt: 0,
      },
    },
  });
}

function bot(over: ConfigOverrides = {}, seedFile?: string) {
  const rt = createMockRuntime();
  const cfg = makeGerdaConfig(over);
  if (seedFile) rt.state.files.set(cfg.worldModelPath, seedFile);
  const kernel = new Kernel(rt, new Logger(sink, "ERR"), new Bus(), cfg, GERDA_PHASES);
  kernel.register(persistence);
  const st = makeInitialState();
  kernel.init(st);
  st.running = true;
  return { rt, kernel, st, cfg };
}

interface PMem {
  waypoints: { name: string }[];
  stats: { dumps: number; veinsFound: number; boots: number };
}

describe("persistence capability", () => {
  it("loads an existing store on the first tick and bumps the boot count", () => {
    const seed = seedModel({
      waypoints: [makeWaypoint("home", { x: 1, y: 2, z: 3 }, "home")],
      stats: { dumps: 4, veinsFound: 2, boots: 7 },
    });
    const { kernel, st } = bot({}, seed);
    kernel.tick(st); // load is deferred to the first guard tick (world ready by then)
    const mem = st.bb[PERSIST_SLICE.name] as PMem;
    expect(mem.waypoints.length).toBe(1);
    expect(mem.stats.dumps).toBe(4);
    expect(mem.stats.boots).toBe(8); // incremented on load
  });

  it("defers the load until the world signature is ready (empty = not loaded)", () => {
    const seed = seedModel({
      waypoints: [makeWaypoint("home", { x: 1, y: 2, z: 3 }, "home")],
      stats: { dumps: 0, veinsFound: 0, boots: 0 },
    });
    const { rt, kernel, st, cfg } = bot({}, seed);
    rt.state.worldSig = ""; // world not loaded yet (worker boot tick)
    kernel.tick(st);
    expect((st.bb[PERSIST_SLICE.name] as PMem).waypoints.length).toBe(0); // nothing loaded
    expect(rt.state.files.get(cfg.worldModelPath)).toBe(seed); // and nothing written
    rt.state.worldSig = SIG; // world ready
    kernel.tick(st);
    expect((st.bb[PERSIST_SLICE.name] as PMem).waypoints.length).toBe(1); // loaded now
  });

  it("re-scopes to a new section on dimension change, preserving the prior one", () => {
    const { rt, kernel, st, cfg } = bot();
    rt.state.worldSig = "LOCAL|minecraft:overworld";
    rt.setPos({ x: 1, y: 2, z: 3 });
    kernel.command(st, { type: "add_waypoint", name: "ow_spot" });
    rt.state.worldSig = "LOCAL|minecraft:the_nether"; // travel to the Nether
    kernel.command(st, { type: "add_waypoint", name: "nether_spot" });
    const model = JSON.parse(rt.state.files.get(cfg.worldModelPath) as string);
    expect(
      model.worlds["LOCAL|minecraft:overworld"].waypoints.map((w: Waypoint) => w.name),
    ).toEqual(["ow_spot"]);
    expect(
      model.worlds["LOCAL|minecraft:the_nether"].waypoints.map((w: Waypoint) => w.name),
    ).toEqual(["nether_spot"]);
  });

  // The HOME→DUMP edge records no home: only a /home that moved the bot does (home-return.test.ts).
  it("records the dump waypoint across a HOME→DUMP→RETURN transition, and no home", () => {
    const { rt, kernel, st } = bot();
    rt.setPos({ x: 10, y: 64, z: 20 });
    const phases: BotState["phase"][] = ["HOME", "DUMP", "RETURN"];
    for (const p of phases) {
      st.phase = p;
      kernel.tick(st);
    }
    const mem = st.bb[PERSIST_SLICE.name] as PMem;
    expect(mem.waypoints.find((w) => w.name === "home")).toBeUndefined();
    expect(mem.waypoints.find((w) => w.name === "dump")).toMatchObject({ x: 10, y: 64, z: 20 });
    expect(mem.stats.dumps).toBe(1);
  });

  function seedVein(kernel: Kernel, st: BotState) {
    kernel.command(st, {
      type: "add_waypoint",
      name: "vein_3_64_0",
      kind: "vein",
      x: 3,
      y: 64,
      z: 0,
    });
  }
  const veinKind = (st: BotState) =>
    (st.bb[PERSIST_SLICE.name] as { waypoints: { name: string; kind: string }[] }).waypoints.find(
      (w) => w.name === "vein_3_64_0",
    )?.kind;

  it("marks nearby veins depleted when the scan exhausts (mining.exhausted)", () => {
    const { rt, kernel, st } = bot();
    rt.setPos({ x: 0, y: 64, z: 0 });
    seedVein(kernel, st);
    // The scan walked the area dry → mine sets `exhausted` (covers BOTH the unlimited-run
    // PAUSED path and the batch-run self-complete path, which has no clean SCAN→PAUSED edge).
    st.bb[MINING_SLICE.name] = { ...initMiningMem(), exhausted: true };
    kernel.tick(st);
    expect(veinKind(st)).toBe("depleted");
  });

  it("depletes only ONCE per exhaustion (the exhaustHandled latch), even held high for ticks", () => {
    const { rt, kernel, st } = bot();
    rt.setPos({ x: 0, y: 64, z: 0 });
    seedVein(kernel, st);
    const mining = { ...initMiningMem(), exhausted: true };
    st.bb[MINING_SLICE.name] = mining;
    kernel.tick(st); // depletes
    expect(veinKind(st)).toBe("depleted");
    // Re-seed a fresh vein near the same spot WITHOUT clearing exhausted — the latch must keep
    // it from re-depleting (it stays a vein) until a new scan re-arms (exhausted→false→true).
    kernel.command(st, {
      type: "add_waypoint",
      name: "vein_3_64_0",
      kind: "vein",
      x: 3,
      y: 64,
      z: 0,
    });
    kernel.tick(st);
    expect(veinKind(st)).toBe("vein");
    mining.exhausted = false; // a fresh scan started
    kernel.tick(st);
    mining.exhausted = true; // and exhausted again → re-arms
    kernel.tick(st);
    expect(veinKind(st)).toBe("depleted");
  });

  it("does NOT deplete on a manual pause (exhausted false)", () => {
    const { rt, kernel, st } = bot();
    rt.setPos({ x: 0, y: 64, z: 0 });
    seedVein(kernel, st);
    st.bb[MINING_SLICE.name] = { ...initMiningMem(), exhausted: false };
    st.phase = "SCAN";
    kernel.tick(st);
    st.phase = "PAUSED";
    kernel.tick(st);
    expect(veinKind(st)).toBe("vein"); // still active
  });

  it("add_waypoint command persists to the world-scoped store file", () => {
    const { rt, kernel, st, cfg } = bot();
    rt.setPos({ x: 1, y: 2, z: 3 });
    kernel.command(st, { type: "add_waypoint", name: "spot1" });
    const raw = rt.state.files.get(cfg.worldModelPath);
    expect(raw).toBeTruthy();
    const model = JSON.parse(raw as string);
    expect(model.worlds[SIG].waypoints[0]).toMatchObject({ name: "spot1", x: 1, y: 2, z: 3 });
  });

  it("preserves the prospector-owned resources section on save (read-modify-write)", () => {
    const { rt, kernel, st, cfg } = bot();
    // Prospector wrote resources for this world; persistence must not clobber them.
    rt.state.files.set(
      cfg.worldModelPath,
      JSON.stringify({
        version: 1,
        worlds: { [SIG]: { waypoints: [], resources: [{ kind: "iron", x: 5, z: 9 }], stats: {} } },
      }),
    );
    kernel.init(st); // reload under the seeded file
    rt.setPos({ x: 1, y: 2, z: 3 });
    kernel.command(st, { type: "add_waypoint", name: "spot1" });
    const model = JSON.parse(rt.state.files.get(cfg.worldModelPath) as string);
    expect(model.worlds[SIG].resources).toEqual([{ kind: "iron", x: 5, z: 9 }]);
    expect(model.worlds[SIG].waypoints[0]).toMatchObject({ name: "spot1" });
  });

  it("scopes by world signature — another world's data is untouched", () => {
    const { rt, kernel, st, cfg } = bot();
    rt.state.files.set(
      cfg.worldModelPath,
      JSON.stringify({
        version: 1,
        worlds: {
          "other|minecraft:the_nether": {
            waypoints: [{ name: "nether_home", kind: "home", x: 0, y: 0, z: 0 }],
            resources: [],
            stats: { dumps: 9, veinsFound: 0, boots: 0 },
          },
        },
      }),
    );
    kernel.init(st); // our world (SIG) has no section → fresh
    rt.setPos({ x: 1, y: 2, z: 3 });
    kernel.command(st, { type: "add_waypoint", name: "spot1" });
    const model = JSON.parse(rt.state.files.get(cfg.worldModelPath) as string);
    // the other world's section survives verbatim
    expect(model.worlds["other|minecraft:the_nether"].waypoints[0].name).toBe("nether_home");
    expect(model.worlds[SIG].waypoints[0].name).toBe("spot1");
  });

  it("JourneyMap export writes a per-waypoint file when enabled", () => {
    const { rt, kernel, st } = bot({ journeyMapExport: true, journeyMapDir: "./jm" });
    rt.setPos({ x: 8, y: 64, z: 8 });
    kernel.command(st, { type: "add_waypoint", name: "base", kind: "home" });
    const jmFile = rt.state.files.get("./jm/base_8-64-8.json"); // JM's own id scheme
    expect(jmFile).toBeTruthy();
    expect(JSON.parse(jmFile as string).origin).toBe("gerda-bot");
  });
});
