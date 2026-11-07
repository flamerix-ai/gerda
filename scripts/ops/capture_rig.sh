#!/usr/bin/env bash
# capture_rig.sh — record a Minecraft client as video WITHOUT putting anything on the user's
# monitor. The game runs inside an INDEPENDENT headless Wayland compositor (sway, off-screen
# output HEADLESS-1); wf-recorder reads that output. The desk is never touched: no fullscreen
# on a physical monitor, no window focus stolen, no view popping up. The camera is a SEPARATE
# client on its own instance/account — nothing here touches the live fleet or the human's
# playing instance.
#
#   nix develop .#capture -c scripts/ops/capture_rig.sh -a <account> -l <instance> [-o out.mp4]
#
#   -a account  -l instance   REQUIRED (FreesmLauncher profile + instance dir)
#   -s host:port              join a server after boot (else title screen)
#   -o out.mp4  -t seconds    output file / record duration (0 = until exit / Ctrl-C)
#   -R WxH  -c codec          headless resolution / encoder (default 1920x1080 libx264; fps via FPS env)
#   -H hook                   shell run once the world is ready, BEFORE recording (stage/pose/plan)
#   -K                        boot + keep the client alive, do NOT record (worker / offline run)
#   -P                        swap the instance to the CAPTURE options profile for this run
#                             (no view-bob / no FOV pulse / brighter gamma …), restore on exit
#
# Needs the `capture` devShell (sway, wf-recorder, ffmpeg, grim, python3) — run via
# `nix develop .#capture -c ...`, NOT the default shell.
#
# ─────────────────────────────────────────────────────────────────────────────────────────
# CAPTURE MODEL — settled after a supervised bake-off on the RTX 4070 (proprietary
# NVIDIA driver). The requirement that drove the design: recording must run in the BACKGROUND,
# invisible to whoever is at the desk — no fullscreen takeover, no refocus flicker.
#
#  • WHY NOT gamescope→PipeWire. gamescope renders modded Monifactory fine on NVIDIA, but its
#    auto-published PipeWire node is BLACK on the proprietary driver: `zero modifiers for DRM
#    format …`, node stuck `state: "suspended"` — an unfixable DMA-BUF export wall
#    (gamescope#477, drivers 515→580, both backends). The whole gamescope+GStreamer path is GONE.
#
#  • WHY NOT record the real niri desktop. wf-recorder off the physical niri output works, but
#    to frame the game it must be fullscreened on a monitor the human is looking at — a takeover
#    of the operator's desktop the rig is designed never to need. niri also has NO headless backend (Smithay: tty + winit only),
#    and a niri-nested window is frame-callback-THROTTLED when off the visible viewport, so a
#    nested niri starves wf-recorder. niri cannot host a truly-invisible capture.
#
#  • WHAT WORKS — independent headless sway. sway has a wlroots HEADLESS backend: an off-screen
#    output that renders nothing on any monitor. wlr-screencopy of that output exports NON-BLACK
#    on proprietary NVIDIA (the gamescope DMA-BUF wall does not apply to the shm/screencopy path).
#    We start sway FIRST (WLR_BACKENDS=headless, --unsupported-gpu, `xwayland enable`), then launch
#    MC into it through XWAYLAND (DISPLAY set to sway's Xwayland — NOT native Wayland; see the
#    Phase 3 comment for why the modded client crashes on native Wayland), and wf-recorder reads
#    HEADLESS-1. sway still composites the X window onto HEADLESS-1, so capture is identical.
#    Nothing is ever shown to the user; recording never needs focus, so it cannot fight the person
#    at the desk. We use sway (not cage/`gamescope --`) because it is an INDEPENDENT compositor:
#    freesmlauncher fork-detaches the game, so any wrapper that owns the launcher as its child dies
#    ("Primary child shut down"). sway outlives the launcher.
#
#  • THE @60Hz GOTCHA (critical). A headless output created with a bare `mode WxH` gets
#    refresh:0 — no vblank clock, so the compositor emits NO frame callbacks, so the client
#    renders ONE frame and blocks. wf-recorder then starves at a single frame. The output MUST
#    carry an explicit refresh (`mode WxH@60Hz`) so frame callbacks flow and the client renders
#    continuously. This is why an earlier headless attempt captured exactly 1 frame.
#
#  • WHY wf-recorder over gpu-screen-recorder. Both can NVENC. wf-recorder is a single
#    wlr-screencopy binary needing NO root / NO setcap / NO portal picker; gsr's Wayland monitor
#    capture needs a privileged gsr-kms-server (cap_sys_admin) or a portal grant. Ease-for-a-fork
#    was the deciding criterion.
# ─────────────────────────────────────────────────────────────────────────────────────────
set -euo pipefail

