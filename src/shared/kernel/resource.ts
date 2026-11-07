// Declarative resources — the structural fix for "every handler re-derives the same
// preconditions and any one can forget to check". A capability lists the resources it
// `requires`; the kernel resolves each ONCE per tick before dispatching that
// capability and, if any is unavailable, SKIPS the capability that tick (it never runs
// half-ready). Resolved values are injected as a typed `ctx.res(KEY)`.
//
// Two concrete resources exist (deliberately not a general DI container):
//   - PLAYER      → a consistent snapshot {pos, eyePos, health, input}, collapsing the
//                   `const r = rt.player.pos(); if (!r.ok) return` boilerplate.
//   - WORLD_SCOPE → a BRANDED handle obtainable only when the world signature resolves.
//                   `save()` takes the handle, so persisting unscoped won't type-check —
//                   the old, easily-forgotten `ensureScoped()` discipline is deleted.
import type { PlayerInput, Runtime } from "@/core/runtime/Runtime";
import { type Result, type Vec3, err, ok } from "@/core/runtime/types";

interface ResolveEnv {
  readonly rt: Runtime;
}

export interface ResourceKey<T> {
  readonly name: string;
  resolve(env: ResolveEnv): Result<T>;
}

// Every resource name must be unique process-wide (mirrors defineSlice) so two
// resources can't collide in the resolved map.
const registered = new Set<string>();

function defineResource<T>(name: string, resolve: (env: ResolveEnv) => Result<T>): ResourceKey<T> {
  if (registered.has(name)) {
    throw new Error(`resource "${name}" already defined`);
  }
  registered.add(name);
  return { name, resolve };
}

// ── PLAYER ────────────────────────────────────────────────────────────────────
interface PlayerSnapshot {
  readonly pos: Vec3;
  readonly eyePos: Vec3;
  readonly health: number;
  readonly input: PlayerInput;
}

export const PLAYER = defineResource<PlayerSnapshot>("player", ({ rt }) => {
  const pos = rt.player.pos();
  if (!pos.ok) return err(`player.pos: ${pos.error}`);
  const eyePos = rt.player.eyePos();
  if (!eyePos.ok) return err(`player.eyePos: ${eyePos.error}`);
  const health = rt.player.health();
  if (!health.ok) return err(`player.health: ${health.error}`);
  const input = rt.player.input();
  if (!input.ok) return err(`player.input: ${input.error}`);
  return ok({ pos: pos.value, eyePos: eyePos.value, health: health.value, input: input.value });
});

// ── BODY ────────────────────────────────────────────────────────────────────────
// The F1 sensing snapshot — air/food/motion/liveness, resolved once per tick like
// PLAYER. Kept SEPARATE from PLAYER on purpose: these are newer helper getters, and if
// one is unavailable on some setup the body-driven reflexes (air/hunger/death) simply
// skip that tick while the HP-driven PLAYER reflexes (vitals/hazard) keep guarding.
interface BodySnapshot {
  readonly air: number;
  readonly maxAir: number;
  readonly food: number;
  readonly velocity: Vec3;
  readonly alive: boolean;
  readonly canBreatheWater: boolean;
}

export const BODY = defineResource<BodySnapshot>("body", ({ rt }) => {
  const air = rt.player.air();
  if (!air.ok) return err(`player.air: ${air.error}`);
  const maxAir = rt.player.maxAir();
  if (!maxAir.ok) return err(`player.maxAir: ${maxAir.error}`);
  const food = rt.player.food();
  if (!food.ok) return err(`player.food: ${food.error}`);
  const velocity = rt.player.velocity();
  if (!velocity.ok) return err(`player.velocity: ${velocity.error}`);
  const alive = rt.player.alive();
  if (!alive.ok) return err(`player.alive: ${alive.error}`);
  const canBreatheWater = rt.player.canBreatheWater();
  if (!canBreatheWater.ok) return err(`player.canBreatheWater: ${canBreatheWater.error}`);
  return ok({
    air: air.value,
    maxAir: maxAir.value,
    food: food.value,
    velocity: velocity.value,
    alive: alive.value,
    canBreatheWater: canBreatheWater.value,
  });
});

// ── WORLD_SCOPE ─────────────────────────────────────────────────────────────────
// Branded so it can be constructed ONLY here (the unique symbol is module-private).
// Anything that read/write-modifies the world model takes a WorldScope, making
// "persist while the world isn't ready" a compile error rather than a runtime guard.
declare const SCOPE_BRAND: unique symbol;
export interface WorldScope {
  readonly [SCOPE_BRAND]: true;
  readonly sig: string;
}

export const WORLD_SCOPE = defineResource<WorldScope>("worldScope", ({ rt }) => {
  const sig = rt.world.signature();
  if (!sig.ok) return err(`world.signature: ${sig.error}`);
  // reliability-ok: the SINGLE constructor of the WorldScope brand — the resource
  // resolution is the only place a scope handle comes into existence.
  return ok({ sig: sig.value } as WorldScope);
});
