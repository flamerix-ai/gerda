// "Hands" facet of the jsMacros runtime — the mutation slices that act on the world through the
// interaction manager + held keys: mine (break), interact (place/use/attack/eat/rotate/craft), inv
// (open container), keys + nav (held-key press/release, shared movement-held tracking). Grouped
// because keys+nav close over the same `heldMovement` set the stuck reflex reads. Part of the
// exempt `src/core/runtime/jsmacros/` globals group.
import type { BreakResult, Container, ItemStack, Runtime } from "@/core/runtime/Runtime";
import { craftGridSlots, craftOutSlot } from "@/core/runtime/craft-regions";
import { FACE_TO_DIR, type Fx, stackOf } from "@/core/runtime/jsmacros/shared";
import { SRG } from "@/core/runtime/jsmacros/srg";
import type { Face, Result, Vec3 } from "@/core/runtime/types";

// Bind the shared region resolver (craft-regions.ts) to a live InventoryHelper. The
// resolution (player 2×2 "crafting_in"/"craft_out" → table 3×3 "input"/"output" fallback)
// is shared with the mock so it can't drift, and unit-tested there.
const gridSlotsOf = (inv: InventoryHelper): number[] => craftGridSlots((r) => inv.getSlots(r));
const outSlotOf = (inv: InventoryHelper): number | undefined =>
  craftOutSlot((r) => inv.getSlots(r));

// All the horizontal-movement keys released together, plus the action keys — a reflex divert
// and nav.stop both release this whole set.
const RELEASE_KEYS = [
  "key.attack",
  "key.use",
  "key.drop",
  "key.forward",
  "key.back",
  "key.left",
  "key.right",
  "key.jump",
  "key.sprint",
  "key.sneak",
];

