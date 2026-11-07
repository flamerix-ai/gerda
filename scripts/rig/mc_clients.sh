#!/usr/bin/env bash
# mc_clients.sh — list REAL Minecraft launcher-client PIDs, self-match-SAFE.
#
# WHY THIS EXISTS (the F1/F4 footgun): a bare `pgrep -f org.prismlauncher.EntryPoint`
# (or `pkill -f …`, `ps | grep …`) run from a shell whose OWN argv contains that token —
# because you literally typed it in the command, or piped it to grep — matches the CALLER
# and can SIGTERM it (exit 144). It also false-POSITIVES on the dedicated server JVM if the
# pattern is loose (`net.minecraft` matches `net/minecraftforge` in the server classpath).
#
# This reads /proc directly instead of pgrep, so the match token lives ONLY in this file,
# never in the invoking shell's argv — a caller runs `scripts/rig/mc_clients.sh`, whose argv
# is just the script path. It keys on comm==java AND `org.prismlauncher.EntryPoint` in the
# cmdline (present in every Prism/Freesm game client, absent from the `nogui` server JVM and
# from any shell/python), and restricts to the current uid. Same signature teardown.sh keys on.
#
# Usage:
#   scripts/rig/mc_clients.sh              # every real client of this user: "PID  <instance>"
#   scripts/rig/mc_clients.sh Monifactory_bot_1   # only clients whose cmdline matches the arg
#   n=$(scripts/rig/mc_clients.sh | grep -c .)     # SAFE client count (0 when only the server runs)
# Exit: always 0 (a count of 0 lines is the "no clients" signal, not an error).
set -uo pipefail

want="${1:-}"
entry='org.prismlauncher.EntryPoint'
uid="$(id -u)"

for d in /proc/[0-9]*; do
  pid="${d#/proc/}"
  [ -r "$d/cmdline" ] || continue
  # owner uid must be ours
  [ "$(stat -c %u "$d" 2>/dev/null)" = "$uid" ] || continue
  # comm must be exactly java (never trust a loose classpath substring)
  IFS= read -r comm < "$d/comm" 2>/dev/null || continue
  [ "$comm" = "java" ] || continue
  # flatten NUL-separated cmdline to spaces for substring tests
  cmd="$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null)" || continue
  case "$cmd" in *"$entry"*) : ;; *) continue ;; esac
  [ -z "$want" ] || case "$cmd" in *"$want"*) : ;; *) continue ;; esac
  # best-effort instance label: the "-l <name>" or …/instances/<name>/ segment
  inst="$(printf '%s\n' "$cmd" | grep -oE '/instances/[^/]+/' | head -1 | tr -d '/' | sed 's/^instances//')"
  [ -n "$inst" ] || inst='?'
  printf '%s\t%s\n' "$pid" "$inst"
done
