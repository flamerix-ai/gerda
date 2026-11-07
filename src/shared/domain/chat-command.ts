// chat-command — the in-game chat command GRAMMAR, as a pure tokenizer.
//
//     <PlayerName> !<addr> <verb> [args…]
//
// Vanilla decorates player chat as `<Name> text`; the RecvMessage event carries NO sender
// field (jar-verified: EventRecvMessage has only text/signature/messageType), so the sender
// is recovered from that rendered shape and a line that doesn't match it — a server/system
// broadcast — is simply not a command.
//
// Pure + jsMacros-free (shared/domain convention): the whole grammar is unit-testable, and
// the impure half (identity, trust, verb→mission mapping) lives in the capability. Args stay
// RAW strings — numeric coercion is the dispatcher's job, so this file knows nothing about
// the mission vocabulary.

/** Command prefix — a chat line must start with this (after the sender) to be a command. */
export const CHAT_COMMAND_PREFIX = "!";

/** The broadcast address: every bot that hears it acts on it. */
export const CHAT_ADDR_ALL = "all";

// Vanilla's default chat decoration. `\w+` is exactly the vanilla username charset.
const SENDER_RE = /^<(\w+)> (.*)$/;

export interface ParsedChatCommand {
  /** Bot name this is addressed to, or CHAT_ADDR_ALL. Lowercased. */
  readonly addr: string;
  /** The verb, lowercased. */
  readonly verb: string;
  /** Raw, un-coerced argument tokens. */
  readonly args: readonly string[];
  /** The player who typed it, in the case they typed it (the trust allowlist is case-sensitive). */
  readonly sender: string;
}

/** Flatten a jsMacros RecvMessage event's text at the impurity boundary (Module.onChat).
 *  Structurally typed, so this file still imports nothing from jsMacros and stays testable
 *  against a stub.
 *
 *  getStringStripFormatting, NEVER getString: a server that colours chat renders the line as
 *  `§7<§fAlex§7>§r !all mine`, and those invisible section codes sit exactly where SENDER_RE
 *  expects `<` — the whole capability would go silently inert on such a server. */
export function chatTextOf(ev: {
  text?: { getStringStripFormatting(): string } | null;
}): string {
  return ev.text?.getStringStripFormatting() ?? "";
}

/** Split a rendered chat line into its sender and the message body, or null when the line
 *  isn't player chat at all (system message, server broadcast, malformed). */
export function extractSender(rawLine: string): { sender: string; body: string } | null {
  const m = SENDER_RE.exec(rawLine);
  if (m === null) return null;
  const sender = m[1];
  const body = m[2];
  if (sender === undefined || body === undefined) return null;
  return { sender, body };
}

/** Tokenize a chat line into a command, or null if it isn't one (not player chat / no `!`
 *  prefix / fewer than the two mandatory `<addr> <verb>` tokens). */
export function parseChatCommand(rawLine: string): ParsedChatCommand | null {
  const from = extractSender(rawLine);
  if (from === null) return null;
  const body = from.body.trim();
  // Cheap early exit: ordinary conversation never reaches the tokenizer.
  if (!body.startsWith(CHAT_COMMAND_PREFIX)) return null;
  const tokens = body
    .slice(CHAT_COMMAND_PREFIX.length)
    .split(/\s+/)
    .filter((t) => t !== "");
  const addr = tokens[0];
  const verb = tokens[1];
  if (addr === undefined || verb === undefined) return null;
  return {
    addr: addr.toLowerCase(),
    verb: verb.toLowerCase(),
    args: tokens.slice(2),
    sender: from.sender,
  };
}
