// Shared test harness — builds a kernel on the mock runtime with the always-on layer
// (core + reflexes + recover) wired, so a mission/capability test is one makeBot() call
// instead of ~20 lines of copy-pasted setup (which drifted: some files registered reflexes,
// others forgot). Special harnesses (orchestrator recorders, etc.) can still build by hand.
import { core } from "@/bot/capabilities/core";
import { recover } from "@/bot/capabilities/recover";
import { makeGerdaConfig } from "@/bot/profile/config";
import { GERDA_PHASES } from "@/bot/profile/states";
import { type MockRuntime, createMockRuntime } from "@/core/runtime/mock";
import type { ConfigOverrides } from "@/shared/config/schema";
import { Bus } from "@/shared/kernel/bus";
import {
  type BotState,
  type Capability,
  Kernel,
  makeInitialState,
} from "@/shared/kernel/capability";
import { type Level, type LogSink, Logger } from "@/shared/kernel/logger";
import type { Mission } from "@/shared/kernel/mission";
import { reflexes } from "@/shared/reflexes";

export const silentSink: LogSink = { emit: () => {} };

export interface BotHarness {
  rt: MockRuntime;
  kernel: Kernel;
  st: BotState;
}

export interface MakeBotOpts {
  /** Extra always-on capabilities, registered after core/reflexes/recover. */
  caps?: readonly Capability[];
  /** Missions to register (activate later with kernel.startMission). */
  missions?: readonly Mission[];
  /** Config overrides (merged over DEFAULT_CONFIG). */
  config?: ConfigOverrides;
  /** Register the safety reflex layer (default true). */
  withReflexes?: boolean;
  /** Register the RECOVER capability (default true). */
  withRecover?: boolean;
  /** Call kernel.init(st) before returning (default true). */
  init?: boolean;
  /** Log sink (default: silent). Pass a recorder to assert on emitted events. */
  sink?: LogSink;
  /** Emit threshold (default "ERR", i.e. effectively silent). Lower it to see DBG/TRC events. */
  logLevel?: Level;
}

export function makeBot(opts: MakeBotOpts = {}): BotHarness {
  const rt = createMockRuntime();
  const kernel = new Kernel(
    rt,
    new Logger(opts.sink ?? silentSink, opts.logLevel ?? "ERR"),
    new Bus(),
    makeGerdaConfig(opts.config ?? {}),
    GERDA_PHASES,
  );
  kernel.register(core);
  if (opts.withReflexes !== false) for (const r of reflexes) kernel.register(r);
  if (opts.withRecover !== false) kernel.register(recover);
  for (const c of opts.caps ?? []) kernel.register(c);
  for (const m of opts.missions ?? []) kernel.registerMission(m);
  const st = makeInitialState();
  if (opts.init !== false) kernel.init(st);
  return { rt, kernel, st };
}

/** Total count of an item id across the mock's inventory slots. */
export function countItem(rt: MockRuntime, id: string): number {
  let n = 0;
  for (const s of rt.state.slots.values()) if (s.id === id) n += s.count;
  return n;
}
