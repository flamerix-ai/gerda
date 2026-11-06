#!/usr/bin/env python3
"""shoot.py — DECLARATIVE shot runner: turn a shot-list JSON into a folder of takes.

The film rig (scripts/ops/capture_rig.sh) can boot a camera client off-screen and roll
one long clip. That is a CAMERA, not a SHOOT: every take so far was one static pose held
for minutes, framed by hand and re-framed by editing the hook. This script is the layer
above it — each shot declares WHERE the camera stands, WHAT it looks at, WHAT the bot is
doing, and HOW LONG to roll; shoot.py poses, drives, records, and files the clip.

  python3 scripts/demo/shoot.py list    scenarios/shots/teaser.json
  python3 scripts/demo/shoot.py pose    scenarios/shots/teaser.json 03_vein   # frame only, no roll
  just shoot <id> [id ...]                             # ROLL — capture devShell + camera display (scripts/rig/shoot.sh)

PRECONDITIONS (this script does NOT boot anything — by design)
  • the worker client is up and its bridge answers on BOT_PORT (55545);
  • the CAMERA client is up inside headless sway and answers on CAM_PORT
    (SHOOT_CAM_PORT, default sway_windows.DEFAULT_CAM_PORT);
  • WAYLAND_DISPLAY points at that sway (capture_rig.sh prints it) — required to record;
  • wf-recorder + ffprobe on PATH, i.e. the `capture` devShell.
  `just shoot <id> …` provides the last two (scripts/rig/shoot.sh: capture devShell, display
  resolved from the camera client itself). A `shoot` missing any of them REFUSES (exit 2)
  before the first shot is staged — see recording_preflight().
  Boot both with `scripts/ops/capture_rig.sh -K` (worker) + a second `-K -P` run for the
  camera, then run shoot.py against them. Keeping boot out of here is deliberate: a shoot
  day re-frames and re-rolls dozens of times over ONE 5-minute modded boot.

TRACKING (why the camera can move at all)
  A shot may declare `track` — the camera then AIMS at a moving point ~4×/s over the
  ext.js `cam_look_at` command. The per-frame smoothing lives in the game (a Forge
  ViewportEvent.ComputeCameraAngles hook eases the stored angles every FRAME), so a 4 Hz
  host push still reads as continuous motion, and the render-thread callback stays pure
  arithmetic — no scan, no IO, nothing the EventLockWatchdog can kill. See harness/ext.js.

SHOT SCHEMA (scenarios/shots/*.json)
  {
    "name": "teaser", "fps": 60, "out_dir": "release/takes/teaser",
    "shots": [{
      "id":       "01_wide",              # take filename stem — keep it sortable
      "note":     "why this shot exists", # editorial intent, printed while rolling
      "seconds":  12,                     # roll duration
      "settle":   3,                      # pause after posing/driving, BEFORE rolling
      "camera":   {"pos": [13,109,9], "yaw": 135, "pitch": 30, "spectator": true},
      "track":    {"target": "bot", "offset": [0,1,0], "hz": 4, "smooth": 0.12},
      "console":  ["tp bot_1 0 101 0 180 0"],        # server-console lines (op authority)
      "bot":      {"cmd": "plan_start", "params": {"name": "sustain-cycle"}},
      "during":   ["python3 scripts/demo/sustain_live.py loop 3"],  # host driver, killed after
      "cam":      [{"cmd": "cam_hud", "params": {"hide": true}}]
    }]
  }
  Every key but `id` and `seconds` is optional. `track.target` is either "bot" (poll the
  worker's live position) or a literal [x,y,z].

  `during` exists because a one-shot `bot` command is often NOT enough to fill a take. The
  sustain-cycle plan, for instance, runs ONE lap in a few seconds and stops (the sandbox
  needs re-arming between laps — see sustain_live.py), so a 45s take of `plan_start` alone
  films 42s of a bot standing still. A `during` command runs from the repo root for exactly
  the duration of the take and is killed (process group) when the take ends. Its output is
  appended to `<out_dir>/<id>.during.log` — the take's own timeline of what the driver did,
  and the evidence that answers "why was the bot idle at 0:12" after the shoot day is over.

FAIL-LOUD: a shot whose camera pose, console staging or bot command fails is REPORTED and
SKIPPED, not filmed — a silently mis-posed take looks fine in the log and is worthless in
the edit. The run continues to the next shot and the summary lists what was skipped.

A LANDED take is not trusted on its file size either: `roll` ffprobes it. An mp4 only gets
its index (the moov atom) when the recorder shuts down cleanly, so a recorder that crashes
mid-roll leaves a file that is big and completely unreadable. That happened once —
wf-recorder took a `Bus error` right after "frames flowing (262192B)", record.sh
printed "done → …01_clutch.mp4 (260K)" and exited 0, and this script filed `01_clutch ok`
off `size >= 51200` alone; ffprobe on the "take" said "moov atom not found". So the check
is now: the container must OPEN, and `format=duration` must be at least MIN_TAKE_RATIO of
the seconds we asked for (these captures are 60 fps CFR, so a crash mid-roll shows up as a
short file). A shot that fails it is `failed: <reason>` in the summary and counts against
the "did NOT produce a take" tally — never green.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import IO

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "mcp"))
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "scripts" / "rig"))
import local_config  # noqa: E402
import sway_windows  # noqa: E402  — the display check recording_preflight() runs

from bridge_client import BridgeClient  # noqa: E402

RECORD_SH = REPO / "scripts/rig/record.sh"

BOT_PORT = int(os.environ.get("SHOOT_BOT_PORT", 55545))   # the worker being filmed
CAM_PORT = sway_windows.cam_port()                        # the operator/camera client

MIN_TAKE_BYTES = 51200      # below this the file is a header, not footage (see record.sh -D note)
# A take must be >= this much of the seconds it was asked to roll.
#
# The floor assumes a WALL-CLOCK-FAITHFUL CFR capture: wf-recorder stamps 60 fps CFR pts, so
# container duration = frames / 60, and only a recorder that kept up makes that equal the
# real-time roll. A FRAME-STARVED capture is therefore refused BY DESIGN, and that is the
# point, not a false positive — measured: an 80 s roll under load wrote 3266
# frames = 54.4 s of container (ratio 0.68), and because the pts are CFR the file PLAYS 1.47x
# fast rather than short-and-correct. Nothing else in the pipeline notices that.
#
# Calibration note: delivered files run ~3.5-4 s LONGER than `seconds` (record.sh starts the
# clock before frames flow and finalises after), so a file that just clears 0.8 x secs holds
# only ~0.75 x secs of actual content — budget shot length against that, not against 0.8.
MIN_TAKE_RATIO = 0.8


# ── plumbing ────────────────────────────────────────────────────────────────────────────

def bridge(port: int, cmd: str, params: dict | None = None, timeout: int = 20):
    return BridgeClient(port=port, timeout=timeout).send(cmd, params or {})


def console(line: str) -> None:
    """One server-console command (full op authority — bots are non-op, see FLEET_PLAYBOOK)."""
    subprocess.run([str(local_config.server_ctl()), "cmd", line], check=False,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.25)


def bot_pos() -> tuple[float, float, float]:
    """Live worker position, read through the SRG-free jsMacros facade.

    Deliberately NOT the raw `mc.player` fields: those are SRG and read as `undefined`
    by their Mojang names, so a probe built on them lies unconditionally (see CLAUDE.md).
    """
    js = ("var p=Player.getPlayer();"
          "JSON.stringify(p?{x:p.getX(),y:p.getY(),z:p.getZ()}:null)")
    raw = bridge(BOT_PORT, "jeval", {"code": js}, timeout=8)
    data = raw.get("data", raw) if isinstance(raw, dict) else raw  # jeval returns {ok,type,id,data}
    if isinstance(data, str):
        data = json.loads(data)
    if not data:
        raise RuntimeError("worker reports no player (not in world?)")
    return float(data["x"]), float(data["y"]), float(data["z"])


# ── camera ──────────────────────────────────────────────────────────────────────────────

def pose_camera(cam: dict) -> None:
    """Stand the camera where the shot says, facing where the shot says."""
    p = cam.get("pos")
    if not p:
        return
    params = {"x": p[0], "y": p[1], "z": p[2], "spectator": cam.get("spectator", True)}
    if "yaw" in cam:
        params["yaw"] = cam["yaw"]
    if "pitch" in cam:
        params["pitch"] = cam["pitch"]
    print(f"  [cam] pose {params}")
    bridge(CAM_PORT, "cam_pose", params)
    if "look_at" in cam:
        la = cam["look_at"]
        bridge(CAM_PORT, "cam_look_at", {"x": la[0], "y": la[1], "z": la[2],
                                         "smooth": cam.get("smooth", 1)})


class Tracker(threading.Thread):
    """Push a look-at target to the camera at `hz` while a take rolls.

    The host only sets the TARGET angle; the in-game per-frame hook eases towards it, so
    this loop can stay slow and cheap. A failed poll is logged once and retried — a hiccup
    mid-take must not kill the take (the camera simply holds its last aim, which reads as
    a deliberate hold, not as a glitch).
    """

    def __init__(self, track: dict):
        super().__init__(daemon=True)
        self.track = track
        self.stop_flag = threading.Event()
        self.errors = 0

    def run(self) -> None:
        hz = float(self.track.get("hz", 4))
        period = 1.0 / max(hz, 0.5)
        offset = self.track.get("offset", [0, 1, 0])
        smooth = self.track.get("smooth", 0.12)
        target = self.track.get("target", "bot")
        while not self.stop_flag.is_set():
            try:
                if target == "bot":
                    x, y, z = bot_pos()
                else:
                    x, y, z = target
                bridge(CAM_PORT, "cam_look_at",
                       {"x": x + offset[0], "y": y + offset[1], "z": z + offset[2],
                        "smooth": smooth}, timeout=8)
            except Exception as e:  # noqa: BLE001 — never let a poll hiccup end the take
                self.errors += 1
                if self.errors in (1, 20):
                    print(f"  [track] WARN poll failed ({e}) — camera holds its last aim")
            self.stop_flag.wait(period)


# ── host-side drivers that run FOR THE DURATION of a take ───────────────────────────────

def start_during(shot: dict, out_dir: Path) -> list[tuple[subprocess.Popen, IO[str]]]:
    """Launch the shot's `during` commands in their own process groups, from the repo root.

    Their output lands in `<out_dir>/<id>.during.log`, NEXT TO THE TAKE — not in DEVNULL as
    it used to. That redirect cost a whole shoot day: `05_economy` filmed 42 of 49 seconds of
    a motionless bot and the one witness to WHY (the driver's own stdout — did plan_start even
    answer? which phase was the bot in?) had been thrown away, so the question was unanswerable
    after the fact. The log is APPENDED (a re-shoot of the same id keeps the earlier attempt)
    and each launch writes a timestamped header naming the command, so one file reads as the
    take's timeline. Pair it with `scripts/rig/motion_probe.py` on the take itself: the probe
    says WHEN the picture froze, the log says what the driver was doing at that second.
    """
    procs: list[tuple[subprocess.Popen, IO[str]]] = []
    try:
        for cmd in shot.get("during", []):
            out_dir.mkdir(parents=True, exist_ok=True)
            log = out_dir / f"{shot['id']}.during.log"
            fh = log.open("a", buffering=1)
            fh.write(f"\n=== {time.strftime('%Y-%m-%d %H:%M:%S')}  {cmd}\n")
            fh.flush()
            print(f"  [during] {cmd} → {log}")
            procs.append((subprocess.Popen(cmd, shell=True, cwd=REPO, start_new_session=True,
                                           stdout=fh, stderr=subprocess.STDOUT), fh))
    except Exception:
        # A second driver that fails to launch must not orphan the first one: without this the
        # exception escapes past shoot_one's try/finally (which only guards the ROLL), leaving a
        # live sustain_live loop driving the bot through every later shot of the list.
        stop_during(procs)
        raise
    return procs


def stop_during(procs: list[tuple[subprocess.Popen, IO[str]]]) -> None:
    """Kill each driver's whole group — sustain_live's `loop` spawns children of its own."""
    for p, fh in procs:
        try:
            if p.poll() is not None:
                msg = (f"driver already exited (rc={p.returncode}) before the take ended")
                print(f"  [during] {msg}")
                fh.write(f"=== shoot.py: {msg}\n")  # the log must say so too — see start_during
                continue
            try:
                os.killpg(os.getpgid(p.pid), 15)
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    # A driver ignoring SIGTERM (or blocked in a bridge call) would otherwise
                    # keep driving the bot into the NEXT shot. Escalate; do not hope.
                    print("  [during] driver survived SIGTERM — SIGKILLing the group")
                    fh.write("=== shoot.py: driver survived SIGTERM — SIGKILL\n")
                    os.killpg(os.getpgid(p.pid), 9)
                    p.wait(timeout=5)
            except Exception as e:  # noqa: BLE001 — teardown must never sink a landed take
                print(f"  [during] WARN could not stop driver: {e}")
        finally:
            try:
                fh.close()
            except Exception:  # noqa: BLE001
                pass


# ── shots ───────────────────────────────────────────────────────────────────────────────

def stage(shot: dict) -> None:
    """Everything that must be true BEFORE the camera rolls: staging, bot drive, cam tweaks."""
    for line in shot.get("console", []):
        print(f"  [console] {line}")
        console(line)
    for c in shot.get("cam", []):
        print(f"  [cam] {c['cmd']} {c.get('params', {})}")
        bridge(CAM_PORT, c["cmd"], c.get("params", {}))
    pose_camera(shot.get("camera", {}))
    b = shot.get("bot")
    if b:
        print(f"  [bot] {b['cmd']} {b.get('params', {})}")
        r = bridge(BOT_PORT, b["cmd"], b.get("params", {}), timeout=b.get("timeout", 30))
        print(f"  [bot] -> {r}")


def probe_duration(path: Path) -> tuple[float | None, str]:
    """(seconds, "") if ffprobe can read the container, else (None, why it could not).

    This is the take's ONLY proof of life. Size cannot be it: an mp4 grows on disk for the
    whole roll and is indexed only at the end, so a crashed recorder leaves a fat file that
    opens nowhere. `format=duration` comes out of that index — reading it at all is the
    "the container opens" assertion, and its VALUE is the "the roll went the distance" one.
    ffprobe's own stderr is carried into the reason verbatim ("moov atom not found" is the
    sentence that names the failure); a reason that just said "invalid file" would send the
    operator hunting the scene instead of the capture path.
    """
    ffprobe = shutil.which("ffprobe")
    if ffprobe is None:
        return None, "ffprobe is not on PATH, so this take could NOT be validated"
    r = subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration",
                        "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
                       capture_output=True, text=True, check=False)
    # ALL of stderr, not its last line: ffprobe names the cause first and the consequence last
    # ("… moov atom not found" then "<file>: Invalid data found when processing input"), so a
    # tail-only reason would drop the only word that identifies a crashed recorder.
    detail = "; ".join(ln.strip() for ln in (r.stderr or "").splitlines() if ln.strip())[:300]
    if r.returncode != 0:
        return None, f"ffprobe could not open the take (rc={r.returncode}: {detail or 'no stderr'})"
    raw = (r.stdout or "").strip()
    try:
        seconds = float(raw)
    except ValueError:
        # "N/A", an empty answer, anything non-numeric — a container that opened but has no
        # duration is still not a take, and must not be coerced into 0.0 or into a pass.
        return None, (f"ffprobe reported no usable duration ({raw!r})"
                      + (f": {detail}" if detail else ""))
    if seconds <= 0:
        return None, f"ffprobe reads a {seconds:.2f}s take — nothing was encoded"
    return seconds, ""


def roll(shot: dict, out: Path, fps: int) -> str:
    """Record one take. Returns "" when a playable take of the right LENGTH landed, else why not."""
    if not os.environ.get("WAYLAND_DISPLAY"):
        print("  [rec] REFUSING: WAYLAND_DISPLAY is unset — it must point at the camera's "
              "headless sway (capture_rig.sh prints it). Nothing recorded.")
        return "WAYLAND_DISPLAY is unset — nothing was recorded"
    out.parent.mkdir(parents=True, exist_ok=True)
    secs = int(shot["seconds"])
    print(f"  [rec] rolling {secs}s → {out}")
    r = subprocess.run([str(RECORD_SH), str(out), str(secs), "HEADLESS-1", str(fps)],
                       check=False)
    size = out.stat().st_size if out.exists() else 0
    if r.returncode != 0 or size < MIN_TAKE_BYTES:
        reason = f"record.sh rc={r.returncode}, {size}B on disk"
        print(f"  [rec] FAILED ({reason}) — see record.sh output above")
        return reason
    duration, why = probe_duration(out)
    if duration is None:
        print(f"  [rec] FAILED: {why} ({size}B on disk — size proves nothing)")
        return why
    # Rounded because binary float is not: 0.8 * 12 is 9.600000000000001, so an exactly-9.60s
    # take would be rejected by a floor the message itself prints as "9.60s".
    floor = round(MIN_TAKE_RATIO * secs, 3)
    if duration < floor:
        reason = (f"the take is only {duration:.2f}s of the {secs}s rolled, short of the "
                  f"{floor:.2f}s floor ({MIN_TAKE_RATIO:g}x) — the recording was cut off")
        print(f"  [rec] FAILED: {reason}")
        return reason
    print(f"  [rec] ok ({size // 1024} KiB, {duration:.2f}s of {secs}s)")
    return ""


def recording_preflight() -> list[str]:
    """Why no take could be recorded in this environment — empty when every tool is there.

    Checked ONCE, before the first shot is staged. Once shoot.py ran outside the
    capture devShell: the shot was posed, the console staged and the bot command FIRED, and only
    then did record.sh find no wf-recorder — a lost take, and a world state that had moved on.
    roll() still refuses per take; this makes the same answer arrive before anything moves.
    The recorder is resolved the way record.sh resolves it (WFREC, else PATH), and ffprobe is
    required because probe_duration() is the only thing that can call a landed file a take.
    The display gets the REAL check, not "is it set": sway_windows.check_display() — a live sway
    serves it, with HEADLESS-1, holding the window of the client listening on CAM_PORT. A set
    but wrong value (the desktop's display, a stale wayland-N, the worker's sway) is refused.
    """
    problems = []
    display = os.environ.get("WAYLAND_DISPLAY")
    if not display:
        problems.append("WAYLAND_DISPLAY is unset — it must name the camera's headless sway")
    else:
        try:
            sway_windows.check_display(display, CAM_PORT)
        except sway_windows.ResolveError as e:
            problems.append(f"WAYLAND_DISPLAY={display} is not the camera's recordable sway: {e}")
    wfrec = os.environ.get("WFREC") or shutil.which("wf-recorder")
    if not wfrec or not os.access(wfrec, os.X_OK):
        problems.append(f"no wf-recorder ({'WFREC=' + wfrec if wfrec else 'not on PATH'})")
    if shutil.which("ffprobe") is None:
        problems.append("no ffprobe on PATH — a landed take could not be validated")
    return problems


def shoot_one(shot: dict, out_dir: Path, fps: int) -> str:
    print(f"\n── {shot['id']}  {shot.get('note', '')}")
    try:
        stage(shot)
    except Exception as e:  # noqa: BLE001 — a mis-staged shot is worthless; skip, don't film
        print(f"  [stage] FAILED: {e} — SKIPPING this shot (nothing recorded)")
        return "skipped"
    settle = shot.get("settle", 2)
    if settle:
        print(f"  [settle] {settle}s")
        time.sleep(settle)
    tracker = None
    if shot.get("track"):
        tracker = Tracker(shot["track"])
        tracker.start()
        print(f"  [track] {shot['track']}")
    drivers = start_during(shot, out_dir)
    try:
        why = roll(shot, out_dir / f"{shot['id']}.mp4", fps)
    finally:
        stop_during(drivers)
        if tracker:
            tracker.stop_flag.set()
            tracker.join(timeout=3)
            try:  # release the aim so the next shot's pose is authoritative
                bridge(CAM_PORT, "cam_free", {})
            except Exception:  # noqa: BLE001
                pass
    # The reason travels into the summary: "failed" alone sends the operator back through a
    # 12-second take's console scrollback to learn whether it was the recorder, the length or
    # the pose. `main` counts everything that is not exactly "ok" as a shot with no take.
    return "ok" if not why else f"failed: {why}"


def load(path: Path) -> dict:
    doc = json.loads(path.read_text())
    ids = [s["id"] for s in doc["shots"]]
    if len(set(ids)) != len(ids):
        raise SystemExit(f"{path}: duplicate shot ids — takes would overwrite each other")
    return doc


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", choices=["list", "pose", "shoot"])
    ap.add_argument("shotlist", type=Path)
    ap.add_argument("ids", nargs="*", help="shot ids to run (default: all, in order)")
    args = ap.parse_args()

    doc = load(args.shotlist)
    shots = doc["shots"]
    if args.ids:
        by_id = {s["id"]: s for s in shots}
        missing = [i for i in args.ids if i not in by_id]
        if missing:
            raise SystemExit(f"unknown shot id(s): {', '.join(missing)}")
        shots = [by_id[i] for i in args.ids]

    if args.action == "list":
        total = sum(int(s["seconds"]) + s.get("settle", 2) for s in shots)
        print(f"{doc.get('name', args.shotlist.stem)} — {len(shots)} shots, ~{total}s of roll")
        for s in shots:
            cam = s.get("camera", {}).get("pos", "—")
            trk = s.get("track", {}).get("target", "static") if s.get("track") else "static"
            print(f"  {s['id']:<16} {s['seconds']:>3}s  cam={cam}  aim={trk}  {s.get('note','')}")
        return 0

    if args.action == "pose":
        if len(shots) != 1:
            raise SystemExit("pose takes exactly one shot id (it frames, it does not roll)")
        stage(shots[0])
        print("posed — screenshot the camera to check the framing, then `shoot` it")
        return 0

    problems = recording_preflight()
    if problems:
        print("shoot: REFUSING before staging anything — this environment cannot record a take:")
        for p in problems:
            print(f"  - {p}")
        print("Run it as `just shoot <id> …` (capture devShell + the camera's display, "
              "docs/RIG.md § Shot runner).")
        return 2

    out_dir = REPO / doc.get("out_dir", f"release/takes/{doc.get('name', 'shoot')}")
    print(f"shoot: {len(shots)} shots → {out_dir}  (fps={doc.get('fps', 60)})")
    results = {s["id"]: shoot_one(s, out_dir, int(doc.get("fps", 60))) for s in shots}

    print("\n── summary")
    for sid, res in results.items():
        print(f"  {sid:<16} {res}")
    bad = [s for s, r in results.items() if r != "ok"]
    if bad:
        print(f"\n{len(bad)} shot(s) did NOT produce a take: {', '.join(bad)}")
        return 1
    print(f"\nall {len(results)} takes in {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
