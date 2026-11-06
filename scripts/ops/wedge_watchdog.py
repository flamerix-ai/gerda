#!/usr/bin/env python3
"""Detect + recover the CLIENT-RESPAWN WEDGE (the `level=null` limbo), host-side.

THE FAULT: a real headless death + scripted respawn can
wedge the MC CLIENT at `mc.level == null` / `mc.player == null` — the bridge still answers
(jsMacros is alive) and the SERVER still holds the player, but the client never materialises
the world. It just sits in login-limbo forever. No in-game/jeval fix clears it; the world must
be reloaded (disconnect → reconnect), and if even that fails, the instance must be relaunched.

This watchdog lives ENTIRELY host-side (outside the kernel/bundle — a process fault is not a
game-state one, so it must not entangle with the in-game safety tiers). It:
  1. polls the bridge for `{level, player}`;
  2. classifies: healthy (level present) / WEDGE (bridge ok but level=null) / bridge-down;
  3. after `--confirm` consecutive WEDGE polls, runs the documented recovery:
        Client.disconnect() → wait → Client.connect(<server>)   (a world reload)
     then waits `--load-wait` for the world to come back and re-checks;
  4. escalates to a RELAUNCH only if `--auto-relaunch` is set (disruptive — spawns a fresh
     16GB JVM), else prints the exact manual relaunch recipe and keeps watching with backoff.

The reconnect is the SAME sequence proven live; the relaunch is intentionally OPT-IN so the
watchdog never kills a heavy client process on its own without the operator asking for it.

Usage:
  # one-shot check (for cron / a supervisor):
  python scripts/ops/wedge_watchdog.py --port 55545 --once
  # continuous watch, auto disconnect/reconnect on a confirmed wedge:
  python scripts/ops/wedge_watchdog.py --port 55545 --server localhost:25565
  # …and auto-relaunch the instance if reconnect can't clear it:
  python scripts/ops/wedge_watchdog.py --port 55545 --auto-relaunch Monifactory_bot_1
"""
from __future__ import annotations

import argparse
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # scripts/ root
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "mcp"))  # mcp/ -> canonical bridge_client
from bridge_client import BridgeClient  # noqa: E402

# jeval that reports the wedge signal via the jsMacros FACADE — NEVER raw Minecraft fields.
# WHY (a phantom-wedge bug that burned hours): `Client.getMinecraft().level` / `.player` /
# `.screen` are SRG-obfuscated fields (`f_91073_` etc.). GraalJS resolves Java fields by their
# REAL (SRG) name, so `mc.level` accessed by the Mojang name is `undefined` — and in JS
# `undefined != null` is FALSE, so every probe reported level=null unconditionally (a phantom
# wedge) regardless of whether the world was loaded. `Player.getPlayer()` and
# `Hud.getOpenScreenName()` are SRG-free jsMacros facades and report the TRUE state.
#   inWorld=true                     -> healthy (Player present)
#   inWorld=false, screen name set   -> AT_MENU (parked on TitleScreen/Join — don't touch)
#   inWorld=false, screen null/empty -> WEDGE  (the level=null limbo we target)
_PROBE = (
    "JSON.stringify({"
    "inWorld: Player.getPlayer()!=null,"
    "screen: Hud.getOpenScreenName()"
    "});"
)

HEALTHY, WEDGE, AT_MENU, BRIDGE_DOWN, UNKNOWN = (
    "healthy",
    "wedge",
    "at_menu",
    "bridge_down",
    "unknown",
)


def probe(b: BridgeClient) -> tuple[str, dict]:
    """One classification: (state, detail). Never raises — a dead bridge is a state, not a crash."""
    try:
        resp = b.send("jeval", {"code": _PROBE})
    except (TimeoutError, ConnectionError, OSError) as e:
        return BRIDGE_DOWN, {"error": str(e)}
    if not resp.get("ok"):
        return UNKNOWN, {"error": resp.get("error", resp)}
    try:
        import json

        data = json.loads(resp.get("data") or "{}")
    except (ValueError, TypeError):
        return UNKNOWN, {"raw": resp.get("data")}
    if data.get("inWorld"):
        return HEALTHY, data  # Player.getPlayer() present → really in the world
    # Not in world. Distinguish the true limbo (no screen at all) from a client parked on a menu.
    if data.get("screen"):
        return AT_MENU, data  # a real screen name (title/join) → deliberately parked; don't touch
    return WEDGE, data  # no world AND no screen → the level=null limbo we target


def reconnect(b: BridgeClient, server: str, disconnect_wait: float) -> None:
    """The documented first-line recovery: disconnect (drop the wedged session) → reconnect."""
    host, _, port_s = server.partition(":")
    port = int(port_s) if port_s else 25565
    b.send("jeval", {"code": 'Client.disconnect(); "disconnecting";'})
    time.sleep(disconnect_wait)  # let the server register the drop before we rejoin
    b.send("jeval", {"code": f'Client.connect("{host}", {port}); "connecting";'})


