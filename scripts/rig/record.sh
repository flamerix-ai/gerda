#!/usr/bin/env bash
# record.sh — record a headless-sway output to mp4 for a fixed duration, off-screen.
#
#   WAYLAND_DISPLAY=wayland-N scripts/rig/record.sh <out.mp4> <seconds> [output] [fps]
#
# Records the given sway OUTPUT (default HEADLESS-1) with wf-recorder while SOMETHING
# ELSE drives the scene (the plan loop, a mission, the camera). Optionally runs an
# $ON_START shell snippet once the recorder is confirmed rolling, so scene-drive lines
# up with frame 0. SIGINT-finalises the mp4 — wf-recorder writes the moov atom on its way
# out of the main loop — with a SIGKILL backstop.
#
# The moov atom is why the recorder's EXIT STATUS is checked and not just the file size.
# An mp4 grows on disk all through the take and only becomes READABLE at the end, so a
# recorder that dies mid-roll leaves a fat file with no index: 260 KB that no player and
# no ffprobe will open ("moov atom not found"). Measured — wf-recorder
# took a `Bus error (core dumped)` right after "frames flowing (262192B)", this script
# went on to print "finalising" and "done → …01_clutch.mp4 (260K)" and exited 0, and
# shoot.py filed the dud as `01_clutch ok`. So: `wait` the recorder, and treat anything
# but a clean rc=0 as a FAILED take. A SIGKILL backstop (137) and death BY SIGINT (130,
# i.e. the handler never ran) are failures for the same reason — no handler, no moov.
# The clean-SIGINT code is NOT measured directly: the pinned wf-recorder 0.6.0 store path
# ships a bare bin/ (no docs, no source to read), so 0 is ASSUMED from the six shipped takes,
# every one of which exited 0 after this script's SIGINT. Re-measure on a wf-recorder bump.
#
# WHY a wrapper at all: wf-recorder + swaymsg are NOT on the agent default PATH (they
# live in the nix store); a truly-headless output needs @60Hz or frame callbacks stall
# (see scripts/ops/capture_rig.sh header). This bakes the proven invocation so a take is
# one command, not a hand-assembled pipe.
#
# ENV:
#   WAYLAND_DISPLAY   REQUIRED — the sway compositor serving the MC camera (e.g. wayland-2).
#                     Find it: for the operator camera it is printed by capture_rig.sh, or
#                     resolve it with `scripts/rig/sway_windows.py display` (the camera client's sway).
#   ON_START          optional shell run once the recorder is up (e.g. a plan_start curl).
#   WFREC             override the wf-recorder binary (else PATH — the capture devShell).
set -uo pipefail

OUT="${1:?usage: record.sh <out.mp4> <seconds> [output] [fps]}"
DUR="${2:?seconds required}"
OUTPUT="${3:-HEADLESS-1}"
FPS="${4:-60}"
: "${WAYLAND_DISPLAY:?set WAYLAND_DISPLAY to the camera sway display, e.g. wayland-2}"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"

# WFREC, else PATH — nothing else. There used to be a third leg, a hard-coded /nix/store path "for
# the agent shell", and it was garbage-collected out from under the script (absent): a
# fallback that silently rots is a promise the script cannot keep. `just shoot` runs inside the
# capture devShell, where wf-recorder IS on PATH.
WFREC="${WFREC:-$(command -v wf-recorder || true)}"
[ -n "$WFREC" ] && [ -x "$WFREC" ] || { echo "record.sh: wf-recorder not found (${WFREC:-not on PATH}) — run under 'nix develop .#capture' (just shoot does) or set WFREC" >&2; exit 1; }
ERR="$(mktemp "${TMPDIR:-/tmp}/rig_wf.XXXXXX.err")"

# -D/--no-damage is LOAD-BEARING, not a tweak. wf-recorder is damage-driven by default: it
# grabs the initial screencopy frame, then only pulls a new one when a client COMMITS a new
# buffer. On a headless output whose MC has gone static — a menu-wedge, a frozen camera pose
# before the scene drives, GUI hidden on a still frame — nothing commits, the output never
# repaints, and wf-recorder starves at ONE frame → a ~261-byte header-only mp4 (the "zero-frame
# dud"). `-r` only sets the ENCODER rate; it does NOT force capture. `-D` makes wf-recorder pull
# a frame every output refresh regardless of damage → constant framerate even on a static scene.
# Proven on this box (RTX 4070, NVIDIA): a static swaybg output gave 261 B without -D and
# 356 frames/6s WITH it.
echo "record.sh: $WFREC -D -o $OUTPUT -c libx264 -r $FPS -f $OUT   (WAYLAND_DISPLAY=$WAYLAND_DISPLAY, ${DUR}s)"
"$WFREC" -D -o "$OUTPUT" -c libx264 -r "$FPS" -f "$OUT" 2>"$ERR" &
WF=$!
sleep 2
if ! kill -0 "$WF" 2>/dev/null; then
  echo "record.sh: wf-recorder died immediately:" >&2; cat "$ERR" >&2; rm -f "$ERR"; exit 1
