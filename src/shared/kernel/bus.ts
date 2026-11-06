// Typed in-process event bus — decouples capabilities (a finder emits, others
// react) without them referencing each other. Mirrors the ecosystem pattern of
// jsMacros custom events (btscreen's `BTScreenStatusChange`); a capability that
// must signal ANOTHER script context can additionally bridge to a real
// `JsMacros.createCustomEvent`, but in-context this stays plain and synchronous.

export type Handler<T> = (payload: T) => void;

// Capabilities augment this interface via declaration merging to add their events.
export interface BotEvents {
  phaseChanged: { from: string; to: string; reason: string };
  oreFound: { x: number; y: number; z: number; id: string };
  lootSpotted: { x: number; y: number; z: number; id: string };
  inventoryFull: { reason: string };
  missionStarted: { name: string; params: Record<string, unknown> };
  missionDone: { name: string };
  missionAborted: { name: string };
  crafted: { id: string; count: number };
  lowHealth: { health: number; phase: string };
  // Proactive distress (vitals): the bot lost `lost` HP from its recent peak within
  // cfg.safety.distressWindow — something is actively hurting it (drown/lava/suffocation), react
  // BEFORE the cfg.safety.minHealth floor. `health` is the current HP at the moment of the trip.
  distress: { health: number; lost: number; phase: string };
  lowAir: { air: number; maxAir: number; phase: string };
  lowFood: { food: number; phase: string };
  died: { phase: string };
  stuck: { phase: string; ticks: number };
  waterClutch: { x: number; y: number; z: number; drop: number };
  submerged: { x: number; y: number; z: number; air: number };
  recovered: { from: string };
  // The universal progress contract detected the phase's progress signature frozen past
  // its budget — a silent wedge. Raised loud + typed BEFORE the per-phase recovery disposition runs.
  phaseStalled: { phase: string; policy: string; budget: number };
  // autonomy upkeep outcomes (effect-verified — emitted when the state change is
  // OBSERVED, not when the action is dispatched): a meal reached target, the player
  // came back alive after a death.
  ate: { food: number; ticks: number };
  respawned: { afterTicks: number };
  blockMined: { x: number; y: number; z: number };
  kernelError: { owner: string; label: string; error: string };
}

export class Bus {
  private readonly handlers = new Map<keyof BotEvents, Set<Handler<unknown>>>();
  /** Last subscriber throw (for debugging); delivery to other subscribers continues. */
  lastEmitError: string | null = null;

  on<K extends keyof BotEvents>(event: K, handler: Handler<BotEvents[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    // reliability-ok: the handler Set is heterogeneous (one per event key); the public
    // `on`/`emit` signatures are the contract that each handler matches its key's payload.
    // Erase once so add + delete share the single cast.
    const erased = handler as Handler<unknown>;
    set.add(erased);
    return () => set?.delete(erased);
  }

  emit<K extends keyof BotEvents>(event: K, payload: BotEvents[K]): void {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const h of set) {
      // reliability-ok: re-apply the payload type erased by the heterogeneous Set (the
      // key→payload contract from `on`).
      const fn = h as Handler<BotEvents[K]>;
      // reliability-ok: deliver in isolation — one throwing subscriber must not break the
      // others, and the throw is recorded (lastEmitError), never swallowed.
      try {
        fn(payload);
      } catch (e) {
        this.lastEmitError = String(e);
      }
    }
  }
}
