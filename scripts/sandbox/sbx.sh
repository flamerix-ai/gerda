#!/usr/bin/env bash
# sbx.sh — the in-container half of the Gerda sandbox. Runs as `student`.
# provision.sh (host) calls it through `podman exec`; you can also run it by hand inside:
#   bash /opt/sbx/sbx.sh <step> [args]
#
# Steps (each idempotent — a finished sub-step is skipped, so re-running resumes):
#   server            Monifactory 0.13.4 dedicated server: pack, Forge, monilabs fix, fml.toml,
#                     eula, heap, server.properties, server-ctl.sh, first boot, always-day,
#                     FTB Essentials /home cooldown 0. Leaves the server RUNNING.
#   client [--from <dir>]   FreesmLauncher portable + offline account + the Monifactory instance:
#                     the launcher's own import of the client zip (it downloads the mods),
#                     every file checked against the sha256 pins; or, with --from, the mods
#                     copied out of an instance you installed yourself, checked the same way.
#                     Then monilabs fix + jsMacros + options.txt + jsMacros services, and ONE
#                     warm-up launch to the title screen (downloads MC/Forge/Java, writes the
#                     Forge mappings srg.py needs). Leaves the client STOPPED.
#   repo <src> [branch]  clone (bundle path or URL) to ~/gerda, bun install, build, srg export,
#                     local.config.json, telemetry off, sync into Monifactory.
#   matrix            the four vanilla+jsMacros instances (Forge 1.20.1, Fabric 1.20.1,
#                     Fabric 1.21, Forge 1.18.2) in the test root, each with a generated
#                     single-player world, synced on bridge ports 55560+.
#   pack <instance> <zip|url> [sha256|--unpinned] [--from <dir>]   any CurseForge-format modpack
#                     as a test-root instance, imported by the launcher (or its mods copied from
#                     --from); a url needs the zip's sha256, or --unpinned (re-downloaded each run).
#   add-mods <instance> <dir>            copy the jars in <dir> into an instance's mods/.
#   start             Xvfb + server + Monifactory client joined as the bot; waits for the bridge.
#   start-matrix <instance> [world]   one test-root client in its single-player world.
#   stop              clients (kill) + server (graceful console `stop`).
#   status            what runs, bridge ping.
#   verify            ./gerda ctl ping + ./gerda smoke against the running Monifactory bot.
#   console <command...>  one line to the server console (e.g. `op student_bot`); prints the
#                     server's answer from its log.
#   record <seconds> [name]   film the running client's window (ffmpeg x11grab on its Xvfb
#                     display) to ~/recordings/<name>.mp4, then fail if it is black (motion_probe).
#
# Fail loud: a failure through `die` prints `FAIL: <step>: <why>` and exits non-zero; a command
# that fails under `set -e` ends the script with its own error output and no `FAIL:` line.
set -euo pipefail

SBX_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=pins.env
source "$SBX_DIR/pins.env"

CACHE=${SBX_CACHE:-/cache}
LOGS=$HOME/logs
STATE=$HOME/.sbx
ACCOUNT=${SBX_ACCOUNT:-student_bot}
LDIR=$HOME/apps/FreesmLauncher            # portable launcher: data lives next to the binary
INST_ROOT=$LDIR/instances
INST=$INST_ROOT/Monifactory
GAME=$INST/minecraft
MDIR=$HOME/apps/FreesmLauncher-matrix     # second data root (the launcher is single-instance per root)
SRV=$HOME/mc-servers/monifactory-$MONI_VERSION
REPO_DIR=$HOME/gerda
DISP=${SBX_DISPLAY:-:99}
MAPPINGS="$LDIR/libraries/net/minecraft/client/1.20.1-20230612.114412/client-1.20.1-20230612.114412-mappings.txt"
export LANG=C.UTF-8 LC_ALL=C.UTF-8
export MC_INSTANCES_ROOT=$INST_ROOT MC_BRIDGE_HOST=127.0.0.1

CUR=init
# An instance this step is installing and has not verified yet (pack_instance sets it): `die`
# removes it and prints FAIL. A failure ended by `set -e` instead of `die` may leave it on disk;
# repo, start and start-matrix refuse an instance without its verified mark.
UNVERIFIED=""
say() { echo "== [$(date -u +%H:%M:%S)] $CUR: $*"; }
die() {   # not-a-gate: definition of the fail helper itself
  echo "FAIL: $CUR: $*" >&2
  if [ -n "$UNVERIFIED" ] && [ -e "$UNVERIFIED" ]; then   # gate:unverified-instance-removed
    rm -rf -- "$UNVERIFIED"   # gate:unverified-instance-removed
    echo "FAIL: $CUR: removed the unverified instance $UNVERIFIED" >&2
  fi
  exit 1   # gate:die-exits
}
done_mark() { mkdir -p "$STATE"; touch "$STATE/$1.done"; }
is_done() { [ -f "$STATE/$1.done" ]; }   # not-a-gate: predicate whether a step finished
mkdir -p "$LOGS" "$STATE"
[ -w "$CACHE" ] || sudo chown "$(id -u):$(id -g)" "$CACHE" || die "cache $CACHE not writable"   # not-a-gate: propagates the exit of the command it guards

