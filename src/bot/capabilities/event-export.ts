// event-export — mirrors the whitelisted bus events into the EventBuffer the worker
// drains to the cross-process ring (stage 6). Global, no handlers/guards — pure
// subscription.
//
// RING_MAP is the SSOT for what goes in the ring AND how each payload is flattened to
// plain JSON fields. Its key type is `keyof BotEvents`, so a typo or a removed bus event
// is a COMPILE error; a test asserts its key set equals EVENT_KINDS, so the ring schema
// (ipc.ts) and the wiring can't drift (they did: stale death/toolBroke/deposited vs the
// missing F1 died/lowAir/lowFood).
import type { BotEvents } from "@/shared/kernel/bus";
import type { Capability, Ctx } from "@/shared/kernel/capability";
import type { EventBuffer } from "@/shared/kernel/event-buffer";

type RingMap = { [K in keyof BotEvents]?: (e: BotEvents[K]) => Record<string, unknown> };

const RING_MAP: RingMap = {
  phaseChanged: (e) => ({ from: e.from, to: e.to, reason: e.reason }),
  oreFound: (e) => ({ x: e.x, y: e.y, z: e.z, id: e.id }),
  lootSpotted: (e) => ({ x: e.x, y: e.y, z: e.z, id: e.id }),
  inventoryFull: (e) => ({ reason: e.reason }),
  missionStarted: (e) => ({ name: e.name }),
  missionDone: (e) => ({ name: e.name }),
  missionAborted: (e) => ({ name: e.name }),
  lowHealth: (e) => ({ health: e.health, phase: e.phase }),
  lowAir: (e) => ({ air: e.air, maxAir: e.maxAir, phase: e.phase }),
  lowFood: (e) => ({ food: e.food, phase: e.phase }),
  died: (e) => ({ phase: e.phase }),
  stuck: (e) => ({ phase: e.phase }),
  recovered: (e) => ({ from: e.from }),
  kernelError: (e) => ({ owner: e.owner, label: e.label, error: e.error }),
};

/** The kinds event-export actually mirrors — a test pins this against EVENT_KINDS. */
export const RING_KINDS: readonly string[] = Object.keys(RING_MAP);

export function makeEventExport(buffer: EventBuffer): Capability {
  return {
    name: "event-export",

    init(ctx: Ctx): void {
      for (const k of Object.keys(RING_MAP)) {
        // reliability-ok: RING_MAP is keyed BY keyof BotEvents, so its own keys are too.
        const kind = k as keyof BotEvents;
        // reliability-ok: RING_MAP's type binds each key to its own payload flattener;
        // iterating keys erases that correlation, so this is the single re-narrowing point
        // (the union flattener accepts the union payload — same shape as Bus's own erasure).
        const flatten = RING_MAP[kind] as (
          e: BotEvents[keyof BotEvents],
        ) => Record<string, unknown>;
        ctx.bus.on(kind, (e) => buffer.push(k, flatten(e)));
      }
    },
  };
}
