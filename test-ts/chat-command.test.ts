// chat-command — the pure grammar (shared/domain) and the capability that dispatches it.
// Neg-control-first: every accepted shape is paired with a rejected one, so a parser that
// simply said "yes" to everything (or a dispatcher that ignored the trust/addressing gates)
// would fail here rather than silently pass.
//
// The capability half is driven THROUGH A TICK on purpose: onChat only enqueues (it runs on the
// jsMacros listener thread), and the drain+dispatch happens in the always-guard. `hear()` below
// mirrors that seam, so a regression that moved dispatch back onto the listener thread would
// show up as a test that passes without ticking.
import { readFileSync } from "node:fs";
import { CHAT_TRUST_ANY, makeChatCommand } from "@/bot/capabilities/chat-command";
import { HOME_TELEPORT_SLICE } from "@/bot/capabilities/home-teleport";
import { makeMissionControl } from "@/bot/capabilities/mission-control";
import { chopMission } from "@/bot/missions/chop";
import { drillMission } from "@/bot/missions/drill";
import { followMission } from "@/bot/missions/follow";
import { gotoMission } from "@/bot/missions/goto";
import { huntMission } from "@/bot/missions/hunt";
import { mineMission } from "@/bot/missions/mine";
import { makeGerdaConfig } from "@/bot/profile/config";
import type { ConfigOverrides } from "@/shared/config/schema";
import {
  CHAT_ADDR_ALL,
  chatTextOf,
  extractSender,
  parseChatCommand,
} from "@/shared/domain/chat-command";
import type { Capability, ChatEvent } from "@/shared/kernel/capability";
import type { LogRecord } from "@/shared/kernel/logger";
import type { Mission } from "@/shared/kernel/mission";
import { describe, expect, it } from "vitest";
import { type BotHarness, makeBot } from "./harness";

describe("extractSender", () => {
  it("splits vanilla-decorated player chat", () => {
    expect(extractSender("<Alex> hello there")).toEqual({ sender: "Alex", body: "hello there" });
  });

  it("accepts an empty body (the sender is still recoverable)", () => {
    expect(extractSender("<Alex> ")).toEqual({ sender: "Alex", body: "" });
  });

  // NEG-CONTROL: the shapes that must NOT read as player chat.
  it("rejects a system/server line with no <name> decoration", () => {
    expect(extractSender("Alex joined the game")).toBeNull();
    expect(extractSender("[Server] restarting in 5m")).toBeNull();
    expect(extractSender("")).toBeNull();
  });

  it("rejects a malformed decoration (unclosed / missing space / punctuation in the name)", () => {
    expect(extractSender("<Alex hello")).toBeNull();
    expect(extractSender("<Alex>hello")).toBeNull();
    expect(extractSender("<Ni ck> hello")).toBeNull();
  });
});

describe("parseChatCommand — accepted shapes", () => {
  it("parses the minimal <addr> <verb> form", () => {
    expect(parseChatCommand("<Alex> !bot_2 status")).toEqual({
      addr: "bot_2",
      verb: "status",
      args: [],
      sender: "Alex",
    });
  });

  it("parses each verb shape in the vocabulary, keeping args RAW", () => {
    expect(parseChatCommand("<Alex> !all mine")?.args).toEqual([]);
    expect(parseChatCommand("<Alex> !all drill iron")?.args).toEqual(["iron"]);
    expect(parseChatCommand("<Alex> !all chop 12")?.args).toEqual(["12"]);
    expect(parseChatCommand("<Alex> !all hunt 3")?.args).toEqual(["3"]);
    expect(parseChatCommand("<Alex> !all goto 120 70 -40")?.args).toEqual(["120", "70", "-40"]);
    expect(parseChatCommand("<Alex> !all follow bot_3")?.args).toEqual(["bot_3"]);
    expect(parseChatCommand("<Alex> !all home")?.verb).toBe("home");
    expect(parseChatCommand("<Alex> !all stop")?.verb).toBe("stop");
  });

  it("normalizes addr + verb casing but preserves sender + arg casing", () => {
    const p = parseChatCommand("<AlEx> !BOT_2 GoTo 1 2 3");
    expect(p?.addr).toBe("bot_2");
    expect(p?.verb).toBe("goto");
    expect(p?.sender).toBe("AlEx");
    const f = parseChatCommand("<Alex> !all follow BoT_3");
    expect(f?.args).toEqual(["BoT_3"]); // args stay raw — coercion is the dispatcher's job
  });

  it("tolerates surrounding + repeated whitespace", () => {
    expect(parseChatCommand("<Alex> !all   goto   1    2  3  ")).toEqual({
      addr: CHAT_ADDR_ALL,
      verb: "goto",
      args: ["1", "2", "3"],
      sender: "Alex",
    });
  });
});

