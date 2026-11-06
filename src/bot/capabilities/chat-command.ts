// chat-command — players drive the bot by typing in Minecraft's in-game chat:
//
//     !<botname|all> <verb> [args…]
//
// The grammar is a pure tokenizer (shared/domain/chat-command); this capability is the impure
// half — identity (which bot am I), the trust gate, and the verb→command mapping. Every verb
// routes through `kernel.command`, the SAME entry point the bridge uses, so a chat `goto` gets
// the existing mission_start validation and error classification rather than a second path.
//
// THREADING — why this is a queue and not a handler. jsMacros fires RecvMessage on its own
// listener thread while Kernel.tick runs on the client tick thread. Starting/aborting a mission
// rewrites the FSM, the handler maps and st.phase, and reading the ack clobbers the single
// lastCommandOutcome slot the bridge reads — doing any of that from the listener thread races a
// tick mid-pass. So `onChat` ONLY pushes onto a queue, and everything else — the drop-oldest
// eviction that bounds it AND the whole parse→identity→trust→dispatch pipeline — runs from the
// always-guard, on the tick thread, serialized with the bridge's own command drain.
//
// TRUST is fail-CLOSED (cfg.chat.trustedPlayers empty = nobody, `"*"` = anyone) and is checked
// AFTER addressing, so an untrusted line aimed at another bot stays silent and a broadcast
// refusal is never spoken — one griefer must not be able to make N bots answer at once.
import { rearmHome, sendHome } from "@/bot/capabilities/home-teleport";
import { STATE } from "@/bot/profile/states";
import { assert, must } from "@/core/prim/invariant";
import {
  CHAT_ADDR_ALL,
  CHAT_COMMAND_PREFIX,
  type ParsedChatCommand,
  parseChatCommand,
} from "@/shared/domain/chat-command";
import type { Capability, ChatEvent, Ctx, Kernel } from "@/shared/kernel/capability";

/** The one `trustedPlayers` entry that opens the capability to everyone — the explicit escape
 *  hatch replacing the old fail-OPEN "empty list means anyone". */
export const CHAT_TRUST_ANY = "*";

export function makeChatCommand(kernel: Kernel): Capability {
  // Heard-but-undrained lines. onChat (jsMacros listener thread) only ever PUSHES; every
  // REMOVAL — the drain and the drop-oldest eviction alike — happens in the guard, on the tick
  // thread. That push-only/remove-only split IS the synchronisation contract: two threads
  // shifting the same array (the obvious place to put drop-oldest) is exactly the tear this
  // capability exists to avoid.
  const queue: ChatEvent[] = [];
  // sender (lowercased) → tick of the last SPOKEN refusal, backing the per-sender debounce.
  const denied = new Map<string, number>();

  return {
    name: "chat-command",
    // Heartbeat: a human must be able to say `!bot_2 mine` to an IDLE bot, and `always` guards
    // are the only ones that run before the not-running short-circuit. Never preempts.
    always: true,

    init(ctx: Ctx): void {
      // Checked once, loudly: a reply prefix that itself began with the command prefix would
      // re-open the bot-to-bot feedback loop this design closes structurally.
      assert(
        !ctx.cfg.chat.replyPrefix.startsWith(CHAT_COMMAND_PREFIX),
        `chat.replyPrefix must not start with "${CHAT_COMMAND_PREFIX}"`,
      );
      // The `home` MACRO is the one line spoken WITHOUT that prefix, so it is the one remaining
      // way to configure a permanent fleet-wide loop (`homeCommand: "!all home"` + open trust).
      // Only the chat-command prefix is banned: `/home base` and Baritone-style `#goto …` are
      // both legal macros, and an empty homeCommand (the neutral default) passes.
      assert(
        !ctx.cfg.homeCommand.startsWith(CHAT_COMMAND_PREFIX),
        `homeCommand must not start with "${CHAT_COMMAND_PREFIX}" (it is spoken unprefixed)`,
      );
    },

    guard(ctx: Ctx): boolean {
      // Eviction lives HERE, not in onChat: removal is tick-thread-only (see the queue comment).
      // A flood between two ticks is trimmed to the newest `queueCapacity` lines before draining.
      while (queue.length > ctx.cfg.chat.queueCapacity) queue.shift();
      // The drain header is a BOUNDED `while (queue.length > 0)`, never `for(;;)`: the deploy
      // bundle validator (scripts/ops/sync.py) rejects unbounded loop headers outright — same
      // precedent as the sift loops in shared/domain/heap.ts. Semantics are IDENTICAL to the
      // for(;;) form because the condition is re-read every iteration: a line the listener thread
      // pushes DURING this drain is still taken in this same tick, and the loop still ends
      // exactly when the queue runs empty.
      while (queue.length > 0) {
        const ev = queue.shift();
        // Control flow over a cross-thread structure, NOT a defensive guard: an empty read simply
        // ends this tick's drain. (`must` here would turn one lost line into a ContractError
        // thrown from a "core"-owned always-guard — i.e. a remotely triggerable worker halt.)
        if (ev === undefined) break;
        // NOT core-owned: untrusted human input that faults is a visible, recoverable
        // mission-level error, not a manufactured CoreFatalError worker.js can only swallow.
        // One bad line also must not abort the drain of the lines behind it. Such a fault lands
        // st.phase in ERROR and the drain CONTINUES — so a mission_start queued behind it clears
        // that ERROR, exactly as the same command from the bridge would. Deliberate.
        kernel.dispatchChatLine(ctx.st, "chat-command", () => handle(kernel, ctx, ev, denied));
      }
      return false; // a heartbeat guard never short-circuits the tick
    },

    onChat(ctx: Ctx, ev: ChatEvent): void {
      // Fail-closed default made literal: with no trusted player configured nothing can ever be
      // dispatched, so a chat flood costs this bot nothing at all.
      if (ctx.cfg.chat.trustedPlayers.length === 0) return;
      queue.push(ev); // push-only — the guard evicts and drains
    },
  };
}

