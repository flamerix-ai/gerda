// BinaryHeap — a small, dependency-free generic binary heap shared by the two navigator
// searchers (A* `planner.ts` and incremental `dstar.ts`), which used to each carry a
// byte-for-byte copy of the same parent/child-index sift-up/down. The ONLY difference was the
// comparator (planner: scalar priority; D*: lexicographic key) and D*'s lazy-deletion open-map —
// so the comparator is injected and D* keeps its map as a thin wrapper over this heap.
//
// `less(a, b)` = "a should sit ABOVE b" (a min-heap on whatever order `less` encodes). The
// sift loops are BOUNDED (no unbounded for(;;)/while(true)) so the deploy-bundle validator stays
// happy, and there are no non-null assertions.

export class BinaryHeap<T> {
  private readonly heap: T[] = [];

  constructor(private readonly less: (a: T, b: T) => boolean) {}

  get size(): number {
    return this.heap.length;
  }

  /** The current root (smallest by `less`) without removing it, or undefined if empty. */
  peek(): T | undefined {
    return this.heap[0];
  }

  push(item: T): void {
    const h = this.heap;
    h.push(item);
    let i = h.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      const a = h[i];
      const b = h[parent];
      if (a === undefined || b === undefined || !this.less(a, b)) break;
      h[i] = b;
      h[parent] = a;
      i = parent;
    }
  }

  pop(): T | undefined {
    const h = this.heap;
    const top = h[0];
    if (top === undefined) return undefined;
    const last = h.pop();
    if (h.length > 0 && last !== undefined) {
      h[0] = last;
      let i = 0;
      // sift-down: bounded by the heap height (≤ length) — keeps the deploy bundle validator happy,
      // which rejects unbounded for(;;)/while(true).
      for (let depth = 0; depth <= h.length; depth++) {
        const l = 2 * i + 1;
        const r = 2 * i + 2;
        let best = i;
        const cur = h[best];
        const lh = h[l];
        const rh = h[r];
        if (lh !== undefined && cur !== undefined && this.less(lh, cur)) best = l;
        const bb = h[best];
        if (rh !== undefined && bb !== undefined && this.less(rh, bb)) best = r;
        if (best === i) break;
        const a = h[i];
        const b = h[best];
        if (a === undefined || b === undefined) break;
        h[i] = b;
        h[best] = a;
        i = best;
      }
    }
    return top;
  }
}