export function handsFacet(fx: Fx): Pick<Runtime, "mine" | "interact" | "inv" | "keys" | "nav"> {
  const { attempt, fx: fxDo, readOr } = fx;

  // Currently-held BOT-driven body keys. Two readings over one set (see Runtime.keys):
  //   movementHeld() = a horizontal key is held ("trying to walk") — the stuck reflex;
  //   driveHeld()    = any drive key (horizontal + jump + sprint) is held — the human reflex,
  //                    because jump/sprint alone still show up in player.input() and would
  //                    otherwise be misread as a human takeover.
  const HORIZONTAL_KEYS = new Set(["key.forward", "key.back", "key.left", "key.right"]);
  const DRIVE_KEYS = new Set([...HORIZONTAL_KEYS, "key.jump", "key.sprint"]);
  const heldDrive = new Set<string>();

  function wrapContainer(inv: InventoryHelper): Container {
    return {
      regions: () => readOr("regions", () => inv.getMap().keySet().toArray(), []),
      // jsMacros' getSlots() with NO args returns EMPTY (not "all"), which silently broke
      // every caller that means "my carry inventory" (equip/dump/tool/guards). Normalize
      // no-arg to main+hotbar here so the facade contract matches the mock and intent.
      slots: (...regions) =>
        readOr(
          "slots",
          () => inv.getSlots(...(regions.length > 0 ? regions : ["main", "hotbar"])),
          [],
        ),
      totalSlots: () => readOr("totalSlots", () => inv.getTotalSlots(), 0),
      slot: (index) => readOr("slot", () => stackOf(inv.getSlot(index)), null),
      selectedHotbar: () => readOr("selectedHotbar", () => inv.getSelectedHotbarSlotIndex(), 0),
      selectHotbar: (index) => fxDo("selectHotbar", () => inv.setSelectedHotbarSlotIndex(index)),
      quick: (index) => fxDo("quick", () => void inv.quick(index)),
      swap: (a, b) => fxDo("swap", () => void inv.swap(a, b)),
      dropSlot: (index) => fxDo("dropSlot", () => void inv.dropSlot(index)),
    };
  }

  return {
    mine: {
      setTarget(p: Vec3, face: Face): void {
        fxDo("setTarget", () =>
          Player.getInteractionManager().setTarget(p.x, p.y, p.z, FACE_TO_DIR[face]),
        );
      },
      breakAsync(p: Vec3, onDone: (r: BreakResult) => void): void {
        fxDo("breakAsync", () => {
          // SYNC break by coordinates, NOT breakBlockAsync. The async breaker is a silent no-op when
          // issued from the worker Service thread (callback never fires, block never breaks — live-
          // diagnosed: identical breakBlockAsync works from the render thread / a fresh
          // Thread but not the worker loop), the same render-thread affinity that makes synthetic
          // input flaky. InteractionManager.breakBlock(x,y,z) targets the cell directly and DOES work
          // from the worker (like interactBlock, which drives pillar/bridge placement fine) — one call
          // breaks a normal block. onDone is a HINT only (break-cell treats the world read as truth),
          // called inline (a worker closure on the worker thread — no cross-thread runOnMainThread).
          Player.getInteractionManager().breakBlock(p.x, p.y, p.z);
          onDone({ broken: true });
        });
      },
      cancel(): void {
        fxDo("cancel", () => Player.getInteractionManager().cancelBreakBlock());
      },
    },

    interact: {
      placeBlock(against: Vec3, face: Face): Result<void> {
        // Placing in MC = right-clicking a block face with a block held → the block lands
        // on that face. interactBlock is the jsMacros-wrapped path (no Forge SRG needed).
        return attempt(() => {
          Player.getInteractionManager().interactBlock(
            against.x,
            against.y,
            against.z,
            FACE_TO_DIR[face],
            false,
          );
        });
      },
      useOnBlock(p: Vec3, face: Face): Result<void> {
        return attempt(() => {
          Player.getInteractionManager().interactBlock(p.x, p.y, p.z, FACE_TO_DIR[face], false);
        });
      },
      useItem(): Result<void> {
        return attempt(() => {
          Player.getInteractionManager().interactItem(false);
        });
      },
      useOnEntity(uuid: string): Result<void> {
        // Right-click the entity with this uuid with the held item (put into an item frame /
        // use on an armor stand). Same resolve-by-uuid pattern as attack() below — a no-arg
        // interact() depends on the render-thread crosshair hitResult (null on the worker), but
        // interactEntity(entity, offhand=false) sends the server-validated interaction packet
        // directly (jar-confirmed 1.9.2 signature: interactEntity(EntityHelper<?>, boolean)).
        // err if the uuid is gone (frame broken/despawned).
        return attempt(() => {
          const ents = World.getEntities();
          for (let i = 0; i < ents.size(); i++) {
            const e = ents.get(i);
            if (e?.getUUID() === uuid) {
              Player.getInteractionManager().interactEntity(e, false);
              return;
            }
          }
          throw new Error(`entity ${uuid} not found`);
        });
      },
      attack(uuid: string): Result<void> {
        // Melee-attack the entity with this uuid. We resolve the live EntityHelper by scanning
        // World.getEntities() for a matching getUUID(), then call attack(entity) — the overload
        // that lands a hit. The no-arg attack() relies on the render-thread crosshair hitResult
        // (null on the worker → swings but never connects, verified live). attack(entity) sends a
        // server-validated attack packet (range-checked server-side), which DOES work from the
        // worker like interactBlock/breakBlock. err if the uuid is gone (already dead/despawned).
        return attempt(() => {
          const ents = World.getEntities();
          for (let i = 0; i < ents.size(); i++) {
            const e = ents.get(i);
            if (e?.getUUID() === uuid) {
              Player.getInteractionManager().attack(e);
              return;
            }
          }
          throw new Error(`entity ${uuid} not found`);
        });
      },
      eat(): Result<void> {
        // Eat by calling the held ItemStack's finishUsingItem(Level, LivingEntity) directly
        // — exactly what completeUsingItem() invokes: applies nutrition + shrinks the stack
        // for an edible item, no-op otherwise. We DON'T simulate a held key.use: jsMacros
        // re-asserts held keys every tick, so startUsingItem keeps resetting useItemRemaining
        // to 32 and the use never completes (verified live). Raw vanilla call →
        // must run on the render thread (the worker ticks on a Service thread), fire-and-forget
        // like closeScreen; the closure touches only Java objects so it's thread-safe. SRG:
        // m_21205_=getMainHandItem, m_9236_=level, m_41671_=ItemStack.finishUsingItem.
        return attempt(() => {
          const p = Player.getPlayer();
          if (!p) throw new Error("no player");
          const raw = p.getRaw();
          Client.runOnMainThread(
            JavaWrapper.methodToJava(() => {
              const stack = raw[SRG.getMainHandItem](); // getMainHandItem → ItemStack
              if (stack) stack[SRG.finishUsingItem](raw[SRG.entityLevel](), raw); // ItemStack.finishUsingItem(Level, LivingEntity)
            }),
          );
        });
      },
      lookAt(p: Vec3): Result<void> {
        return attempt(() => {
          const pl = Player.getPlayer();
          if (!pl) throw new Error("no player");
          pl.lookAt(p.x, p.y, p.z);
        });
      },
      setRotation(yaw: number, pitch: number): Result<void> {
        return attempt(() => {
          const pl = Player.getPlayer();
          if (!pl) throw new Error("no player");
          // Entity.setYRot(float)/setXRot(float) → SRG m_146922_/m_146926_. For a LocalPlayer
          // these ARE the camera angles, so setting them turns the player. Live-verified
          // (idle bot): the set persists across ticks (a real turn, not a one-shot
          // write); onGround reads correctly alongside. If the head/body lags in the executor's
          // first walking run, also call setYHeadRot (m_5616_) or kjs$setRotation.
          //
          // Math.fround is REQUIRED: m_146922_/m_146926_ take a Java float, but a JS number is a
          // double; GraalJS rejects a non-float-exact double as a "lossy primitive coercion"
          // (e.g. yaw -202.05 threw live). fround snaps to the nearest float32-exact double, so
          // the double→float conversion is lossless and accepted.
          const raw = pl.getRaw();
          raw[SRG.setYRot](Math.fround(yaw));
          raw[SRG.setXRot](Math.fround(pitch));
        });
      },
      setYaw(yaw: number): Result<void> {
        return attempt(() => {
          const pl = Player.getPlayer();
          if (!pl) throw new Error("no player");
          // setYRot only (m_146922_) — leaves the pitch as-is, so a walking heading change
          // doesn't yank the camera back to level after a downward break aim. fround as above.
          pl.getRaw()[SRG.setYRot](Math.fround(yaw));
        });
      },
      closeScreen(): Result<void> {
        // Screen.close() rebuilds the screen → must run on the render thread (the worker
        // ticks on a Service thread). Fire-and-forget via runOnMainThread, mirroring the
        // harness `close_screen` command; the close applies ~1 tick later.
        return attempt(() => {
          const screen = Hud.getOpenScreen();
          if (!screen) return;
          Client.runOnMainThread(
            JavaWrapper.methodToJava(() => {
              screen.close();
            }),
          );
        });
      },
      // Manual grid crafting — the recipe-book API returns nothing on Monifactory (verified
      // live: getCraftableRecipes empty even after `/recipe give *`), so we place into the
      // open grid and let the server compute the result. Player.openInventory() ensures the
      // 2×2 survival grid is usable; a 3×3 needs a table screen already open (useOnBlock).
      craft: {
        gridSize(): Result<number> {
          return attempt(() => {
            const inv = Player.openInventory();
            if (!inv) throw new Error("no inventory");
            return gridSlotsOf(inv).length;
          });
        },
        place(slots: ReadonlyArray<string | null>): Result<void> {
          return attempt(() => {
            const inv = Player.openInventory();
            if (!inv) throw new Error("no inventory");
            const cin = gridSlotsOf(inv);
            if (cin.length < slots.length) {
              throw new Error(`grid ${cin.length} < needs ${slots.length}`);
            }
            const findSrc = (id: string): number => {
              for (const s of inv.getSlots("main", "hotbar")) {
                const st = inv.getSlot(s);
                if (st && !st.isEmpty() && st.getItemId() === id) return s;
              }
              return -1;
            };
            for (let i = 0; i < slots.length; i++) {
              const id = slots[i];
              if (!id) continue;
              const cell = cin[i];
              if (cell === undefined) throw new Error(`no grid cell ${i}`);
              const src = findSrc(id);
              if (src < 0) throw new Error(`missing ingredient ${id}`);
              inv.click(src); // pick up the source stack
              inv.click(cell, 1); // right-click: drop exactly one into the cell
              inv.click(src); // return the remainder to the source slot
            }
          });
        },
        output(): Result<ItemStack | null> {
          return attempt(() => {
            const inv = Player.openInventory();
            if (!inv) throw new Error("no inventory");
            const outSlot = outSlotOf(inv);
            if (outSlot === undefined) throw new Error("no result slot");
            return stackOf(inv.getSlot(outSlot));
          });
        },
        take(): Result<number> {
          return attempt(() => {
            const inv = Player.openInventory();
            if (!inv) throw new Error("no inventory");
            const outSlot = outSlotOf(inv);
            if (outSlot === undefined) throw new Error("no result slot");
            const st = inv.getSlot(outSlot);
            if (!st || st.isEmpty()) return 0;
            const n = st.getCount();
            inv.quick(outSlot); // shift-click the result into inventory
            return n;
          });
        },
        clearGrid(): Result<void> {
          return attempt(() => {
            const inv = Player.openInventory();
            if (!inv) throw new Error("no inventory");
            for (const cell of gridSlotsOf(inv)) {
              const st = inv.getSlot(cell);
              if (st && !st.isEmpty()) inv.quick(cell); // shift back to inventory
            }
          });
        },
      },
    },

    inv: {
      open(): Result<Container> {
        return attempt(() => {
          const inv = Player.openInventory();
          if (!inv) throw new Error("no container open");
          return wrapContainer(inv);
        });
      },
    },

    keys: {
      set(key: string, pressed: boolean): void {
        if (DRIVE_KEYS.has(key)) {
          if (pressed) heldDrive.add(key);
          else heldDrive.delete(key);
        }
        fxDo("keySet", () => KeyBind.keyBind(key, pressed));
      },
      movementHeld: () => [...heldDrive].some((k) => HORIZONTAL_KEYS.has(k)),
      driveHeld: () => heldDrive.size > 0,
      driveHeldKeys: () => [...heldDrive],
      releaseAll(): void {
        heldDrive.clear();
        // Action keys AND movement keys: a reflex divert calls this, and the greedy navigator
        // holds key.forward/key.jump — without releasing them a diverted bot would
        // keep walking. Releasing movement is a harmless no-op under the Baritone driver.
        for (const k of RELEASE_KEYS) {
          fxDo("keyRelease", () => KeyBind.keyBind(k, false));
        }
      },
    },

    nav: {
      // Baritone removed: the greedy executor drives movement via held keys, so "stop
      // navigating" = release every held key (forward/jump/sprint + actions). No chat command.
      stop: () => {
        heldDrive.clear();
        fxDo("navStop", () => {
          for (const k of RELEASE_KEYS) {
            KeyBind.keyBind(k, false);
          }
        });
      },
    },
  };
}
