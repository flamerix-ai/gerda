import { BinaryHeap } from "@/shared/domain/heap";
// BinaryHeap — the shared min-heap under the A* planner + D* Lite queue. Assert the heap
// contract (ordered drain, injected comparator, peek, empty) against a naive reference.
import { describe, expect, it } from "vitest";

describe("BinaryHeap", () => {
  it("is empty to start", () => {
    const h = new BinaryHeap<number>((a, b) => a < b);
    expect(h.size).toBe(0);
    expect(h.peek()).toBeUndefined();
    expect(h.pop()).toBeUndefined();
  });

  it("drains a scalar min-heap in ascending order", () => {
    const h = new BinaryHeap<number>((a, b) => a < b);
    const input = [5, 3, 8, 1, 9, 2, 7, 0, 4, 6, 3, 1];
    for (const n of input) h.push(n);
    expect(h.size).toBe(input.length);
    const out: number[] = [];
    let x = h.pop();
    while (x !== undefined) {
      out.push(x);
      x = h.pop();
    }
    expect(out).toEqual([...input].sort((a, b) => a - b));
    expect(h.size).toBe(0);
  });

  it("respects an inverted comparator (max-heap)", () => {
    const h = new BinaryHeap<number>((a, b) => a > b);
    for (const n of [1, 4, 2, 8, 5, 7]) h.push(n);
    expect(h.peek()).toBe(8);
    expect(h.pop()).toBe(8);
    expect(h.pop()).toBe(7);
    expect(h.pop()).toBe(5);
  });

  it("orders by a lexicographic key like the D* queue", () => {
    const less = (a: [number, number], b: [number, number]) =>
      a[0] < b[0] || (a[0] === b[0] && a[1] < b[1]);
    const h = new BinaryHeap<[number, number]>(less);
    const input: [number, number][] = [
      [2, 1],
      [1, 5],
      [1, 2],
      [3, 0],
      [1, 5],
      [2, 0],
    ];
    for (const k of input) h.push(k);
    const out: [number, number][] = [];
    let x = h.pop();
    while (x !== undefined) {
      out.push(x);
      x = h.pop();
    }
    const sorted = [...input].sort((a, b) => (less(a, b) ? -1 : less(b, a) ? 1 : 0));
    expect(out).toEqual(sorted);
  });

  it("peek does not remove the root", () => {
    const h = new BinaryHeap<number>((a, b) => a < b);
    h.push(3);
    h.push(1);
    h.push(2);
    expect(h.peek()).toBe(1);
    expect(h.peek()).toBe(1);
    expect(h.size).toBe(3);
    expect(h.pop()).toBe(1);
    expect(h.size).toBe(2);
  });

  it("interleaves push and pop while keeping the min invariant", () => {
    const h = new BinaryHeap<number>((a, b) => a < b);
    h.push(5);
    h.push(2);
    expect(h.pop()).toBe(2);
    h.push(1);
    h.push(9);
    expect(h.pop()).toBe(1);
    h.push(3);
    expect(h.pop()).toBe(3);
    expect(h.pop()).toBe(5);
    expect(h.pop()).toBe(9);
    expect(h.pop()).toBeUndefined();
  });
});