# fetch <url> <sha256|UNPINNED> <dest> — download through the cache, verify, never leave a
# partial file. No sha256 is an error, never "skip the check"; the one way to skip it is the
# literal UNPINNED, which only the pack step passes (for `pack <url> --unpinned`).
fetch() {
  local url=$1 sha=$2 dest=$3 got
  [ -n "$sha" ] || die "no sha256 pin for $url — add one to pins.env"   # gate:fetch-needs-pin
  [ "$sha" != UNPINNED ] || [ "$CUR" = pack ] || die "UNPINNED is accepted only by the pack step, not by $CUR"   # gate:unpinned-only-pack
  if [ ! -f "$dest" ]; then
    mkdir -p "$(dirname "$dest")"
    say "download $(basename "$dest")"
    curl -fsSL --retry 4 --retry-delay 5 -o "$dest.part" "$url" || { rm -f "$dest.part"; die "download failed: $url"; }   # not-a-gate: propagates the exit of the command it guards
    mv "$dest.part" "$dest"
  fi
  got=$(sha256sum "$dest" | cut -d' ' -f1)
  if [ "$sha" = UNPINNED ]; then
    echo "UNPINNED: $(basename "$dest") taken without a check (--unpinned); its sha256 is $got"
  elif [ "$got" != "$sha" ]; then
    mv "$dest" "$dest.bad"; die "sha256 mismatch for $(basename "$dest"): got $got, pinned $sha (moved to .bad)"   # gate:fetch-sha256
  fi
}
# cached <url> — its cache path, keyed by the sha256 of the WHOLE url (two urls that end in the
# same file name never share a file), with the url's file name as a readable suffix.
cached() { echo "$CACHE/dl/$(printf %s "$1" | sha256sum | cut -c1-64)-$(basename "${1//%2B/+}")"; }   # gate:cache-key-by-url

# wait_log <file> <ok-ERE> <fail-ERE> <timeout-s> [from-line]
wait_log() {
  local f=$1 ok=$2 bad=$3 t=$4 from=${5:-0} i l
  for ((i = 0; i < t; i += 3)); do
    if [ -f "$f" ]; then
      if l=$(tail -n +"$((from + 1))" "$f" | grep -aE -m1 -e "$bad"); then echo "log FAIL after ${i}s: ${l:0:300}"; return 1; fi   # gate:wait-log-fail-pattern
      if l=$(tail -n +"$((from + 1))" "$f" | grep -aE -m1 -e "$ok"); then echo "log OK after ${i}s: ${l:0:200}"; return 0; fi
    fi
    sleep 3
  done
  echo "log TIMEOUT ${t}s on $f"; tail -n 5 "$f" 2>/dev/null | cut -c1-300; return 2   # gate:wait-log-timeout
}
lines() { [ -f "$1" ] && wc -l < "$1" || echo 0; }   # not-a-gate: counts lines for progress output

ensure_x() {
  if ! pgrep -f "Xvfb $DISP " >/dev/null; then
    say "Xvfb $DISP"
    setsid nohup Xvfb "$DISP" -screen 0 1920x1080x24 -nolisten tcp > "$LOGS/xvfb${DISP#:}.log" 2>&1 < /dev/null &
    echo $! > "$STATE/xvfb${DISP#:}.pid"
    sleep 2
    pgrep -f "Xvfb $DISP " >/dev/null || die "Xvfb did not start (see $LOGS/xvfb${DISP#:}.log)"   # not-a-gate: diagnostic naming the Xvfb log
  fi
}
# stop_x — stop the Xvfb of $DISP, only when ensure_x started it (its pid file).
stop_x() {
  local f="$STATE/xvfb${DISP#:}.pid" p
  [ -f "$f" ] || return 0   # not-a-gate: nothing to stop without its pid file
  p=$(cat "$f"); rm -f "$f"
  [ "$(ps -o comm= -p "$p" 2>/dev/null)" = Xvfb ] && kill "$p" 2>/dev/null   # not-a-gate: stops only an Xvfb this script started
  return 0
}

# ---------------------------------------------------------------- server
srv_ctl() { "$SRV/server-ctl.sh" "$@"; }
srv_running() { [ -x "$SRV/server-ctl.sh" ] && srv_ctl status | grep -q '^running'; }   # not-a-gate: predicate whether the server runs
srv_start_wait() {
  local from; from=$(lines "$SRV/logs/latest.log")
  srv_running && { say "server already running"; return 0; }
  # latest.log is rotated at start; count from 0 once it is fresh.
  srv_ctl start || die "server-ctl start failed (see $SRV/console.log)"   # not-a-gate: propagates the exit of the command it guards
  sleep 5; from=0
  wait_log "$SRV/logs/latest.log" 'Done \([0-9.]+s\)! For help' 'Crash report|---- Minecraft Crash|Failed to start the minecraft server|Encountered an unexpected exception' 900 "$from" \
    || die "server did not reach Done (see $SRV/logs/latest.log, $SRV/console.log)"   # gate:server-done
}

do_server() {
  CUR=server
  local zip inst sctl=${SBX_SERVER_CTL:-/tmp/server-ctl.sh}
  mkdir -p "$SRV"
  if ! is_done server-unpack; then
    zip=$(cached "$SERVER_ZIP_URL"); fetch "$SERVER_ZIP_URL" "$SERVER_ZIP_SHA256" "$zip"
    say "unpack server pack"; unzip -qo "$zip" -d "$SRV"; done_mark server-unpack
  fi
  if [ ! -f "$SRV/libraries/net/minecraftforge/forge/$FORGE_VERSION/unix_args.txt" ]; then
    inst=$(cached "$FORGE_INSTALLER_URL"); fetch "$FORGE_INSTALLER_URL" "$FORGE_INSTALLER_SHA256" "$inst"
    say "Forge installer --installServer"
    (cd "$SRV" && java -jar "$inst" --installServer > "$LOGS/forge-install.log" 2>&1) || die "Forge installer failed (see $LOGS/forge-install.log)"   # not-a-gate: propagates the exit of the command it guards
    rm -f "$SRV/run.bat" "$SRV/"forge-*-installer.jar.log
  fi
  # 3a: monilabs 0.21.2 crashes the dedicated server.
  local ml; ml=$(cached "$MONILABS_URL"); fetch "$MONILABS_URL" "$MONILABS_SHA256" "$ml"
  rm -f "$SRV/mods/$MONILABS_OLD_JAR"; cp -u "$ml" "$SRV/mods/"
  # 3b: single-threaded mod loading (parallel-load deadlock); the pack ships no fml.toml.
  mkdir -p "$SRV/config"
  [ -f "$SRV/config/fml.toml" ] || printf 'maxThreads = 1\nversionCheck = false\n' > "$SRV/config/fml.toml"   # not-a-gate: writes the default config when missing
  grep -q '^maxThreads = 1' "$SRV/config/fml.toml" || sed -i 's/^maxThreads = .*/maxThreads = 1/' "$SRV/config/fml.toml"   # not-a-gate: rewrites the thread count when different
  echo 'eula=true' > "$SRV/eula.txt"
  grep -qx -- '-Xmx8G' "$SRV/user_jvm_args.txt" || printf -- '-Xms4G\n-Xmx8G\n' >> "$SRV/user_jvm_args.txt"   # not-a-gate: adds the memory flags when missing
  # server.properties: no inline comments (they silently become part of the value).
  python3 - "$SRV/server.properties" <<'PY'
import sys, os
p = sys.argv[1]
want = {"online-mode": "false", "server-port": "25565", "spawn-protection": "0", "pvp": "false",
        "difficulty": "peaceful", "max-players": "10", "enforce-secure-profile": "false"}
lines = open(p).read().splitlines() if os.path.exists(p) else []
seen = set()
for i, l in enumerate(lines):
    k = l.split("=", 1)[0]
    if k in want and not l.startswith("#"):
        lines[i] = f"{k}={want[k]}"; seen.add(k)
lines += [f"{k}={v}" for k, v in want.items() if k not in seen]
open(p, "w").write("\n".join(lines) + "\n")
PY
  [ -f "$sctl" ] || die "server-ctl.sh not staged at $sctl (provision.sh copies scripts/ops/server-ctl.sh there)"   # not-a-gate: names the file provision.sh stages
  install -m 0755 "$sctl" "$SRV/server-ctl.sh"

  srv_start_wait
  if ! is_done server-world; then
    say "always-day + FTB Essentials /home cooldown 0"
    srv_ctl cmd "time set day" >/dev/null; srv_ctl cmd "gamerule doDaylightCycle false" >/dev/null   # not-a-gate: false is a game rule argument here
    local snbt="$SRV/world/serverconfig/ftbessentials.snbt"
    [ -f "$snbt" ] || die "no $snbt after first boot"   # not-a-gate: diagnostic naming the config file the next line edits
    srv_ctl stop || die "server-ctl stop failed"   # not-a-gate: propagates the exit of the command it guards
    python3 - "$snbt" <<'PY' || die "could not set home.cooldown in $snbt"   # not-a-gate: propagates the exit of the command it guards
import re, sys
p = sys.argv[1]; s = open(p).read()
m = re.search(r"\bhome\s*:\s*\{", s)
if not m: sys.exit("no home block")   # not-a-gate: diagnostic naming what the config lacks
# the first `cooldown: N` after `home: {` belongs to the home block
c = re.compile(r"(\bcooldown\s*:\s*)(\d+)(\w?)")
cm = c.search(s, m.end())
if not cm: sys.exit("no cooldown in home block")   # not-a-gate: diagnostic naming what the config lacks
s = s[:cm.start()] + cm.group(1) + "0" + cm.group(3) + s[cm.end():]
open(p, "w").write(s)
print("home.cooldown -> 0")
PY
    srv_start_wait
    done_mark server-world
  fi
  say "server ready on 25565 ($SRV)"
}

# ---------------------------------------------------------------- client
write_offline_account() {
  python3 - "$LDIR/accounts.json" "$ACCOUNT" <<'PY'
import hashlib, json, sys, time, uuid
path, name = sys.argv[1], sys.argv[2]
h = bytearray(hashlib.md5(("OfflinePlayer:" + name).encode()).digest())
h[6] = h[6] & 0x0F | 0x30; h[8] = h[8] & 0x3F | 0x80          # Java nameUUIDFromBytes (v3)
acc = {"active": True,
       "entitlement": {"canPlayMinecraft": True, "ownsMinecraft": True},
       "profile": {"capes": [], "id": uuid.UUID(bytes=bytes(h)).hex, "name": name,
                   "skin": {"id": "", "url": "", "variant": ""}},
       "type": "Offline",
       # an offline account carries no secret: the launcher itself writes token "0"
       "ygg": {"extra": {"clientToken": uuid.uuid4().hex, "userName": name},
               "iat": int(time.time()), "token": "0"}}
json.dump({"accounts": [acc], "formatVersion": 3}, open(path, "w"), indent=4)
PY
}

write_options_txt() {   # <minecraft dir> <guiScale>
  [ -f "$1/options.txt" ] && return 0   # not-a-gate: keeps an existing options file
  cat > "$1/options.txt" <<EOF
renderDistance:3
simulationDistance:5
maxFps:30
enableVsync:false
guiScale:$2
graphicsMode:0
soundCategory_master:0.0
onboardAccessibility:false
narrator:0
pauseOnLostFocus:false
skipMultiplayerWarning:true
tutorialStep:none
EOF
}

# jsMacros services via its config file (game CLOSED). The first boot writes "version": 2 and the
# next boot migrates it to 3 with `services: {}` — registrations made on a v2 file are lost. So
# write a v3 file up front (the shape jsMacros 1.9.x itself writes), with main + bridge enabled;
# main starts worker on its own.
write_jsm_options() {   # <minecraft dir>
  local f="$1/config/jsMacros/options.json"
  mkdir -p "$1/config/jsMacros/Macros"
  python3 - "$f" "$SBX_DIR/jsmacros-options.v3.json" <<'PY'
import json, os, sys
p, tmpl = sys.argv[1], sys.argv[2]
o = json.load(open(p)) if os.path.exists(p) else json.load(open(tmpl))
if o.get("version") != 3:
    o["version"] = 3   # same edit as the services: skips the v2->v3 migration that drops them
o.setdefault("core", {}).setdefault("services", {}).update(
    {"main": {"file": "main.js", "enabled": True}, "bridge": {"file": "bridge.js", "enabled": True}})
json.dump(o, open(p, "w"), indent=2)
print("jsMacros services:", sorted(o["core"]["services"]))
PY
}

write_instance() {   # <instances root> <name> <mmc-pack components json> <minMem> <maxMem>
  local d="$1/$2"
  mkdir -p "$d/minecraft"
  [ -f "$d/mmc-pack.json" ] || printf '{"components":%s,"formatVersion":1}\n' "$3" > "$d/mmc-pack.json"   # not-a-gate: writes the component list when missing
  [ -f "$d/instance.cfg" ] || cat > "$d/instance.cfg" <<EOF   # not-a-gate: writes the instance config when missing
[General]
ConfigVersion=1.3
InstanceType=OneSix
AutomaticJava=true
name=$2
OverrideMemory=true
MinMemAlloc=$4
MaxMemAlloc=$5
EOF
}

install_launcher() {
  if [ ! -x "$LDIR/FreesmLauncher" ]; then
    local tgz; tgz=$(cached "$LAUNCHER_URL"); fetch "$LAUNCHER_URL" "$LAUNCHER_SHA256" "$tgz"
    say "unpack FreesmLauncher $LAUNCHER_VERSION (portable)"
    mkdir -p "$LDIR"; tar xzf "$tgz" -C "$LDIR"
    [ -f "$LDIR/portable.txt" ] || die "tarball is not the portable build (no portable.txt)"   # not-a-gate: names a wrong tarball, which its sha256 pin refuses first
  fi
  # What the launcher downloads at the first launch (Minecraft/loader libraries, assets, its
  # metadata, the Java runtimes; ~1 GB) lives in the cache volume, so a rebuilt sandbox skips it.
  local d
  for d in assets libraries meta java; do
    if [ ! -e "$LDIR/$d" ]; then mkdir -p "$CACHE/launcher/$d"; ln -s "$CACHE/launcher/$d" "$LDIR/$d"; fi
  done
  # Pre-seeded so the first-run wizard never blocks a headless start (with locale C it stops on
  # the Language page); FlameKey... = do not offer to fetch the official CurseForge app's API
  # key — the modpack import uses the launcher's own CurseForge access.
  # gate:launcher-no-flame-key
  [ -f "$LDIR/freesmlauncher.cfg" ] || cat > "$LDIR/freesmlauncher.cfg" <<'EOF'
[General]
ConfigVersion=1.3
Language=en_US
FlameKeyShouldBeFetchedOnStartup=false
AutomaticJavaDownload=true
AutomaticJavaSwitch=true
EOF
  [ -f "$LDIR/accounts.json" ] || write_offline_account   # not-a-gate: writes the offline account when missing
}

# ---------------------------------------------------------------- modpack files
# The mod files of a CurseForge-format modpack come from the launcher's own import (below) or,
# as the fallback, from an instance the user installed in their own launcher (--from). Either
# way they are then listed, and checked against the pins when the pack has them.
PACK_DIRS="mods resourcepacks shaderpacks"   # where a modpack's own files land in an instance

# list_pack_files <minecraft dir> — "<dir>\t<file name>\t<sha256>" for every file directly in
# the PACK_DIRS (the launcher's metadata dirs such as mods/.index are not files), sorted.
list_pack_files() {
  local d f
  for d in $PACK_DIRS; do
    [ -d "$1/$d" ] || continue   # not-a-gate: skips a pack dir the instance lacks
    find "$1/$d" -maxdepth 1 -type f -print0 | while IFS= read -r -d '' f; do
      printf '%s\t%s\t%s\n' "$d" "${f##*/}" "$(sha256sum "$f" | cut -d' ' -f1)"   # gate:pack-files-dir
    done
  done | LC_ALL=C sort
}

# manifest_ids <zip> — "<projectID>\t<fileID>" of every file the zip's manifest.json lists, sorted.
manifest_ids() {
  unzip -p "$1" manifest.json | python3 -c '
import json,sys
for f in json.load(sys.stdin)["files"]: print(f["projectID"], f["fileID"], sep="\t")' | LC_ALL=C sort
}

# check_pins_file <pins tsv> <zip> — the pins exist, every row is "<projectID>\t<fileID>\t<dir>\t
# <file name>\t<sha256>" with <dir> one of the PACK_DIRS, and they pin exactly the files the zip's
# manifest lists. A missing pins path is an error, never "unpinned": falling open would install
# unverified files exactly when the pins went missing.
check_pins_file() {
  [ -f "$1" ] || die "pins file $1 is missing — refusing to install unverified files"   # gate:pins-file-present
  local bad
  bad=$(awk -F'\t' -v dirs=" $PACK_DIRS " 'NF != 5 || index(dirs, " " $3 " ") == 0 { print NR": "$0; exit }' "$1")   # gate:pins-dir-column
  [ -z "$bad" ] || die "pins $1, row $bad: want <projectID> <fileID> <dir: ${PACK_DIRS// /|}> <name> <sha256>, tab-separated"   # gate:pins-dir-column
  # gate:pins-match-manifest
  diff <(cut -f1,2 "$1" | LC_ALL=C sort) <(manifest_ids "$2") > /dev/null \
    || die "the pins $1 do not list the same files as the manifest of $(basename "$2")"
}

# verify_pack_files <minecraft dir> <tag> [pins tsv] — record the instance's pack files in
# ~/.sbx/<tag>-files.tsv; with pins, they must be exactly the pinned files — each in its pinned
# dir, under its pinned name, with its pinned sha256.
verify_pack_files() {
  local game=$1 tag=$2 pins=${3:-} got="$STATE/$2-files.tsv" n
  list_pack_files "$game" > "$got"
  n=$(wc -l < "$got")
  [ "$n" -gt 0 ] || die "no files in $game/{${PACK_DIRS// /,}}"   # gate:pack-files-nonempty
  if [ -n "$pins" ]; then
    # gate:pack-files-match-pins gate:pack-files-dir
    diff <(cut -f3-5 "$pins" | LC_ALL=C sort) "$got" > "$STATE/$tag-files.diff" \
      || { head -n 20 "$STATE/$tag-files.diff"; die "the instance's files differ from the pins ($pins): < pinned, > installed — see $STATE/$tag-files.diff"; }
    say "all $n files match their sha256 pins"
  else
    echo "UNPINNED: $n modpack files installed, not verified; dirs, names + sha256 in $got"
    grep -a $'\.disabled\t' "$got" | sed 's/^/  disabled by the launcher: /' || true
  fi
}

# from_game_dir <dir> — the minecraft dir of a launcher instance given in any of its usual
# shapes: <instance>/minecraft (Prism, MultiMC, FreesmLauncher), <instance>/.minecraft, or the
# minecraft dir itself.
from_game_dir() {
  local d
  for d in "$1/minecraft" "$1/.minecraft" "$1"; do
    [ -d "$d/mods" ] && { echo "$d"; return 0; }   # not-a-gate: returns the first shape that has mods
  done
  die "no mods/ in $1, $1/minecraft or $1/.minecraft — point --from at an installed instance"   # gate:from-dir-shape
}

# copy_pack_files <source minecraft dir> <minecraft dir> <tag> [pins tsv] [may-miss name] — the
# fallback: the pack files out of an instance installed elsewhere. With pins, exactly the
# pinned files, each from its pinned dir at the source; one missing FAILs (except
# <may-miss name>, which the caller replaces anyway — it then leaves the effective pins in
# ~/.sbx/<tag>-pins.tsv); the source's other files are not copied. Without pins, every file
# directly in the source's PACK_DIRS.
copy_pack_files() {
  local src=$1 game=$2 tag=$3 pins=${4:-} miss=${5:-} d f line name n=0 missing=()
  if [ -n "$pins" ]; then
    : > "$STATE/$tag-pins.tsv"
    while IFS= read -r line; do
      IFS=$'\t' read -r _ _ d name _ <<< "$line"
      f="$src/$d/$name"
      if [ ! -f "$f" ]; then
        [ "$name" = "$miss" ] && { say "$name is not in $src (replaced by this step anyway)"; continue; }   # not-a-gate: skips the file this step replaces
        missing+=("$d/$name"); continue   # gate:from-copy-complete
      fi
      printf '%s\n' "$line" >> "$STATE/$tag-pins.tsv"
      mkdir -p "$game/$d"; cp "$f" "$game/$d/"; n=$((n + 1))
    done < "$pins"
    [ ${#missing[@]} = 0 ] || { printf '  missing: %s\n' "${missing[@]}" | head -n 30; die "${#missing[@]} pinned file(s) not found in $src/{${PACK_DIRS// /,}}"; }   # gate:from-copy-complete
  else
    for d in $PACK_DIRS; do
      [ -d "$src/$d" ] || continue   # not-a-gate: skips a pack dir the source lacks
      for f in "$src/$d"/*; do
        [ -f "$f" ] || continue   # not-a-gate: skips a glob that matched nothing
        mkdir -p "$game/$d"; cp "$f" "$game/$d/"; n=$((n + 1))
      done
    done
  fi
  say "copied $n pack files from $src"
}

# unpack_overrides <zip> <minecraft dir> — the modpack's overrides/ (configs, scripts, ...).
unpack_overrides() {
  rm -rf "$STATE/ovr"; unzip -q "$1" 'overrides/*' -d "$STATE/ovr" || true
  [ -d "$STATE/ovr/overrides" ] && cp -a "$STATE/ovr/overrides/." "$2/"   # not-a-gate: copies overrides when the zip has them
  rm -rf "$STATE/ovr"
}

# pack_manifest <zip> — prints "<mc version> <loader> <loader version>" of a CurseForge modpack.
pack_manifest() {
  unzip -p "$1" manifest.json | python3 -c '
import json,sys; m=json.load(sys.stdin)["minecraft"]
ld=next((l for l in m["modLoaders"] if l.get("primary")), m["modLoaders"][0])["id"]
name,_,ver=ld.partition("-"); print(m["version"], name, ver)' || die "$1 has no readable CurseForge manifest.json"   # not-a-gate: propagates the exit of the command it guards
}

# components <mc> <loader> <loader version> — the launcher's mmc-pack.json component list.
components() {
  local mc=$1 l=$2 lv=$3 c="{\"uid\":\"net.minecraft\",\"version\":\"$1\",\"important\":true}"
  case "$l" in
    forge) echo "[$c,{\"uid\":\"net.minecraftforge\",\"version\":\"$lv\"}]" ;;
    neoforge) echo "[$c,{\"uid\":\"net.neoforged\",\"version\":\"$lv\"}]" ;;
    fabric) echo "[$c,{\"uid\":\"net.fabricmc.intermediary\",\"version\":\"$mc\"},{\"uid\":\"net.fabricmc.fabric-loader\",\"version\":\"$lv\"}]" ;;
    quilt) echo "[$c,{\"uid\":\"net.fabricmc.intermediary\",\"version\":\"$mc\"},{\"uid\":\"org.quiltmc.quilt-loader\",\"version\":\"$lv\"}]" ;;
    none|vanilla) echo "[$c]" ;;
    *) die "unknown mod loader '$l' (forge|neoforge|fabric|quilt)" ;;   # not-a-gate: usage, names the loaders the step knows
  esac
}

# jsmacros_pin <loader> <mc> — the pins.env variable prefix of the jsMacros build for it, or "".
jsmacros_pin() {
  case "$1/$2" in
    forge/1.20.1) echo JSMACROS_FORGE_1201 ;;
    fabric/1.20.1) echo JSMACROS_FABRIC_1201 ;;
    fabric/1.21) echo JSMACROS_FABRIC_121 ;;
    forge/1.18.2) echo JSMACROS_FORGE_1182 ;;
    *) echo "" ;;
  esac
}

add_pinned_jar() {   # <pins.env prefix> <mods dir>
  local url=${1}_URL sha=${1}_SHA256 f
  f=$(cached "${!url}"); fetch "${!url}" "${!sha}" "$f"; mkdir -p "$2"; cp -u "$f" "$2/"
}

launcher_pids() { pgrep -f -- "-d $1 -l " || true; }
import_pids() { pgrep -f -- "-d $1 -I " || true; }
game_pids() { pgrep -f "java.*$1/instances/" || true; }

launch() {   # <launcher dir> <instance> <log> [launcher args...]
  local ld=$1 inst=$2 log=$3; shift 3
  ensure_x
  [ -z "$(game_pids "$ld")" ] || die "a game from $ld is already running (sbx.sh stop first)"   # gate:launch-single-game
  rm -f "$ld/instances/$inst/minecraft/logs/latest.log"
  say "launch $inst ($*)"
  # One launcher binary ($LDIR); `-d` picks the data root (main or matrix).
  DISPLAY=$DISP setsid nohup "$LDIR/FreesmLauncher" -d "$ld" -l "$inst" -a "$ACCOUNT" "$@" > "$log" 2>&1 < /dev/null &
  sleep 5
  [ -n "$(launcher_pids "$ld")$(game_pids "$ld")" ] || { tail -n 15 "$log"; die "the launcher exited at once (see $log)"; }   # not-a-gate: diagnostic naming the launcher log
}

stop_launcher_root() {   # <launcher dir>
  local p i
  p=$(game_pids "$1"); [ -n "$p" ] && kill $p 2>/dev/null   # not-a-gate: stops a running game, if any
  for i in $(seq 1 30); do [ -z "$(game_pids "$1")" ] && break; sleep 1; done   # not-a-gate: waits for the game to exit
  p=$(game_pids "$1"); [ -n "$p" ] && { say "game did not exit in 30 s — kill -9"; kill -9 $p 2>/dev/null; }   # not-a-gate: message text, not a fail path
  p="$(launcher_pids "$1") $(import_pids "$1")"; [ -n "${p// /}" ] && kill $p 2>/dev/null   # not-a-gate: stops the launcher, if it runs
  sleep 1; return 0
}

# ---------------------------------------------------------------- launcher import
# A CurseForge-format modpack zip goes through the launcher's own import, as a player installs
# it: FreesmLauncher (a Prism Launcher fork) resolves the manifest with its own access to the
# official CurseForge API and downloads the files. A file whose author keeps it out of
# third-party launchers is taken from the author's Modrinth upload when one exists; otherwise
# the launcher asks for a manual download, and the import FAILs with the list (fallback: --from).
# The import is a GUI flow, driven on its OWN Xvfb display ($SBX_IMPORT_DISPLAY, :98 — never the
# display a running client draws on, so no click or key can reach a game window) by the title of
# each window the launcher opens:
#   New Instance          Import page, the name is the zip's file name: Return accepts it.
#   Select Optional Mods  Select All, then OK. Unchecked optional mods would end up disabled.
#   Please wait...        the downloads; nothing to click.
#   Blocked mods found    files to download by hand: FAIL with the list.
# The launcher's main window is the one window that is neither a dialog nor transient (xprop).
# Any other window — an untitled dialog too, which Qt titles with the application's name —
# FAILs with its title and a screenshot. The launcher commits the instance directory only when
# the import succeeded.
IMPORT_TIMEOUT=${SBX_IMPORT_TIMEOUT:-1200}               # seconds for the whole import
IMPORT_DIALOG_TIMEOUT=${SBX_IMPORT_DIALOG_TIMEOUT:-60}   # seconds a dialog may stay after its input
IMPORT_POLL=${SBX_IMPORT_POLL:-2}                        # seconds between two looks at the windows
IMPORT_SETTLE=${SBX_IMPORT_SETTLE:-2}                    # seconds a new dialog gets before the input
IMPORT_QUIET=${SBX_IMPORT_QUIET:-3}                      # dialog-free polls after the commit = done
IMPORT_FAIL='Blocked (mods|files) found|Instance creation failed|Instance import has been aborted|Failed to commit instance'
# window-relative click points (pixels; negative = from the right/bottom edge) in the
# "Select Optional Mods" dialog of FreesmLauncher 2.3.1 at its default size
OPT_SELECT_ALL=(59 -65)
OPT_OK=(-179 -28)

xdo() { DISPLAY=$DISP timeout 15 xdotool "$@"; }
click_in() {   # <window> <dx> <dy> — returns non-zero when the window has no readable geometry
  local X="" Y="" WIDTH="" HEIGHT="" SCREEN WINDOW dx=$2 dy=$3 geo
  geo=$(xdo getwindowgeometry --shell "$1") || geo=""   # not-a-gate: empty geometry is refused by click-geometry below
  eval "$geo"
  [ -n "$X" ] && [ -n "$Y" ] && [ -n "$WIDTH" ] && [ -n "$HEIGHT" ] || return 1   # gate:click-geometry
  [ "$dx" -lt 0 ] && dx=$((WIDTH + dx)); [ "$dy" -lt 0 ] && dy=$((HEIGHT + dy))   # not-a-gate: offsets from the right or bottom edge
  xdo mousemove $((X + dx)) $((Y + dy)) click 1
}
# window_kind <window> — "dialog" for a dialog or transient window, "main" for any other; fails
# when the window cannot be read (it closed in between).
window_kind() {
  local props
  props=$(DISPLAY=$DISP timeout 15 xprop -id "$1" _NET_WM_WINDOW_TYPE WM_TRANSIENT_FOR 2>/dev/null) || return 1   # not-a-gate: a window that closed is skipped like a vanished title
  case "$props" in
    *_NET_WM_WINDOW_TYPE_DIALOG*|*"WM_TRANSIENT_FOR(WINDOW)"*) echo dialog ;;   # gate:import-untitled-dialog
    *) echo main ;;
  esac
}
# import_windows <launcher root> — "<window id> <main|dialog> <title>" of every visible window of
# the import launcher, found by its pid; an untitled one is listed with an empty title.
import_windows() {
  local p w title kind
  for p in $(import_pids "$1"); do
    for w in $(xdo search --onlyvisible --pid "$p" 2>/dev/null); do
      title=$(xdo getwindowname "$w" 2>/dev/null) || continue   # not-a-gate: skips a window that closed meanwhile
      kind=$(window_kind "$w") || continue   # not-a-gate: skips a window of no known kind
      echo "$w $kind $title"
    done
  done
  return 0
}
instance_cfgs() { ls "$1"/instances/*/instance.cfg 2>/dev/null || true; }
import_fail() {   # not-a-gate: definition of the import fail helper — <launcher root> <log> <why>
  local shot; shot="$LOGS/import-fail-$(date -u +%H%M%S).png"
  DISPLAY=$DISP import -window root "$shot" 2>/dev/null || shot="(no screenshot)"   # not-a-gate: the screenshot is best effort for the report
  grep -aE "$IMPORT_FAIL" "$2" | cut -c1-300 | head -n 10 || true
  # the launcher logs each blocked file as { name: "<file>", websiteUrl: "<its CurseForge page>", ... }
  grep -a 'Blocked Mods Dialog\] Mods List' "$2" | grep -aoE 'name: "[^"]*", websiteUrl: "[^"]*"' \
    | sed -E 's/name: "([^"]*)", websiteUrl: "([^"]*)"/  blocked: \1 — download it by hand from \2/' || true
  stop_launcher_root "$1"; stop_x
  die "launcher import: $3 (launcher log $2, screen $shot). Fallback: install the pack in your own launcher, then run this step again with --from <that instance's folder>"   # gate:import-fail-fatal
}

# launcher_import <launcher root> <instance> <zip> — the instance <root>/instances/<instance>,
# imported from <zip> by the launcher. The caller made sure <root>/instances/<instance> is free.
launcher_import() {
  local DISP=${SBX_IMPORT_DISPLAY:-:98}   # gate:import-own-display
  local root=$1 name=$2 zip=$3 staged="$STATE/import/$2.zip" log="$LOGS/import-$2.log"
  local inst="$1/instances/$2" t0=$SECONDS t=0 w kind title before other dialogs quiet=0 new_at=-1 opt_at=-1
  # gate:import-launcher-idle
  [ -z "$(launcher_pids "$root")$(import_pids "$root")$(game_pids "$root")" ] \
    || die "the launcher of $root is running — stop it first (sbx.sh stop)"
  command -v xprop > /dev/null || die "no xprop (x11-utils) — the import tells dialogs from the main window with it"   # not-a-gate: names a missing tool of the image
  ensure_x
  rm -rf "$root/instances/.tmp"
  before=$(instance_cfgs "$root")
  mkdir -p "$STATE/import"; cp "$zip" "$staged"   # the launcher names the instance after the file
  say "launcher import of $(basename "$zip") as $name on DISPLAY $DISP (launcher log $log)"
  DISPLAY=$DISP setsid nohup "$LDIR/FreesmLauncher" -d "$root" -I "$staged" > "$log" 2>&1 < /dev/null &
  while :; do
    sleep "$IMPORT_POLL"; t=$((SECONDS - t0))
    [ $t -lt "$IMPORT_TIMEOUT" ] || import_fail "$root" "$log" "no instance after ${IMPORT_TIMEOUT}s"   # gate:import-timeout
    grep -aqE "$IMPORT_FAIL" "$log" && import_fail "$root" "$log" "the launcher reported: $(grep -aoE "$IMPORT_FAIL" "$log" | head -n 1)"   # gate:import-log-failure
    # gate:import-launcher-alive
    [ -n "$(import_pids "$root")" ] \
      || { tail -n 15 "$log" | cut -c1-300; import_fail "$root" "$log" "the launcher exited during the import"; }
    dialogs=0
    while read -r w kind title; do
      [ "$kind" = main ] && [[ $title == "Freesm Launcher"* ]] && continue   # gate:import-untitled-dialog
      case "$title" in
        "New Instance — "*)
          dialogs=1
          if [ $new_at -lt 0 ]; then
            sleep "$IMPORT_SETTLE"
            { xdo windowfocus --sync "$w" && xdo key Return; } || import_fail "$root" "$log" "xdotool could not press Return in the New Instance dialog"   # gate:import-xdotool-return
            new_at=$t
            say "import dialog accepted (instance name: $name)"
          elif [ $((t - new_at)) -gt "$IMPORT_DIALOG_TIMEOUT" ]; then import_fail "$root" "$log" "the New Instance dialog did not take Return"; fi ;;   # gate:import-dialog-timeout
        "Select Optional Mods — "*)
          dialogs=1
          if [ $opt_at -lt 0 ]; then
            sleep "$IMPORT_SETTLE"
            { click_in "$w" "${OPT_SELECT_ALL[@]}" && sleep 1 && click_in "$w" "${OPT_OK[@]}"; } \
              || import_fail "$root" "$log" "xdotool could not click the Select Optional Mods dialog"   # gate:import-xdotool-click
            opt_at=$t
            say "optional mods: Select All, OK"
          elif [ $((t - opt_at)) -gt "$IMPORT_DIALOG_TIMEOUT" ]; then import_fail "$root" "$log" "the Select Optional Mods dialog did not take the clicks"; fi ;;   # gate:import-optional-timeout
        "Please wait..."*) dialogs=1 ;;
        "Blocked mods found"*|"Blocked files found"*)
          import_fail "$root" "$log" "files blocked for third-party launchers, to be downloaded by hand" ;;   # gate:import-blocked-window
        *) import_fail "$root" "$log" "unexpected launcher window '$title'" ;;   # gate:import-unknown-window
      esac
    done < <(import_windows "$root")
    [ $dialogs = 0 ] || { quiet=0; continue; }   # not-a-gate: a dialog resets the quiet counter
    if [ -f "$inst/instance.cfg" ]; then
      quiet=$((quiet + 1)); [ $quiet -ge "$IMPORT_QUIET" ] && break   # not-a-gate: committed, and no dialog since
    elif other=$(comm -13 <(echo "$before") <(instance_cfgs "$root")) && [ -n "$other" ]; then   # gate:import-instance-name
      import_fail "$root" "$log" "the launcher created $(dirname "$other") instead of $inst"   # gate:import-instance-name
    fi
  done
  stop_launcher_root "$root"; stop_x
  grep -q '^ManagedPackType=flame' "$inst/instance.cfg" || die "$inst is not a CurseForge import (instance.cfg)"   # gate:import-curseforge-type
  say "launcher import done in ${t}s: $(ls "$inst/minecraft/mods" | wc -l) files in mods/"
}

