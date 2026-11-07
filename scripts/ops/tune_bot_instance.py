#!/usr/bin/env python3
"""Tune a launcher *bot* instance for minimum host resource use while staying
mining/combat-capable (multi-bot fleet). Idempotent + safe to re-run. Full rationale:
docs/BOT_INSTANCE_SETUP.md.

A bot never needs to be *looked at* by a human, so all the desktop-gamer render settings
(render distance 12, 90 fps, fancy graphics, AO, mipmaps, shadows) are pure waste multiplied
by N clients. We cut them to a headless-ish floor but keep the two bot-critical keys
UNTOUCHED by simply not listing them:
  - enableVsync:false  — REQUIRED for off-screen screenshots (an unfocused window with vsync
                         on stops rendering and the frame goes stale). screen.js eyes depend on it.
  - guiScale:4         — the eyes/hands click math is screenshot-pixel ÷ guiScale (÷4).

GOTCHA: a *running* MC writes its in-memory options back to options.txt on quit, clobbering
edits. Only tune an instance while it is STOPPED (this script just edits files; it doesn't
check — stop the bot first). instance.cfg (heap) is launcher-owned and takes effect next launch.

Usage:
  python3 scripts/ops/tune_bot_instance.py                       # every known *_bot_* instance
  python3 scripts/ops/tune_bot_instance.py Monifactory_bot_2     # specific instance(s)
With no arguments the targets are every instance whose name contains `_bot_` that the fleet
registry (mc-bots.json) or the launcher instances dir knows (docs/BOT_INSTANCE_SETUP.md § Naming).
That default set never includes the human's play instance (`humanInstance`, default
"Monifactory") — that one is left at full settings.
"""
import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # scripts/ root
import fleet_registry  # noqa: E402
import local_config  # noqa: E402

# Where a pid's state is read (`<PROC_ROOT>/<pid>/stat`); a module constant so tests can point it
# at a scratch tree.
PROC_ROOT = Path("/proc")

# Process names (comm) of the MultiMC-format launchers that cache instance.cfg in memory.
# Matched case-insensitively against the process NAME, not the full command line: every game
# client's java cmdline carries the launcher's data dir (`…/FreesmLauncher/instances/…`), and a
# shell that merely mentions the pattern would self-match — either way a false "launcher up".
# Unanchored, so a Nix-wrapped `.prismlauncher-wrapped` (comm `.prismlauncher-`) still matches.
LAUNCHER_PROCESSES = ("freesmlauncher", "prismlauncher", "multimc")
LAUNCHER_PATTERN = "|".join(LAUNCHER_PROCESSES)


def _is_zombie(pid: str) -> bool:
    """True only when `<PROC_ROOT>/<pid>/stat` reads state `Z`. An unreadable stat (no /proc,
    the pid already gone) is NOT a zombie: the pid then counts as a live launcher, the safe side
    (the heap edit is skipped, never clobbered)."""
    try:
        stat = (PROC_ROOT / pid / "stat").read_text()
    except OSError:
        return False
    # `pid (comm) S …` — comm may itself hold ')' or spaces, so split after the LAST ')'.
    fields = stat[stat.rfind(")") + 1 :].split()
    return bool(fields) and fields[0] == "Z"


def launcher_running() -> bool:
    """Prism, MultiMC and FreesmLauncher rewrite instance.cfg from their in-memory cache, so a
    heap edit applied while one runs is clobbered (the bot launches with the old -Xmx and the
    file gets duplicate keys). Detect your own running launcher so we skip instance.cfg and tell
    the user to use the GUI instead.

    Only THIS user's processes count (`pgrep -u <uid>`, as scripts/ops/capture_profile.py
    _clients_running keys on the uid): another user's launcher — a container's, uid 101000 on the
    dev host — never rewrites our instance.cfg. Zombie pids are dropped too: a defunct launcher
    holds no cache, yet pgrep lists it."""
    try:
        out = subprocess.run(
            ["pgrep", "-u", str(os.getuid()), "-i", LAUNCHER_PATTERN],
            capture_output=True,
            text=True,
            timeout=3,
        )
    except Exception:  # noqa: BLE001 — if we can't tell, don't block; just edit
        return False
    if out.returncode != 0:
        return False
    return any(not _is_zombie(pid) for pid in out.stdout.split())


def default_targets(inst_root: Path, registry: dict, human_instance: str) -> list[str]:
    """Every `_bot_` instance the fleet registry or the instances dir knows, minus the human's.

    `inst_root` must exist — main() gets it from local_config.instances_root(), which exits
    loudly when it does not. A registry name with no instance dir under the root stays in the
    set, so tune() reports it and exits non-zero instead of the bot silently dropping out. A
    non-object `bots[]` entry is skipped. No match at all is a loud error: tuning nothing with
    exit 0 would read as success."""
    names = {
        b["name"]
        for b in registry.get("bots", [])
        if isinstance(b, dict) and isinstance(b.get("name"), str)
    }
    names |= {e.name for e in inst_root.iterdir() if e.is_dir()}
    targets = sorted(n for n in names if fleet_registry.is_bot_instance(n) and n != human_instance)
    if not targets:
        raise SystemExit(
            f"no bot instances found: neither {fleet_registry.registry_path()} nor {inst_root} "
            f"knows an instance whose name contains {fleet_registry.BOT_NAME_MARK!r} (human instance "
            f"{human_instance!r} is never tuned). Name the instance explicitly, or create it "
            "per docs/BOT_INSTANCE_SETUP.md § 1."
        )
    return targets