describe("parseChatCommand — NEG-CONTROL rejections", () => {
  it("rejects ordinary chat with no ! prefix", () => {
    expect(parseChatCommand("<Alex> all status")).toBeNull();
    expect(parseChatCommand("<Alex> hey bot_2 can you mine")).toBeNull();
  });

  it("rejects a system-message-shaped line even when it contains a !command", () => {
    expect(parseChatCommand("[Server] !all mine")).toBeNull();
    expect(parseChatCommand("Alex left the game")).toBeNull();
  });

  it("rejects a command with no addr and/or no verb", () => {
    expect(parseChatCommand("<Alex> !")).toBeNull();
    expect(parseChatCommand("<Alex> !bot_2")).toBeNull();
    expect(parseChatCommand("<Alex> !   ")).toBeNull();
  });

  it("rejects an empty or non-chat line", () => {
    expect(parseChatCommand("")).toBeNull();
    expect(parseChatCommand("!all mine")).toBeNull(); // no sender decoration at all
  });

  // NEG-CONTROL for a future regex relaxation: a sender who TYPES a second decoration must not
  // be able to launder a command through it — the outer <Griefer> is the only sender there is,
  // and the body ("<Alex> !all mine") does not start with the prefix, so nothing is a command.
  it("rejects a spoofed second <name> decoration inside the body", () => {
    const p = parseChatCommand("<Griefer> <Alex> !all mine");
    expect(p).toBeNull();
    expect(extractSender("<Griefer> <Alex> !all mine")?.sender).toBe("Griefer");
  });
});

describe("chatTextOf — the jsMacros impurity boundary", () => {
  // A coloured server renders `<Alex> !all mine` with § codes sitting exactly where the sender
  // regex expects `<`. Stripping at the boundary is the difference between working and inert.
  const coloured = {
    getString: (): string => "§7<§fAlex§7>§r !all mine",
    getStringStripFormatting: (): string => "<Alex> !all mine",
  };

  it("flattens a TextHelper with formatting stripped", () => {
    expect(chatTextOf({ text: coloured })).toBe("<Alex> !all mine");
    expect(parseChatCommand(chatTextOf({ text: coloured }))?.verb).toBe("mine");
  });

  // NEG-CONTROL: the un-stripped rendering is exactly what the grammar cannot read.
  it("the un-stripped form does NOT parse (which is why getString is wrong here)", () => {
    expect(parseChatCommand(coloured.getString())).toBeNull();
  });

  it("a system event with no text flattens to the empty string, not a throw", () => {
    expect(chatTextOf({})).toBe("");
    expect(chatTextOf({ text: null })).toBe("");
  });

  // Drift guard: the entry point must actually route through chatTextOf (the boundary is one
  // line of wiring that a refactor could silently swap back to getString()).
  it("worker-bundle routes Module.onChat through chatTextOf", () => {
    const src = readFileSync("src/bot/entry/worker-bundle.ts", "utf8");
    expect(src).toContain("chatTextOf(ev)");
    expect(src).not.toContain("ev.text?.getString()");
  });
});