// ── the tick-thread pipeline ───────────────────────────────────────────────────────────────

function handle(kernel: Kernel, ctx: Ctx, ev: ChatEvent, denied: Map<string, number>): void {
  const cmd = parseChatCommand(ev.text);
  if (cmd === null) {
    // Fail-loud on a FORMAT mismatch: a line carrying the command prefix that the sender regex
    // could not split is almost always a server decorating chat differently (nickname plugin,
    // rank prefix). INFO, not TRC — the default minLevel is INFO, and a diagnosis line nobody
    // can see in get_logs is not a diagnosis; throttled so a chatty server can't flood the ring.
    if (ev.text.includes(CHAT_COMMAND_PREFIX)) {
      ctx.log.throttle(ctx.st.tickCount, "INFO", "CHAT_NO_PARSE", { line: ev.text });
    }
    return;
  }

  const selfR = ctx.rt.player.name();
  if (!selfR.ok) {
    // No player entity (death screen, world loading): we can tell neither our own echoed reply
    // from a human's line nor whether `!bot_2` means us. Skipping the line is the only safe
    // reading — admitting `!all` here starts missions on a bot that has no body.
    // INFO for the same reason as CHAT_NO_PARSE: "the bot went deaf" must be visible at the
    // default log level; throttled because a death screen makes this recur every line.
    ctx.log.throttle(ctx.st.tickCount, "INFO", "CHAT_NO_SELF", { error: selfR.error });
    return;
  }
  // Minecraft usernames are unique case-INSENSITIVELY, so both identity comparisons (self-skip
  // and addressing) fold case; only the trust allowlist stays an exact match, because there the
  // conservative direction is to refuse a lookalike rather than admit one.
  const self = selfR.value.toLowerCase();
  if (cmd.sender.toLowerCase() === self) {
    // Logged, not silent: a TOTALLY silent self-skip is indistinguishable live from "onChat was
    // never wired up" — both look like a bot that heard nothing. DBG (not INFO, and not throttled)
    // because a healthy bot echoes every reply back to itself: below the default minLevel it costs
    // nothing, and once `trace` lowers the threshold every skipped echo is exactly what you want
    // to see. Logger has no dbg() shorthand, hence the explicit level.
    ctx.log.log(ctx.st.tickCount, "DBG", "CHAT_SELF", { sender: cmd.sender });
    return; // our own line, echoed back by the server
  }

  // Addressing BEFORE trust: a line aimed at another bot is none of our business, so it must be
  // silent here even from an untrusted sender — otherwise the whole fleet answers one griefer.
  if (!addressesMe(cmd.addr, self)) return;

  if (!isTrusted(ctx, cmd.sender)) {
    denyReply(ctx, cmd, denied);
    return;
  }

  ctx.log.info(ctx.st.tickCount, "CHAT_CMD", {
    sender: cmd.sender,
    verb: cmd.verb,
    args: cmd.args,
  });
  run(kernel, ctx, cmd);
}

