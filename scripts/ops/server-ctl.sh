#!/usr/bin/env sh
# server-ctl.sh — run the Monifactory dedicated server detached, with a FIFO console.
#
#   server-ctl.sh start                 # start in the background (log: console.log)
#   server-ctl.sh stop                  # send `stop`, wait for the world save, then return
#   server-ctl.sh cmd "<console cmd>"   # e.g. cmd "op bot_1", cmd "list"
#   server-ctl.sh status
#   server-ctl.sh log                   # last 40 lines of logs/latest.log
#
# Copy it INTO the server dir (docs/SERVER_SETUP.md § 4); it works on the directory it sits in.
# The FIFO's write end is held open by a `sleep` so the server never reads EOF on its console
# (EOF on stdin stops the server without a word in the log).
SRV="$(cd "$(dirname "$0")" && pwd)"
PIPE="$SRV/console.in"; JPIDF="$SRV/server.pid"; HPIDF="$SRV/holder.pid"
ARGS="libraries/net/minecraftforge/forge/1.20.1-47.4.13/unix_args.txt"
# A GT world save can take a while; give up WAITING (never the server) after this many seconds.
STOP_WAIT_S="${SERVER_STOP_WAIT_S:-120}"

# Alive = the pid answers AND is not a zombie (a reaped-never zombie still answers kill -0).
alive() { kill -0 "$1" 2>/dev/null && [ "$(awk '/^State:/ { print $2 }' "/proc/$1/status" 2>/dev/null)" != Z ]; }
is_running() { [ -f "$JPIDF" ] && alive "$(cat "$JPIDF" 2>/dev/null)"; }
# The pid in holder.pid is still OUR console holder (not a recycled pid of something else).
holder_alive() {
  hp="$(cat "$HPIDF" 2>/dev/null)" && alive "$hp" \
    && [ "$(tr '\0' ' ' < "/proc/$hp/cmdline" 2>/dev/null)" = "sleep 2147483647 " ]
}

case "$1" in
  start)
    is_running && { echo "already running"; exit 0; }
    # A server that died on its own (crash, OOM kill) leaves its console holder running; a new
    # holder would overwrite holder.pid and the old one would never be stopped. No server reads
    # the FIFO now, so ending the old holder hands nobody an EOF.
    if holder_alive; then kill "$hp"; fi
    rm -f "$HPIDF"
    [ -p "$PIPE" ] || { rm -f "$PIPE"; mkfifo "$PIPE"; }
    cd "$SRV" || exit 1
    sleep 2147483647 > "$PIPE" & echo $! > "$HPIDF"       # hold the FIFO write-end open
    nohup java @user_jvm_args.txt @"$ARGS" nogui < "$PIPE" >> "$SRV/console.log" 2>&1 &
    echo $! > "$JPIDF"
    sleep 1   # a bad JVM arg or a missing jar exits at once — say so, not "started"
    if ! is_running; then
      kill "$(cat "$HPIDF")" 2>/dev/null; rm -f "$HPIDF" "$JPIDF"
      echo "java exited at once — see $SRV/console.log"; exit 1
    fi
    echo "started (pid $(cat "$JPIDF"))" ;;
  stop)
    if is_running; then
      pid="$(cat "$JPIDF")"
      echo "stop" > "$PIPE"
      waited=0
      while alive "$pid" && [ "$waited" -lt "$STOP_WAIT_S" ]; do sleep 1; waited=$((waited + 1)); done
    fi
    # The holder goes only once the server is gone: killing it under a live server hands the
    # server an EOF on its console, which stops it without a word in the log.
    if is_running; then
      echo "still running after ${STOP_WAIT_S}s (pid $(cat "$JPIDF")) — check: $0 log"; exit 1
    fi
    [ -f "$HPIDF" ] && kill "$(cat "$HPIDF")" 2>/dev/null; rm -f "$HPIDF"
    rm -f "$JPIDF"; echo "stopped" ;;
  cmd)  # A FIFO without a reader blocks the write forever — refuse when nothing reads it.
    is_running || { echo "not running — $0 start"; exit 1; }
    shift; echo "$*" > "$PIPE"; echo "sent: $*" ;;
  status) is_running && echo "running (pid $(cat "$JPIDF"))" || echo "stopped" ;;
  log)  tail -n 40 "$SRV/logs/latest.log" ;;
  *) echo "usage: $0 {start|stop|cmd \"<console command>\"|status|log}"; [ "$1" = -h ] || [ "$1" = --help ] ;;
esac