// ── the capability ────────────────────────────────────────────────────────────────────────
const MISSIONS = [mineMission, drillMission, chopMission, huntMission, gotoMission, followMission];

interface BotOpts {
  self?: string;
  /** Defaults to the single operator "Alex" — the capability itself now ships fail-CLOSED. */
  trusted?: readonly string[];
  config?: ConfigOverrides;
  missions?: readonly Mission[];
  /** Extra onChat listeners, registered BEFORE chat-command (fan-out ordering tests). */
  caps?: readonly Capability[];
}

/** The harness plus the journal it emitted — the capability's only observable output besides
 *  chat itself (CHAT_SELF is DBG, so the sink runs at "DBG", not the harness default "ERR"). */
interface ChatBot extends BotHarness {
  logs: LogRecord[];
}

function bot(opts: BotOpts = {}): ChatBot {
  const logs: LogRecord[] = [];
  const h = makeBot({
    config: {
      ...(opts.config ?? {}),
      chat: { trustedPlayers: [...(opts.trusted ?? ["Alex"])], ...(opts.config?.chat ?? {}) },
    },
    missions: opts.missions ?? MISSIONS,
    withReflexes: false,
    init: false, // init AFTER the kernel-closing capabilities below are registered
    sink: { emit: (line) => logs.push(JSON.parse(line) as LogRecord) },
    logLevel: "DBG",
  });
  h.rt.state.playerName = opts.self ?? "bot_2";
  for (const c of opts.caps ?? []) h.kernel.register(c);
  h.kernel.register(makeMissionControl(h.kernel));
  h.kernel.register(makeChatCommand(h.kernel));
  h.kernel.init(h.st);
  return { ...h, logs };
}

const evs = (logs: readonly LogRecord[], name: string): readonly LogRecord[] =>
  logs.filter((l) => l.event === name);

/** Newest chat line the bot said (lib is ES2020 — no Array.prototype.at). */
function last(lines: readonly string[]): string | null {
  return lines.length === 0 ? null : (lines[lines.length - 1] ?? null);
}

const PREFIX = makeGerdaConfig({}).chat.replyPrefix;

/** Strip the reply prefix so assertions read like the spoken text. */
function reply(lines: readonly string[]): string | null {
  const l = last(lines);
  return l === null ? null : l.replace(PREFIX, "");
}

/** Hear a line the way the game delivers it: enqueue off-thread, drain on the NEXT tick. */
function hear(h: BotHarness, line: string): void {
  const ev: ChatEvent = { text: line };
  h.kernel.dispatchChat(h.st, ev);
  h.kernel.tick(h.st);
}