FPS="${FPS:-60}"
RES="${RES:-1920x1080}"                 # headless output resolution
SERVER="${SERVER:-}"                    # empty = title screen (no server join); else host:port
CODEC="${CODEC:-}"                      # force encoder; empty = auto (h264_nvenc → libx264)
DURATION="${DURATION:-0}"               # record N seconds then stop; 0 = until game exits / Ctrl-C
HOOK="${HOOK:-}"                         # -H: shell run once the world is ready, BEFORE recording
NORECORD="${NORECORD:-0}"               # -K: boot + keep the client alive, do NOT record
PROFILE="${PROFILE:-0}"                 # -P: swap in the capture options profile for this run
OUT="capture_$(date +%Y%m%d_%H%M%S).mp4"
ACCOUNT="" INSTANCE=""

usage() { sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }
while getopts "a:l:o:s:R:c:t:H:KPh" opt; do
  case "$opt" in
    a) ACCOUNT="$OPTARG" ;;
    l) INSTANCE="$OPTARG" ;;
    o) OUT="$OPTARG" ;;
    s) SERVER="$OPTARG" ;;
    R) RES="$OPTARG" ;;
    c) CODEC="$OPTARG" ;;
    t) DURATION="$OPTARG" ;;
    H) HOOK="$OPTARG" ;;
    K) NORECORD=1 ;;
    P) PROFILE=1 ;;
    h) usage 0 ;;
    *) usage 1 ;;
  esac
done
[ -n "$ACCOUNT" ] && [ -n "$INSTANCE" ] || { echo "capture_rig: -a <account> and -l <instance> are required" >&2; usage 1; }

for bin in sway swaymsg wf-recorder ffmpeg freesmlauncher python3; do
  command -v "$bin" >/dev/null || { echo "capture_rig: '$bin' not found — are you in 'nix develop .#capture'?" >&2; exit 1; }
done

# List KERNEL-LIVE wayland sockets, NOT socket FILES on disk. A SIGKILL'd compositor leaves its
# wayland-N file behind; a file-glob would then see a "socket" nobody is bound to and a
# before/after diff would miss the one sway really creates (it rebinds the same name). /proc/net/unix
# lists only sockets actually bound in the kernel — the path is the last field when a socket is named.
_wl_sockets() { awk 'NR>1 && $NF ~ /\/wayland-[0-9]+$/ {print $NF}' /proc/net/unix | sort -u; }
# Same idea for sway's IPC socket, keyed on OUR sway's pid (sway names it sway-ipc.<uid>.<pid>.sock).
# With a second rig up (worker + camera) an unkeyed pick returned the OTHER rig's socket: the camera
# then launched MC on the worker's Xwayland and its cleanup `swaymsg exit` killed the worker's sway.
_sway_ipc()  { awk -v pid="$SWAY_PID" 'NR>1 && $NF ~ ("/sway-ipc\\.[0-9]+\\." pid "\\.sock$") {print $NF}' /proc/net/unix | sort -u | tail -1; }

# walk the sway tree for the MC game window (never freesmlauncher's own Qt window)
_find_mc_con() {
  swaymsg -s "$SWAYSOCK" -t get_tree 2>/dev/null | python3 -c '
import sys, json
def walk(n, acc):
    acc.append(n)
    for c in n.get("nodes", []) + n.get("floating_nodes", []): walk(c, acc)
try: t = json.load(sys.stdin)
except Exception: sys.exit(0)
acc = []; walk(t, acc)
for n in acc:
    name = (n.get("name") or ""); app = (n.get("app_id") or "")
    cls = ((n.get("window_properties") or {}).get("class") or "")
    s = (name + " " + app + " " + cls).lower()
    if ("minecraft" in s or "lwjgl" in s or "monifactory" in s) and "freesm" not in s:
        print(n.get("id")); break
'
}