# options.txt — low-resource render profile (colon-separated). Keys NOT listed are preserved.
OPTIONS = {
    "renderDistance": "5",           # 64-block sensory horizon: plenty for mine/nav/melee
    "simulationDistance": "5",       # client-side; the server simulates anyway in MP
    "maxFps": "30",                  # bot tick runs on the worker thread, not fps-bound; 30 is ample
    "graphicsMode": "0",             # fast (not fancy/fabulous)
    "ao": "false",                   # no smooth lighting
    "biomeBlendRadius": "0",         # no biome colour blending
    "renderClouds": '"false"',
    "entityShadows": "false",
    "entityDistanceScaling": "0.75", # render-only cull; entities still EXIST for hunt sensing
    "mipmapLevels": "0",
    "bobView": "false",
    "particles": "2",                # 0=all 1=decreased 2=minimal
    "soundCategory_master": "0.0",   # mute: drop the sound-engine cost
    "pauseOnLostFocus": "false",     # keep running when the window isn't focused
}

# instance.cfg — per-instance heap (=-separated). Global default is an absurd 16G/8G; a render-5
# bot fits in 4G with Xms low so the JVM doesn't pre-commit 8G the moment it launches.
INSTANCE_CFG = {
    "OverrideMemory": "true",
    "MinMemAlloc": "2048",
    "MaxMemAlloc": "4096",
}


def set_keys(path: Path, kv: dict, sep: str) -> None:
    """Update-or-append each key=value, preserving every other line verbatim."""
    seen = set()
    out = []
    for ln in path.read_text().splitlines():
        m = re.match(r"^([A-Za-z0-9_\\.]+)" + re.escape(sep), ln)
        if m and m.group(1) in kv:
            out.append(f"{m.group(1)}{sep}{kv[m.group(1)]}")
            seen.add(m.group(1))
        else:
            out.append(ln)
    for k, v in kv.items():
        if k not in seen:
            out.append(f"{k}{sep}{v}")
    path.write_text("\n".join(out) + "\n")


def set_ini_keys(path: Path, kv: dict, section: str) -> None:
    """Update-or-insert each key=value INSIDE `[section]`, preserving every other line verbatim.

    The launcher reads instance settings from [General] only: a key appended at the end of the
    file lands in whatever section comes last ([UI] in FreesmLauncher's layout) and is ignored,
    so the instance silently runs on the global 16G heap. Copies of the keys in any OTHER section
    (left there by the old append-at-end writer) are dropped, and a repeat inside the section
    keeps only the first occurrence.
    """
    lines = path.read_text().splitlines()
    header = f"[{section}]"
    if header not in lines:
        raise SystemExit(f"{path}: no {header} section — refusing to guess where the keys go")
    out: list[str] = []
    seen: set[str] = set()
    cur = None
    insert_at = None
    for ln in lines:
        if ln.startswith("[") and ln.endswith("]"):
            if cur == section:
                insert_at = len(out)
            cur = ln[1:-1]
            out.append(ln)
            continue
        m = re.match(r"^([A-Za-z0-9_\\.]+)=", ln)
        if m and m.group(1) in kv:
            if cur != section or m.group(1) in seen:
                continue
            out.append(f"{m.group(1)}={kv[m.group(1)]}")
            seen.add(m.group(1))
            continue
        out.append(ln)
    if insert_at is None:
        insert_at = len(out)
    while insert_at > 0 and out[insert_at - 1] == "":
        insert_at -= 1
    missing = [f"{k}={v}" for k, v in kv.items() if k not in seen]
    out[insert_at:insert_at] = missing
    path.write_text("\n".join(out) + "\n")


def tune(inst: str) -> bool:
    base = local_config.instances_root() / inst
    opts = base / "minecraft" / "options.txt"
    cfg_path = base / "instance.cfg"
    if not opts.exists():
        print(f"  ! {inst}: no options.txt ({opts}) — skipped", file=sys.stderr)
        return False
    set_keys(opts, OPTIONS, ":")
    if not cfg_path.exists():
        heap = "no instance.cfg (heap unchanged)"
        print(f"  ! {inst}: no instance.cfg — heap left at launcher default", file=sys.stderr)
    elif launcher_running():
        # editing instance.cfg now would be clobbered by the running launcher — leave it.
        heap = "heap SKIPPED (launcher running → set memory in the GUI: Edit → Memory 2G/4G)"
    else:
        set_ini_keys(cfg_path, INSTANCE_CFG, "General")
        heap = "heap 2G/4G"
    print(f"  {inst}: render-5/30fps/fast, muted; {heap}")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("instances", nargs="*",
                    help="instance names (default: every known *_bot_* instance)")
    targets = ap.parse_args().instances
    if not targets:
        # Strict read: a corrupt mc-bots.json must not silently shrink the default set to the
        # instances dir alone (the forgiving load() reads it as empty).
        try:
            registry = fleet_registry.load_strict()
        except fleet_registry.RegistryUnreadable as e:
            sys.exit(f"tune: can't derive the default bot set: {e}")
        targets = default_targets(local_config.instances_root(), registry,
                                  local_config.get("humanInstance", "Monifactory"))
    print("Tuning bot instances (stop the bot first — a running MC clobbers options.txt on quit):")
    ok = all(tune(t) for t in targets)
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