describe("chat-command capability — dispatch", () => {
  it("starts the addressed mission and confirms without a ! prefix", () => {
    const h = bot();
    hear(h, "<Alex> !bot_2 mine");
    expect(h.kernel.activeMission()).toBe("mine");
    expect(reply(h.rt.state.chat)).toBe("on it: mining");
    expect(h.rt.state.chat.every((l) => !l.startsWith("!"))).toBe(true);
  });

  it("accepts the `all` broadcast address, in any casing", () => {
    const h = bot();
    hear(h, "<Alex> !ALL mine");
    expect(h.kernel.activeMission()).toBe("mine");
  });

  it("matches its own name case-insensitively", () => {
    const h = bot({ self: "Bot_2" });
    hear(h, "<Alex> !BOT_2 mine");
    expect(h.kernel.activeMission()).toBe("mine");
  });

  // NEG-CONTROL: a message for another bot must be inert on this one.
  it("ignores a command addressed to a DIFFERENT bot", () => {
    const h = bot({ self: "bot_2" });
    hear(h, "<Alex> !bot_3 mine");
    expect(h.kernel.activeMission()).toBeNull();
    expect(h.rt.state.chat).toEqual([]);
  });

  // NEG-CONTROL: the bot must not act on (or answer) its own chat output — case-INSENSITIVELY,
  // because Minecraft usernames are unique regardless of case.
  it("skips a line it sent itself, whatever the case", () => {
    const h = bot({ self: "bot_2", trusted: [CHAT_TRUST_ANY] });
    hear(h, "<bot_2> !all mine");
    hear(h, "<BOT_2> !all mine");
    expect(h.kernel.activeMission()).toBeNull();
    expect(h.rt.state.chat).toEqual([]);
  });

  // …and that skip must be OBSERVABLE. Totally silent, "self-skip works" and "onChat was never
  // wired up" look identical live — both are a bot that answers nothing.
  it("logs CHAT_SELF (DBG) when it skips its own echoed line", () => {
    const h = bot({ self: "bot_2", trusted: [CHAT_TRUST_ANY] });
    hear(h, "<bot_2> !all mine");
    const self = evs(h.logs, "CHAT_SELF");
    expect(self.length).toBe(1);
    expect(self[0]?.level).toBe("DBG"); // below the default minLevel: free unless tracing
    expect(self[0]?.fields).toMatchObject({ sender: "bot_2" });
    expect(h.kernel.activeMission()).toBeNull();
  });

  // NEG-CONTROL: everything that is NOT our own echo must leave the marker absent — dispatched,
  // addressed elsewhere and refused lines alike. A CHAT_SELF that fired for any of these would
  // make the debug signal useless.
  it("logs NO CHAT_SELF for a line from anyone else", () => {
    const h = bot({ self: "bot_2", trusted: ["Alex"] });
    hear(h, "<Alex> !bot_2 mine"); // dispatched
    hear(h, "<Alex> !bot_3 mine"); // another bot's business
    hear(h, "<Griefer> !bot_2 mine"); // refused
    expect(evs(h.logs, "CHAT_SELF")).toEqual([]);
    expect(evs(h.logs, "CHAT_CMD").length).toBe(1); // control: the journal WAS being recorded
  });

  it("ignores plain conversation entirely", () => {
    const h = bot();
    hear(h, "<Alex> bot_2 please mine some iron");
    hear(h, "[Server] !all mine");
    expect(h.kernel.activeMission()).toBeNull();
    expect(h.rt.state.chat).toEqual([]);
  });

  it("passes mission params through: drill ore, chop/hunt count, goto xyz, follow target", () => {
    const drill = bot();
    hear(drill, "<Alex> !all drill iron");
    expect(drill.kernel.activeMission()).toBe("drill");

    const chop = bot();
    hear(chop, "<Alex> !all chop 12");
    expect(chop.kernel.activeMission()).toBe("chop");
    expect(reply(chop.rt.state.chat)).toBe("on it: chop 12");

    const hunt = bot();
    hear(hunt, "<Alex> !all hunt 3");
    expect(hunt.kernel.activeMission()).toBe("hunt");

    // goto is asserted on its ACK, not on activeMission: on the mock the mission reaches its
    // goal within the same tick and the sequencer collapses it back to IDLE.
    const go = bot();
    hear(go, "<Alex> !all goto 120 70 -40");
    expect(reply(go.rt.state.chat)).toBe("on it: goto 120 70 -40");

    const fol = bot();
    hear(fol, "<Alex> !all follow bot_3");
    expect(fol.kernel.activeMission()).toBe("follow");
  });

  it("answers an unknown verb instead of throwing", () => {
    const h = bot();
    expect(() => hear(h, "<Alex> !all frobnicate")).not.toThrow();
    expect(reply(h.rt.state.chat)).toBe("unknown command: frobnicate");
    expect(h.kernel.activeMission()).toBeNull();
  });

  it("a trusted player whose NAME is a verb is still just a sender", () => {
    const h = bot({ trusted: ["mine"] });
    hear(h, "<mine> !all status");
    expect(reply(h.rt.state.chat)).toContain("status: mission=none");
    expect(h.kernel.activeMission()).toBeNull();
  });
});

