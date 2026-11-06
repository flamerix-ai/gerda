// ipc.ts — IPC single source of truth, R2 (TS worker bundle) mirror of
// harness/ipc.js. Keep the two in lockstep — test-ts/ipc-contract.test.ts
// asserts KEYS / RING_SIZE / VERSION / envelope-shape equality, so drift fails
// `bun run check`. The plain-JS Services use ipc.js (eval-included); the bundle
// uses this module.

export const IPC_VERSION = 1;
export const RING_SIZE = 256;

export const KEYS = {
  bridge: {
    alive: "mc_bridge_alive",
    seq: "mc_bridge_seq",
    cmdCount: "mc_bridge_cmd_count",
    cmdPfx: "mc_bridge_cmd_",
    respPfx: "mc_bridge_resp_",
    host: "mc_bridge_host",
    port: "mc_bridge_port",
  },
  worker: {
    cmd: "mc_worker_cmd",
    cmdFlag: "mc_worker_cmd_flag",
    alive: "mc_worker_alive",
    aliveTs: "mc_worker_alive_ts",
    status: "mc_worker_status",
    lastCmd: "mc_worker_last_cmd",
    resp: "mc_worker_resp",
    cmds: "mc_worker_cmds",
    build: "mc_worker_build",
    fatal: "mc_worker_fatal",
    tickPace: "mc_worker_tick_pace", // {lastMs,maxMs,slow,missed} (JSON): the worker's paceTick stats (harness/ipc.js)
    wantSprint: "mc_want_sprint", // worker→main: DESIRED sprint flag ("1"/"0"). The worker can't safely
    // call LivingEntity.setSprinting itself — that mutates the speed-attribute modifier map off the
    // main thread, racing the render thread's FOV read → CME crash. So it publishes intent here and
    // main.js applies it ON THE MAIN THREAD (mc_world_sig in reverse).
  },
  main: {
    alive: "mc_main_alive",
    build: "mc_main_build",
    srgOk: "mc_main_srg_ok", // "1" all required SRG names resolved | "0" rot | "unknown" map absent
    srgMissing: "mc_main_srg_missing", // JSON: { tokens:[…], members:[…] } — the loud boot diagnosis
  },
  events: {
    seq: "mc_events_seq",
    head: "mc_events_head",
    size: "mc_events_size",
    slotPfx: "mc_events_slot_",
  },
  world: {
    file: "mc_world.json",
    sig: "mc_world_sig",
    items: "mc_items",
    mobs: "mc_mobs",
    peers: "mc_peers",
    frames: "mc_frames",
    assignment: "mc_assignment",
  },
} as const;

export const bridgeCmd = (n: number): string => KEYS.bridge.cmdPfx + n;
export const bridgeResp = (id: number): string => KEYS.bridge.respPfx + id;
export const eventSlot = (i: number): string => KEYS.events.slotPfx + i;

// `t` is optional in stage 1 (envelopes stay byte-identical to today); stage 6
// makes responses carry `t` and the factories emit it.
interface Response {
  id: number;
  ok: boolean;
  type: string;
  data?: unknown;
  error?: string;
  t?: number;
}
interface Event {
  seq: number;
  kind: string;
  t: number;
  [k: string]: unknown;
}

export const now = (): number => Date.now();

export const ok = (id: number, type: string, data?: unknown): Response =>
  data === undefined ? { ok: true, type, id } : { ok: true, type, id, data };

export const okFlat = (id: number, type: string, fields?: Record<string, unknown>): Response => ({
  ok: true,
  type,
  id,
  ...(fields ?? {}),
});

export const err = (
  id: number,
  type: string,
  error: string,
  extra?: Record<string, unknown>,
): Response => ({ ok: false, type, id, error, ...(extra ?? {}) });

export const evt = (seq: number, kind: string, fields?: Record<string, unknown>): Event => ({
  seq,
  kind,
  t: now(),
  ...(fields ?? {}),
});

// The event kinds the worker->ring exporter mirrors (observability / IPC). MUST match real bus
// events (BotEvents) — event-export.ts owns the typed map and a test asserts the two
// sets are identical, so this can't silently drift again (it had: stale death/toolBroke/
// deposited that nothing emitted, while F1's died/lowAir/lowFood were missing).
export const EVENT_KINDS = [
  "phaseChanged",
  "oreFound",
  "lootSpotted",
  "inventoryFull",
  "missionStarted",
  "missionDone",
  "missionAborted",
  "lowHealth",
  "lowAir",
  "lowFood",
  "died",
  "stuck",
  "recovered",
  "kernelError",
] as const;