# ── safety: never co-launch over a client that might be the human's ────────────────────────
# A same-name offline login KICKS the human. Match ONLY the launcher CLIENT signature
# `org.prismlauncher.EntryPoint`: it is present in every Prism/Freesm game client and in
# NOTHING else on this box — NOT the dedicated server (a bare `nogui` forge JVM, no
# EntryPoint), NOT a containerised Stirling-PDF (never comm==java heuristics), NOT our own
# shell/argv. Do NOT re-add `net.minecraft` / `/instances/.*/minecraft` here: the former's
# `.` matched `net/minecraftforge` in the SERVER's classpath, so filming ALWAYS false-tripped
# with only the server up and needed ALLOW_CONCURRENT=1 as a workaround (teardown.sh keys on
# the same EntryPoint token for exactly this reason). Only our own uid.
if pgrep -u "$(id -u)" -af 'org.prismlauncher.EntryPoint' 2>/dev/null | grep -qv "$0"; then
  echo "capture_rig: a Minecraft CLIENT appears to be running already." >&2
  echo "  Verify it is NOT the human's client before launching (a same-name login kicks them)." >&2
  echo "  (The dedicated SERVER is fine — this only matches launcher clients, not the server JVM.)" >&2
  echo "  Set ALLOW_CONCURRENT=1 to proceed anyway (expected when booting the camera over our own worker)." >&2
  [ "${ALLOW_CONCURRENT:-0}" = "1" ] || exit 1
fi

INST_ROOT="$(python3 "$(dirname "$0")/../local_config.py" instances_root)"
LOG="$INST_ROOT/$INSTANCE/minecraft/logs/latest.log"

SWAY_PID="" SWAY_WD="" SWAYSOCK="" WF_PID="" CONF="" PROFILE_APPLIED=0
CAPPROF="$(dirname "$0")/capture_profile.py"
MC_CLIENTS="$(dirname "$0")/../rig/mc_clients.sh"

# PIDs of live launcher clients for one instance — the ONLY safe way to ask "is my client still
# up?" from a script whose own argv names that instance. `pgrep -f "$INSTANCE"` self-matches:
# the keep-alive loop then waited on ITSELF and never exited (so cleanup, and with it the
# options-profile restore, never ran), and the cleanup kill signalled its own shell. mc_clients.sh
# keeps the match token inside the file and reads /proc (comm==java + EntryPoint), never pgrep.
_clients() { "$MC_CLIENTS" "$1" 2>/dev/null | cut -f1; }
cleanup() {
  # SIGINT lets wf-recorder flush the mp4 trailer (writes the moov atom). If it's cut short the
  # clip is unplayable/truncated. A recorder starved on a STATIC final frame (no new damage to
  # wake its capture loop) can be slow to notice the signal, so give finalisation a generous 15s
  # before the SIGKILL backstop. On real gameplay (constant motion) the trailer lands in <1s;
  # the wide window only matters when recording ended on a frozen frame (e.g. the idle menu).
  [ -n "$WF_PID" ] && kill -INT "$WF_PID" 2>/dev/null || true
  [ -n "$WF_PID" ] && { for _ in $(seq 1 75); do kill -0 "$WF_PID" 2>/dev/null || break; sleep 0.2; done; }
  [ -n "$WF_PID" ] && kill -0 "$WF_PID" 2>/dev/null && kill -KILL "$WF_PID" 2>/dev/null || true
  # Kill only OUR client. Via mc_clients.sh, NEVER `pgrep -f "$INSTANCE|…"`: that pattern is in
  # THIS script's own argv (-l <instance>), so pgrep matched capture_rig itself and cleanup
  # SIGKILLed its own shell (the exit-144 footgun). mc_clients.sh reads /proc and keys on
  # comm==java + the EntryPoint token, so it can only ever return real game clients.
  _clients "$INSTANCE" | while read -r p; do kill -TERM "$p" 2>/dev/null || true; done
  sleep 1
  _clients "$INSTANCE" | while read -r p; do kill -KILL "$p" 2>/dev/null || true; done
  # put the PLAYING options profile back — only after the client is really gone, since a live MC
  # rewrites options.txt on quit and would clobber the restore. --force is safe here for the same
  # reason (the guard would find no client anyway); it only stops a stale kill from wedging cleanup.
  if [ "$PROFILE_APPLIED" = 1 ]; then
    python3 "$CAPPROF" restore "$INSTANCE" --force || echo "capture_rig: WARN — options profile NOT restored; run 'capture_profile.py restore $INSTANCE'." >&2
    PROFILE_APPLIED=0
  fi
  # tear down the headless compositor (nothing on the monitor to restore — it was never shown)
  [ -n "$SWAYSOCK" ] && swaymsg -s "$SWAYSOCK" exit 2>/dev/null || true
  [ -n "$SWAY_PID" ] && kill -TERM "$SWAY_PID" 2>/dev/null || true
  [ -n "$CONF" ] && rm -f "$CONF" 2>/dev/null || true
  wait 2>/dev/null || true
  echo "capture_rig: stopped. Video: $OUT"
}
trap cleanup EXIT INT TERM