describe("chat-command capability — argument validation", () => {
  // NEG-CONTROL: user-typed garbage must fail into a REPLY, never a throw or a bad mission.
  it("rejects non-numeric / missing / surplus goto coords gracefully", () => {
    const h = bot();
    hear(h, "<Alex> !all goto here now please");
    expect(reply(h.rt.state.chat)).toContain("goto needs exactly three whole numbers");

    hear(h, "<Alex> !all goto 1 2");
    expect(reply(h.rt.state.chat)).toContain("goto needs exactly three whole numbers");

    // Surplus args are REJECTED, not silently dropped down to the first three.
    hear(h, "<Alex> !all goto 1 2 3 4");
    expect(reply(h.rt.state.chat)).toContain("goto needs exactly three whole numbers");
    expect(h.kernel.activeMission()).toBeNull();
  });

  it("rejects non-decimal-integer coords (hex, exponential, fractional)", () => {
    const h = bot();
    for (const line of ["!all goto 0x10 70 0", "!all goto 3e7 70 0", "!all goto 1.5 70 0"]) {
      hear(h, `<Alex> ${line}`);
      expect(reply(h.rt.state.chat)).toContain("goto needs exactly three whole numbers");
    }
    expect(h.kernel.activeMission()).toBeNull();
  });

  it("rejects out-of-world goto coordinates with the violated bound", () => {
    const h = bot();
    hear(h, "<Alex> !all goto 30000001 70 0");
    expect(reply(h.rt.state.chat)).toContain("goto out of bounds");
    hear(h, "<Alex> !all goto 0 -9999 0");
    expect(reply(h.rt.state.chat)).toContain("goto out of bounds");
    hear(h, "<Alex> !all goto 0 400 0");
    expect(reply(h.rt.state.chat)).toContain("goto out of bounds");
    expect(h.kernel.activeMission()).toBeNull();
  });

  // POSITIVE control for the bound: the extremes INSIDE it are accepted.
  it("accepts coordinates at the edge of the configured bounds", () => {
    const h = bot();
    hear(h, "<Alex> !all goto -30000000 -64 30000000");
    expect(reply(h.rt.state.chat)).toBe("on it: goto -30000000 -64 30000000");
  });

  it("rejects a non-numeric, negative, fractional or oversized chop/hunt count", () => {
    for (const arg of ["lots", "-5", "0", "0.5", "0x10", "99999"]) {
      const h = bot();
      hear(h, `<Alex> !all chop ${arg}`);
      expect(reply(h.rt.state.chat)).toBe("chop count must be a whole number 1..512");
      expect(h.kernel.activeMission()).toBeNull();
    }
  });

  it("rejects surplus args on a count/target verb", () => {
    const h = bot();
    hear(h, "<Alex> !all chop 3 4");
    expect(reply(h.rt.state.chat)).toContain("chop takes at most 1 argument");
    hear(h, "<Alex> !all status now");
    expect(reply(h.rt.state.chat)).toContain("status takes at most 0 arguments");
    expect(h.kernel.activeMission()).toBeNull();
  });

  it("rejects a follow with no target gracefully", () => {
    const h = bot();
    hear(h, "<Alex> !all follow");
    expect(reply(h.rt.state.chat)).toBe("follow needs a player name");
    expect(h.kernel.activeMission()).toBeNull();
  });
});

