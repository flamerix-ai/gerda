// Bounded in-process buffer bridging the TS event bus → the cross-process event ring
// (events = PULL). The worker bundle stays facade-only (no raw GlobalVars), so
// it can't write the ring itself; instead the event-export capability fills this
// buffer from the bus, and the worker.js Service drains it each tick into the
// GlobalVars ring (IPC.ringAppend), which `poll_events {since}` reads. Only the
// whitelisted EVENT_KINDS are mirrored — the bus carries more, but the ring is for the
// AI's pull feed.
import { RING_SIZE } from "@/core/ipc/ipc";

export interface RingEvent {
  readonly kind: string;
  readonly fields: Record<string, unknown>;
}

export class EventBuffer {
  private buf: RingEvent[] = [];
  private readonly cap: number;

  // Default cap matches the cross-process ring (RING_SIZE) — this in-process buffer
  // feeds it, so there's no point holding more than the ring can carry.
  constructor(cap = RING_SIZE) {
    this.cap = cap;
  }

  push(kind: string, fields: Record<string, unknown>): void {
    this.buf.push({ kind, fields });
    if (this.buf.length > this.cap) this.buf.shift(); // drop oldest if never drained
  }

  /** Return and clear all buffered events (worker.js calls this each tick). */
  drain(): RingEvent[] {
    if (this.buf.length === 0) return [];
    const out = this.buf;
    this.buf = [];
    return out;
  }

  size(): number {
    return this.buf.length;
  }
}
