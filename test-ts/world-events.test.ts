// World-model normalization + the event-export → ring-buffer bridge (stages 5 + 6).
import { makeEventExport } from "@/bot/capabilities/event-export";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { createMockRuntime } from "@/core/runtime/mock";
import {
  type HazardMarker,
  emptyModel,
  getSection,
  hazardNear,
  mergeHazardMarker,
  normalizeModel,
  putSection,
} from "@/shared/domain/world-model";
import { Bus } from "@/shared/kernel/bus";
import { Kernel, makeInitialState } from "@/shared/kernel/capability";
import { EventBuffer } from "@/shared/kernel/event-buffer";
import { type LogSink, Logger } from "@/shared/kernel/logger";
import { describe, expect, it } from "vitest";

describe("world-model domain", () => {
  it("normalizes junk/partial input to an empty model", () => {
    expect(normalizeModel(null)).toEqual(emptyModel());
    expect(normalizeModel("nope")).toEqual(emptyModel());
    expect(normalizeModel({ worlds: 42 })).toEqual(emptyModel());
  });

  it("getSection returns an empty section for an unknown world", () => {
    const s = getSection(emptyModel(), "a|b");
    expect(s.waypoints).toEqual([]);
    expect(s.resources).toEqual([]);
    expect(s.stats).toEqual({ dumps: 0, veinsFound: 0, boots: 0 });
  });

  it("putSection replaces one world without touching the others", () => {
    let m = emptyModel();
    m = putSection(m, "w1", {
      waypoints: [],
      resources: [],
      storages: [],
      hazards: [],
      stats: { dumps: 1, veinsFound: 0, boots: 0 },
      updatedAt: 0,
    });
    m = putSection(m, "w2", {
      waypoints: [],
      resources: [],
      storages: [],
      hazards: [],
      stats: { dumps: 2, veinsFound: 0, boots: 0 },
      updatedAt: 0,
    });
    expect(getSection(m, "w1").stats.dumps).toBe(1);
    expect(getSection(m, "w2").stats.dumps).toBe(2);
  });

  it("coerces a section's missing fields to defaults", () => {
    const m = normalizeModel({ version: 1, worlds: { x: { waypoints: [{ name: "a" }] } } });
    const s = getSection(m, "x");
    expect(s.waypoints.length).toBe(1);
    expect(s.resources).toEqual([]);
    expect(s.hazards).toEqual([]);
    expect(s.stats.boots).toBe(0);
  });

  it("preserves an existing hazards array through normalize", () => {
    const m = normalizeModel({
      version: 1,
      worlds: { x: { hazards: [{ kind: "drowned", x: 5, z: 7 }] } },
    });
    expect(getSection(m, "x").hazards).toEqual([{ kind: "drowned", x: 5, z: 7 }]);
  });
});

describe("hazard markers (drowned columns — mark it and don't come back)", () => {
  const h = (x: number, z: number, tick?: number): HazardMarker =>
    tick === undefined ? { kind: "drowned", x, z } : { kind: "drowned", x, z, tick };

  it("mergeHazardMarker appends a new column and dedups by X/Z (newest wins)", () => {
    let list = mergeHazardMarker([], h(1, 2, 10));
    expect(list).toEqual([h(1, 2, 10)]);
    list = mergeHazardMarker(list, h(3, 4, 20)); // different column → appended
    expect(list.length).toBe(2);
    list = mergeHazardMarker(list, h(1, 2, 99)); // same column → replaced, not duplicated
    expect(list.length).toBe(2);
    expect(list.find((m) => m.x === 1 && m.z === 2)?.tick).toBe(99);
  });

  it("hazardNear matches within the radius (Euclidean) and misses beyond it", () => {
    const hazards = [h(0, 0)];
    expect(hazardNear(hazards, 0, 0, 3)).toBe(true); // exact
    expect(hazardNear(hazards, 2, 2, 3)).toBe(true); // dist √8 ≈ 2.83 ≤ 3
    expect(hazardNear(hazards, 3, 3, 3)).toBe(false); // dist √18 ≈ 4.24 > 3
    expect(hazardNear([], 0, 0, 3)).toBe(false); // no hazards → never near
  });

  it("hazardNear with radius 0 → exact-column match only", () => {
    const hazards = [h(5, 5)];
    expect(hazardNear(hazards, 5, 5, 0)).toBe(true);
    expect(hazardNear(hazards, 5, 6, 0)).toBe(false);
  });
});

describe("hazard markers — ravine kind (descent-recoverability trap, cross-run)", () => {
  it("normalize preserves a ravine marker", () => {
    const m = normalizeModel({
      version: 1,
      worlds: { w: { hazards: [{ kind: "ravine", x: -12, z: 4, tick: 7 }] } },
    });
    expect(getSection(m, "w").hazards).toEqual([{ kind: "ravine", x: -12, z: 4, tick: 7 }]);
  });

  it("hazardNear is kind-agnostic — a ravine column skips a target just like a drowned one", () => {
    const hazards: HazardMarker[] = [{ kind: "ravine", x: 10, z: 10 }];
    expect(hazardNear(hazards, 11, 11, 3)).toBe(true); // within radius of the ravine column
    expect(hazardNear(hazards, 20, 20, 3)).toBe(false);
  });

  it("mergeHazardMarker dedups drowned+ravine by X/Z column (newest kind wins)", () => {
    let list = mergeHazardMarker([], { kind: "drowned", x: 2, z: 2, tick: 1 });
    // a ravine veto later at the SAME column replaces the drowned marker (still one column entry)
    list = mergeHazardMarker(list, { kind: "ravine", x: 2, z: 2, tick: 5 });
    expect(list).toEqual([{ kind: "ravine", x: 2, z: 2, tick: 5 }]);
  });
});

const sink: LogSink = { emit: () => {} };

describe("event-export → EventBuffer", () => {
  it("mirrors only whitelisted bus events, flattened, and drains once", () => {
    const rt = createMockRuntime();
    const bus = new Bus();
    const buffer = new EventBuffer();
    const kernel = new Kernel(rt, new Logger(sink, "ERR"), bus, makeGerdaConfig(), GERDA_PHASES);
    kernel.register(makeEventExport(buffer));
    const st = makeInitialState();
    kernel.init(st); // subscribes

    bus.emit("phaseChanged", { from: "SCAN", to: "MINE", reason: "x" });
    bus.emit("missionStarted", { name: "mine", params: {} });
    bus.emit("blockMined", { x: 0, y: 0, z: 0 }); // high-frequency → NOT mirrored to the ring

    const drained = buffer.drain();
    expect(drained.map((e) => e.kind)).toEqual(["phaseChanged", "missionStarted"]);
    expect(drained[0]?.fields).toEqual({ from: "SCAN", to: "MINE", reason: "x" });
    expect(drained[1]?.fields).toEqual({ name: "mine" });

    expect(buffer.drain()).toEqual([]); // drained → empty
  });

  it("bounds the buffer to its cap (drops oldest)", () => {
    const buffer = new EventBuffer(3);
    for (let i = 0; i < 5; i++) buffer.push("phaseChanged", { n: i });
    const drained = buffer.drain();
    expect(drained.length).toBe(3);
    expect(drained.map((e) => e.fields["n"])).toEqual([2, 3, 4]);
  });
});
