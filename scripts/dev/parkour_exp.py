#!/usr/bin/env python3
"""parkour_exp.py — one-command parkour experiment recorder (navigator debug).

Builds a parkour arena, drives the greedy navigator across it, and records the run as
DATA you can actually read: the full per-tick executor trace (nav_trace), a side-view SVG
of the arc over the arena geometry (open in any browser), a printed metrics summary, and —
opt-in — an mp4 stitched from compositor screenshots (grim; needs MC the visible window).

This replaces the blind rebuild→drive→grep-the-evicting-log loop: every run drops a complete,
un-sampled record under out/parkour/<name>.{trace.json,svg,mp4} so a launch that fires/doesn't,
the charge speed reached, and the exact landing are all visible at a glance.

    python scripts/dev/parkour_exp.py parkour-gap2 --to 8           # build + drive + trace + svg
    python scripts/dev/parkour_exp.py parkour-runup --to 9 --video  # also record an mp4 (MC visible)
    python scripts/dev/parkour_exp.py parkour-gap2 --to 8 --name try3

The navigator drive uses greedy_drive (navProbe is a heartbeat guard, so it runs from a clean
IDLE — no mission fake). Arena build cheats (/fill,/tp) are TEST-SETUP only, never mission logic.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # scripts/ root
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "mcp"))  # mcp/ -> canonical bridge_client
from bridge_client import BridgeClient  # noqa: E402

REPO = Path(__file__).resolve().parents[2]  # repo root (this file lives in scripts/dev/)
ARENA_DIR = REPO / "scenarios" / "arenas"
OUT_DIR = REPO / "out" / "parkour"


def _payload(resp: dict) -> dict:
    """Normalize a bridge reply. Worker-passthrough commands (nav_trace, greedy_drive) nest
    their fields under result.data; container handlers (get_state, get_logs) put them at the
    top level. Return the inner field dict either way."""
    r = resp.get("result")
    if isinstance(r, dict):
        d = r.get("data")
        return d if isinstance(d, dict) else r
    return resp

# action → colour for the SVG trajectory points (the executor's per-tick decision).
ACTION_COLOR = {
    "BACKUP": "#888888",
    "BACKUP_DONE": "#aa66cc",
    "CHARGE": "#2277dd",
    "LAUNCH": "#ff8800",
    "AIR": "#22aa55",
    "LAND": "#dd2222",
    "STALL": "#bbbb00",
    "ABORT_UNDERPOWERED": "#cc00cc",
    "ABORT_FLOOR_GONE": "#cc00cc",
}


# ── arena geometry (for the static backdrop of the side-view) ─────────────────
def _solids_xy(spec: dict) -> list[tuple[int, int, int, int]]:
    """Project the arena's fill ops to the X–Y plane (z is the jump's flat axis here):
    a list of (x0,y0,x1,y1) inclusive solid rectangles. `clear` ops are skipped (air)."""
    rects: list[tuple[int, int, int, int]] = []
    for op in spec.get("ops", []):
        if op.get("op") == "fill":
            a, b = op["from"], op["to"]
            rects.append((min(a[0], b[0]), min(a[1], b[1]), max(a[0], b[0]), max(a[1], b[1])))
        elif op.get("op") == "set":
            p = op["pos"]
            rects.append((p[0], p[1], p[0], p[1]))
    return rects


def _start_pos(spec: dict) -> tuple[float, float] | None:
    for op in spec.get("ops", []):
        if op.get("op") == "player":
            return float(op["pos"][0]), float(op["pos"][1])
    return None


# ── SVG side-view ─────────────────────────────────────────────────────────────
def render_svg(spec: dict, trace: list[dict], target: dict, summary: dict, out: Path) -> None:
    rects = _solids_xy(spec)
    xs = [r[0] for r in rects] + [r[2] for r in rects] + [p["x"] for p in trace]
    ys = [r[1] for r in rects] + [r[3] for r in rects] + [p["y"] for p in trace]
    if not xs:
        return
    pad = 2.0
    minx, maxx = min(xs) - pad, max(xs) + pad
    miny, maxy = min(ys) - pad, max(ys) + pad
    scale = 48  # px per block
    w = (maxx - minx) * scale
    h = (maxy - miny) * scale

    def sx(x: float) -> float:
        return (x - minx) * scale

    def sy(y: float) -> float:  # SVG y grows downward; world y grows up → flip
        return (maxy - y) * scale

    el: list[str] = []
    el.append(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w:.0f}" height="{h:.0f}" '
        f'viewBox="0 0 {w:.0f} {h:.0f}" font-family="monospace" font-size="11">'
    )
    el.append(f'<rect width="{w:.0f}" height="{h:.0f}" fill="#0d1117"/>')
    # grid (1-block) for reading coordinates
    gx = int(minx)
    while gx <= maxx:
        el.append(f'<line x1="{sx(gx):.0f}" y1="0" x2="{sx(gx):.0f}" y2="{h:.0f}" stroke="#1c2430"/>')
        el.append(f'<text x="{sx(gx) + 2:.0f}" y="{h - 3:.0f}" fill="#3a4658">{gx}</text>')
        gx += 1
    gy = int(miny)
    while gy <= maxy:
        el.append(f'<line x1="0" y1="{sy(gy):.0f}" x2="{w:.0f}" y2="{sy(gy):.0f}" stroke="#1c2430"/>')
        el.append(f'<text x="2" y="{sy(gy) - 2:.0f}" fill="#3a4658">{gy}</text>')
        gy += 1
    # solid blocks
    for x0, y0, x1, y1 in rects:
        rx, ry = sx(x0), sy(y1)
        rw, rh = (x1 - x0 + 1) * scale, (y1 - y0 + 1) * scale
        el.append(
            f'<rect x="{rx:.0f}" y="{ry:.0f}" width="{rw:.0f}" height="{rh:.0f}" '
            f'fill="#39414d" stroke="#4a5568"/>'
        )
    # target marker
    tx, ty = sx(target["x"]), sy(target["y"])
    el.append(f'<line x1="{tx:.0f}" y1="0" x2="{tx:.0f}" y2="{h:.0f}" stroke="#dd2222" stroke-dasharray="4 4" opacity="0.5"/>')
    # trajectory polyline + per-tick points
    if trace:
        pts = " ".join(f"{sx(p['x']):.1f},{sy(p['y']):.1f}" for p in trace)
        el.append(f'<polyline points="{pts}" fill="none" stroke="#2b3340" stroke-width="1.5"/>')
        for p in trace:
            c = ACTION_COLOR.get(p["action"], "#ffffff")
            r = 4 if p["action"] in ("LAUNCH", "LAND") else 2.5
            el.append(f'<circle cx="{sx(p["x"]):.1f}" cy="{sy(p["y"]):.1f}" r="{r}" fill="{c}"/>')
    # title + summary
    lines = [
        f"{summary['arena']} → x={target['x']}  result={summary['result']}",
        f"charge_peak={summary['charge_peak']:.3f} b/t  launch@x={summary['launch_x']}  land@x={summary['land_x']}",
        f"max_fall={summary['max_fall']:.2f}  end_hp={summary['end_hp']}  ticks={summary['ticks']}",
    ]
    for i, ln in enumerate(lines):
        el.append(f'<text x="8" y="{16 + i * 14}" fill="#c9d1d9">{ln}</text>')
    # legend
    lx = w - 180
    for i, (name, col) in enumerate(
        [("backup", "#888888"), ("charge", "#2277dd"), ("launch", "#ff8800"), ("air", "#22aa55"), ("land", "#dd2222"), ("abort", "#cc00cc")]
    ):
        el.append(f'<circle cx="{lx:.0f}" cy="{14 + i * 14}" r="4" fill="{col}"/>')
        el.append(f'<text x="{lx + 10:.0f}" y="{18 + i * 14}" fill="#8b949e">{name}</text>')
    el.append("</svg>")
    out.write_text("\n".join(el), "utf-8")


# ── ASCII side-view (dependency-free, printed inline for fast debugging) ──────
# Glyph per action so the arc reads at a glance; solid blocks = '#', the bot's path overrides.
_ACT_GLYPH = {
    "BACKUP": ".", "BACKUP_DONE": "v", "CHARGE": ">", "LAUNCH": "J",
    "AIR": "o", "LAND": "L", "STALL": "x", "ABORT_UNDERPOWERED": "A", "ABORT_FLOOR_GONE": "A",
}


def ascii_view(spec: dict, trace: list[dict], target: dict) -> str:
    rects = _solids_xy(spec)
    pts = [(round(p["x"]), round(p["y"]), p["action"]) for p in trace]
    xs = [r[0] for r in rects] + [r[2] for r in rects] + [p[0] for p in pts] + [round(target["x"])]
    ys = [r[1] for r in rects] + [r[3] for r in rects] + [p[1] for p in pts]
    if not xs:
        return "(no geometry)"
    minx, maxx, miny, maxy = min(xs) - 1, max(xs) + 1, min(ys) - 1, max(ys) + 1
    w, h = maxx - minx + 1, maxy - miny + 1
    grid = [[" "] * w for _ in range(h)]

    def put(x: int, y: int, ch: str) -> None:
        gx, gy = x - minx, maxy - y  # flip y (up = smaller row)
        if 0 <= gy < h and 0 <= gx < w:
            grid[gy][gx] = ch

    for x0, y0, x1, y1 in rects:  # solid blocks
        for x in range(x0, x1 + 1):
            for y in range(y0, y1 + 1):
                put(x, y, "#")
    ty = round(target["y"])  # target column marker
    for y in range(miny, maxy + 1):
        if grid[maxy - y][round(target["x"]) - minx] == " ":
            put(round(target["x"]), y, "|")
    for x, y, act in pts:  # the path (overrides blocks so the arc is visible)
        put(x, y, _ACT_GLYPH.get(act, "*"))
    body = "\n".join(f"  y{maxy - r:>4} {''.join(grid[r])}" for r in range(h))
    axis = "       " + "".join(str(abs(x) % 10) for x in range(minx, maxx + 1))
    return body + "\n" + axis + f"   (x {minx}..{maxx})"


# ── metrics from the trace + the probe-done log ──────────────────────────────
def summarize(arena: str, trace: list[dict], start_y: float, probe: dict | None) -> dict:
    charge = [p["speed"] for p in trace if p["phase"] == "CHARGE" and not p["launched"]]
    launch = next((p for p in trace if p["action"] == "LAUNCH"), None)
    land = next((p for p in trace if p["action"] == "LAND"), None)
    min_y = min((p["y"] for p in trace), default=start_y)
    return {
        "arena": arena,
        "result": (probe or {}).get("result", "?"),
        "ticks": (probe or {}).get("ticks", len(trace)),
        "charge_peak": max(charge) if charge else 0.0,
        "launch_x": round(launch["x"], 2) if launch else None,
        "launch_tick": launch["t"] if launch else None,
        "land_x": round(land["x"], 2) if land else None,
        "max_fall": round(start_y - min_y, 2),
        "end_hp": (probe or {}).get("end_hp"),
    }


# ── grim screenshot loop → mp4 (opt-in, compositor-side, zero game-thread cost) ─
class GrimVideo:
    def __init__(self, frames_dir: Path, fps: int = 15):
        self.dir = frames_dir
        self.fps = fps
        self.proc: subprocess.Popen | None = None

    def _capturing(self) -> bool:
        return shutil.which("grim") is not None

    def start(self) -> bool:
        if not self._capturing():
            print("  [video] grim missing — skipping")
            return False
        # Probe once: grim fails if MC isn't the visible toplevel.
        test = self.dir / "probe.png"
        r = subprocess.run(["grim", str(test)], capture_output=True)
        if r.returncode != 0:
            print(f"  [video] grim failed (MC not the visible window?) — skipping: {r.stderr.decode().strip()[:80]}")
            return False
        test.unlink(missing_ok=True)
        # Background loop: grim every 1/fps s into numbered frames.
        period = 1.0 / self.fps
        script = (
            f"i=0; while true; do grim {self.dir}/f$(printf %04d $i).png >/dev/null 2>&1; "
            f"i=$((i+1)); sleep {period}; done"
        )
        self.proc = subprocess.Popen(["bash", "-c", script])
        return True

    def stop_and_encode(self, out: Path) -> bool:
        if self.proc is None:
            return False
        self.proc.terminate()
        self.proc.wait()
        frames = sorted(self.dir.glob("f*.png"))
        if len(frames) < 2:
            print("  [video] too few frames")
            return False
        r = subprocess.run(
            ["ffmpeg", "-y", "-framerate", str(self.fps), "-pattern_type", "glob",
             "-i", f"{self.dir}/f*.png", "-vf", "scale=1280:-2", "-pix_fmt", "yuv420p", str(out)],
            capture_output=True,
        )
        for f in frames:
            f.unlink(missing_ok=True)
        if r.returncode != 0:
            print(f"  [video] ffmpeg failed: {r.stderr.decode().strip()[-200:]}")
            return False
        print(f"  [video] {out}  ({len(frames)} frames @ {self.fps}fps)")
        return True


# ── main flow ─────────────────────────────────────────────────────────────────
def _last_probe_done(c: BridgeClient) -> dict | None:
    logs = c.send("get_logs", {"n": 60}).get("logs", [])
    done = [e for e in logs if e.get("event") == "NAV_PROBE_DONE"]
    if not done:
        return None
    f = done[-1].get("fields", {})
    return {"result": f.get("result"), "ticks": f.get("ticks"), "end_hp": None}


def run(arena: str, target: dict, name: str, video: bool) -> int:
    spec_path = ARENA_DIR / f"{arena}.json"
    if not spec_path.exists():
        sys.exit(f"no arena '{arena}' at {spec_path}")
    spec = json.loads(spec_path.read_text("utf-8"))
    spec.setdefault("name", arena)
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    # 1. build the arena (clears, builds, kits, TPs the bot to start).
    print(f"building arena '{arena}' …")
    subprocess.run([sys.executable, str(REPO / "scripts" / "dev" / "arena.py"), "build", arena], check=True)
    time.sleep(0.5)

    c = BridgeClient()
    st = c.send("get_state")
    start = st.get("position", {})
    start_y = float(start.get("y", target["y"]))
    print(f"  start @ ({start.get('x'):.2f},{start_y:.0f},{start.get('z'):.2f})  hp={st.get('health')}")

    # 2. optional compositor video (zero game-thread cost — never loads the render thread).
    frames_dir = OUT_DIR / f"{name}_frames"
    vid = GrimVideo(frames_dir)
    recording = False
    if video:
        frames_dir.mkdir(exist_ok=True)
        recording = vid.start()

    # 3. drive.
    print(f"  greedy_drive → {target}")
    c.send("greedy_drive", target)

    # 4. poll until the probe finishes (position stable + a NAV_PROBE_DONE appears) or timeout.
    deadline = time.time() + 8.0
    last = None
    while time.time() < deadline:
        time.sleep(0.4)
        cur = c.send("get_state").get("position", {})
        if last and abs(cur.get("x", 0) - last.get("x", 0)) < 0.01 and abs(cur.get("y", 0) - last.get("y", 0)) < 0.01:
            # settled — give the probe one more beat to log DONE, then stop.
            break
        last = cur

    if recording:
        vid.stop_and_encode(OUT_DIR / f"{name}.mp4")
        frames_dir.rmdir() if not any(frames_dir.iterdir()) else None

    # 5. pull the trace + probe result.
    trace = _payload(c.send("nav_trace")).get("trace", [])
    probe = _last_probe_done(c)
    end_st = c.send("get_state")
    if probe is not None:
        probe["end_hp"] = end_st.get("health")
    summary = summarize(arena, trace, start_y, probe)

    # 6. write artifacts.
    (OUT_DIR / f"{name}.trace.json").write_text(json.dumps({"summary": summary, "target": target, "trace": trace}, indent=2), "utf-8")
    render_svg(spec, trace, target, summary, OUT_DIR / f"{name}.svg")

    print("\n" + ascii_view(spec, trace, target))
    print("\n── experiment summary ──────────────────────────")
    print(f"  arena       {arena}  → x={target['x']}")
    print(f"  result      {summary['result']}  ({summary['ticks']} ticks)")
    print(f"  charge_peak {summary['charge_peak']:.3f} b/tick  (sprint≈0.28, walk≈0.13)")
    print(f"  launch      {'x=' + str(summary['launch_x']) + ' @t' + str(summary['launch_tick']) if summary['launch_x'] is not None else 'NEVER FIRED'}")
    print(f"  land        {'x=' + str(summary['land_x']) if summary['land_x'] is not None else '— (no clean land)'}")
    print(f"  max_fall    {summary['max_fall']:.2f} blocks   end_hp {summary['end_hp']}")
    print(f"  end_pos     ({end_st.get('position', {}).get('x'):.2f},{end_st.get('position', {}).get('y'):.0f})")
    print(f"  artifacts   out/parkour/{name}.svg  .trace.json" + ("  .mp4" if recording else ""))
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description="parkour experiment recorder (trace + svg + mp4)")
    ap.add_argument("arena", help="arena name under scenarios/arenas/")
    ap.add_argument("--to", required=True, help="drive target: X or X,Y,Z (Y,Z default to start)")
    ap.add_argument("--name", default=None, help="output basename (default = arena)")
    ap.add_argument("--video", action="store_true", help="also record an mp4 via grim (MC must be visible)")
    args = ap.parse_args()

    parts = [float(v) for v in args.to.split(",")]
    spec = json.loads((ARENA_DIR / f"{args.arena}.json").read_text("utf-8"))
    sp = _start_pos(spec) or (0.0, 101.0)
    target = {"x": parts[0], "y": parts[1] if len(parts) > 1 else sp[1], "z": parts[2] if len(parts) > 2 else 0}
    sys.exit(run(args.arena, target, args.name or args.arena, args.video))


if __name__ == "__main__":
    main()
