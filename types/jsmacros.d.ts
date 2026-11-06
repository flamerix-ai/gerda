// Ambient declarations for the jsMacros (GraalJS) globals — the ONLY surface the
// L0 runtime facade is allowed to touch. Hand-curated to exactly what was verified
// present on Monifactory (MC 1.20.1 / Forge / jsMacros 1.9.2) by harness/probes/probe_runtime.js.
// Precise where the facade depends on it; `any` where the real shape is irrelevant.
//
// SSOT for the jsMacros boundary: if a method we rely on isn't declared here, it
// doesn't exist for the rest of the codebase.

export {};

declare global {
  // --- Item / block helpers ---
  interface ItemStackHelper {
    getItemId(): string;
    getCount(): number;
    isEmpty(): boolean;
    getDamage(): number;
    getMaxDamage(): number;
  }

  interface BlockDataHelper {
    getId(): string;
    getBlockPos?(): { getX(): number; getY(): number; getZ(): number };
  }

  // --- Inventory / container (from Player.openInventory(); wraps open screen too) ---
  interface InventoryHelper {
    getMap(): { keySet(): { toArray(): string[] }; get(key: string): number[] };
    getSlots(...regions: string[]): number[];
    getSlot(slot: number): ItemStackHelper;
    getTotalSlots(): number;
    click(slot: number, mouseButton?: number): InventoryHelper;
    quick(slot: number): InventoryHelper;
    swap(slot1: number, slot2: number): InventoryHelper;
    dropSlot(slot: number): InventoryHelper;
    getSelectedHotbarSlotIndex(): number;
    setSelectedHotbarSlotIndex(index: number): void;
    closeAndDrop?(): void;
  }

  // --- Entities ---
  interface EntityHelper {
    getType(): string;
    getX(): number;
    getY(): number;
    getZ(): number;
    // Stable cross-tick identity (LivingEntityHelper etc.) — the hunt mission matches the
    // attack target by this. Verified live on a LivingEntityHelper.
    getUUID(): string;
    // LivingEntityHelper.getHealth() — present on living entities, throws on non-living.
    getHealth(): number;
    // ItemEntityHelper.getContainedItemStack() — the stack carried by a dropped-item entity.
    // (jsMacros names it this, NOT getItem(); verified live via reflect.)
    getContainedItemStack?(): ItemStackHelper;
  }

  // --- InteractionManager ---
  interface InteractionManagerHelper {
    attack(await_?: boolean): void;
    /** Melee-attack a SPECIFIC entity (the overload that lands a hit off the render thread —
     *  no-arg attack() depends on the crosshair hitResult, which is null on the worker). */
    attack(entity: EntityHelper): void;
    breakBlock(x: number, y: number, z: number): unknown;
    breakBlockAsync(callback: unknown): void;
    setTarget(x: number, y: number, z: number, direction?: string): void;
    cancelBreakBlock(): void;
    /** Right-click a block on `direction` (place a held block / open a GUI / activate). */
    interactBlock(x: number, y: number, z: number, direction?: string, offhand?: boolean): unknown;
    /** Right-click with the held item. */
    interactItem(offhand?: boolean): unknown;
    /** Right-click a SPECIFIC entity with the held item (put into an item frame / use on an
     *  armor stand) — the interact counterpart of attack(entity), and like it works off the
     *  render thread (a no-arg interact() needs the crosshair hitResult, null on the worker).
     *  Jar-confirmed 1.9.2 signature: interactEntity(EntityHelper<?>, boolean offhand). */
    interactEntity(entity: EntityHelper, offhand: boolean): unknown;
  }

  /** jsMacros wrapper around a Minecraft Component — helper class, so real method names. */
  interface TextHelper {
    getString(): string;
    getStringStripFormatting(): string;
  }

  interface ClientPlayerEntityHelper {
    /** EntityHelper.getName() — for a player, the username. */
    getName(): TextHelper | null;
    getX(): number;
    getY(): number;
    getZ(): number;
    getHealth(): number;
    getPitch(): number;
    getYaw(): number;
    /** Orient toward a world coordinate (yaw + pitch). */
    lookAt(x: number, y: number, z: number): void;
    getAir(): number;
    getMaxAir(): number;
    getFoodLevel(): number;
    getVelocity(): { getX(): number; getY(): number; getZ(): number } | null;
    isAlive(): boolean;
    canBreatheInWater(): boolean;
    /** The raw Minecraft LocalPlayer — SRG-named methods for what jsMacros doesn't wrap.
     *  m_21205_=getMainHandItem (→ ItemStack with m_41671_=finishUsingItem, m_41613_=count),
     *  m_9236_=level(). */
    getRaw(): {
      m_21205_(): { m_41671_(level: unknown, entity: unknown): unknown; m_41613_(): number } | null;
      m_9236_(): unknown;
      m_7583_(): void; // LocalPlayer.respawn() — sends the PERFORM_RESPAWN packet
      m_20096_(): boolean; // Entity.onGround()
      m_146922_(yaw: number): void; // Entity.setYRot(float)
      m_146926_(pitch: number): void; // Entity.setXRot(float)
      [k: string]: any;
    };
    [k: string]: any;
  }

  const Player: {
    getPlayer(): ClientPlayerEntityHelper | null;
    getInteractionManager(): InteractionManagerHelper;
    openInventory(): InventoryHelper | null;
    getCurrentPlayerInput(): Record<string, unknown> | null;
    [k: string]: any;
  };

  const World: {
    getBlock(x: number, y: number, z: number): BlockDataHelper | null;
    getEntities(...filter: unknown[]): JavaList<EntityHelper>;
    findBlocksMatching(...args: unknown[]): unknown[];
    getDimension?(): string;
    getWorldIdentifier?(): string;
    [k: string]: any;
  };

  const Chat: {
    say(text: string): void;
    log(text: unknown): void;
    [k: string]: any;
  };

  const KeyBind: {
    keyBind(key: string, pressed: boolean): void;
    [k: string]: any;
  };

  const Client: {
    waitTick(ticks?: number): void;
    /** Schedule a Runnable on the render (main) thread. Fire-and-forget — no return. */
    runOnMainThread(runnable: unknown): void;
    [k: string]: any;
  };

  const FS: {
    open(path: string): any;
    exists?(path: string): boolean;
    [k: string]: any;
  };

  interface EventListener {}

  const JsMacros: {
    on(event: string, callback: unknown): EventListener;
    on(event: string, joined: boolean, callback: unknown): EventListener;
    off(listener: EventListener): boolean;
    once(event: string, callback: unknown): EventListener;
    waitForEvent(event: string, ...rest: unknown[]): unknown;
    createCustomEvent(name: string): { trigger(): void; [k: string]: any };
    getServiceManager(): any;
    getConfig(): { macroFolder: { toString(): string }; [k: string]: any };
    assertEvent(event: unknown, type: string): void;
    [k: string]: any;
  };

  const JavaWrapper: {
    methodToJava(fn: (...args: any[]) => any): unknown;
    methodToJavaAsync(fn: (...args: any[]) => any): unknown;
    [k: string]: any;
  };

  const GlobalVars: {
    putString(key: string, value: string): void;
    getString(key: string): string | null;
    putInt(key: string, value: number): void;
    getInt(key: string): number;
    putBoolean(key: string, value: boolean): void;
    getBoolean(key: string): boolean;
    incrementAndGetInt(key: string): number;
    getAndIncrementInt(key: string): number;
    toggleBoolean(key: string): boolean;
    remove(key: string): void;
    [k: string]: any;
  };

  // GraalJS Java interop
  const Java: { type(name: string): any };
  const Graal: { versionECMAScript?: string; language?: string; [k: string]: any };
  // eslint-disable-next-line @typescript-eslint/naming-convention
  const java: any;

  // jsMacros service event object (Service scripts)
  const event: { stopListener?: unknown; [k: string]: any };

  // World signature mirrored into the worker's GraalJS context by worker.js (main.js
  // publishes it via GlobalVars because FWorld.getDimension/getWorldIdentifier are pinned
  // to main.js's thread). The facade's world.signature() reads this. Undefined until the
  // first heartbeat lands.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  var __MC_WORLD_SIG: string | undefined;

  // JSON snapshot of nearby dropped-item entities, published by main.js (render thread) and
  // mirrored by worker.js — the bundle's world.items() reads this (ItemEntityHelper methods
  // can't be invoked from the worker thread). Shape: [{x,y,z,id,count}].
  // eslint-disable-next-line @typescript-eslint/naming-convention
  var __MC_ITEMS: string | undefined;

  // JSON snapshot of nearby living entities (mobs), published by main.js (render thread) and
  // mirrored by worker.js — the bundle's world.mobs() reads this (living-entity reads are
  // render-thread-pinned like items). Shape: [{type,uuid,x,y,z,health}].
  // eslint-disable-next-line @typescript-eslint/naming-convention
  var __MC_MOBS: string | undefined;

  // JSON snapshot of nearby OTHER players (peers — humans + other bots), published by main.js
  // (render thread) and mirrored by worker.js — the bundle's world.peers() reads this (player
  // entity reads are render-thread-pinned like mobs; publishMobs excludes players, so peers are
  // a separate feed). Self is excluded by uuid. Shape: [{name,uuid,x,y,z,health}].
  // eslint-disable-next-line @typescript-eslint/naming-convention
  var __MC_PEERS: string | undefined;

  // JSON snapshot of nearby item-frame entities (item_frame / glow_item_frame), published by
  // main.js (render thread) and mirrored by worker.js — the bundle's world.frames() reads this
  // (decoration-entity reads are render-thread-pinned like mobs/peers; frames are non-living so
  // publishMobs skips them). Shape: [{type,uuid,x,y,z}].
  // eslint-disable-next-line @typescript-eslint/naming-convention
  var __MC_FRAMES: string | undefined;

  // JSON of the fleet assignment the coordinator hub pushed down, published into
  // mc_assignment and mirrored by worker.js — the bundle's world.assignment() reads it. Shape:
  // {allowed: {minX,maxX,minZ,maxZ}|null, forbidden: [{minX,maxX,minZ,maxZ}, ...]}.
  // eslint-disable-next-line @typescript-eslint/naming-convention
  var __MC_ASSIGNMENT: string | undefined;

  // HUD overlay (Draw2D)
  interface Draw2DHelper {
    setOnInit(callback: unknown): Draw2DHelper;
    register(): Draw2DHelper;
    unregister(): Draw2DHelper;
    /** Clear elements + re-run onInit (this jsMacros build has no `reInit`). */
    init(): void;
    addText(text: string, x: number, y: number, color: number, shadow: boolean): unknown;
    [k: string]: any;
  }
  /** A clickable button widget (jsMacros wrapper) — label + a real onPress via click(). */
  interface ButtonWidgetHelper {
    getLabel(): { getString(): string } | null;
    click(): void;
    [k: string]: any;
  }
  /** jsMacros wraps Java collections as size()/get() lists. */
  interface JavaList<T> {
    size(): number;
    get(i: number): T;
  }
  /** The open GUI screen (jsMacros IScreen wrapper); `close()` must run on the render thread. */
  interface ScreenHelper {
    close(): void;
    getButtonWidgets(): JavaList<ButtonWidgetHelper>;
    [k: string]: any;
  }
  const Hud: {
    createDraw2D(): Draw2DHelper;
    getOpenScreen(): ScreenHelper | null;
    [k: string]: any;
  };
}