# set_instance_cfg <instance.cfg> <key=value>... — set keys in the launcher's [General] section.
set_instance_cfg() {
  python3 - "$@" <<'PY'
import sys
p, kv = sys.argv[1], dict(a.split("=", 1) for a in sys.argv[2:])
lines = open(p).read().splitlines()
seen = set()
for i, l in enumerate(lines):
    k = l.split("=", 1)[0]
    if k in kv:
        lines[i] = f"{k}={kv[k]}"; seen.add(k)
lines += [f"{k}={v}" for k, v in kv.items() if k not in seen]
open(p, "w").write("\n".join(lines) + "\n")
PY
}

# pack_instance <launcher data root> <instance> <zip> <tag> [pins tsv] [minMem maxMem] [--from dir]
# [may-miss name] — a launcher instance from a CurseForge-format modpack zip: the launcher's
# import, or with a from-dir the zip's overrides plus the pack files of that installed instance;
# the files are checked against the pins (when given), then jsMacros (when a pinned build
# matches) and the headless options.
pack_instance() {
  local root=$1 name=$2 zip=$3 tag=$4 pins=${5:-} mn=${6:-2048} mx=${7:-4096} from=${8:-} miss=${9:-}
  local inst="$1/instances/$2" game="$1/instances/$2/minecraft" man mc l lv jp src comps
  [ -z "$pins" ] || check_pins_file "$pins" "$zip"   # gate:pins-checked-before-install
  man=$(pack_manifest "$zip"); read -r mc l lv <<< "$man"
  say "$name: Minecraft $mc, $l $lv"
  if ! is_done "$tag-files"; then
    if [ -n "$from" ]; then
      src=$(from_game_dir "$from")
      # the copy source must survive the removal below
      case "$(realpath -m "$src")/" in "$(realpath -m "$inst")/"*) die "--from $from is inside $inst itself" ;; esac   # gate:from-outside-instance
    fi
    if [ -e "$inst" ]; then
      # Only a directory this step started may be removed (an interrupted earlier run).
      is_done "$tag-started" || die "$inst exists and was not made by this step — remove it, or pick another instance name"   # gate:instance-ownership
      say "remove $inst (unfinished earlier run)"; rm -rf "$inst"
    fi
    done_mark "$tag-started"
    UNVERIFIED=$inst   # gate:unverified-instance-removed
    if [ -n "$from" ]; then
      comps=$(components "$mc" "$l" "$lv")
      write_instance "$root/instances" "$name" "$comps" "$mn" "$mx"
      unpack_overrides "$zip" "$game"
      copy_pack_files "$src" "$game" "$tag" "$pins" "$miss"
      [ -z "$pins" ] || pins="$STATE/$tag-pins.tsv"   # not-a-gate: the later check reads the staged pins
    else
      launcher_import "$root" "$name" "$zip"
    fi
    verify_pack_files "$game" "$tag" "$pins"   # gate:pack-verified-after-install
    done_mark "$tag-files"
    UNVERIFIED=""   # gate:verified-instance-kept
  elif [ -n "$from" ]; then
    say "$name already installed — --from ignored (to redo: remove $inst and ~/.sbx/$tag-files.done)"
  fi
  set_instance_cfg "$inst/instance.cfg" OverrideMemory=true MinMemAlloc="$mn" MaxMemAlloc="$mx"
  jp=$(jsmacros_pin "$l" "$mc")
  if [ -n "$jp" ]; then add_pinned_jar "$jp" "$game/mods"
  else say "WARNING: no pinned jsMacros build for $l $mc — add one with add-mods, or the bridge will not run"; fi
  write_options_txt "$game" 4
  write_jsm_options "$game"
}