echo "capture_rig: headless sway ${RES}@60Hz  fps=$FPS  account=$ACCOUNT instance=$INSTANCE → $OUT"

# ── Phase 1: start the INDEPENDENT headless sway (nothing renders on any monitor) ───────────
CONF="$(mktemp /tmp/capture_rig_sway.XXXXXX.conf)"
{
  echo "output HEADLESS-1 mode ${RES}@60Hz position 0 0"   # @60Hz REQUIRED (see header gotcha)
  echo "xwayland enable"                                    # MC runs via Xwayland (see Phase 3)
  echo "default_border none"
  echo "default_floating_border none"
} > "$CONF"

BEFORE="$(_wl_sockets | sort)"
env -u DISPLAY WLR_BACKENDS=headless WLR_NO_HARDWARE_CURSORS=1 WLR_RENDERER_ALLOW_SOFTWARE=1 \
  sway --unsupported-gpu -c "$CONF" >/tmp/capture_rig_sway.$$.log 2>&1 &
SWAY_PID=$!

for _ in $(seq 1 30); do
  NEW="$(comm -13 <(echo "$BEFORE") <(_wl_sockets | sort) | head -1)"
  [ -n "$NEW" ] && { SWAY_WD="$(basename "$NEW")"; break; }
  sleep 1
done
[ -n "$SWAY_WD" ] || { echo "capture_rig: headless sway did not come up." >&2; tail -20 /tmp/capture_rig_sway.$$.log >&2; exit 1; }
for _ in $(seq 1 15); do SWAYSOCK="$(_sway_ipc)"; [ -n "$SWAYSOCK" ] && break; sleep 1; done
[ -n "$SWAYSOCK" ] || { echo "capture_rig: could not find sway IPC socket." >&2; exit 1; }
echo "capture_rig: headless compositor up — WAYLAND_DISPLAY=$SWAY_WD"
export WAYLAND_DISPLAY="$SWAY_WD"        # sway/wf-recorder target from here on
sleep 2

# Discover sway's Xwayland DISPLAY (:N). A command run via `swaymsg exec` inherits sway's full
# environment, so it sees the DISPLAY sway assigned when it brought Xwayland up. We launch MC
# against THIS X display (Phase 3) instead of native Wayland — see the header for why.
XWL_DISPLAY=""
XDISP_F="$(mktemp /tmp/capture_rig_xdisp.XXXXXX)"; : > "$XDISP_F"
swaymsg -s "$SWAYSOCK" exec "sh -c 'printf %s \"\$DISPLAY\" > $XDISP_F'" >/dev/null 2>&1 || true
for _ in $(seq 1 20); do [ -s "$XDISP_F" ] && { XWL_DISPLAY="$(cat "$XDISP_F")"; break; }; sleep 0.5; done
rm -f "$XDISP_F"
[ -n "$XWL_DISPLAY" ] || { echo "capture_rig: sway did not provide an Xwayland DISPLAY (is xwayland built in?)." >&2; exit 1; }
echo "capture_rig: Xwayland DISPLAY=$XWL_DISPLAY"