describe("chat-command capability — honest acks", () => {
  it("stop reports the mission it ended", () => {
    const h = bot();
    hear(h, "<Alex> !all mine");
    hear(h, "<Alex> !all status");
    expect(reply(h.rt.state.chat)).toContain("mission=mine");
    hear(h, "<Alex> !all stop");
    expect(h.kernel.activeMission()).toBeNull();
    expect(reply(h.rt.state.chat)).toBe("stopped mine");
  });

  // NEG-CONTROL: the ack must reflect the NO-OP, not parrot success.
  it("stop with nothing running answers failed, not `stopped`", () => {
    const h = bot();
    hear(h, "<Alex> !all stop");
    expect(reply(h.rt.state.chat)).toBe("failed: no mission running");
  });

  it("pause/resume report what actually happened", () => {
    const h = bot();
    hear(h, "<Alex> !all pause"); // nothing running
    expect(reply(h.rt.state.chat)).toBe("failed: nothing to pause");
    hear(h, "<Alex> !all resume"); // not paused
    expect(reply(h.rt.state.chat)).toBe("failed: not paused");

    hear(h, "<Alex> !all mine");
    hear(h, "<Alex> !all pause");
    expect(reply(h.rt.state.chat)).toBe("paused");
    hear(h, "<Alex> !all resume");
    expect(reply(h.rt.state.chat)).toBe("resumed");
  });

  // The defect this replaces: mission_start for a mission the fork never registered threw a
  // CORE fatal out of the chat path. It must be an answer, and the kernel must keep working.
  it("an unregistered mission answers `failed:` and does NOT wedge the kernel", () => {
    const h = bot({ missions: [] });
    expect(() => hear(h, "<Alex> !all mine")).not.toThrow();
    expect(reply(h.rt.state.chat)).toBe("failed: unknown mission mine");
    expect(h.st.phase).not.toBe("ERROR");
    hear(h, "<Alex> !all status"); // still answering
    expect(reply(h.rt.state.chat)).toContain("status: mission=none");
  });
});

describe("chat-command capability — home", () => {
  it("home stops the body and the mission, then sends the teleport macro", () => {
    const h = bot();
    hear(h, "<Alex> !all mine");
    h.rt.state.keys["key.forward"] = true;
    hear(h, "<Alex> !all home");
    // "come home" means stop: keys released, navigator stopped, mission aborted — otherwise the
    // mission keeps driving from wherever the teleport dropped the bot.
    expect(h.rt.state.keys["key.forward"]).toBe(false);
    expect(h.kernel.activeMission()).toBeNull();
    // The macro is the LAST thing said, verbatim and unprefixed (it is a server command).
    expect(last(h.rt.state.chat)).toBe(makeGerdaConfig({}).homeCommand);
    // The abort lands in IDLE — never in STATE.HOME, whose edge is mine-mission-only.
    expect(h.st.phase).toBe("IDLE");
  });

  // A player asking for home is the re-arm of a /home the bot gave up on (HOME_COMMAND_DISABLED).
  it("home re-arms a disabled home command and sends it", () => {
    const h = bot();
    const mem = HOME_TELEPORT_SLICE.init();
    mem.disabled = true;
    mem.disabledAt = h.st.tickCount;
    mem.noEffect = makeGerdaConfig({}).safety.homeNoEffectLimit;
    h.st.bb[HOME_TELEPORT_SLICE.name] = mem;
    hear(h, "<Alex> !all home");
    expect(last(h.rt.state.chat)).toBe(makeGerdaConfig({}).homeCommand);
    expect(mem.disabled).toBe(false);
    expect(mem.noEffect).toBe(0);
  });

  // NEG-CONTROL: a fork with no teleport macro says so instead of saying an empty line.
  it("answers when no home command is configured", () => {
    const h = bot({ config: { homeCommand: "" } });
    hear(h, "<Alex> !all home");
    expect(reply(h.rt.state.chat)).toBe("no home command configured");
  });
});