# --from <dir> parsing for client/pack: prints the dir, or nothing.
from_arg() {
  [ $# = 0 ] && return 0   # not-a-gate: no --from option was given
  [ "$1" = --from ] && [ -n "${2:-}" ] && [ $# = 2 ] || die "expected --from <installed instance folder>, got: $*"   # not-a-gate: usage of the --from option
  [ -d "$2" ] || die "--from $2: no such directory"   # gate:from-dir-exists
  echo "$2"
}

TITLE_OK='Sound engine started|Created: [0-9x]+ minecraft:textures/atlas/blocks.png-atlas'
GAME_FAIL='---- Minecraft Crash Report|Crash report saved|Incompatible mods found|Exception in thread "main"|Missing or unsupported mandatory dependencies'

do_client() {
  CUR=client
  local from; from=$(from_arg "$@")
  install_launcher
  local zip; zip=$(cached "$CLIENT_ZIP_URL"); fetch "$CLIENT_ZIP_URL" "$CLIENT_ZIP_SHA256" "$zip"
  # --from: an instance the user set up by the docs may already have monilabs 0.21.7 instead
  # of 0.21.2 — the pinned 0.21.2 may be missing there, it is replaced below anyway.
  pack_instance "$LDIR" Monifactory "$zip" client "$SBX_DIR/monifactory-$MONI_VERSION-client-files.tsv" 2048 4096 "$from" "$MONILABS_OLD_JAR"   # gate:client-pinned
  # monilabs 0.21.2 → 0.21.7 on the client too: the server runs 0.21.7 and the handshake must match.
  rm -f "$GAME/mods/$MONILABS_OLD_JAR"; add_pinned_jar MONILABS "$GAME/mods"
  say "instance ready: $(ls "$GAME/mods" | wc -l) mods in $GAME/mods"

  if [ ! -f "$MAPPINGS" ] || ! is_done client-warmup; then   # not-a-gate: chooses whether to run the warm-up
    # One launch to the title screen: the launcher fetches MC, Forge, the libraries and its own
    # Java, and Forge's install processors write the mappings srg.py reads.
    launch "$LDIR" Monifactory "$LOGS/client-warmup.log"
    wait_log "$GAME/logs/latest.log" "$TITLE_OK" "$GAME_FAIL" 900 \
      || { tail -n 20 "$LOGS/client-warmup.log" | cut -c1-300; stop_launcher_root "$LDIR"; die "warm-up launch did not reach the title screen"; }   # gate:warmup-title
    sleep 10; stop_launcher_root "$LDIR"
    [ -f "$MAPPINGS" ] || die "warm-up done but no Forge mappings at $MAPPINGS"   # gate:warmup-mappings
    python3 -c 'import json,sys; o=json.load(open(sys.argv[1])); s=o["core"]["services"]; assert o["version"]==3 and "main" in s and "bridge" in s, o["version"]; print("jsMacros options after warm-up: version", o["version"], sorted(s))' \
      "$GAME/config/jsMacros/options.json" || die "jsMacros options.json lost the services during warm-up"   # gate:warmup-jsm-services
    done_mark client-warmup
  fi
  say "client installed (stopped). Launcher: $LDIR, instance: $INST"
}

# ---------------------------------------------------------------- repo
do_repo() {
  CUR=repo
  local src=${1:-} branch=${2:-}
  if [ ! -d "$REPO_DIR/.git" ]; then
    [ -n "$src" ] || die "usage: repo <bundle-path|git-url> [branch]"   # not-a-gate: usage of the repo step
    say "clone $src ${branch:+(branch $branch)}"
    git clone ${branch:+-b "$branch"} "$src" "$REPO_DIR" || die "git clone failed"   # not-a-gate: propagates the exit of the command it guards
  else
    say "repo already cloned at $REPO_DIR ($(git -C "$REPO_DIR" log --oneline -1))"
  fi
  cd "$REPO_DIR"
  [ -x ./gerda ] || die "$REPO_DIR has no ./gerda CLI — wrong repo/branch?"   # gate:repo-is-gerda
  say "bun install"; bun install > "$LOGS/bun-install.log" 2>&1 || die "bun install failed (see $LOGS/bun-install.log)"   # not-a-gate: propagates the exit of the command it guards
  [ -f local.config.json ] || printf '{\n  "instancesRoot": "%s",\n  "humanInstance": "Monifactory"\n}\n' "$INST_ROOT" > local.config.json   # not-a-gate: writes the local config when missing
  mkdir -p config
  # The sandbox has no telemetry endpoint; a configured push URL only fills the journal with failures.
  [ -f config/local.overrides.json ] || echo '{"telemetry":{"pushUrl":null}}' > config/local.overrides.json   # not-a-gate: writes the overrides file when missing
  say "build"; just build > "$LOGS/build.log" 2>&1 || die "just build failed (see $LOGS/build.log)"   # not-a-gate: propagates the exit of the command it guards
  # srg_names.json (Forge 1.20.1 SRG → Mojang names) comes from the mappings the first Forge
  # 1.20.1 launch writes; without it the harness runs, only its SRG self-check reads "unknown".
  if [ ! -f harness/srg_names.json ]; then
    if [ -f "$MAPPINGS" ]; then
      say "srg export"; python3 scripts/dev/srg.py --export harness/srg_names.json > "$LOGS/srg-export.log" 2>&1 \
        || die "srg export failed (see $LOGS/srg-export.log)"   # not-a-gate: propagates the exit of the command it guards
    elif [ -d "$INST" ]; then
      die "no Forge mappings yet — run the client step (its warm-up launch writes them) first"   # not-a-gate: step-order hint naming the client step
    else
      say "no Forge 1.20.1 mappings yet — srg_names.json skipped (re-run repo after a Forge 1.20.1 launch)"
    fi
  fi
  if [ -d "$INST" ]; then
    is_done client-files || die "$INST has no verified install (no client-files mark) — run the client step again"   # gate:repo-needs-verified-client
    say "sync into Monifactory"; ./gerda sync --only Monifactory > "$LOGS/sync.log" 2>&1 || die "sync failed (see $LOGS/sync.log)"   # not-a-gate: propagates the exit of the command it guards
    grep -E 'Fleet registry|Deployed|bridge|port' "$LOGS/sync.log" | head -5 || true
    [ -f "$GAME/config/jsMacros/Macros/main.js" ] || die "sync did not deploy main.js into $GAME"   # gate:repo-sync-deployed
  else
    say "no Monifactory instance (client step not run) — nothing to sync there; matrix/pack sync the test root"   # not-a-gate: message text that names the test root
  fi
  [ -d "$MDIR/instances" ] && sync_matrix_root   # not-a-gate: syncs the test root when it exists
  say "repo ready: $REPO_DIR @ $(git log --oneline -1)"
}

# ---------------------------------------------------------------- matrix
# name | launcher components | jsMacros pin var | extra jar pin var | MC version (world gen)
MATRIX=(
  "Vanilla-Forge-1.20.1|[{\"uid\":\"net.minecraft\",\"version\":\"1.20.1\",\"important\":true},{\"uid\":\"net.minecraftforge\",\"version\":\"47.4.13\"}]|JSMACROS_FORGE_1201||1.20.1"   # not-a-gate: an empty field of the matrix row
  "Fabric-1.20.1|[{\"uid\":\"net.minecraft\",\"version\":\"1.20.1\",\"important\":true},{\"uid\":\"net.fabricmc.intermediary\",\"version\":\"1.20.1\"},{\"uid\":\"net.fabricmc.fabric-loader\",\"version\":\"$FABRIC_LOADER_VERSION\"}]|JSMACROS_FABRIC_1201|FABRIC_BASE_1201|1.20.1"
  "Fabric-1.21|[{\"uid\":\"net.minecraft\",\"version\":\"1.21\",\"important\":true},{\"uid\":\"net.fabricmc.intermediary\",\"version\":\"1.21\"},{\"uid\":\"net.fabricmc.fabric-loader\",\"version\":\"$FABRIC_LOADER_VERSION\"}]|JSMACROS_FABRIC_121|FABRIC_BASE_121|1.21"
  "Forge-1.18.2|[{\"uid\":\"net.minecraft\",\"version\":\"1.18.2\",\"important\":true},{\"uid\":\"net.minecraftforge\",\"version\":\"$FORGE_1182_VERSION\"}]|JSMACROS_FORGE_1182||1.18.2"   # not-a-gate: an empty field of the matrix row
)

# gen_world <mc version> — a single-player world for a matrix instance, made without a GUI: the
# vanilla dedicated server of that version generates it (peaceful, fixed seed), the client opens
# it with quick-play `-w "New World"`. Cached in $CACHE/worlds/<version>.
gen_world() {
  local v=$1 dir="$CACHE/worlds/.gen-$1" jar sha url pid i
  [ -d "$CACHE/worlds/$v" ] && return 0   # not-a-gate: keeps a world generated before
  say "generate a $v world with the vanilla server"
  read -r url sha < <(python3 - "$v" <<'PY'
import json, sys, urllib.request
v = sys.argv[1]
m = json.load(urllib.request.urlopen("https://piston-meta.mojang.com/mc/game/version_manifest_v2.json"))
vj = json.load(urllib.request.urlopen(next(x["url"] for x in m["versions"] if x["id"] == v)))
print(vj["downloads"]["server"]["url"], vj["downloads"]["server"]["sha1"])
PY
) || die "no vanilla server download for $v in Mojang's version manifest"   # not-a-gate: propagates the exit of the command it guards
  jar="$CACHE/dl/minecraft-server-$v.jar"
  if [ ! -f "$jar" ]; then
    curl -fsSL --retry 4 -o "$jar.part" "$url" || { rm -f "$jar.part"; die "download failed: $url"; }   # not-a-gate: propagates the exit of the command it guards
    mv "$jar.part" "$jar"
  fi
  [ "$(sha1sum "$jar" | cut -d' ' -f1)" = "$sha" ] || { rm -f "$jar"; die "sha1 mismatch for the $v server jar (Mojang publishes $sha)"; }   # gate:world-server-sha1
  rm -rf "$dir"; mkdir -p "$dir"
  echo eula=true > "$dir/eula.txt"
  printf 'level-name=world\nlevel-seed=gerda\ndifficulty=peaceful\nonline-mode=false\nserver-port=25599\nspawn-protection=0\nmax-players=1\n' > "$dir/server.properties"
  mkfifo "$dir/console"
  (cd "$dir" && exec java -Xmx2G -jar "$jar" nogui < console > gen.log 2>&1) &
  pid=$!
  exec 7> "$dir/console"   # hold the console open; `stop` goes through it
  wait_log "$dir/gen.log" 'Done \([0-9.]+s\)!' 'Exception|FAILED|Failed to start' 600 \
    || { exec 7>&-; kill "$pid" 2>/dev/null; die "vanilla $v server did not finish world generation (see $dir/gen.log)"; }   # not-a-gate: diagnostic naming the world generator's log
  echo stop >&7
  for i in $(seq 1 120); do kill -0 "$pid" 2>/dev/null || break; sleep 1; done   # not-a-gate: waits for the server to exit
  exec 7>&-
  [ -f "$dir/world/level.dat" ] || die "no level.dat after the $v world generation"   # gate:world-level-dat
  mv "$dir/world" "$CACHE/worlds/$v"; rm -rf "$dir"
}

ensure_matrix_root() {
  install_launcher   # the binary, the account and the shared download dirs live in the main root
  mkdir -p "$MDIR/instances"
  # A second data root: FreesmLauncher is single-instance PER ROOT, so `-l` against the main root
  # would be handed to a running Monifactory launcher. The big shared dirs are symlinked.
  local d
  for d in assets libraries meta java; do mkdir -p "$LDIR/$d"; [ -e "$MDIR/$d" ] || ln -s "$LDIR/$d" "$MDIR/$d"; done   # not-a-gate: links the shared dirs when missing
  [ -f "$MDIR/accounts.json" ] || cp "$LDIR/accounts.json" "$MDIR/"   # not-a-gate: copies the account when missing
  [ -f "$MDIR/freesmlauncher.cfg" ] || grep -v '^SelectedInstance=' "$LDIR/freesmlauncher.cfg" > "$MDIR/freesmlauncher.cfg"   # not-a-gate: copies the launcher config when missing
}

ensure_world() {   # <instance> <mc version> — a "New World" save, generated once per version
  local saves="$MDIR/instances/$1/minecraft/saves"
  if [ ! -d "$saves/New World" ]; then
    gen_world "$2"; mkdir -p "$saves"; cp -a "$CACHE/worlds/$2" "$saves/New World"
  fi
  # A server-generated world has cheats off; arenas build with /fill, /give and /tp.
  python3 "$SBX_DIR/level_cheats.py" "$saves/New World" || die "could not allow cheats in $1's New World"   # not-a-gate: propagates the exit of the command it guards
}

# Deploy the harness into every instance of the test root: its own fleet registry and bridge
# ports from 55560, so it never touches the Monifactory instance (55544).
sync_matrix_root() {
  [ -d "$REPO_DIR/.git" ] || die "run the repo step first (the harness is deployed from ~/gerda)"   # not-a-gate: step-order hint naming the repo step
  mkdir -p "$HOME/matrix"
  say "sync into the test root (bridge ports from 55560, own registry)"   # not-a-gate: message text that names the test root
  (cd "$REPO_DIR" && MC_INSTANCES_ROOT=$MDIR/instances MC_BOTS_REGISTRY=$HOME/matrix/mc-bots.json \
    ./gerda sync --bridge-base-port 55560 > "$LOGS/sync-matrix.log" 2>&1) || die "test-root sync failed (see $LOGS/sync-matrix.log)"   # not-a-gate: propagates the exit of the command it guards
  local i
  for i in "$MDIR"/instances/*/; do
    i=$(basename "$i")
    # not-a-gate: status text of the test root, never fails
    echo "  $i: bridge $(cat "$MDIR/instances/$i/minecraft/config/jsMacros/Macros/bridge_port.txt" 2>/dev/null || echo 'none (no jsMacros)')," \
      "world: $([ -d "$MDIR/instances/$i/minecraft/saves/New World" ] && echo 'New World' || echo none)"
  done
}

do_matrix() {
  CUR=matrix
  ensure_matrix_root
  local row name comps jv ev mcv v
  for row in "${MATRIX[@]}"; do
    IFS='|' read -r name comps jv ev mcv <<< "$row"
    write_instance "$MDIR/instances" "$name" "$comps" 1024 2560
    for v in $jv $ev; do add_pinned_jar "$v" "$MDIR/instances/$name/minecraft/mods"; done
    write_options_txt "$MDIR/instances/$name/minecraft" 2
    write_jsm_options "$MDIR/instances/$name/minecraft"
    ensure_world "$name" "$mcv"
  done
  sync_matrix_root
  say "matrix instances ready in $MDIR/instances"
}

# pack <instance> <zip|url> [sha256|--unpinned] [--from <dir>] — any CurseForge-format modpack
# zip as a test-root instance, imported by the launcher; with --from, its mod files come from
# that installed instance instead. A url needs the zip's sha256; `--unpinned` takes it
# unchecked instead, and then downloads it again on every run (a cached copy proves nothing
# about the url now). The pack's own files are recorded, not pinned.
do_pack() {
  CUR=pack
  local usage="usage: pack <instance> <modpack zip path|url> [sha256|--unpinned] [--from <dir>]"
  local name=${1:?$usage} src=${2:?$usage} sha="" from zip man mc l lv
  shift 2
  [ "${1:-}" = --from ] || { sha=${1:-}; [ $# = 0 ] || shift; }   # not-a-gate: argument parsing of the sha or --from
  from=$(from_arg "$@")
  # the name becomes a directory and the zip's file name for the launcher's import
  [[ $name =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "instance name '$name': letters, digits, . _ - only ($usage)"   # gate:pack-instance-name
  [ -z "$sha" ] || [ "$sha" = --unpinned ] || [[ $sha =~ ^[0-9a-f]{64}$ ]] || die "not a sha256: '$sha' ($usage)"   # gate:pack-sha-format
  if [ -f "$src" ]; then
    zip=$src
    [[ $sha =~ ^[0-9a-f]{64}$ ]] && { [ "$(sha256sum "$zip" | cut -d' ' -f1)" = "$sha" ] || die "sha256 mismatch for $src"; }   # gate:pack-zip-sha256
  elif [ "$sha" = --unpinned ]; then sha=UNPINNED; zip=$(cached "$src"); rm -f "$zip"
  elif [ -n "$sha" ]; then zip=$(cached "$src")
  else die "a modpack url needs the zip's sha256 (or --unpinned to take it unchecked): $usage"; fi   # gate:pack-url-needs-sha
  ensure_matrix_root
  [ -f "$src" ] || fetch "$src" "$sha" "$zip"   # not-a-gate: a local zip needs no download
  pack_instance "$MDIR" "$name" "$zip" "pack-$name" "" 2048 4096 "$from"
  man=$(pack_manifest "$zip"); read -r mc l lv <<< "$man"
  ensure_world "$name" "$mc"
  sync_matrix_root
  say "pack instance $name ready — launch it with: start-matrix $name"
}

# add-mods <instance> <dir> — copy every *.jar from <dir> into that instance's mods/ (either root).
do_add_mods() {
  CUR=add-mods
  local name=${1:?usage: add-mods <instance> <dir with jars>} dir=${2:?usage: add-mods <instance> <dir>} mods j n=0
  if [ -d "$INST_ROOT/$name" ]; then mods="$INST_ROOT/$name/minecraft/mods"
  elif [ -d "$MDIR/instances/$name" ]; then mods="$MDIR/instances/$name/minecraft/mods"
  else die "no instance $name in $INST_ROOT or $MDIR/instances"; fi   # not-a-gate: usage, names no instance
  [ -z "$(game_pids "$LDIR")$(game_pids "$MDIR")" ] || die "stop the game first (sbx.sh stop): the mod list is read at launch"   # not-a-gate: advice, a running game reads mods only at launch
  mkdir -p "$mods"
  for j in "$dir"/*.jar; do [ -f "$j" ] || continue; cp "$j" "$mods/"; n=$((n + 1)); echo "  + $(basename "$j")"; done   # not-a-gate: skips a glob that matched nothing
  [ $n -gt 0 ] || die "no *.jar in $dir"   # gate:add-mods-nonempty
  say "$n jar(s) added to $mods"
}

do_start_matrix() {
  CUR=start-matrix
  local name=${1:?usage: start-matrix <instance> [world]} world=${2:-New World} args=() port i
  local mc="$MDIR/instances/$name/minecraft"
  DISP=${SBX_MATRIX_DISPLAY:-:100}
  [ -d "$mc" ] || die "no matrix instance $name (run matrix)"   # not-a-gate: usage, names no instance
  # gate:start-matrix-needs-verified-pack
  if is_done "pack-$name-started"; then is_done "pack-$name-files" || die "$name has no verified install (no pack-$name-files mark) — run the pack step again"; fi
  port=$(cat "$mc/config/jsMacros/Macros/bridge_port.txt" 2>/dev/null) || die "$name has no bridge_port.txt (run matrix after repo)"   # not-a-gate: step-order hint naming the matrix step
  [ -d "$mc/saves/$world" ] || die "$name has no world '$world' (run matrix: it generates one)"   # not-a-gate: step-order hint naming the matrix step
  # quick-play (-w) exists from 1.20 on; on 1.18.2 the game stops at the title screen and the
  # world is opened by hand: Singleplayer → New World → Play Selected World.
  args=(-w "$world")
  launch "$MDIR" "$name" "$LOGS/matrix-$name.log" "${args[@]}"
  wait_log "$mc/logs/latest.log" "$TITLE_OK" "$GAME_FAIL" 600 || die "$name did not reach the title screen"   # not-a-gate: diagnostic naming the title-screen wait
  if ! wait_log "$mc/logs/latest.log" 'logged in with entity id|joined the game' "$GAME_FAIL" 60; then
    # Pre-1.20 (no quick-play): click Singleplayer → the only world → Play Selected World.
    # Window-relative coordinates for the launcher's default 854x480 window at guiScale 2.
    say "$name did not open '$world' by itself (no quick-play before 1.20) — opening it with three clicks"
    local w X Y
    w=$(DISPLAY=$DISP xdotool search --name Minecraft | head -1) || die "no Minecraft window on $DISP"   # not-a-gate: propagates the exit of the command it guards
    eval "$(DISPLAY=$DISP xdotool getwindowgeometry --shell "$w")"
    DISPLAY=$DISP xdotool mousemove $((X + 425)) $((Y + 236)) click 1; sleep 3
    DISPLAY=$DISP xdotool mousemove $((X + 427)) $((Y + 134)) click 1; sleep 1
    DISPLAY=$DISP xdotool mousemove $((X + 267)) $((Y + 394)) click 1
    wait_log "$mc/logs/latest.log" 'logged in with entity id|joined the game' "$GAME_FAIL" 180 \
      || say "$name is still not in '$world' — the bridge runs at the title screen too; open the world by hand (DISPLAY $DISP)"   # not-a-gate: a hint, the join is not checked here
  fi
  for i in $(seq 1 36); do
    (cd "$REPO_DIR" && timeout 15 ./gerda ctl --port "$port" ping 2>&1) | grep -q pong && { say "$name up on DISPLAY $DISP, bridge $port answers"; return 0; }
    sleep 5
  done
  die "$name: bridge $port does not answer ping"   # gate:start-matrix-bridge
}

# ---------------------------------------------------------------- lifecycle
bridge_ping() { (cd "$REPO_DIR" && timeout 15 ./gerda ctl ping) 2>&1; }

do_start() {
  CUR=start
  [ -x "$SRV/server-ctl.sh" ] || die "run the server step first"   # not-a-gate: step-order hint naming the server step
  [ -f "$GAME/config/jsMacros/Macros/main.js" ] || die "run the repo step first (nothing deployed into the instance)"   # not-a-gate: step-order hint naming the repo step
  is_done client-files || die "the Monifactory instance has no verified install (no client-files mark) — run the client step again"   # gate:start-needs-verified-client
  ensure_x
  srv_start_wait
  if [ -n "$(game_pids "$LDIR")" ]; then say "client already running"; else
    local from; from=$(lines "$SRV/logs/latest.log")
    launch "$LDIR" Monifactory "$LOGS/client.log" -s localhost:25565
    wait_log "$SRV/logs/latest.log" "$ACCOUNT joined the game" 'Stopping server' 900 "$from" \
      || { tail -n 15 "$LOGS/client.log" | cut -c1-300; die "the bot did not join the server"; }   # gate:start-joined
  fi
  local i
  for i in $(seq 1 60); do
    if bridge_ping | grep -q pong; then say "bridge answers (ping → pong)"; return 0; fi
    sleep 5
  done
  die "joined, but the bridge does not answer ping after 5 min (services? see $GAME/logs/latest.log)"   # gate:start-bridge
}

do_stop() {
  CUR=stop
  [ -d "$MDIR" ] && stop_launcher_root "$MDIR"   # not-a-gate: stops the test root when it exists
  stop_launcher_root "$LDIR"
  if srv_running; then say "server: console stop (waits for the world save)"; srv_ctl stop || die "server did not stop"; fi   # not-a-gate: propagates the exit of the command it guards
  pkill -f "Xvfb :" 2>/dev/null || true
  say "stopped"
}

do_status() {
  CUR=status
  echo "server : $([ -x "$SRV/server-ctl.sh" ] && srv_ctl status || echo 'not installed')"   # not-a-gate: status text only, never fails
  echo "client : $([ -n "$(game_pids "$LDIR")" ] && echo "running (pid $(game_pids "$LDIR" | tr '\n' ' '))" || echo stopped)"   # not-a-gate: status text only, never fails
  echo "matrix : $([ -d "$MDIR" ] && { [ -n "$(game_pids "$MDIR")" ] && echo running || echo stopped; } || echo 'not installed')"   # not-a-gate: status text only, never fails
  echo "Xvfb   : $(pgrep -af Xvfb | cut -d' ' -f2-3 | tr '\n' ' ' || true)"
  echo "repo   : $([ -d "$REPO_DIR/.git" ] && git -C "$REPO_DIR" log --oneline -1 || echo 'not cloned')"   # not-a-gate: status text only, never fails
  echo "steps  : $(ls "$STATE" 2>/dev/null | grep '\.done$' | sed 's/\.done//' | tr '\n' ' ')"
  if [ -n "$(game_pids "$LDIR")" ] && [ -d "$REPO_DIR" ]; then echo "bridge : $(bridge_ping | tr -d '\n' | cut -c1-120)"; fi   # not-a-gate: status text only, never fails
}

do_verify() {
  CUR=verify
  cd "$REPO_DIR"
  local out ok=0 i
  # Right after the join the client is still loading chunks and EMI's index on a software GL
  # renderer; main.js answers late (>5 s) for a minute or two. Settled = 3 pongs in a row.
  for i in $(seq 1 40); do
    if out=$(timeout 30 ./gerda ctl ping 2>&1) && echo "$out" | grep -q pong; then ok=$((ok + 1)); else ok=0; fi
    [ $ok -ge 3 ] && break   # gate:verify-ping
    sleep 5
  done
  [ $ok -ge 3 ] || die "bridge never answered 3 pings in a row: $(echo "$out" | tail -n 1)"   # gate:verify-ping
  say "ping: $(echo "$out" | tr -d '\n' | cut -c1-120)"
  for i in 1 2 3; do
    timeout 300 ./gerda smoke > "$LOGS/smoke.log" 2>&1 && break
    [ $i = 3 ] && { tail -n 30 "$LOGS/smoke.log"; die "smoke failed 3 times (see $LOGS/smoke.log)"; }   # gate:verify-smoke
    say "smoke attempt $i failed ($(tail -n 1 "$LOGS/smoke.log" | cut -c1-120)); retry in 20 s"; sleep 20
  done
  tail -n 5 "$LOGS/smoke.log"
  say "verify OK"
}

do_console() {
  CUR=console
  [ $# -ge 1 ] || die "usage: console <server console command>"   # not-a-gate: usage of the console step
  srv_running || die "the server is not running (start or server first)"   # not-a-gate: step-order hint naming the server step
  local from; from=$(lines "$SRV/logs/latest.log")
  srv_ctl cmd "$@" >/dev/null || die "server-ctl cmd failed"   # not-a-gate: propagates the exit of the command it guards
  sleep 2
  tail -n +"$((from + 1))" "$SRV/logs/latest.log" | cut -c1-200
}

# ---------------------------------------------------------------- record
# The client renders into an Xvfb framebuffer, so plain x11grab sees every frame the game draws
# (no compositor, no GPU). Only the game window is grabbed: the rest of the 1920x1080 screen is
# black and would drown the brightness check.
REC_MIN_LUMA=${SBX_REC_MIN_LUMA:-30}   # mean gray level 0..255 under which a take counts as black
do_record() {
  CUR=record
  local secs=${1:?usage: record <seconds> [name]} name=${2:-rec-$(date -u +%Y%m%d-%H%M%S)} disp pid w X Y WIDTH HEIGHT
  local out=$HOME/recordings/$name.mp4 probe=$REPO_DIR/scripts/rig/motion_probe.py
  [[ $secs =~ ^[0-9]+$ ]] && [ "$secs" -gt 0 ] || die "seconds must be a positive whole number, got '$secs'"   # not-a-gate: usage of the record step
  command -v ffmpeg >/dev/null || die "no ffmpeg in this image — rebuild it (provision.sh build), then down + up"   # not-a-gate: names a missing tool of the image
  [ -f "$probe" ] || die "no $probe — run the repo step first (it holds the black-frame check)"   # not-a-gate: step-order hint naming the repo step
  if pid=$(game_pids "$LDIR" | head -1) && [ -n "$pid" ]; then disp=$DISP   # not-a-gate: picks the display of the running game
  elif pid=$(game_pids "$MDIR" | head -1) && [ -n "$pid" ]; then disp=${SBX_MATRIX_DISPLAY:-:100}   # not-a-gate: picks the display of the running game
  else die "no game client is running (start or start-matrix first)"; fi   # not-a-gate: step-order hint naming the start step
  # By the game's pid, not its title: a modpack renames the window ("Monifactory (BETA)").
  w=$(DISPLAY=$disp xdotool search --onlyvisible --pid "$pid" 2>/dev/null | head -1) || true
  [ -n "$w" ] || die "no visible window of the game (pid $pid) on DISPLAY $disp"   # not-a-gate: diagnostic naming the missing window
  eval "$(DISPLAY=$disp xdotool getwindowgeometry --shell "$w")"
  WIDTH=$((WIDTH / 2 * 2)); HEIGHT=$((HEIGHT / 2 * 2))   # h264 + yuv420p need even sizes
  mkdir -p "$HOME/recordings"
  say "recording ${secs}s of the window ${WIDTH}x${HEIGHT}+$X+$Y on DISPLAY $disp → $out"
  ffmpeg -nostdin -y -loglevel error -f x11grab -framerate 30 -video_size "${WIDTH}x${HEIGHT}" \
    -i "$disp+$X,$Y" -t "$secs" -c:v libx264 -preset veryfast -crf 23 -pix_fmt yuv420p \
    -movflags +faststart -an "$out" || die "ffmpeg x11grab failed"   # not-a-gate: propagates the exit of the command it guards
  [ -s "$out" ] || die "ffmpeg wrote nothing to $out"   # not-a-gate: diagnostic naming the empty file
  ffprobe -v error -show_entries format=duration,size -of default=noprint_wrappers=1 "$out"
  python3 "$probe" --min-luma "$REC_MIN_LUMA" "$out" || die "the recording failed the check above (black or unreadable): $out"   # gate:record-black-check
  say "recorded $out"
}

# ---------------------------------------------------------------- dispatch
# Sourced (scripts/tests/test_sandbox_scripts.py does, for the functions): define, never dispatch.
[[ ${BASH_SOURCE[0]} != "$0" ]] && return 0   # not-a-gate: sourced for tests: define, never dispatch
cmd=${1:-}; shift || true
case "$cmd" in
  server) do_server ;;
  client) do_client "$@" ;;
  repo) do_repo "$@" ;;
  matrix) do_matrix ;;
  pack) do_pack "$@" ;;
  add-mods) do_add_mods "$@" ;;
  start) do_start ;;
  start-matrix) do_start_matrix "$@" ;;
  stop) do_stop ;;
  status) do_status ;;
  verify) do_verify ;;
  record) do_record "$@" ;;
  console) do_console "$@" ;;
  *) sed -n '/^set -euo pipefail/q;2,$p' "${BASH_SOURCE[0]}"; [ -z "$cmd" ] || [ "$cmd" = -h ] || [ "$cmd" = help ] ;;   # gate:dispatch-unknown-fails
esac