fi

if [ -n "${ON_START:-}" ]; then
  echo "record.sh: ON_START hook"; bash -c "$ON_START" || echo "record.sh: WARN ON_START returned non-zero" >&2
fi

# Fail-loud frame guard — a BACKSTOP now that -D is in place. Root cause of the historic
# "zero-frame dud" (a header-only ~261-byte mp4) is understood: wf-recorder without -D starves
# when the headless output stops committing buffers (see the -D note above). With -D a static
# scene still records, so this guard should almost never fire. If it DOES fire despite -D, the
# output itself is not refreshing — sway for this display is dead/misconfigured, the -o OUTPUT
# name is wrong, or WAYLAND_DISPLAY points at the wrong compositor. The scene is driving now
# (ON_START ran) — poll up to ~14s (the first frame can lag a few seconds) and abort only if
# none ever land. On abort PRINT wf-recorder's stderr — it is the only diagnostic, so never drop it.
SZ=0
for _ in $(seq 1 7); do
  sleep 2
  SZ=$(stat -c%s "$OUT" 2>/dev/null || echo 0)
  [ "$SZ" -ge 51200 ] && break
  kill -0 "$WF" 2>/dev/null || { echo "record.sh: wf-recorder DIED during warmup:" >&2; cat "$ERR" >&2; rm -f "$ERR"; exit 1; }
done
if [ "$SZ" -lt 51200 ]; then
  echo "record.sh: NO FRAMES — $OUT is only ${SZ}B after ~14s. wf-recorder is alive but the" >&2
  echo "  headless output never refreshed. This should NOT happen with -D (constant framerate)," >&2
  echo "  so the output itself is stuck: check the sway for WAYLAND_DISPLAY=$WAYLAND_DISPLAY is" >&2
  echo "  alive, that '-o $OUTPUT' is a real output ('swaymsg -t get_outputs'), and that the mode" >&2
  echo "  is @60Hz. NOT resolution-bound." >&2
  echo "record.sh: wf-recorder stderr follows ↓" >&2
  cat "$ERR" >&2
  kill -INT "$WF" 2>/dev/null || true; sleep 0.5; kill -KILL "$WF" 2>/dev/null || true
  rm -f "$ERR"; exit 1
fi

echo "record.sh: frames flowing (${SZ}B) — rolling ${DUR}s ..."
sleep "$DUR"

HARDKILL=0
if kill -0 "$WF" 2>/dev/null; then
  echo "record.sh: finalising (SIGINT → moov atom)"
  kill -INT "$WF" 2>/dev/null
  for _ in $(seq 1 75); do kill -0 "$WF" 2>/dev/null || break; sleep 0.2; done
  if kill -0 "$WF" 2>/dev/null; then HARDKILL=1; kill -KILL "$WF" 2>/dev/null; fi
else
  # It is already gone, so it died DURING the roll — the take stops wherever it crashed and
  # the moov atom was never written. Saying "finalising" here (as this script used to) reads
  # like a normal shutdown of a healthy recorder; it is the opposite.
  echo "record.sh: wf-recorder is ALREADY GONE before finalisation — it died mid-roll" >&2
fi
# The status is the whole point: bash reaps a dead background child on SIGCHLD, so `kill -0`
# above cannot tell "crashed" from "finished", and the FILE cannot either (it is fat and
# unreadable in both cases). `wait` keeps the recorder's real exit status either way.
wait "$WF" 2>/dev/null
RC=$?
sleep 0.5
if [ "$HARDKILL" = 1 ] || [ "$RC" -ne 0 ]; then
  SZ_END=$(stat -c%s "$OUT" 2>/dev/null || echo 0)
  echo "record.sh: RECORDER FAILED — wf-recorder exited rc=$RC (>128 = killed by signal rc-128:" >&2
  echo "  135 = SIGBUS, 137 = SIGKILL, 139 = SIGSEGV, 130 = died BY SIGINT without finalising)." >&2
  [ "$HARDKILL" = 1 ] && echo "  It ignored SIGINT for 15s and was SIGKILLed — no clean shutdown ran." >&2
  echo "  $OUT (${SZ_END}B) is NOT a take: an mp4 is only indexed when the recorder exits" >&2
  echo "  cleanly, so this file is unreadable ('moov atom not found') however big it looks." >&2
  echo "  Re-shoot. If it keeps crashing, suspect the capture path (NVIDIA/headless sway)," >&2
  echo "  not the scene." >&2
  echo "record.sh: wf-recorder stderr tail follows ↓" >&2
  tail -n 20 "$ERR" >&2
  rm -f "$ERR"; exit 1
fi
if [ -s "$OUT" ]; then
  echo "record.sh: done → $OUT ($(du -h "$OUT" | cut -f1))"; rm -f "$ERR"
else
  echo "record.sh: NO OUTPUT" >&2; cat "$ERR" >&2; rm -f "$ERR"; exit 1
fi