describe("chat-command capability — trust gate (fail-CLOSED)", () => {
  // NEG-CONTROL for the inverted polarity: the SHIPPED default must drive nothing.
  it("an empty allowlist admits NOBODY and stays completely silent", () => {
    const h = bot({ trusted: [] });
    hear(h, "<Alex> !bot_2 mine");
    hear(h, "<Alex> !all mine");
    expect(h.kernel.activeMission()).toBeNull();
    expect(h.rt.state.chat).toEqual([]);
  });

  it("the explicit `*` entry opens it to anyone", () => {
    const h = bot({ trusted: [CHAT_TRUST_ANY] });
    hear(h, "<Randomer> !all mine");
    expect(h.kernel.activeMission()).toBe("mine");
  });

  it("a listed player is admitted", () => {
    const h = bot({ trusted: ["Alex"] });
    hear(h, "<Alex> !all mine");
    expect(h.kernel.activeMission()).toBe("mine");
  });

  it("an unlisted player addressing this bot BY NAME is refused (and told so)", () => {
    const h = bot({ trusted: ["Alex"] });
    hear(h, "<Griefer> !bot_2 mine");
    expect(h.kernel.activeMission()).toBeNull();
    expect(reply(h.rt.state.chat)).toBe("Griefer: not authorized");
  });

  // The fleet-amplification guard: N bots must not each answer one broadcast.
  it("an unlisted player's BROADCAST is refused SILENTLY (logged, never spoken)", () => {
    const h = bot({ trusted: ["Alex"] });
    hear(h, "<Griefer> !all mine");
    expect(h.kernel.activeMission()).toBeNull();
    expect(h.rt.state.chat).toEqual([]);
  });

  // …and a line for a DIFFERENT bot is not ours to refuse at all.
  it("an unlisted player addressing ANOTHER bot is fully silent", () => {
    const h = bot({ trusted: ["Alex"], self: "bot_2" });
    hear(h, "<Griefer> !bot_3 mine");
    expect(h.kernel.activeMission()).toBeNull();
    expect(h.rt.state.chat).toEqual([]);
  });

  it("repeated refusals to the same sender are debounced to one per window", () => {
    const h = bot({ trusted: ["Alex"], config: { chat: { denyReplyTicks: 20 } } });
    hear(h, "<Griefer> !bot_2 mine");
    hear(h, "<Griefer> !bot_2 mine");
    hear(h, "<Griefer> !bot_2 stop");
    expect(h.rt.state.chat).toEqual([`${PREFIX}Griefer: not authorized`]);
    // POSITIVE control: past the window the bot answers again (the debounce is not a mute).
    for (let i = 0; i < 21; i++) h.kernel.tick(h.st);
    hear(h, "<Griefer> !bot_2 mine");
    expect(h.rt.state.chat.length).toBe(2);
  });

  it("the allowlist is case-SENSITIVE (a lookalike name is refused, never admitted)", () => {
    const h = bot({ trusted: ["Alex"] });
    hear(h, "<alex> !bot_2 mine");
    expect(h.kernel.activeMission()).toBeNull();
    expect(reply(h.rt.state.chat)).toBe("alex: not authorized");
  });
});

describe("chat-command capability — init invariants", () => {
  // The `home` macro is the ONE line spoken unprefixed, so it is the last way to configure a
  // permanent fleet-wide feedback loop. Caught at boot, not at the first `!all home`.
  it("refuses a homeCommand that is itself a chat command", () => {
    expect(() => bot({ config: { homeCommand: "!all home" } })).toThrowError(/homeCommand/);
  });

  // POSITIVE control: the legal macro shapes must all still boot — the invariant is ONLY about
  // the `!` prefix (a Baritone `#goto` home macro is documented and legal).
  it("accepts the legal macro shapes (slash, Baritone hash, unset)", () => {
    for (const homeCommand of ["/home base", "#goto 0 64 0", ""]) {
      expect(() => bot({ config: { homeCommand } })).not.toThrow();
    }
  });

  it("refuses a replyPrefix that would let a reply re-parse as a command", () => {
    expect(() => bot({ config: { chat: { replyPrefix: "!" } } })).toThrowError(/replyPrefix/);
  });
});

