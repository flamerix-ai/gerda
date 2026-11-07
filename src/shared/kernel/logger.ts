// Structured, replayable logging — replaces the OpenTelemetry-style trace/span/
// corr machinery (no concurrency exists in a single-thread tick loop for spans to
// bridge). What actually helps debugging a bot:
//   1. a transition journal  {tick, from, to, reason}
//   2. NDJSON events         {tick, phase, event, ...fields}
//   3. tick-sampled snapshots
// Output goes to a pluggable sink so this is pure + testable; the real sink writes
// NDJSON to a file and mirrors WARN/ERR to chat (see runtime/jsmacros.ts).

export type Level = "TRC" | "DBG" | "INFO" | "WARN" | "ERR";

export interface LogRecord {
  readonly tick: number;
  readonly level: Level;
  readonly event: string;
  readonly fields?: Readonly<Record<string, unknown>>;
}

export interface LogSink {
  emit(line: string): void;
  /** Optional human channel for WARN/ERR (chat). */
  alert?(line: string): void;
}

const LEVEL_RANK: Record<Level, number> = { TRC: 0, DBG: 1, INFO: 2, WARN: 3, ERR: 4 };

export class Logger {
  private readonly ring: LogRecord[] = [];
  // Per-key throttle state: last emit tick + how many emits we've swallowed since.
  private readonly throttled = new Map<string, { tick: number; suppressed: number }>();
  constructor(
    private readonly sink: LogSink,
    private minLevel: Level = "INFO",
    private readonly ringLimit = 200,
  ) {}

  /** Lower/raise the emit threshold at runtime (the `trace` command drops this to "TRC"
   *  so per-tick T: lines surface in get_logs, then restores cfg.logLevel). */
  setMinLevel(level: Level): void {
    this.minLevel = level;
  }

  log(tick: number, level: Level, event: string, fields?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;
    const rec: LogRecord = fields ? { tick, level, event, fields } : { tick, level, event };
    this.ring.push(rec);
    if (this.ring.length > this.ringLimit) this.ring.shift();

    const line = JSON.stringify(rec);
    this.sink.emit(line);
    if ((level === "WARN" || level === "ERR") && this.sink.alert) this.sink.alert(line);
  }

  /**
   * Rate-limited log for events that recur every tick (e.g. "still respawning",
   * "still stuck"). Emits at most once per `minGap` ticks PER KEY; when it does emit
   * after suppressing some, it adds `suppressed: N` so the count isn't lost. This
   * replaces ad-hoc `phaseTicks % 20` guards and keeps the journal readable. Use a
   * distinct `key` per logical stream (defaults to `event`) so two throttled streams
   * don't share a window.
   */
  throttle(
    tick: number,
    level: Level,
    event: string,
    fields?: Record<string, unknown>,
    minGap = 20,
    key = event,
  ): void {
    const prev = this.throttled.get(key);
    if (prev && tick - prev.tick < minGap) {
      prev.suppressed++;
      return;
    }
    const suppressed = prev?.suppressed ?? 0;
    this.throttled.set(key, { tick, suppressed: 0 });
    this.log(tick, level, event, suppressed ? { ...fields, suppressed } : fields);
  }

  /** Forget a throttle window so the next `throttle` for `key` emits immediately. */
  resetThrottle(key: string): void {
    this.throttled.delete(key);
  }

  /** The "trace" that matters: the sequence of phase changes. */
  transition(tick: number, from: string, to: string, reason: string): void {
    this.log(tick, "INFO", "TRANSITION", { from, to, reason });
  }

  trc = (t: number, e: string, f?: Record<string, unknown>) => this.log(t, "TRC", e, f);
  info = (t: number, e: string, f?: Record<string, unknown>) => this.log(t, "INFO", e, f);
  warn = (t: number, e: string, f?: Record<string, unknown>) => this.log(t, "WARN", e, f);
  err = (t: number, e: string, f?: Record<string, unknown>) => this.log(t, "ERR", e, f);

  /** Recent entries — backs the bridge `get_logs` endpoint for live MCP debugging. */
  recent(n = 50): readonly LogRecord[] {
    return this.ring.slice(-n);
  }
}