# ── Phase 2: encoder. Default libx264 (proven headless on NVIDIA); NVENC is opt-in via -c. ──
# We deliberately do NOT auto-probe NVENC. Probing HEADLESS-1 before MC is up records sway's
# STATIC black background (zero damage), and a starved wf-recorder blocks on its first-frame
# wait and goes DEAF to SIGINT — a `timeout -sINT` never lands, so the probe wedges the whole
# rig (observed). libx264 encodes 1080p60 headless reliably; pass `-c h264_nvenc`
# only once you've confirmed NVENC works on your driver.
ENC="${CODEC:-libx264}"
echo "capture_rig: encoder = $ENC"

# ── Phase 3: launch the camera client via Xwayland INTO headless sway ────────────────────────
# CRITICAL: run MC through X11/Xwayland (DISPLAY set), NOT native Wayland. The modded client's
# main window is wrapped by borderless/window-position mixins (chloride BorderlessMixin,
# embeddium, oculus) that call glfwSetWindowPos — UNSUPPORTED on Wayland, so LWJGL's GLFW throws
# "GLFW error before init: Wayland: The platform does not provide the window position" and MC
# crashes at the FML-loader→main-window handoff (observed: a native-Wayland launch
# only ever renders the fmlearlydisplay screen, then dies). With DISPLAY pointing at sway's
# Xwayland, GLFW uses its X11 backend where window positioning works; sway composites the X
# window onto HEADLESS-1 all the same, so capture is unaffected. WAYLAND_DISPLAY stays set so the
# launcher's own Qt UI can use Wayland — only the game needs X11.
# -P: swap in the capture options profile BEFORE the client boots (MC reads options.txt once, at
# startup) and restore it in cleanup(). Fatal on failure: silently filming on the playing profile
# is exactly the bug this flag exists to kill (view-bob reads as camera shake, gamma 0.5 turns a
# mine shaft into a black smear) — and you only find out after the take.
if [ "$PROFILE" = 1 ]; then
  echo "capture_rig: applying CAPTURE options profile to $INSTANCE"
  python3 "$CAPPROF" apply "$INSTANCE"
  PROFILE_APPLIED=1
fi

[ -n "$SERVER" ] && SRV_ARG=(-s "$SERVER") || SRV_ARG=()
echo "capture_rig: launching camera client into headless sway (via Xwayland $XWL_DISPLAY)…"
LAUNCH_TS="$(date +%s)"
env DISPLAY="$XWL_DISPLAY" WAYLAND_DISPLAY="$SWAY_WD" \
  freesmlauncher -a "$ACCOUNT" -l "$INSTANCE" "${SRV_ARG[@]}" >/dev/null 2>&1 &

# ── Phase 4: wait for the game to be READY — from the LOG, focus-free ────────────────────────
# Match ONLY ModernFix's "Game took N seconds to start" (fires at the MAIN MENU). Do NOT also
# match "Setting user:" — that logs mid-boot while Forge is still on its fmlearlydisplay window,
# and that early GLFW window is DESTROYED at the loading→menu handoff. If we start recording on
# it, the con we fullscreened vanishes a few seconds in and HEADLESS-1 falls back to sway's black
# background (observed: a red "Loading bootstrap resources" clip that went black at
# ~6.5s). Waiting for the menu marker means the window we grab is the stable main one.
echo "capture_rig: waiting for the client to reach the menu (reading $LOG)…"
# Only THIS launch's log counts: until the new client rotates latest.log, the file on disk is the
# previous run's, and its old marker would end the wait at once (the keep-alive below then finds
# no client and tears the rig down).
READY=0
for _ in $(seq 1 150); do            # up to ~5 min for a cold modded boot
  if [ "$(stat -c %Y "$LOG" 2>/dev/null || echo 0)" -ge "$LAUNCH_TS" ] \
    && grep -aq 'Game took .* seconds to start' "$LOG" 2>/dev/null; then READY=1; break; fi
  sleep 2
done
[ "$READY" = 1 ] || echo "capture_rig: WARN — never saw the game-ready log marker; recording anyway." >&2

# ── Phase 5: find the MC window in sway and fullscreen it INSIDE HEADLESS-1 (off-screen) ─────
MCWIN=""
for _ in $(seq 1 40); do MCWIN="$(_find_mc_con)"; [ -n "$MCWIN" ] && break; sleep 2; done
if [ -n "$MCWIN" ]; then
  echo "capture_rig: MC window con_id=$MCWIN → fullscreen inside headless sway"
  swaymsg -s "$SWAYSOCK" "[con_id=$MCWIN]" fullscreen enable >/dev/null 2>&1 || true
  sleep 2