describe("chat-command capability — isolation & threading", () => {
  // The whole point of routing onChat through the kernel's dispatch boundary — and of owning it
  // as `chat:`, not `core`: the fault must be RECOVERABLE and must not blind later listeners.
  it("a throwing listener neither escapes nor stops the fan-out to the next one", () => {
    const seen: string[] = [];
    const boom: Capability = {
      name: "chat-boom",
      onChat(): void {
        throw new Error("boom");
      },
    };
    const recorder: Capability = {
      name: "chat-recorder",
      onChat(_c, ev): void {
        seen.push(ev.text);
      },
    };
    const h = bot({ caps: [boom, recorder] });
    expect(() => h.kernel.dispatchChat(h.st, { text: "<Alex> !all mine" })).not.toThrow();
    expect(seen).toEqual(["<Alex> !all mine"]); // registered AFTER the thrower — still heard it
    expect(h.st.phase).toBe("ERROR"); // classified as a recoverable chat fault, not a core fatal
  });

  // F9: with no player entity the bot cannot tell its own echo from a human, nor whether it is
  // addressed — `!all` must NOT sneak through that hole.
  it("a chat line with no player in the world is inert, not a crash", () => {
    const h = bot();
    h.rt.state.playerPresent = false;
    expect(() => hear(h, "<Alex> !bot_2 mine")).not.toThrow();
    expect(() => hear(h, "<Alex> !all mine")).not.toThrow();
    expect(h.kernel.activeMission()).toBeNull();
    expect(h.rt.state.chat).toEqual([]);
  });

  it("nothing is dispatched until a tick drains the queue (dispatch is tick-thread work)", () => {
    const h = bot();
    h.kernel.dispatchChat(h.st, { text: "<Alex> !all mine" });
    expect(h.kernel.activeMission()).toBeNull(); // enqueued only
    h.kernel.tick(h.st);
    expect(h.kernel.activeMission()).toBe("mine");
  });

  // Draining is remove-only on the tick thread; an empty read must simply END the drain. If it
  // were a `must`/assert instead, a lost line would throw from a CORE-owned always-guard and
  // fatal-unload the whole worker — remotely triggerable by chat.
  it("draining an empty queue is a no-op, never a throw", () => {
    const h = bot();
    expect(() => h.kernel.tick(h.st)).not.toThrow(); // nothing ever queued
    h.kernel.dispatchChat(h.st, { text: "<Alex> !all frobnicate" });
    h.kernel.tick(h.st);
    const after = [...h.rt.state.chat];
    expect(() => {
      h.kernel.tick(h.st);
      h.kernel.tick(h.st);
    }).not.toThrow();
    expect(h.rt.state.chat).toEqual(after); // drained once, never re-dispatched
    expect(h.st.phase).not.toBe("ERROR"); // and never classified as a fault
  });

  // Eviction is tick-thread work too (onChat is push-only), so the bound is enforced at DRAIN.
  it("a chat flood is bounded: the queue drops the OLDEST lines, never grows", () => {
    const h = bot({ config: { chat: { queueCapacity: 3 } } });
    for (let i = 0; i < 8; i++) h.kernel.dispatchChat(h.st, { text: `<Alex> !all frob${i}` });
    h.kernel.tick(h.st);
    expect(h.rt.state.chat.map((l) => l.replace(PREFIX, ""))).toEqual([
      "unknown command: frob5",
      "unknown command: frob6",
      "unknown command: frob7",
    ]);
  });

  // F3, property-style: NOTHING the capability speaks may re-parse as a command, or a fleet
  // sharing one chat would feed on its own replies.
  it("no reply the capability can emit re-parses as a chat command", () => {
    const h = bot({ trusted: [CHAT_TRUST_ANY] });
    const lines = [
      "!all mine",
      "!all status",
      "!all stop",
      "!all pause",
      "!all resume",
      "!all home",
      "!all frobnicate",
      "!all goto 1 2",
      "!all goto 0x10 70 0",
      "!all goto 30000001 70 0",
      "!all chop -5",
      "!all chop 3 4",
      "!all follow",
      "!bot_2 mine",
    ];
    for (const l of lines) hear(h, `<Alex> ${l}`);
    hear(h, "<Griefer> !bot_2 mine"); // …including the refusal
    expect(h.rt.state.chat.length).toBeGreaterThan(5);
    for (const spoken of h.rt.state.chat) {
      expect(parseChatCommand(`<bot_2> ${spoken}`)).toBeNull();
      expect(spoken.startsWith("!")).toBe(false);
    }
  });
});