function isTrusted(ctx: Ctx, sender: string): boolean {
  const trusted = ctx.cfg.chat.trustedPlayers;
  if (trusted.length === 0) return false; // fail-CLOSED: unconfigured means nobody
  return trusted.includes(CHAT_TRUST_ANY) || trusted.includes(sender);
}

function addressesMe(addr: string, self: string): boolean {
  // Both sides are already lowercased (addr by the parser, self by the caller).
  return addr === CHAT_ADDR_ALL || addr === self;
}

function denyReply(ctx: Ctx, cmd: ParsedChatCommand, denied: Map<string, number>): void {
  // Throttled on the SAME window/key as the spoken refusal below: an unthrottled WARN would let
  // a denied sender flood the journal (and the WARN alert channel) exactly as fast as the
  // debounce stops them flooding chat.
  ctx.log.throttle(
    ctx.st.tickCount,
    "WARN",
    "CHAT_CMD_DENIED",
    { sender: cmd.sender, addr: cmd.addr, verb: cmd.verb },
    ctx.cfg.chat.denyReplyTicks,
    `deny:${cmd.sender.toLowerCase()}`,
  );
  // A BROADCAST refusal is logged but NEVER spoken: `!all <verb>` from an untrusted player would
  // make every bot in the fleet answer, amplifying one line into N. Only a by-name address earns
  // a spoken refusal — there, silence would look like a broken bot.
  if (cmd.addr === CHAT_ADDR_ALL) return;
  const now = ctx.st.tickCount;
  const window = ctx.cfg.chat.denyReplyTicks;
  const key = cmd.sender.toLowerCase();
  const last = denied.get(key);
  if (last !== undefined && now - last < window) return; // debounce: one refusal, not a flood
  for (const [k, t] of denied) if (now - t >= window) denied.delete(k); // keep the map bounded
  denied.set(key, now);
  say(ctx, `${cmd.sender}: not authorized`);
}

/** Speak a REPLY. Every reply carries cfg.chat.replyPrefix, which makes the no-feedback-loop
 *  property structural rather than a convention: a prefixed line can never start with the
 *  command prefix, so no bot (this one included) can re-parse an answer as a fresh command. */
function say(ctx: Ctx, text: string): void {
  ctx.rt.chat.say(ctx.cfg.chat.replyPrefix + text);
}

// A chat argument is HUMAN-typed, so bare Number() is far too generous: it accepts hex (0x10),
// exponentials (3e7), underscores and fractions, each of which reaches mission params as
// something nobody typed. Whole decimal digits with an optional sign, nothing else.
const INTEGER_RE = /^[+-]?\d+$/;

