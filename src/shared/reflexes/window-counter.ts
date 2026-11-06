// WindowCounter — the increment-or-reset debounce shared by the reflex layer. The
// stuck reflex (stillTicks) and the human-input reflex (activeTicks) hand-rolled the SAME loop:
// count consecutive "active" ticks, fire once the run reaches a threshold, reset on any inactive
// tick. One home so the off-by-one can't drift. (Vitals keeps its own sliding SAMPLE window — it
// counts distinct damage EVENTS inside a time window, a different shape, so it isn't folded here.)

/** Debounce state — carried in a reflex's slice; `freshCounter()` seeds it. */
export interface WindowCounter {
  ticks: number;
}

export const freshCounter = (): WindowCounter => ({ ticks: 0 });

export const resetCounter = (c: WindowCounter): void => {
  c.ticks = 0;
};

/** Increment-or-reset. When `active`, bump the run and return true on the tick it FIRST reaches
 *  `threshold` consecutive active ticks (resetting, so re-arming needs another full run). When
 *  `active` is false, reset to 0 and return false. */
export function bump(c: WindowCounter, active: boolean, threshold: number): boolean {
  if (!active) {
    c.ticks = 0;
    return false;
  }
  c.ticks += 1;
  if (c.ticks >= threshold) {
    c.ticks = 0;
    return true;
  }
  return false;
}
