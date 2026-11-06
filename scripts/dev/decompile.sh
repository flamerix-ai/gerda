#!/usr/bin/env bash
# decompile.sh — decompile Minecraft or a mod jar to readable Java with Vineflower.
#
# Why: when `reflect` + `scripts/dev/srg.py` give you a name but you need to understand what a
# method actually DOES (e.g. "what does LocalPlayer.respawn() send?", "how does EMI build a
# recipe?"), read the source. Forge runs SRG method names, so the MC source you want is the
# launcher's pre-remapped **client-<ver>-srg.jar** (classes = Mojang names, members = m_…_,
# matching what reflect/jeval see). Mod jars are decompiled as-is (mostly already readable).
#
# Usage:
#   scripts/dev/decompile.sh mc                 # decompile the SRG-named MC client jar
#   scripts/dev/decompile.sh mod gtceu          # decompile the mod jar whose name contains "gtceu"
#   scripts/dev/decompile.sh mod emi            # e.g. emi-1.1.22+1.20.1+forge.jar
#   scripts/dev/decompile.sh /path/to/some.jar  # decompile an arbitrary jar
#   scripts/dev/decompile.sh list               # list available mod jars
#
# Output goes to decompiled/<name>/ (gitignored). Then grep it, e.g.:
#   rg -n 'void respawn' decompiled/minecraft-srg/net/minecraft/client/player/LocalPlayer.java
#
# Needs `vineflower` + a JDK on PATH (provided by the flake dev shell). Run inside the dev
# shell (direnv) or `nix develop`; the agent Bash tool gets it via the direnv hook.
set -euo pipefail

# -h/--help prints the header above before any instance lookup, so it works with no launcher.
case "${1:-}" in
  -h|--help) awk 'NR > 1 && /^set -euo/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"; exit 0 ;;
esac

# This file lives in scripts/dev/, so repo root is two levels up.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT_ROOT="$ROOT/decompiled"

# Machine-specific paths resolved via scripts/local_config.py (env MC_INSTANCES_ROOT >
# local.config.json > launcher autodetect). libraries/ is a sibling of instances/.
INSTANCES_ROOT="$(python3 "$ROOT/scripts/local_config.py" instances_root)"
LIBS="$(dirname "$INSTANCES_ROOT")/libraries"
MODS="$(python3 "$ROOT/scripts/local_config.py" instance_dir Monifactory)/minecraft/mods"

REMAP=1
if [ "${1:-}" = "--raw" ]; then REMAP=0; shift; fi  # keep SRG names (skip the Mojang rename)

if ! command -v vineflower >/dev/null 2>&1; then
  echo "error: vineflower not on PATH — enter the flake dev shell (direnv / nix develop)." >&2
  exit 1
fi

find_mc_srg_jar() {
  # The version dir is stamped (e.g. 1.20.1-20230612.114412); glob for the srg jar.
  find "$LIBS/net/minecraft/client" -name 'client-*-srg.jar' 2>/dev/null | sort | tail -1
}

run() { # <jar> <out-subdir>
  local jar="$1" name="$2" out="$OUT_ROOT/$2"
  [ -f "$jar" ] || { echo "error: jar not found: $jar" >&2; exit 1; }
  mkdir -p "$out"
  echo ">> vineflower $(basename "$jar") -> decompiled/$name/  (this can take a few minutes)"
  # -dgs=1 decompile generic signatures.
  vineflower -dgs=1 "$jar" "$out"
  if [ "$REMAP" = 1 ]; then
    # Rewrite SRG member tokens (m_…/f_…) → Mojang names so the source reads naturally
    # (this.connection.send(...) instead of this.f_108617_.m_104955_(...)). SRG names are
    # globally unique so this is a safe token replace. --raw to skip.
    echo ">> remapping SRG→Mojang names…"
    python3 "$ROOT/scripts/dev/srg.py" --remap "$out"
  fi
  echo ">> done. e.g.  rg -n 'PATTERN' decompiled/$name/"
}

cmd="${1:-}"
case "$cmd" in
  mc)
    jar="$(find_mc_srg_jar)"
    [ -n "$jar" ] || { echo "error: no client-*-srg.jar under $LIBS/net/minecraft/client" >&2; exit 1; }
    run "$jar" "minecraft-srg"
    ;;
  mod)
    sub="${2:-}"; [ -n "$sub" ] || { echo "usage: decompile.sh mod <name-substring>" >&2; exit 1; }
    jar="$(find "$MODS" -maxdepth 1 -iname "*$sub*.jar" | sort | head -1)"
    [ -n "$jar" ] || { echo "error: no mod jar matching '*$sub*' in $MODS" >&2; exit 1; }
    run "$jar" "$(basename "$jar" .jar)"
    ;;
  list)
    echo "Mod jars in $MODS:"; ls -1 "$MODS"/*.jar | xargs -n1 basename
    ;;
  "" | -h | --help)
    sed -n '2,30p' "$0"
    ;;
  *)
    [ -f "$cmd" ] || { echo "error: unknown command or missing file: $cmd" >&2; exit 1; }
    run "$cmd" "$(basename "$cmd" .jar)"
    ;;
esac