function intArg(raw: string | undefined): number | null {
  if (raw === undefined || !INTEGER_RE.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

function fmt(v: unknown): string {
  if (v === null) return "none";
  if (v === undefined) return "?";
  return String(v);
}

interface CmdResult {
  readonly ok: boolean;
  readonly error: string;
  readonly data: Record<string, unknown>;
}

/** Dispatch through the kernel and read back what ACTUALLY happened, so an ack can be honest.
 *  Reading the shared last-outcome slot is safe here and only here: the drain runs on the tick
 *  thread, serialized with the bridge's own command drain, so the outcome cannot be another
 *  caller's. */
function send(kernel: Kernel, ctx: Ctx, cmd: { type: string; [k: string]: unknown }): CmdResult {
  kernel.command(ctx.st, cmd);
  const o = must(kernel.lastCommandOutcome(), "command() always records an outcome");
  return {
    ok: o.ok,
    error: o.error ?? (o.recognized ? "unknown failure" : `unrecognized command ${o.type}`),
    data: o.data ?? {},
  };
}

/** Reject surplus tokens LOUDLY: obeying `goto 1 2 3 4` as `goto 1 2 3` would run a command
 *  nobody typed. True when the arity is acceptable.
 *
 *  Note the asymmetry with denyReply(): a validation rejection IS spoken for a broadcast, so a
 *  malformed `!all goto 1 2` draws one reply per bot. Accepted — that is a trusted operator
 *  spamming themselves with their own typo, whereas an untrusted DENIAL stays broadcast-silent
 *  precisely because the sender there is hostile and the amplification is the attack. */
function arity(ctx: Ctx, cmd: ParsedChatCommand, max: number): boolean {
  if (cmd.args.length <= max) return true;
  say(
    ctx,
    `${cmd.verb} takes at most ${max} argument${max === 1 ? "" : "s"} (got ${cmd.args.length})`,
  );
  return false;
}

function start(
  kernel: Kernel,
  ctx: Ctx,
  name: string,
  params: Record<string, unknown>,
  ack: string,
): void {
  // Pre-flight the mission name: startMission THROWS on an unknown one, and inside
  // kernel.command that throw is core-owned — a fork shipping without the `follow` mission
  // would turn one chat verb into a fatal. A missing mission is an answer, not a fault.
  if (!kernel.missionNames().includes(name)) {
    say(ctx, `failed: unknown mission ${name}`);
    return;
  }
  const r = send(kernel, ctx, { type: "mission_start", name, params });
  say(ctx, r.ok ? ack : `failed: ${r.error}`);
}

// Split in two only to keep each dispatcher readable (and under the complexity gate): the
// LIFECYCLE verbs drive the bot itself and answer from the command outcome; the MISSION verbs
// validate arguments and hand off to start(). runLifecycle returns false for a verb it doesn't own.
function run(kernel: Kernel, ctx: Ctx, cmd: ParsedChatCommand): void {
  if (runLifecycle(kernel, ctx, cmd)) return;
  runMissionVerb(kernel, ctx, cmd);
}

function runLifecycle(kernel: Kernel, ctx: Ctx, cmd: ParsedChatCommand): boolean {
  switch (cmd.verb) {
    case "status": {
      if (!arity(ctx, cmd, 0)) return true;
      const r = send(kernel, ctx, { type: "mission_status" });
      if (r.ok)
        say(
          ctx,
          `status: mission=${fmt(r.data["active"])} phase=${fmt(r.data["phase"])} running=${fmt(r.data["running"])}`,
        );
      else say(ctx, `failed: ${r.error}`);
      return true;
    }
    case "pause": {
      if (!arity(ctx, cmd, 0)) return true;
      const r = send(kernel, ctx, { type: "pause" });
      // core.pause is a silent no-op unless something is running — don't claim otherwise.
      if (r.ok) say(ctx, ctx.st.phase === STATE.PAUSED ? "paused" : "failed: nothing to pause");
      else say(ctx, `failed: ${r.error}`);
      return true;
    }
    case "resume": {
      if (!arity(ctx, cmd, 0)) return true;
      const wasPaused = ctx.st.phase === STATE.PAUSED;
      const r = send(kernel, ctx, { type: "resume" });
      if (r.ok) say(ctx, wasPaused ? "resumed" : "failed: not paused");
      else say(ctx, `failed: ${r.error}`);
      return true;
    }
    case "stop":
    case "abort": {
      if (!arity(ctx, cmd, 0)) return true;
      const was = kernel.activeMission();
      if (was === null) {
        say(ctx, "failed: no mission running");
        return true;
      }
      const r = send(kernel, ctx, { type: "mission_abort" });
      say(ctx, r.ok ? `stopped ${was}` : `failed: ${r.error}`);
      return true;
    }
    case "home": {
      if (!arity(ctx, cmd, 0)) return true;
      if (ctx.cfg.homeCommand === "") {
        say(ctx, "no home command configured");
        return true;
      }
      // "come home" from a human means STOP FIRST. The two other homeCommand senders (recover,
      // home-return) release the keys and stop the navigator before teleporting; a mission left
      // running would simply drive back out of the base the tick after it lands.
      ctx.rt.keys.releaseAll();
      ctx.rt.nav.stop();
      if (kernel.activeMission() !== null) {
        const r = send(kernel, ctx, { type: "mission_abort" });
        if (!r.ok) {
          say(ctx, `failed: ${r.error}`);
          return true;
        }
      }
      // NOT ctx.transition(STATE.HOME): that edge is legal only from the mine mission's own
      // phases, so an ad-hoc chat `home` would throw everywhere else. Send the same fixed
      // teleport MACRO the HOME leg sends — the mechanism, without the mission choreography.
      // Raw say(): a server command is not a reply and must NOT carry the reply prefix.
      // A player asking for home is the re-arm of a homeCommand the bot gave up on.
      rearmHome(ctx);
      sendHome(ctx);
      return true;
    }
    default:
      return false; // not a lifecycle verb — the mission dispatcher owns it
  }
}

function runMissionVerb(kernel: Kernel, ctx: Ctx, cmd: ParsedChatCommand): void {
  const args = cmd.args;
  switch (cmd.verb) {
    case "mine":
      if (!arity(ctx, cmd, 0)) return;
      start(kernel, ctx, "mine", {}, "on it: mining");
      return;
    case "drill": {
      // The drill mission treats `ore` as optional (absent = any cached vein), so an ore-less
      // `!bot drill` is a legal narrower-scope request, not a grammar error.
      if (!arity(ctx, cmd, 1)) return;
      const ore = args[0];
      start(
        kernel,
        ctx,
        "drill",
        ore === undefined ? {} : { ore },
        `on it: drilling ${ore ?? "any ore"}`,
      );
      return;
    }
    case "chop":
    case "hunt": {
      if (!arity(ctx, cmd, 1)) return;
      const raw = args[0];
      if (raw === undefined) {
        start(kernel, ctx, cmd.verb, {}, `on it: ${cmd.verb}`);
        return;
      }
      const max = ctx.cfg.chat.maxCount;
      const count = intArg(raw);
      if (count === null || count < 1 || count > max) {
        say(ctx, `${cmd.verb} count must be a whole number 1..${max}`);
        return;
      }
      start(kernel, ctx, cmd.verb, { count }, `on it: ${cmd.verb} ${count}`);
      return;
    }
    case "goto":
      runGoto(kernel, ctx, cmd);
      return;
    case "follow": {
      if (!arity(ctx, cmd, 1)) return;
      const target = args[0];
      if (target === undefined) {
        say(ctx, "follow needs a player name");
        return;
      }
      start(kernel, ctx, "follow", { target }, `on it: following ${target}`);
      return;
    }
    default:
      say(ctx, `unknown command: ${cmd.verb}`);
      return;
  }
}

function runGoto(kernel: Kernel, ctx: Ctx, cmd: ParsedChatCommand): void {
  const chat = ctx.cfg.chat;
  const x = intArg(cmd.args[0]);
  const y = intArg(cmd.args[1]);
  const z = intArg(cmd.args[2]);
  if (cmd.args.length !== 3 || x === null || y === null || z === null) {
    say(ctx, "goto needs exactly three whole numbers: goto <x> <y> <z>");
    return;
  }
  // Number.isFinite alone let `goto 3e7 -9999 3e7` reach the navigator as a real target.
  const inBounds =
    Math.abs(x) <= chat.maxCoordXZ &&
    Math.abs(z) <= chat.maxCoordXZ &&
    y >= chat.minCoordY &&
    y <= chat.maxCoordY;
  if (!inBounds) {
    say(
      ctx,
      `goto out of bounds: x/z within ±${chat.maxCoordXZ}, y within ${chat.minCoordY}..${chat.maxCoordY}`,
    );
    return;
  }
  start(kernel, ctx, "goto", { x, y, z }, `on it: goto ${x} ${y} ${z}`);
}
