// Dispatch routing SSOT — the pure decision the plain-JS supervisor (harness/main.js
// `dispatch()`) makes for every inbound bridge command: does this command type belong to a
// hardcoded container HANDLER, a hot-reloadable ext.js plugin (EXT), or neither (fall through
// to the worker bundle over GlobalVars)? The DECISION is pure data — given a type and which
// registries own it, where does it route. The actual invocation (calling the handler, writing
// the worker GlobalVar) stays in JS where the Java/jsMacros globals live.
//
// MIRROR: harness/safe-io.js publishes the byte-identical JS twin (`__MC_HARNESS.route`);
// test-ts/harness-contract.test.ts eval-loads it and asserts parity, so the two can't drift.

export type DispatchRoute = "handler" | "ext" | "passthrough";

/** Resolve where a command of `type` routes, given whether the HANDLERS and EXT registries own
 *  it. HANDLERS wins over EXT (a container primitive shadows an ext plugin of the same name);
 *  neither → passthrough to the worker. A falsy/empty `type` also falls through (the old code's
 *  `req.type && …` guard). Behaviour-identical to main.js's if/else-if ladder. */
export function routeDispatch(
  type: string | undefined,
  hasHandler: boolean,
  hasExt: boolean,
): DispatchRoute {
  if (type && hasHandler) return "handler";
  if (type && hasExt) return "ext";
  return "passthrough";
}
