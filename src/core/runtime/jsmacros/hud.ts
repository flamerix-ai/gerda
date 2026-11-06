// HUD facet of the jsMacros runtime — the on-screen status overlay (cosmetic; failures only log).
// Part of the exempt `src/core/runtime/jsmacros/` globals group.
import type { Runtime } from "@/core/runtime/Runtime";
import type { Fx } from "@/core/runtime/jsmacros/shared";

export function hudFacet(fx: Fx): Runtime["hud"] {
  const { fx: fxDo, readOr } = fx;
  // Canonical jsMacros HUD pattern: a registered Draw2D whose onInit closure reads
  // the latest lines; init() clears its elements and re-runs onInit to update (this
  // jsMacros build has no reInit). Cosmetic — failures only log.
  let draw: Draw2DHelper | null = null;
  let lines: string[] = [];
  const ensure = (): void => {
    if (draw) return;
    draw = readOr<Draw2DHelper | null>(
      "hudInit",
      () => {
        const d = Hud.createDraw2D();
        // Opaque-white ARGB. `0xffffffff` is 4294967295 in JS (> Integer.MAX_VALUE),
        // which GraalJS can't narrow to the Java `int` color param — it stays a double
        // and addText finds "no applicable overload". `| 0` wraps it to the signed
        // int -1, the value Java expects for opaque white.
        const WHITE = 0xffffffff | 0;
        const MARGIN_X = 4;
        const TOP_Y = 16; // start below the FPS/perf overlay mods park at y≈4
        const LINE_H = 11;
        d.setOnInit(
          JavaWrapper.methodToJava(() => {
            let y = TOP_Y;
            for (const line of lines) {
              d.addText(line, MARGIN_X, y, WHITE, true);
              y += LINE_H;
            }
          }),
        );
        d.register();
        return d;
      },
      null,
    );
  };
  return {
    setLines(next: string[]): void {
      lines = next;
      ensure();
      fxDo("hudReInit", () => draw?.init());
    },
    clear(): void {
      fxDo("hudClear", () => draw?.unregister());
      draw = null;
      lines = [];
    },
  };
}
