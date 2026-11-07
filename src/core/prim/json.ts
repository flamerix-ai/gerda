// The ONE JSON.parse in src/. Parsing untrusted disk bytes is an external-failure
// boundary (the file may be truncated, half-written, or hand-edited), exactly the
// kind of throw the facade's `attempt` wraps for FFI — so it lives behind a Result
// here and is whitelisted in the defensive checker. Callers MUST branch on `.ok`;
// nobody else in src/ may call JSON.parse or catch its throw.
//
// Top-level leaf: depends only on runtime/types, so domain AND kernel may import it
// without creating a layering cycle.
import { type Result, err, ok } from "@/core/runtime/types";

export function decodeJson(raw: string): Result<unknown> {
  try {
    return ok(JSON.parse(raw));
  } catch (e) {
    return err(`json parse: ${String(e)}`);
  }
}