def find_pid(instance: str) -> int | None:
    """PID of the running FreesmLauncher instance (matched on its natives path), or None."""
    try:
        out = subprocess.run(
            ["pgrep", "-f", f"instances/{instance}/"],
            capture_output=True,
            text=True,
            check=False,
        ).stdout
    except OSError:
        return None
    for line in out.split():
        if line.strip().isdigit():
            return int(line.strip())
    return None


def relaunch(instance: str, launcher: str) -> bool:
    """Kill the wedged instance and re-launch it via the FreesmLauncher CLI. Disruptive — only
    called under --auto-relaunch. Returns True if the launch command was issued."""
    pid = find_pid(instance)
    if pid:
        print(f"wedge_watchdog: killing wedged instance {instance} (pid {pid})")
        subprocess.run(["kill", str(pid)], check=False)
        time.sleep(3)
    try:
        subprocess.Popen(
            [launcher, "-l", instance],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except OSError as e:
        print(f"wedge_watchdog: relaunch failed to spawn {launcher}: {e}", file=sys.stderr)
        return False
    print(f"wedge_watchdog: relaunched {instance} via {launcher}")
    return True


def manual_recipe(port: int, instance: str | None) -> None:
    inst = instance or "<Monifactory_bot_N>"
    print(
        "wedge_watchdog: reconnect did NOT clear the wedge — the client needs a RELAUNCH.\n"
        f"  Manual recipe (or re-run with --auto-relaunch {inst}):\n"
        f"    1) restart instance '{inst}' in the FreesmLauncher window (or: kill its PID +\n"
        f"       `freesmlauncher -l {inst}`),\n"
        f"    2) wait for the world to load, then verify: the bridge on :{port} reports level!=null.",
        file=sys.stderr,
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=55545)
    ap.add_argument("--host", default=None)
    ap.add_argument("--server", default="localhost:25565", help="game server to reconnect to")
    ap.add_argument("--interval", type=float, default=20.0, help="poll seconds between checks")
    ap.add_argument("--confirm", type=int, default=3, help="consecutive WEDGE polls before acting")
    ap.add_argument("--disconnect-wait", type=float, default=4.0)
    ap.add_argument("--load-wait", type=float, default=60.0, help="seconds to let the world reload")
    ap.add_argument("--auto-relaunch", metavar="INSTANCE", default=None,
                    help="FreesmLauncher instance to kill+relaunch if reconnect fails (disruptive)")
    ap.add_argument("--launcher", default="freesmlauncher")
    ap.add_argument("--timeout", type=float, default=10.0)
    ap.add_argument("--once", action="store_true", help="check once and exit (0 healthy, 3 wedged)")
    args = ap.parse_args()

    b = BridgeClient(host=args.host, port=args.port, timeout=args.timeout)

    if args.once:
        state, detail = probe(b)
        print(f"wedge_watchdog: {state} {detail}")
        # 0 = fine (in-world OR deliberately parked at a menu); 2 = bridge down; 3 = WEDGE; 4 = unknown
        return {HEALTHY: 0, AT_MENU: 0, BRIDGE_DOWN: 2, WEDGE: 3}.get(state, 4)

    wedge_streak = 0
    while True:
        state, detail = probe(b)
        if state == HEALTHY:
            if wedge_streak:
                print("wedge_watchdog: recovered — world present again")
            wedge_streak = 0
        elif state == WEDGE:
            wedge_streak += 1
            print(f"wedge_watchdog: WEDGE {wedge_streak}/{args.confirm} {detail}")
            if wedge_streak >= args.confirm:
                print("wedge_watchdog: confirmed wedge → disconnect/reconnect")
                reconnect(b, args.server, args.disconnect_wait)
                time.sleep(args.load_wait)
                after, _ = probe(b)
                if after == HEALTHY:
                    print("wedge_watchdog: reconnect cleared the wedge")
                    wedge_streak = 0
                elif args.auto_relaunch:
                    relaunch(args.auto_relaunch, args.launcher)
                    time.sleep(args.load_wait)  # give the fresh client time to boot before re-polling
                    wedge_streak = 0
                else:
                    manual_recipe(args.port, args.auto_relaunch)
                    wedge_streak = 0  # reset so we don't thrash reconnects; keep watching with backoff
                    time.sleep(args.interval * 3)  # backoff after a failed recovery
        else:  # AT_MENU / BRIDGE_DOWN / UNKNOWN — not the limbo wedge (parked, or not answering)
            print(f"wedge_watchdog: {state} {detail} (not the level=null limbo; leaving alone)")
            wedge_streak = 0
        time.sleep(args.interval)


if __name__ == "__main__":
    raise SystemExit(main())