else
  echo "capture_rig: WARN — never located the MC window in sway; recording HEADLESS-1 as-is." >&2
fi

# ── Phase 5b: optional READY hook — stage the scene / pose the camera / start the plan ───────
# Runs once the world window exists, BEFORE recording, so scene-drive lines up with frame 0.
# The hook inherits the live env; we also export the compositor coordinates it needs to drive
# wf-recorder or swaymsg itself (e.g. scripts/rig/record.sh reads CAM_WAYLAND). A hook failure
# is a WARNING, not fatal — a take on a half-staged scene beats aborting the whole boot.
if [ -n "$HOOK" ]; then
  echo "capture_rig: READY hook → $HOOK"
  CAM_WAYLAND="$SWAY_WD" CAM_SWAYSOCK="$SWAYSOCK" CAM_XDISPLAY="$XWL_DISPLAY" \
  MC_INSTANCE="$INSTANCE" MC_LOG="$LOG" \
    bash -c "$HOOK" || echo "capture_rig: WARN — READY hook returned non-zero." >&2
fi

# ── Phase 6: record HEADLESS-1 (or, with -K, just keep the client alive). Off-screen throughout. ─
if [ "$NORECORD" = 1 ]; then
  echo "capture_rig: -K keep-alive (no recording) — client is up on HEADLESS-1 ${RES}@60Hz."
  if [ "$DURATION" -gt 0 ]; then
    sleep "$DURATION"
  else
    while [ -n "$(_clients "$INSTANCE")" ]; do sleep 2; done
  fi
else
  echo "capture_rig: recording ($ENC) → $OUT   [$([ "$DURATION" -gt 0 ] && echo "${DURATION}s" || echo 'Ctrl-C to stop')]"
  # -D/--no-damage is LOAD-BEARING (mirrors scripts/rig/record.sh). wf-recorder is damage-driven by
  # default: it grabs the first screencopy frame then only pulls another when a client COMMITS a new
  # buffer, so a static/wedged MC (menu, frozen pose, GUI-hidden still) starves it at ONE frame → a
  # ~261-byte header-only mp4. -D pulls a frame every output refresh regardless → constant framerate.
  wf-recorder -D -o HEADLESS-1 -c "$ENC" -r "$FPS" -f "$OUT" 2>"/tmp/capture_rig_wf.$$.err" &
  WF_PID=$!
  # Fail-loud frame guard — BACKSTOP now that -D is in place (record.sh explains -D).
  # With -D a static scene still records, so a 0-byte result means the
  # OUTPUT itself is stuck (sway dead / wrong -o name / mode not @60Hz), NOT resolution and NOT
  # leaked procs. Catch it fast instead of after the whole roll. SKIP for a throwaway /dev/null sink
  # (size is always 0 — e.g. the film flow, where the -H hook owns the real recording; use -K).
  if [ "$OUT" != /dev/null ]; then
    sleep 5
    WFSZ="$(stat -c%s "$OUT" 2>/dev/null || echo 0)"
    if [ "$WFSZ" -lt 51200 ]; then
      echo "capture_rig: NO FRAMES — $OUT is ${WFSZ}B after 5s; wf-recorder is alive but the" >&2
      echo "  headless output never refreshed. Should NOT happen with -D — the output is stuck:" >&2
      echo "  check 'swaymsg -s $SWAYSOCK -t get_outputs' (HEADLESS-1 present, @60Hz). wf stderr:" >&2
      cat "/tmp/capture_rig_wf.$$.err" 2>/dev/null >&2
      exit 1
    fi
    echo "capture_rig: frames flowing (${WFSZ}B) — recording continues."
  fi
  if [ "$DURATION" -gt 0 ]; then
    sleep "$DURATION"
  else
    # roll until the camera client exits (or Ctrl-C → trap finalises the file)
    while [ -n "$(_clients "$INSTANCE")" ]; do sleep 2; done
  fi
fi
# cleanup() (EXIT trap) SIGINTs wf-recorder to finalise the mp4, kills the client, tears down sway.
