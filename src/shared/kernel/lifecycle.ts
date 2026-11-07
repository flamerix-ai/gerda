// Listener-lifecycle hygiene — the #1 jsMacros runtime rule (from research /
// aMelonRind's StopListeners): every `JsMacros.on` returns a listener that PINS
// the Graal context until `JsMacros.off`. Leak one and the context (and its
// memory) never collects. This tracks every registration and tears them all down
// on stop, so capabilities never have to remember to clean up individually.

interface Disposable {
  dispose(): void;
}

export class Lifecycle {
  private readonly disposers: Array<() => void> = [];
  /** Last teardown throw (for debugging); disposal of the rest continues regardless. */
  lastDisposeError: string | null = null;

  /** Register a teardown thunk; returns a handle to dispose just this one. */
  add(dispose: () => void): Disposable {
    this.disposers.push(dispose);
    return {
      dispose: () => {
        const i = this.disposers.indexOf(dispose);
        if (i >= 0) {
          this.disposers.splice(i, 1);
          this.safe(dispose);
        }
      },
    };
  }

  /** Track a jsMacros event listener for automatic `JsMacros.off` on shutdown. */
  onEvent(event: string, listener: unknown): void {
    // reliability-ok: `listener` is an opaque jsMacros handle (FFI); JsMacros.off takes
    // the engine's own listener type, which has no TS shape here.
    this.add(() => JsMacros.off(listener as never));
    void event;
  }

  /** Tear everything down (call from event.stopListener / Module.stop). */
  disposeAll(): void {
    while (this.disposers.length > 0) {
      const d = this.disposers.pop();
      if (d) this.safe(d);
    }
  }

  size(): number {
    return this.disposers.length;
  }

  private safe(fn: () => void): void {
    // reliability-ok: shutdown isolation — one teardown that throws must not abort the
    // rest (a leaked listener is worse than a logged throw). The error is recorded, not
    // swallowed. This is the disposal counterpart to the bus's delivery isolation.
    try {
      fn();
    } catch (e) {
      this.lastDisposeError = String(e);
    }
  }
}
