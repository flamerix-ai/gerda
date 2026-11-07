import { type LogRecord, type LogSink, Logger } from "@/shared/kernel/logger";
import { describe, expect, it } from "vitest";

// Logger.throttle — rate-limits per-tick-recurring events to one emit per window,
// carrying a `suppressed` count so nothing is silently lost (replaces ad-hoc
// `phaseTicks % N` guards in recover/stuck loops).

function collector(): { sink: LogSink; lines: LogRecord[] } {
  const lines: LogRecord[] = [];
  const sink: LogSink = { emit: (line) => lines.push(JSON.parse(line) as LogRecord) };
  return { sink, lines };
}

describe("Logger.throttle", () => {
  it("emits the first event immediately, suppresses repeats within the window", () => {
    const { sink, lines } = collector();
    const log = new Logger(sink, "INFO");
    log.throttle(0, "INFO", "STILL_DEAD", { deadFor: 0 }, 20);
    log.throttle(5, "INFO", "STILL_DEAD", { deadFor: 5 }, 20);
    log.throttle(19, "INFO", "STILL_DEAD", { deadFor: 19 }, 20);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.event).toBe("STILL_DEAD");
    expect(lines[0]?.fields).toEqual({ deadFor: 0 });
  });

  it("re-emits after the window and reports how many it swallowed", () => {
    const { sink, lines } = collector();
    const log = new Logger(sink, "INFO");
    log.throttle(0, "INFO", "STILL_DEAD", { deadFor: 0 }, 20);
    log.throttle(5, "INFO", "STILL_DEAD", { deadFor: 5 }, 20); // suppressed
    log.throttle(10, "INFO", "STILL_DEAD", { deadFor: 10 }, 20); // suppressed
    log.throttle(20, "INFO", "STILL_DEAD", { deadFor: 20 }, 20); // window elapsed → emit
    expect(lines).toHaveLength(2);
    expect(lines[1]?.fields).toEqual({ deadFor: 20, suppressed: 2 });
  });

  it("keys are independent — two streams don't share a window", () => {
    const { sink, lines } = collector();
    const log = new Logger(sink, "INFO");
    log.throttle(0, "INFO", "A", undefined, 20);
    log.throttle(1, "INFO", "B", undefined, 20);
    expect(lines.map((l) => l.event)).toEqual(["A", "B"]);
  });

  it("resetThrottle makes the next throttle emit immediately", () => {
    const { sink, lines } = collector();
    const log = new Logger(sink, "INFO");
    log.throttle(0, "INFO", "RESPAWN", undefined, 20);
    log.resetThrottle("RESPAWN");
    log.throttle(2, "INFO", "RESPAWN", undefined, 20); // would normally be suppressed
    expect(lines).toHaveLength(2);
  });

  it("honors minLevel like log()", () => {
    const { sink, lines } = collector();
    const log = new Logger(sink, "INFO");
    log.throttle(0, "TRC", "NOISE", undefined, 20);
    expect(lines).toHaveLength(0);
  });
});
