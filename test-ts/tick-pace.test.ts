// Tick pacing (harness/ipc.js paceTick): a slow tick body must not make jsMacros park one
// thread per game tick behind it. jsMacros 1.9 starts a pool thread for EVERY registered Tick
// listener on EVERY tick (FJsMacros$1.trigger), and the thread then waits for the script's one
// GraalJS context; a 4-minute worker tick parked 4538 threads and killed the client. paceTick
// keeps at most one once-listener armed and re-arms it only after the body returns.
//
// FakeJsMacros models exactly the two jsMacros behaviours that matter (javap of
// jsmacros-1.20.1-1.9.2-forge): `on` keeps the listener and starts a task per tick; `once`
// removes the listener BEFORE it starts the task (FJsMacros$2.trigger). Tasks then run one at a
// time, like the single context. `threads` counts started tasks = pool threads.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

type Cb = () => void;
type Listener = { cb: Cb; once: boolean };

class FakeJsMacros {
  listeners: Listener[] = [];
  threads = 0;
  pending: Cb[] = [];
  on(_event: string, cb: Cb): Listener {
    const l = { cb, once: false };
    this.listeners.push(l);
    return l;
  }
  once(_event: string, cb: Cb): Listener {
    const l = { cb, once: true };
    this.listeners.push(l);
    return l;
  }
  off(l: Listener): boolean {
    const i = this.listeners.indexOf(l);
    if (i >= 0) this.listeners.splice(i, 1);
    return i >= 0;
  }
  /** The render thread fires one Tick: each listener starts one pool-thread task. */
  fireTick(): void {
    for (const l of [...this.listeners]) {
      if (l.once) this.off(l);
      this.threads++;
      this.pending.push(l.cb);
    }
  }
  /** The script context runs the next waiting task. */
  runNext(): void {
    const t = this.pending.shift();
    if (t) t();
  }
}

type Pace = {
  stop: () => void;
  stats: () => { lastMs: number; maxMs: number; slow: number; missed: number };
};
type Ipc = {
  TICK_MS: number;
  paceTick: (jsm: FakeJsMacros, wrap: (f: Cb) => Cb, body: Cb) => Pace;
};

function loadIpc(): Ipc {
  const g = globalThis as Record<string, unknown>;
  // biome-ignore lint/security/noGlobalEval: the test must execute the real ipc.js in global scope.
  globalThis.eval(readFileSync("harness/ipc.js", "utf8"));
  const ipc = g["__MC_IPC"];
  if (!ipc) throw new Error("ipc.js did not assign globalThis.__MC_IPC");
  return ipc as Ipc;
}

const ipc = loadIpc();
const identity = (f: Cb): Cb => f;
const GAME_TICKS_DURING_SLOW_BODY = 100;

// One slow tick: the first tick's body runs while the game fires 100 more ticks.
function slowTickScenario(register: (jsm: FakeJsMacros, body: Cb) => void): FakeJsMacros {
  const jsm = new FakeJsMacros();
  let first = true;
  register(jsm, () => {
    if (!first) return;
    first = false;
    for (let i = 0; i < GAME_TICKS_DURING_SLOW_BODY; i++) jsm.fireTick();
  });
  jsm.fireTick();
  jsm.runNext();
  return jsm;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("paceTick: no thread pile-up behind a slow tick", () => {
  it("NEG-CONTROL: a plain JsMacros.on listener parks one thread per tick (the 4538-thread storm)", () => {
    const jsm = slowTickScenario((j, body) => j.on("Tick", body));
    expect(jsm.threads).toBe(1 + GAME_TICKS_DURING_SLOW_BODY);
    expect(jsm.pending.length).toBe(GAME_TICKS_DURING_SLOW_BODY);
  });

  it("paceTick starts no thread while the body runs, and re-arms after it", () => {
    const jsm = slowTickScenario((j, body) => ipc.paceTick(j, identity, body));
    expect(jsm.threads).toBe(1);
    expect(jsm.pending.length).toBe(0);
    expect(jsm.listeners.length).toBe(1); // re-armed for the next tick
    jsm.fireTick();
    expect(jsm.threads).toBe(2);
  });

  it("runs the body once per fired tick when ticks are fast", () => {
    const jsm = new FakeJsMacros();
    let n = 0;
    ipc.paceTick(jsm, identity, () => {
      n++;
    });
    for (let i = 0; i < 5; i++) {
      jsm.fireTick();
      jsm.runNext();
    }
    expect(n).toBe(5);
    expect(jsm.threads).toBe(5);
  });
});

describe("paceTick stats", () => {
  it("counts a slow body and the ticks it covered", () => {
    let clock = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    const jsm = new FakeJsMacros();
    let ms = 230;
    const pace = ipc.paceTick(jsm, identity, () => {
      clock += ms;
    });
    jsm.fireTick();
    jsm.runNext();
    ms = 10;
    jsm.fireTick();
    jsm.runNext();
    expect(pace.stats()).toEqual({
      lastMs: 10,
      maxMs: 230,
      slow: 1,
      missed: Math.floor(230 / ipc.TICK_MS),
    });
  });
});

describe("paceTick lifecycle", () => {
  it("a throwing body still re-arms, and the error still propagates", () => {
    const jsm = new FakeJsMacros();
    ipc.paceTick(jsm, identity, () => {
      throw new Error("boom");
    });
    jsm.fireTick();
    expect(() => jsm.runNext()).toThrow("boom");
    expect(jsm.listeners.length).toBe(1);
  });

  it("stop() removes the armed listener", () => {
    const jsm = new FakeJsMacros();
    const pace = ipc.paceTick(jsm, identity, () => {});
    pace.stop();
    expect(jsm.listeners.length).toBe(0);
    jsm.fireTick();
    expect(jsm.threads).toBe(0);
  });

  it("stop() during the body: no re-arm", () => {
    const jsm = new FakeJsMacros();
    let pace: Pace | null = null;
    pace = ipc.paceTick(jsm, identity, () => pace?.stop());
    jsm.fireTick();
    jsm.runNext();
    expect(jsm.listeners.length).toBe(0);
  });

  it("a task already waiting when stop() runs does not run the body", () => {
    const jsm = new FakeJsMacros();
    let n = 0;
    const pace = ipc.paceTick(jsm, identity, () => {
      n++;
    });
    jsm.fireTick(); // task started, waiting for the context
    pace.stop();
    jsm.runNext();
    expect(n).toBe(0);
    expect(jsm.listeners.length).toBe(0);
  });
});

describe("every Service ticks through paceTick", () => {
  for (const file of ["harness/worker.js", "harness/main.js", "harness/bridge.js"]) {
    it(`${file} registers its Tick with IPC.paceTick, never JsMacros.on("Tick")`, () => {
      const src = readFileSync(file, "utf8");
      expect(src).not.toMatch(/JsMacros\.on\(\s*["']Tick["']/);
      expect(src).toMatch(
        /tickListener = IPC\.paceTick\(JsMacros, JavaWrapper\.methodToJava, function \(\) \{/,
      );
    });
  }
});
