#!/usr/bin/env python3
"""sway_windows.py — which Minecraft client lives in which headless sway, and on what display.

  python3 scripts/rig/sway_windows.py list                     # every MC window sway knows about
  python3 scripts/rig/sway_windows.py fullscreen <instance>    # make that instance the recorded one
  python3 scripts/rig/sway_windows.py display [--port N]       # WAYLAND_DISPLAY of the camera's sway
  python3 scripts/rig/sway_windows.py display --check wayland-3  # is a PINNED one the camera's?

`list`/`fullscreen` are the body of scripts/rig/fullscreen.sh (moved here unchanged so `display`
can reuse the same window resolution instead of growing a second copy of it); see that script
for WHY the window choice is a compositor flip and not an options.txt setting.

MATCHING. A sway con's `name`/`class` is just "Minecraft* 1.20.1" for BOTH clients — it does
not carry the instance. So the con is resolved through its PID: /proc/<pid>/cmdline must hold
the Prism launcher entry AND the instance token, the same two-part signature teardown.sh and
mc_clients.sh use (a token never present in a shell/python argv, so nothing can self-match).

DISPLAY — the one `just shoot` records. shoot.py/record.sh need WAYLAND_DISPLAY to name the
CAMERA's headless sway, and on a shoot day there are two (the worker's `-K` boot and the
camera's each start their own), while the operator's terminal carries the DESKTOP's display,
which has no HEADLESS-1 output at all. Nothing here trusts an inherited value. The camera is
the client whose game process LISTENS on the camera bridge port (cam_port(): SHOOT_CAM_PORT or
DEFAULT_CAM_PORT, as shoot.py drives it); its window's sway is found through the tree as
above, and that sway's wayland socket through the kernel: the compositor PID is in its IPC
socket's name (`sway-ipc.<uid>.<pid>.sock`), and the `wayland-N` socket is the one whose inode
that PID holds open (/proc/net/unix x /proc/<pid>/fd). Every step that finds nothing, or more than one, exits
1 and says which step — never a guess.

Searches every live sway-ipc socket unless SWAYSOCK is set (capture_rig exports the camera's
as CAM_SWAYSOCK). swaymsg must be on PATH — run under `nix develop .#capture`.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from typing import NamedTuple

ENTRY = "org.prismlauncher.EntryPoint"
# The output record.sh/shoot.py record — a camera window anywhere else is not what they film.
RECORDED_OUTPUT = "HEADLESS-1"
DEFAULT_CAM_PORT = 55546          # the ONE home of the default; SHOOT_CAM_PORT overrides it
TCP_LISTEN = "0A"                 # /proc/net/tcp `st` column: TCP_LISTEN
SWAYMSG_TIMEOUT_S = 10            # a live sway answers IPC in milliseconds; a wedged one never
SWAY_IPC_RE = re.compile(r"/sway-ipc\.\d+\.(\d+)\.sock$")
WAYLAND_RE = re.compile(r"/(wayland-\d+)$")


def cam_port() -> int:
    """The camera bridge port: SHOOT_CAM_PORT, else DEFAULT_CAM_PORT.

    Read per call, not at import. shoot.py, sustain_live.py and this CLI all call it, so the
    default and the override live only here; shoot.sh passes no --port, the variable reaches
    this CLI's --port default through the environment. An empty or blank SHOOT_CAM_PORT counts
    as unset. Anything else that is not ASCII digits naming a port 1-65535 is refused by name,
    never a bare ValueError traceback (`str.isdigit` alone accepts '²', which int() rejects).
    """
    raw = os.environ.get("SHOOT_CAM_PORT", "").strip()
    if not raw:
        return DEFAULT_CAM_PORT
    if not (raw.isascii() and raw.isdigit()) or not 0 < int(raw) < 65536:
        raise SystemExit(f"sway_windows: SHOOT_CAM_PORT={raw!r} is not a TCP port "
                         f"(unset it for the default {DEFAULT_CAM_PORT})")
    return int(raw)


class Window(NamedTuple):
    sock: str
    con: int
    instance: str
    output: str | None
    fullscreen: bool
    pid: int


class ResolveError(Exception):
    """A resolution step found nothing (or too much) — the message names the step."""


# ── kernel tables (pure parsers + thin readers) ─────────────────────────────────────────

def parse_unix_sockets(text: str) -> list[tuple[int, str]]:
    """(inode, path) for every NAMED socket in a /proc/net/unix dump (header skipped)."""
    out = []
    for line in text.splitlines()[1:]:
        cols = line.split()
        if len(cols) >= 8:
            out.append((int(cols[6]), cols[7]))
    return out


def parse_tcp_listen_inodes(text: str, port: int) -> set[int]:
    """Inodes of LISTENING sockets bound to `port` in a /proc/net/tcp{,6} dump."""
    inodes = set()
    for line in text.splitlines()[1:]:
        cols = line.split()
        if len(cols) < 10:
            continue
        local, state, inode = cols[1], cols[3], cols[9]
        if state == TCP_LISTEN and int(local.rsplit(":", 1)[1], 16) == port:
            inodes.add(int(inode))
    return inodes


def _read(path: str) -> str:
    try:
        with open(path) as f:
            return f.read()
    except OSError:
        return ""


def socket_inodes_of(pid: int) -> set[int]:
    """Socket inodes a process holds open (`socket:[N]` fd links); empty if unreadable."""
    out = set()
    fd_dir = f"/proc/{pid}/fd"
    try:
        names = os.listdir(fd_dir)
    except OSError:
        return out
    for name in names:
        try:
            target = os.readlink(f"{fd_dir}/{name}")
        except OSError:
            continue
        if target.startswith("socket:[") and target.endswith("]"):
            out.add(int(target[8:-1]))
    return out


# ── sway ────────────────────────────────────────────────────────────────────────────────

def sockets() -> list[str]:
    """Live sway IPC sockets: SWAYSOCK if the caller pinned one, else every bound sway-ipc."""
    pinned = os.environ.get("SWAYSOCK")
    if pinned:
        return [pinned]
    return sorted({path for _inode, path in parse_unix_sockets(_read("/proc/net/unix"))
                   if "/sway-ipc." in path and path.endswith(".sock")})


def tree(sock: str) -> dict | None:
    try:
        raw = subprocess.run(["swaymsg", "-s", sock, "-t", "get_tree"],
                             capture_output=True, text=True, timeout=SWAYMSG_TIMEOUT_S)
    except (OSError, subprocess.SubprocessError):
        return None
    if raw.returncode != 0:
        return None
    try:
        return json.loads(raw.stdout)
    except ValueError:
        return None


def walk(node: dict, out: list, output: str | None = None) -> None:
    if node.get("type") == "output":
        output = node.get("name")
    out.append((node, output))
    for child in node.get("nodes", []) + node.get("floating_nodes", []):
        walk(child, out, output)


def instance_of(pid: int | None) -> str | None:
    """The launcher instance this window's process belongs to, or None if it is not a game.

    argv is split on the real NUL separators, never on spaces: an instance directory that
    contains a space would otherwise resolve to a truncated name and silently match nothing.
    """
    if not pid:
        return None
    try:
        with open(f"/proc/{pid}/cmdline", "rb") as f:
            argv = [a.decode("utf-8", "replace") for a in f.read().split(b"\0") if a]
    except OSError:
        return None
    if ENTRY not in " ".join(argv):
        return None
    for token in argv:
        # Prism passes the instance dir; take its first path segment as the instance name.
        if "/instances/" in token:
            parts = token.split("/instances/", 1)[1].split("/")
            if parts and parts[0]:
                return parts[0]
    return None


def windows() -> list[Window]:
    found = []
    for sock in sockets():
        t = tree(sock)
        if not t:
            continue
        acc: list = []
        walk(t, acc)
        for node, output in acc:
            inst = instance_of(node.get("pid"))
            if not inst:
                continue
            found.append(Window(sock, node.get("id"), inst, output,
                                bool(node.get("fullscreen_mode")), int(node["pid"])))
    return found


# ── display resolution (pure core; the readers above feed it) ───────────────────────────

def pick_camera(wins: list[Window], listen_inodes: set[int],
                inodes_of: dict[int, set[int]], port: int, sway: str | None = None) -> Window:
    """A window of the camera: an MC window whose process holds the camera bridge's LISTEN socket.

    Those windows (the hits) must all live in ONE sway, or it refuses; `sway` (the IPC socket
    serving a PINNED display) first narrows them to that sway, and refuses when the camera has no
    window there — a pin that names another client's display. Several hits in that one sway are
    NOT told apart: the FIRST in sway-tree order is returned, and only ITS output is checked
    against RECORDED_OUTPUT. Every hit shares that `sock` by then; a caller that reports the
    window's `instance`, `pid` or `output` (check_display, resolve_display) names that FIRST hit.
    """
    if not listen_inodes:
        raise ResolveError(f"nothing is LISTENING on port {port} — the camera bridge is not up "
                           f"(boot it with capture_rig.sh -K -P, see docs/RIG.md; a different "
                           f"port goes in SHOOT_CAM_PORT)")
    if not wins:
        raise ResolveError("no Minecraft client window in any live sway — is the rig up? "
                           "(a client outside a headless sway cannot be filmed by record.sh)")
    hits = [w for w in wins if inodes_of.get(w.pid, set()) & listen_inodes]
    if not hits:
        live = ", ".join(f"{w.instance}@{w.output or '?'}" for w in wins)
        raise ResolveError(f"port {port} is listening, but not from any Minecraft window in a "
                           f"headless sway (live windows: {live}) — the camera is running "
                           f"somewhere record.sh cannot film")
    if sway is not None:
        pinned = [w for w in hits if w.sock == sway]
        if not pinned:
            where = ", ".join(sorted({w.sock for w in hits}))
            raise ResolveError(f"the camera (port {port}) has no window in the sway serving the "
                               f"pinned display ({sway}); it lives in {where} — the pin names "
                               f"another client's display, and record.sh would film that one")
        hits = pinned
    socks = {w.sock for w in hits}
    if len(socks) > 1:
        raise ResolveError(f"the port-{port} client has windows in {len(socks)} sways "
                           f"({', '.join(sorted(socks))}) — pin one with CAM_WAYLAND")
    cam = hits[0]
    if cam.output != RECORDED_OUTPUT:
        raise ResolveError(f"the camera ({cam.instance}) is on output {cam.output!r}, but "
                           f"record.sh records {RECORDED_OUTPUT} — that is not a capture_rig sway")
    return cam


def wayland_display_of(sock: str, unix_sockets: list[tuple[int, str]],
                       held: set[int]) -> str:
    """The `wayland-N` whose socket the sway behind `sock` holds open."""
    ipc = SWAY_IPC_RE.search(sock)
    if not ipc:
        raise ResolveError(f"cannot read the compositor pid out of IPC socket {sock!r} "
                           f"(expected sway-ipc.<uid>.<pid>.sock)")
    sway_pid = ipc.group(1)
    # One search per path, bound by the walrus: a held socket that is not `wayland-N` (the IPC
    # socket itself, a `.lock`, an unnamed peer) is skipped, never dereferenced as a None match.
    # (A comprehension's walrus binds in THIS scope — hence its own name, never `ipc`.)
    names = {wl.group(1) for inode, path in unix_sockets
             if inode in held and (wl := WAYLAND_RE.search(path))}
    if len(names) != 1:
        raise ResolveError(f"sway pid {sway_pid} holds {len(names)} wayland sockets "
                           f"({', '.join(sorted(names)) or 'none'}) — expected exactly one; "
                           f"pin the display with CAM_WAYLAND")
    return names.pop()


def sway_serving(display: str, socks: list[str], unix_sockets: list[tuple[int, str]],
                 held_by: dict[str, set[int]]) -> str:
    """The IPC socket of the live sway that serves `display`, or ResolveError.

    The check behind a PINNED display (CAM_WAYLAND): a name that is merely bound is not enough —
    the operator's own desktop display is bound too, and it is not a sway, so record.sh would
    fail on its missing HEADLESS-1 only after shoot.py had staged the shot.
    """
    inodes = {inode for inode, path in unix_sockets
              if (m := WAYLAND_RE.search(path)) and m.group(1) == display}
    if not inodes:
        raise ResolveError(f"{display} is not a bound socket — no compositor is serving it")
    hits = [s for s in socks if held_by.get(s, set()) & inodes]
    if len(hits) != 1:
        raise ResolveError(f"{display} is served by {len(hits)} live sway(s) — it is not a "
                           f"capture_rig headless sway (the desktop compositor, or a dead rig)")
    return hits[0]


def output_names(sock: str) -> list[str]:
    """The output names of the sway behind `sock` — or ResolveError, never an empty guess.

    Every way swaymsg can fail is named rather than read as "no outputs": not runnable (OSError —
    no swaymsg, not executable), no answer in SWAYMSG_TIMEOUT_S (a wedged compositor), a non-zero
    exit (a dead IPC socket), or output that is not the JSON list sway prints.
    """
    try:
        raw = subprocess.run(["swaymsg", "-s", sock, "-t", "get_outputs"],
                             capture_output=True, text=True, timeout=SWAYMSG_TIMEOUT_S)
    except subprocess.TimeoutExpired:
        raise ResolveError(f"swaymsg get_outputs on {sock} did not answer within "
                           f"{SWAYMSG_TIMEOUT_S}s — that sway is wedged") from None
    except OSError as e:
        raise ResolveError(f"cannot run swaymsg to ask {sock} for its outputs ({e}) — run "
                           f"under 'nix develop .#capture'") from None
    if raw.returncode != 0:
        raise ResolveError(f"swaymsg get_outputs on {sock} exited {raw.returncode}: "
                           f"{raw.stderr.strip() or 'no stderr'}")
    try:
        outputs = json.loads(raw.stdout)
        return [o["name"] for o in outputs]
    except (ValueError, TypeError, KeyError):
        raise ResolveError(f"swaymsg get_outputs on {sock} printed no output list: "
                           f"{raw.stdout[:80]!r}") from None


def camera_window(port: int, sway: str | None = None) -> Window:
    """pick_camera() fed from the live system: sway windows, TCP listeners, process fds."""
    wins = windows()
    listen: set[int] = set()
    for table in ("/proc/net/tcp", "/proc/net/tcp6"):
        listen |= parse_tcp_listen_inodes(_read(table), port)
    return pick_camera(wins, listen, {w.pid: socket_inodes_of(w.pid) for w in wins}, port, sway)


def check_display(display: str, port: int) -> str:
    """Verify a PINNED display (CAM_WAYLAND, or shoot.py's WAYLAND_DISPLAY) is the camera's.

    Three things, each a named ResolveError: a live sway serves `display` (sway_serving), that
    sway has RECORDED_OUTPUT, and the client listening on the camera `port` has its window in
    that very sway — a recordable headless display of ANOTHER client (the worker's) is refused.
    """
    socks = sockets()
    held_by = {}
    for sock in socks:
        m = SWAY_IPC_RE.search(sock)
        held_by[sock] = socket_inodes_of(int(m.group(1))) if m else set()
    sock = sway_serving(display, socks, parse_unix_sockets(_read("/proc/net/unix")), held_by)
    outputs = output_names(sock)
    if RECORDED_OUTPUT not in outputs:
        raise ResolveError(f"the sway serving {display} has outputs {outputs or 'none'}, "
                           f"not {RECORDED_OUTPUT} — record.sh would have nothing to record")
    cam = camera_window(port, sway=sock)
    print(f"sway_windows: {display} is served by {sock} with {RECORDED_OUTPUT}, and holds the "
          f"camera {cam.instance} (pid {cam.pid}, port {port})", file=sys.stderr)
    return display


def resolve_display(port: int) -> str:
    cam = camera_window(port)
    sway_pid = SWAY_IPC_RE.search(cam.sock)
    held = socket_inodes_of(int(sway_pid.group(1))) if sway_pid else set()
    display = wayland_display_of(cam.sock, parse_unix_sockets(_read("/proc/net/unix")), held)
    print(f"sway_windows: camera {cam.instance} (pid {cam.pid}, port {port}) on "
          f"{cam.output} of {cam.sock} → WAYLAND_DISPLAY={display}", file=sys.stderr)
    return display


# ── CLI ─────────────────────────────────────────────────────────────────────────────────

def cmd_list_or_fullscreen(want: str | None) -> int:
    wins = windows()
    if not wins:
        print("fullscreen.sh: no Minecraft client windows found in any live sway "
              "(is the rig up? is SWAYSOCK the right compositor?)", file=sys.stderr)
        return 1

    if want is None:
        for w in wins:
            print(f"  con_id={w.con:<8} {w.instance:<24} output={w.output or '?':<12} "
                  f"fullscreen={'YES' if w.fullscreen else 'no':<3} sock={w.sock}")
        return 0

    targets = [w for w in wins if w.instance == want]
    if not targets:
        known = ", ".join(sorted({w.instance for w in wins}))
        print(f"fullscreen.sh: no window for instance '{want}' (live: {known})", file=sys.stderr)
        return 1

    # Un-fullscreen only the windows COMPETING with the target — same compositor AND same
    # output. A second rig (its own headless sway, its own camera) must never be
    # un-fullscreened mid-take because someone flipped a window over here; that would blank
    # the other recording silently.
    contested = {(w.sock, w.output) for w in targets}

    rc = 0
    for w in wins:
        if w.instance == want:
            action = "enable"
        elif (w.sock, w.output) in contested:
            action = "disable"
        else:
            continue  # another compositor/output entirely — not ours to touch
        r = subprocess.run(["swaymsg", "-s", w.sock, f"[con_id={w.con}]", "fullscreen", action],
                           capture_output=True, text=True)
        if r.returncode != 0:
            print(f"fullscreen.sh: swaymsg {action} failed for con_id={w.con} ({w.instance}): "
                  f"{r.stderr.strip()}", file=sys.stderr)
            rc = 1
        else:
            print(f"  con_id={w.con} {w.instance} on {w.output or '?'} → fullscreen {action}")
    return rc


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list", help="every MC window sway knows about")
    fs = sub.add_parser("fullscreen", help="make <instance> the window its output records")
    fs.add_argument("instance")
    dp = sub.add_parser("display", help="print the camera sway's WAYLAND_DISPLAY (wayland-N)")
    dp.add_argument("--port", type=int, default=cam_port(),
                    help=f"camera bridge port (default SHOOT_CAM_PORT or {DEFAULT_CAM_PORT})")
    dp.add_argument("--check", metavar="WAYLAND_DISPLAY",
                    help="verify a PINNED display instead of resolving one: it must be served by "
                         f"a live sway that has {RECORDED_OUTPUT} and holds the camera's window "
                         "(the client listening on --port)")
    args = ap.parse_args(argv)

    if not shutil.which("swaymsg"):
        print("sway_windows.py: swaymsg not on PATH — run under 'nix develop .#capture'",
              file=sys.stderr)
        return 1
    if args.cmd == "list":
        return cmd_list_or_fullscreen(None)
    if args.cmd == "fullscreen":
        return cmd_list_or_fullscreen(args.instance)
    try:
        print(check_display(args.check, args.port) if args.check else resolve_display(args.port))
    except ResolveError as e:
        print(f"sway_windows.py: cannot resolve the camera display: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
