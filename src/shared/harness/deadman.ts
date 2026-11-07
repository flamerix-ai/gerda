// Movement-key dead-man — the harness decision "has the worker stopped ticking long enough that
// main.js must let go of the movement keys?". A worker tick that blocks (a synchronous replan, a long
// SCAN tick) leaves pressed whatever its last drive pressed: the client keeps walking the body while no
// worker veto (step hazard, fall survival, descent guard) can run. RCA I-4: a 25 s replan with
// forward + sprint held walked a bot off a 39-block rim. main.js runs on its own thread, keeps ticking
// through a worker stall, and calls this once per main tick with the worker heartbeat.
//
// The heartbeat is mc_worker_alive: worker.js bumps it once at the START of every tick body, and the
// paced tick (IPC.paceTick, one JsMacros.once("Tick") re-armed when the body returns) runs no body
// while one is in flight — so the counter stands still for exactly as long as a body blocks. The
// seconds stamp mc_worker_alive_ts is too coarse for a half-second threshold.
//
// MIRROR: harness/safe-io.js `__MC_HARNESS.deadman`; test-ts/harness-contract.test.ts asserts parity.

/** The keys the dead-man releases: every body-moving key (sprint and sneak included), no action keys —
 *  a held `use`/`attack` moves nothing, and main.js has no business ending a mining swing. */
export const DEADMAN_KEYS: readonly string[] = [
  "key.forward",
  "key.back",
  "key.left",
  "key.right",
  "key.jump",
  "key.sprint",
  "key.sneak",
];

export interface DeadmanState {
  /** The last heartbeat value seen; null before the first observation. */
  readonly beat: number | null;
  /** The main tick at which `beat` last changed. */
  readonly beatTick: number;
  /** This stall already released the keys (once per stall, never every tick). */
  readonly tripped: boolean;
  /** Worker stalls ≥ staleTicks since main.js started (the diag counter). Each one released the
   *  keys, but main cannot see the worker's held-key set: a stall with no key down (a long SCAN
   *  tick, the gate) counts too. A stall count, not a count of saved walk-offs. */
  readonly stalls: number;
  /** The main tick of the last stall's release; -1 = never. */
  readonly stallTick: number;
}

export interface DeadmanStep {
  readonly state: DeadmanState;
  /** Release DEADMAN_KEYS now (true on the first stale tick of a stall only). */
  readonly release: boolean;
  /** The worker is running and its heartbeat has stood still for ≥ staleTicks main ticks. */
  readonly stale: boolean;
}

export function deadmanInit(): DeadmanState {
  return { beat: null, beatTick: 0, tripped: false, stalls: 0, stallTick: -1 };
}

/** One main tick. `beat` = mc_worker_alive (0 = no worker running: nothing of the bot's to release,
 *  and a human may be holding the keys); `tick` = main.js's own tick count. A changed beat re-arms. */
export function deadmanStep(
  st: DeadmanState,
  beat: number,
  tick: number,
  staleTicks: number,
): DeadmanStep {
  if (beat !== st.beat) {
    return {
      state: { beat, beatTick: tick, tripped: false, stalls: st.stalls, stallTick: st.stallTick },
      release: false,
      stale: false,
    };
  }
  const stale = beat > 0 && tick - st.beatTick >= staleTicks;
  if (!stale || st.tripped) return { state: st, release: false, stale };
  return {
    state: { ...st, tripped: true, stalls: st.stalls + 1, stallTick: tick },
    release: true,
    stale,
  };
}
