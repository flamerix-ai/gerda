#!/usr/bin/env python3
"""capture_profile.py — swap a launcher instance's options.txt to a demo-CAPTURE profile
and back, without ever losing the instance's normal config.

The demo camera is filmed off an INVISIBLE headless sway output, HEADLESS-1 (see
scripts/ops/capture_rig.sh). The playing profile is tuned for the eye; a recording wants
different things — no view-bob, no sprint-FOV pulse, no screen distortion, brighter gamma
so a mine shaft isn't a black smear, a wider FOV, and a bigger render distance so flyovers
aren't foggy. Those read as "camera shake / murk" on video but are fine in normal play, so
they must NOT be baked into the config someone actually plays on.

Mechanism: `apply` backs options.txt up to a sidecar (options.txt.playbak) ONCE, then
rewrites the capture keys in place; `restore` moves the sidecar back and deletes it. The
sidecar is never overwritten while it exists — so a second `apply` (or a crash between the
two) can't clobber the saved playing config. `status` reports which profile is live.

  ⚠ A RUNNING Minecraft writes its in-memory options back to options.txt on quit, which
  would clobber whatever we wrote (same gotcha tune_bot_instance.py carries). So both apply
  and restore REFUSE when the launcher is up, unless --force. Swap while MC is closed.

The instance is a MANDATORY, explicit argument — there is no default, so you cannot swap the
human's playing instance by forgetting a flag. Point this at the dedicated camera instance.

Usage:
    python scripts/ops/capture_profile.py apply   <instance>
    python scripts/ops/capture_profile.py restore <instance> [--if-present]
    python scripts/ops/capture_profile.py status  <instance>

`restore --if-present` is the idempotent form used by unconditional cleanup paths
(scripts/rig/teardown.sh): no sidecar → say so and exit 0, instead of failing. A bare
`restore` stays fail-loud, because asking for one when no backup exists means something
already consumed it.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import local_config  # noqa: E402

# options.txt is colon-separated. Keys NOT listed here are preserved verbatim. Values are
# the raw options.txt encoding (MC stores FOV normalised: 0.0 = 70°, 0.5 ≈ 90°, 1.0 = 110°).
CAPTURE_OPTIONS = {
    "bobView": "false",          # view-bob reads as camera shake on video
    "fovEffectScale": "0.0",     # kill the sprint FOV pulse (zoom jerk on every sprint)
    "screenEffectScale": "0.0",  # kill nausea/portal screen warp
    "gamma": "1.0",              # brighten — a mine shaft at 0.5 is a black smear on camera
    "guiScale": "2",             # 4 eats half the frame; F1 hides the GUI at capture time anyway
    "renderDistance": "16",      # 12 looks foggy on flyovers; raise if the GPU allows
    "simulationDistance": "12",
    "fov": "0.5",                # ≈90°, wider than the default 70° for sweeping shots
    "maxFps": "120",             # above the 60 Hz headless sway output (capture_rig.sh)
    "enableVsync": "false",      # MUST stay false — an off-screen vsync'd MC stops rendering
    "pauseOnLostFocus": "false", # keep rendering headless/unfocused
}

SIDECAR_SUFFIX = ".playbak"


def _opts_path(inst: str) -> Path:
    return local_config.instance_dir(inst) / "minecraft" / "options.txt"


CLIENT_TOKEN = "org.prismlauncher.EntryPoint"  # every Prism/Freesm game CLIENT; no server, no shell


def _clients_running(inst: str | None = None) -> list[int]:
    """PIDs of real launcher CLIENTS of this user (optionally only for one instance).

    Reads /proc directly — the same signature scripts/rig/mc_clients.sh keys on — rather
    than shelling out to pgrep. Two reasons, both bugs we already paid for:
      • the OLD check matched any java whose cmdline contained "minecraft", which the
        dedicated SERVER's classpath does (net/minecraftforge). With the fleet server up —
        i.e. always, on a shoot day — `apply` refused unconditionally and the camera kept
        filming on the playing profile;
      • a pgrep whose PATTERN is in our own argv can self-match (the exit-144 footgun).
    comm must be exactly `java`, so a shell/python that merely mentions the token is never
    matched.
    """
    uid = Path("/proc/self").stat().st_uid
    pids: list[int] = []
    for d in Path("/proc").iterdir():
        if not d.name.isdigit():
            continue
        try:
            if d.stat().st_uid != uid:
                continue
            if (d / "comm").read_text().strip() != "java":
                continue
            cmd = (d / "cmdline").read_bytes().replace(b"\0", b" ").decode("utf-8", "replace")
        except OSError:
            continue
        if CLIENT_TOKEN not in cmd:
            continue
        if inst and inst not in cmd:
            continue
        pids.append(int(d.name))
    return pids


def _set_keys(path: Path, kv: dict[str, str]) -> None:
    """Update-or-append each key:value, preserving every other line verbatim."""
    seen: set[str] = set()
    out: list[str] = []
    for ln in path.read_text().splitlines():
        m = re.match(r"^([A-Za-z0-9_.]+):", ln)
        if m and m.group(1) in kv:
            out.append(f"{m.group(1)}:{kv[m.group(1)]}")
            seen.add(m.group(1))
        else:
            out.append(ln)
    for k, v in kv.items():
        if k not in seen:
            out.append(f"{k}:{v}")
    path.write_text("\n".join(out) + "\n")


def _guard_running(force: bool, inst: str) -> None:
    """Refuse only when THIS instance's client is up — it would clobber options.txt on quit.

    Scoped to the instance on purpose: filming boots the worker client first, and that one
    writing its own options.txt is none of the camera's business.
    """
    pids = _clients_running(inst)
    if pids and not force:
        raise SystemExit(
            f"refusing: a Minecraft client for {inst} is running (pid {', '.join(map(str, pids))}) "
            "— it would clobber options.txt on quit. Close it first, or pass --force."
        )


def apply(inst: str, args: argparse.Namespace) -> int:
    opts = _opts_path(inst)
    if not opts.exists():
        raise SystemExit(f"no options.txt at {opts}")
    _guard_running(args.force, inst)
    sidecar = opts.with_name(opts.name + SIDECAR_SUFFIX)
    if sidecar.exists():
        print(f"  capture profile already applied ({sidecar.name} present) — re-applying keys")
    else:
        sidecar.write_text(opts.read_text())  # back up the PLAYING config, once
        print(f"  backed up playing profile → {sidecar.name}")
    _set_keys(opts, CAPTURE_OPTIONS)
    print(f"  wrote capture profile to {opts}")
    print("  camera keys:", ", ".join(f"{k}={v}" for k, v in CAPTURE_OPTIONS.items()))
    return 0


def restore(inst: str, args: argparse.Namespace) -> int:
    opts = _opts_path(inst)
    sidecar = opts.with_name(opts.name + SIDECAR_SUFFIX)
    if not sidecar.exists():
        # Bare `restore` is fail-loud: if you asked for one and there is no backup, something
        # already ate it. `--if-present` is the IDEMPOTENT form for unconditional cleanup paths
        # (scripts/rig/teardown.sh runs it on every instance it kills, capture profile or not).
        if args.if_present:
            print(f"  {inst}: no capture backup — nothing to restore")
            return 0
        raise SystemExit(
            f"no backup at {sidecar} — capture profile was never applied (nothing to restore)"
        )
    _guard_running(args.force, inst)
    opts.write_text(sidecar.read_text())
    sidecar.unlink()
    print(f"  restored playing profile from {sidecar.name} (backup removed)")
    return 0


def status(inst: str, _args: argparse.Namespace) -> int:
    opts = _opts_path(inst)
    sidecar = opts.with_name(opts.name + SIDECAR_SUFFIX)
    if sidecar.exists():
        print(f"  {inst}: CAPTURE profile active (playing config saved in {sidecar.name})")
    else:
        print(f"  {inst}: playing profile (no capture backup present)")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", choices=["apply", "restore", "status"])
    ap.add_argument("instance", help="launcher instance name (e.g. the dedicated camera instance)")
    ap.add_argument("--force", action="store_true", help="proceed even if a java/launcher process is up")
    ap.add_argument(
        "--if-present",
        action="store_true",
        help="restore only: exit 0 (instead of failing) when there is no capture backup",
    )
    args = ap.parse_args()
    return {"apply": apply, "restore": restore, "status": status}[args.action](args.instance, args)


if __name__ == "__main__":
    raise SystemExit(main())
