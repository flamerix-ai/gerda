#!/usr/bin/env bash
# teardown.sh — kill the rig's Minecraft camera/worker clients by instance signature,
# WITHOUT the pkill/pgrep self-match footgun.
#
#   scripts/rig/teardown.sh <instance> [<instance> ...]
#
# WHY not `pkill -f`: `pkill -f Monifactory_bot_1` matches the AGENT's OWN bash argv
# (which contains that string) → the shell dies exit 144, and can cascade into killing
# the OTHER client mid-sweep. `pgrep -f … | kill` hits the same wall. Proven twice this
# session. The fix is a /proc scan in one Python process that EXPLICITLY excludes its own
# pid + ppid and matches ONLY real JVM game processes for OUR uid (never comm==java on a
# stray container JVM like Stirling-PDF — match the instance path + the launcher entry).
#
# Leaves the server and the compositor alone — only the game clients are killed. A
# same-name relaunch later re-adopts the world; nothing here touches the human instance.
#
# It ALSO restores each instance's playing options.txt if a capture profile is still applied
# (`capture_profile.py restore --if-present`, idempotent — instances that were never `-P`'d
# are a no-op). capture_rig.sh restores in its own cleanup(), but only when IT is the one that
# reaps the client: kill the client from outside (this script, a crash, a shoot day that ended
# with the rig still up) and cleanup() never runs, leaving the camera instance on gamma 1.0 /
# fov 90 / guiScale 2 the next time a human plays it. Restoring here closes that hole — and it
# must happen AFTER the kill loop, because a live MC rewrites options.txt on quit.
#
# MATCH PRECISION (learned the hard way): a victim MUST carry BOTH the Prism launcher
# entry (`org.prismlauncher.EntryPoint`, unique to the real game JVM) AND the instance
# token. Do NOT match on a bare `/minecraft` substring — the agent's own shell runs from
# a CWD under `…/minecraft/…`, so a loose match SIGTERMs the caller (exit 144). EntryPoint
# is never present in a shell/python argv, so requiring it excludes the whole agent tree.
set -uo pipefail
[ "$#" -ge 1 ] || { echo "usage: teardown.sh <instance> [<instance> ...]" >&2; exit 2; }

python3 - "$@" <<'PY'
import os, sys, signal, time

wanted = sys.argv[1:]
me, parent = os.getpid(), os.getppid()
uid = os.getuid()
# A victim is a real game JVM: it carries the Prism launcher entry AND our instance token.
# EntryPoint is absent from any shell/python argv, so the agent's own process tree (which
# runs from a CWD under …/minecraft/…) can never match — this is the anti-self-match guard.
ENTRY = "org.prismlauncher.EntryPoint"

def victims():
    out = []
    for pid_s in os.listdir("/proc"):
        if not pid_s.isdigit():
            continue
        pid = int(pid_s)
        if pid in (me, parent):
            continue
        try:
            if os.stat(f"/proc/{pid}").st_uid != uid:
                continue
            with open(f"/proc/{pid}/cmdline", "rb") as f:
                cmd = f.read().replace(b"\0", b" ").decode("utf-8", "replace")
        except (FileNotFoundError, ProcessLookupError, PermissionError):
            continue
        if ENTRY in cmd and any(inst in cmd for inst in wanted):
            out.append(pid)
    return out

hit = victims()
if not hit:
    print(f"teardown: no live clients for {wanted}")
    sys.exit(0)

print(f"teardown: SIGTERM {hit}")
for pid in hit:
    try: os.kill(pid, signal.SIGTERM)
    except ProcessLookupError: pass
for _ in range(30):
    if not victims():
        break
    time.sleep(0.5)
left = victims()
if left:
    print(f"teardown: SIGKILL {left}")
    for pid in left:
        try: os.kill(pid, signal.SIGKILL)
        except ProcessLookupError: pass
    # WAIT for the pids to actually leave /proc. Without this the profile restore below runs
    # while the wedged client is still listed, capture_profile's _guard_running refuses, the
    # SystemExit is swallowed by the `|| echo WARN`, and the profile is NOT restored — on
    # exactly the stuck client this branch exists for.
    for _ in range(20):
        if not victims():
            break
        time.sleep(0.5)
    if victims():
        print(f"teardown: WARN — still alive after SIGKILL: {victims()}")
print("teardown: done")
PY

# ── restore the playing options profile (idempotent; instances never -P'd are a no-op) ──
CAPPROF="$(dirname "$0")/../ops/capture_profile.py"
for inst in "$@"; do
  python3 "$CAPPROF" restore "$inst" --if-present \
    || echo "teardown: WARN — options profile for $inst NOT restored; run 'capture_profile.py restore $inst'." >&2
done
