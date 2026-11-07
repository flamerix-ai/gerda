import { KEYS } from "@/core/ipc/ipc";
// Player facet of the jsMacros runtime — position/vitals/rotation sensing + the direct-call
// mutations (respawn/jump/setSprinting). Part of the exempt `src/core/runtime/jsmacros/` globals group.
import { EYE_HEIGHT } from "@/core/prim/movement-physics";
import type { PlayerInput, Runtime } from "@/core/runtime/Runtime";
import type { Fx } from "@/core/runtime/jsmacros/shared";
import { SRG } from "@/core/runtime/jsmacros/srg";
import type { Result, Vec3 } from "@/core/runtime/types";

export function playerFacet(fx: Fx): Runtime["player"] {
  const { attempt } = fx;
  return {
    // EntityHelper.getName() → TextHelper (a jsMacros helper with real method names, no SRG),
    // getString() flattens it to the plain username. Jar-verified against jsmacros 1.9.2.
    name(): Result<string> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        const n = p.getName();
        if (!n) throw new Error("no name");
        return n.getString();
      });
    },
    pos(): Result<Vec3> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        return { x: p.getX(), y: p.getY(), z: p.getZ() };
      });
    },
    health(): Result<number> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        return p.getHealth();
      });
    },
    eyePos(): Result<Vec3> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        return { x: p.getX(), y: p.getY() + EYE_HEIGHT, z: p.getZ() };
      });
    },
    input(): Result<PlayerInput> {
      // Player.getCurrentPlayerInput() exposes movementForward/movementSideways/
      // jumping/sprinting (names vary by mapping).
      return attempt(() => {
        const raw = Player.getCurrentPlayerInput();
        if (!raw) throw new Error("no input");
        const num = (...keys: string[]): number => {
          for (const k of keys) {
            const v = raw[k];
            if (typeof v === "number") return v;
          }
          return 0;
        };
        const bool = (k: string): boolean => raw[k] === true;
        return {
          forward: num("movementForward", "forward"),
          strafe: num("movementSideways", "strafe"),
          jumping: bool("jumping"),
          sprinting: bool("sprinting"),
        };
      });
    },
    // The vitals below are all jsMacros-wrapped helper getters (verified live on
    // ClientPlayerEntityHelper) — no Forge SRG needed.
    air(): Result<number> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        return p.getAir();
      });
    },
    maxAir(): Result<number> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        return p.getMaxAir();
      });
    },
    food(): Result<number> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        return p.getFoodLevel();
      });
    },
    velocity(): Result<Vec3> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        const v = p.getVelocity();
        if (!v) throw new Error("no velocity");
        return { x: v.getX(), y: v.getY(), z: v.getZ() };
      });
    },
    alive(): Result<boolean> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        return p.isAlive();
      });
    },
    canBreatheWater(): Result<boolean> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        return p.canBreatheInWater();
      });
    },
    // Respawn the player. Calls LocalPlayer.respawn() directly (SRG m_7583_, descriptor
    // ()V — sends the PERFORM_RESPAWN client command packet), NOT a death-screen button
    // click: jsMacros' ButtonWidgetHelper.click() respawns from the privileged main/jeval
    // context but NOT from the worker's Service-thread context (verified live — it logged
    // clicked:true every tick yet never respawned), whereas a plain method call on the
    // captured raw player DOES cross threads (same shape as `eat`'s finishUsingItem). The
    // SRG name was looked up from the mojang→SRG mapping (mappings.dev), not guessed
    // in-game (blind method-trial tripped the EventLockWatchdog). Raw vanilla call → render
    // thread, fire-and-forget; the death reflex re-reads player.alive() to confirm.
    // Returns true when the player was dead and a respawn was scheduled; false if alive.
    respawn(): Result<boolean> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        if (p.isAlive()) return false;
        const raw = p.getRaw();
        Client.runOnMainThread(
          JavaWrapper.methodToJava(() => {
            raw[SRG.respawn]();
          }),
        );
        return true;
      });
    },
    onGround(): Result<boolean> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        // Entity.onGround() → SRG m_20096_ (boolean). A pure read on the captured raw
        // object — no main-thread hop needed. Live-verified: reads true while
        // the bot stands on the ground.
        return p.getRaw()[SRG.onGround]() === true;
      });
    },
    yaw(): Result<number> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        return p.getYaw(); // jsMacros PlayerHelper.getYaw() — pure read
      });
    },
    setSprinting(on: boolean): Result<void> {
      return attempt(() => {
        // We do NOT call LivingEntity.setSprinting (SRG m_6858_) here. That mutates the player's
        // speed-attribute MODIFIER MAP (remove+re-add, even for `false`), and this runs on the
        // worker's background Tick thread — while the RENDER thread reads that same map every frame
        // in GameRenderer.getPlayerFov → AttributeInstance.getValue. Two threads on one collection =
        // ConcurrentModificationException → the client is dropped off the server (live,
        // both bots, mid-loot). GraalJS confines a context to its thread, so we can't hop a worker
        // closure onto the main thread either (it kills the worker's Tick listener). So we PUBLISH the desired flag and main.js applies it on
        // the MAIN thread (mc_world_sig bridge in reverse). The caller's edge-trigger keeps writes rare.
        GlobalVars.putString(KEYS.worker.wantSprint, on === true ? "1" : "0");
      });
    },
    jump(): Result<void> {
      return attempt(() => {
        const p = Player.getPlayer();
        if (!p) throw new Error("no player");
        // LivingEntity.jumpFromGround() → SRG m_6135_ — the one-shot upward impulse. The jsMacros
        // key.jump keybind does NOT reliably leave the ground here (verified live: parkour launches
        // stayed at y=101, ground=true — same flaky-keybind class as sprint/sneak), so the executor
        // calls this directly on the launch tick. While sprinting it ALSO applies vanilla's sprint-jump
        // forward boost, which is exactly the extra horizontal reach a dist-4 parkour needs.
        p.getRaw()[SRG.jumpFromGround]();
      });
    },
  };
}
