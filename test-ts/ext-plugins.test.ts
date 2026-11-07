// ext.js plugins run against fake jsMacros/Java globals: the real harness/ext.js is evaluated, its
// register() calls are captured, and single plugins are driven with stub mod classes.
//   emi_search — EMI searches on its own thread. The old fixed 8-tick wait read EmiSearch.stacks
//     before a slow search landed and answered ok:true with the UNFILTERED index ("iron ingot" →
//     oak logs). It must wait for THIS search (a new compiledQuery, searchThread back to null), or
//     fail loud.
//   prospect — on a pack without GregTech CEu it must name the missing mod, not say "no gtceu
//     prospector in hotbar" (which reads as "go get one").
import { afterEach, describe, expect, it } from "vitest";

import { type Resp, loadExt, unloadExt } from "./_harness-tables";

afterEach(unloadExt);

function javaList<T>(items: T[]) {
  return { size: () => items.length, get: (i: number) => items[i] };
}
function emiEntry(id: string) {
  return { getEmiStacks: () => javaList([{ getId: () => id }]) };
}
const UNFILTERED = ["minecraft:oak_log", "minecraft:oak_wood"].map(emiEntry);
const IRON = ["minecraft:iron_ingot"].map(emiEntry);

// EMI's search as javap shows it: search() starts a thread; the worker compiles a NEW query
// object, then apply() publishes the stacks and clears searchThread. `ticksToLand` = how many
// ticks the worker takes on this client.
function fakeEmi(ticksToLand: number) {
  const emi = {
    compiledQuery: { q: "old" } as object,
    searchThread: null as object | null,
    stacks: javaList(UNFILTERED),
    pending: -1,
    update: () => {
      emi.searchThread = {};
      emi.pending = ticksToLand;
    },
    tick: () => {
      if (emi.pending < 0) return;
      if (emi.pending-- === 0) {
        emi.compiledQuery = { q: "new" };
        emi.stacks = javaList(IRON);
        emi.searchThread = null;
      }
    },
  };
  return emi;
}

function search(ticksToLand: number): Resp {
  const emi = fakeEmi(ticksToLand);
  const { handlers, resps } = loadExt({
    classes: {
      "dev.emi.emi.search.EmiSearch": emi,
      "dev.emi.emi.api.EmiApi": { setSearchText: () => {} },
    },
    onWaitTick: () => emi.tick(),
  });
  const h = handlers["emi_search"];
  if (!h) throw new Error("emi_search not registered");
  h({ text: "iron ingot", limit: 5 }, 7);
  const r = resps[0];
  if (!r) throw new Error("no response");
  return r;
}

describe("ext.js emi_search waits for its own search", () => {
  it("a search that lands after 12 ticks returns ITS results (the old 8-tick wait read the index)", () => {
    const r = search(12);
    expect(r["ok"]).toBe(true);
    expect(r["results"]).toEqual(["minecraft:iron_ingot"]);
  });

  it("a search that never lands fails loud instead of returning the unfiltered list", () => {
    const r = search(10_000);
    expect(r["ok"]).toBe(false);
    expect(String(r["error"])).toContain("did not finish");
    expect(r["results"]).toBeUndefined();
  });
});

describe("ext.js prospect off GregTech", () => {
  it("names the missing mod, not an empty hotbar", () => {
    const { handlers, resps } = loadExt({
      classes: {},
      missingClasses: new Set(["com.gregtechceu.gtceu.api.capability.GTCapabilityHelper"]),
      hotbar: [],
    });
    const h = handlers["prospect"];
    if (!h) throw new Error("prospect not registered");
    h({}, 3);
    const r = resps[0];
    expect(r?.["ok"]).toBe(false);
    expect(String(r?.["error"])).toContain("needs GregTech CEu");
    expect(String(r?.["error"])).not.toContain("hotbar");
  });
});
