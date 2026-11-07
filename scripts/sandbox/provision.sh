#!/usr/bin/env bash
# provision.sh — build and drive the Gerda sandbox: a rootless podman container that plays a
# plain Ubuntu 24.04 PC, with a real Minecraft client (software GL on Xvfb), a dedicated server,
# jsMacros and the Gerda harness installed unattended. Host half; the steps run inside (sbx.sh).
#
#   provision.sh build                 build the image (Containerfile)
#   provision.sh up                    create + start the container (or start a stopped one)
#   provision.sh server                install + configure + boot the Monifactory server
#   provision.sh client [--from <dir>] launcher + Monifactory client (the launcher's own import of
#                                      the modpack, or the mods of an instance you installed
#                                      yourself) + jsMacros (+ warm-up launch)
#   provision.sh repo <bundle|url> [branch]   clone, install, build, sync into the instance
#   provision.sh matrix                the 4 vanilla+jsMacros instances (after repo)
#   provision.sh pack <instance> <modpack.zip|url> [sha256|--unpinned] [--from <dir>]   your
#                                      CurseForge-format modpack; a url needs the zip's sha256
#                                      or --unpinned
#   provision.sh add-mods <instance> <jar|dir>...             your mod jars into an instance
#   provision.sh start | stop | status | verify
#   provision.sh start-matrix <instance> [world]
#   provision.sh console <command...>  a server console command, e.g. `console op student_bot`
#   provision.sh record <seconds> [host.mp4]  film the running client's window; checked not black
#   provision.sh fetch <path in container> [host dest]   copy a file out (~-relative paths work)
#   provision.sh all <bundle|url> [branch]    build → up → server → client → repo → start → verify
#   provision.sh shell                 interactive shell as student
#   provision.sh logs [name]           list ~/logs, or tail one
#   provision.sh down                  stop game + server gracefully, then stop the container
#   provision.sh destroy --yes         remove the container and its home volume (cache kept);
#                                      only ones `up` created (label gerda.sandbox=1)
#
# Any step takes `--detach`: run it in the background inside the container, log to
# ~/logs/sbx-<step>.log, and return; `provision.sh wait <step> [seconds]` polls for its result.
#
# Environment (defaults in brackets):
#   SBX_NAME [gerda-sandbox]  SBX_IMAGE [localhost/gerda-sandbox:1]
#   SBX_CACHE_VOL [gerda-sandbox-cache] (downloads, shared by every sandbox; ~1.5 GB)
#   SBX_HOME_VOL [<name>-home]  SBX_MEMORY [24g]  SBX_CPUS [12]  SBX_PIDS [8192]
#   GERDA_REPO [the checkout this script lives in] — source of scripts/ops/server-ctl.sh
#
# The container gets its OWN network namespace (podman's default). Never --network=host: the
# host may run a live Minecraft client (bridge 55544) and server (25565) on the same ports.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NAME=${SBX_NAME:-gerda-sandbox}
IMAGE=${SBX_IMAGE:-localhost/gerda-sandbox:1}
CACHE_VOL=${SBX_CACHE_VOL:-gerda-sandbox-cache}
HOME_VOL=${SBX_HOME_VOL:-$NAME-home}
MEM=${SBX_MEMORY:-24g}
CPUS=${SBX_CPUS:-12}
PIDS=${SBX_PIDS:-8192}
# scripts/sandbox/provision.sh → the repo root is two levels up.
REPO=${GERDA_REPO:-$(cd "$HERE/../.." && pwd)}
CHOME=/home/student   # the home of the user `student` INSIDE the container (Containerfile)
LABEL=gerda.sandbox=1   # on the container and the volumes `up` creates; `destroy` checks it

die() { echo "FAIL: provision: $*" >&2; exit 1; }   # gate:prov-die-exits
say() { echo "== [$(date -u +%H:%M:%S)] provision: $*"; }
exists() { podman container exists "$NAME"; }
running() { [ "$(podman inspect -f '{{.State.Running}}' "$NAME" 2>/dev/null)" = true ]; }   # not-a-gate: predicate whether the container runs
need_running() { running || die "container $NAME is not running — provision.sh up"; }   # not-a-gate: step-order hint naming the up step
labelled() {   # container|volume <name> — true when it carries $LABEL
  local fmt='{{index .Config.Labels "'"${LABEL%=*}"'"}}'
  [ "$1" = volume ] && fmt='{{index .Labels "'"${LABEL%=*}"'"}}'   # not-a-gate: picks the label format for volumes
  [ "$(podman "$1" inspect -f "$fmt" "$2" 2>/dev/null)" = "${LABEL#*=}" ]   # gate:destroy-container-label gate:destroy-volume-label
}

# in_sbx [--detach] <step> [args] — run sbx.sh inside as student.
in_sbx() {
  local detach=0
  [ "${1:-}" = --detach ] && { detach=1; shift; }   # not-a-gate: option parsing of --detach
  need_running
  if [ $detach = 1 ]; then
    podman exec -u student "$NAME" mkdir -p $CHOME/logs $CHOME/.sbx/rc
    podman exec -u student "$NAME" rm -f "$CHOME/.sbx/rc/$1"
    podman exec -d -u student -w $CHOME "$NAME" \
      bash -c 'step=$1; bash /opt/sbx/sbx.sh "$@" > "$HOME/logs/sbx-$step.log" 2>&1; echo $? > "$HOME/.sbx/rc/$step"' _ "$@"
    say "$1 started in the background — log ~/logs/sbx-$1.log; poll: provision.sh wait $1"
  else
    podman exec -u student -w $CHOME "$NAME" bash /opt/sbx/sbx.sh "$@"
  fi
}

do_build() {
  # shellcheck source=pins.env
  source "$HERE/pins.env"
  say "build $IMAGE"
  podman build -t "$IMAGE" --build-arg BASE_IMAGE="$BASE_IMAGE" \
    --build-arg BUN_VERSION="$BUN_VERSION" --build-arg BUN_SHA256="$BUN_SHA256" \
    --build-arg UV_VERSION="$UV_VERSION" --build-arg UV_SHA256="$UV_SHA256" \
    -f "$HERE/Containerfile" "$HERE"
}

do_up() {
  if exists; then
    running && { say "$NAME already running"; return 0; }
    say "start existing $NAME"; podman start "$NAME" >/dev/null; return 0
  fi
  podman image exists "$IMAGE" || die "no image $IMAGE — provision.sh build"   # not-a-gate: step-order hint naming the build step
  say "create $NAME (mem $MEM, cpus $CPUS, pids $PIDS, cache volume $CACHE_VOL, home volume $HOME_VOL)"
  # The label marks what this script made: `destroy` removes only a labelled container + volume.
  local v
  for v in "$CACHE_VOL" "$HOME_VOL"; do
    podman volume exists "$v" || podman volume create --label "$LABEL" "$v" >/dev/null   # gate:up-labels
  done
  # --init: a real PID 1 reaps the server/launcher children (no zombies, clean SIGTERM on stop).
  # --pids-limit: the modded client alone runs ~300 threads; 2048 starved it.
  # gate:up-labels
  podman run -d --name "$NAME" --label "$LABEL" --hostname student-pc --init \
    --pids-limit "$PIDS" --memory "$MEM" --cpus "$CPUS" --shm-size 1g \
    -v "$CACHE_VOL:/cache" -v "$HOME_VOL:$CHOME" -v "$HERE:/opt/sbx:ro" \
    "$IMAGE" sleep infinity >/dev/null
  podman exec -u root "$NAME" chown student:student /cache $CHOME
  say "$NAME up"
}

stage_server_ctl() {
  local f="$REPO/scripts/ops/server-ctl.sh"
  [ -f "$f" ] || die "no $f — set GERDA_REPO to a Gerda checkout"   # not-a-gate: names the checkout GERDA_REPO must point at
  podman cp "$f" "$NAME:/tmp/server-ctl.sh"
  podman exec -u root "$NAME" chmod 0755 /tmp/server-ctl.sh
}

stage_file() {   # <host file> <container path> — copy in, readable by student; prints the path
  podman cp "$1" "$NAME:$2"
  podman exec -u root "$NAME" chmod a+r "$2"
  echo "$2"
}

# stage_from <host dir> <tag> — for `--from`: the pack files (mods/, resourcepacks/,
# shaderpacks/) of an installed launcher instance, copied in; prints the container path. The
# dir may be the instance folder or its minecraft folder (sbx.sh from_game_dir, same shapes).
stage_from() {
  local src=$1 dst=/tmp/sbx-from-$2 g d
  for g in "$src/minecraft" "$src/.minecraft" "$src" ""; do [ -n "$g" ] && [ -d "$g/mods" ] && break; done   # not-a-gate: finds the minecraft dir of the instance
  [ -n "$g" ] || die "--from $src: no mods/ in it, in minecraft/ or in .minecraft/ — point it at an installed instance"   # gate:prov-from-shape
  podman exec -u root "$NAME" rm -rf "$dst"
  podman exec -u root "$NAME" mkdir -p "$dst"
  for d in mods resourcepacks shaderpacks; do
    [ -d "$g/$d" ] && { podman cp "$g/$d" "$NAME:$dst/$d" || die "could not copy $g/$d into $NAME"; }   # not-a-gate: propagates the exit of the command it guards
  done
  podman exec -u root "$NAME" chmod -R a+rX "$dst"
  echo "$dst"
}

stage_repo_src() {   # host path → copied in; anything else (URL) passes through
  local src=$1
  if [ -e "$src" ]; then
    podman exec -u root "$NAME" rm -rf /tmp/gerda-src
    podman cp "$src" "$NAME:/tmp/gerda-src"
    podman exec -u root "$NAME" chmod -R a+rX /tmp/gerda-src
    echo /tmp/gerda-src
  else
    echo "$src"
  fi
}

fetch() {   # <container path, absolute or relative to the student's home> [host dest]
  local src=$1 dest=${2:-.}
  need_running
  case "$src" in /*) ;; *) src=$CHOME/${src#\~/} ;; esac
  podman cp "$NAME:$src" "$dest" || die "could not copy $src out of $NAME"   # not-a-gate: propagates the exit of the command it guards
  say "copied $src → $dest"
}

do_wait() {   # wait <step> [seconds]
  local step=${1:?usage: wait <step> [seconds]} t=${2:-570} i rc
  need_running
  for ((i = 0; i < t; i += 10)); do
    if rc=$(podman exec -u student "$NAME" cat "$CHOME/.sbx/rc/$step" 2>/dev/null); then
      podman exec -u student "$NAME" tail -n 15 "$CHOME/logs/sbx-$step.log"
      [ "$rc" = 0 ] && { say "$step finished OK"; return 0; }   # not-a-gate: the success branch of the wait
      die "$step exited $rc (log ~/logs/sbx-$step.log)"   # gate:wait-step-rc
    fi
    sleep 10
  done
  podman exec -u student "$NAME" tail -n 3 "$CHOME/logs/sbx-$step.log" || true
  say "$step still running after ${t}s — wait again"; return 3   # gate:wait-still-running
}

detach=()
args=()
for a in "$@"; do [ "$a" = --detach ] && detach=(--detach) || args+=("$a"); done   # not-a-gate: option parsing of --detach
set -- "${args[@]}"
cmd=${1:-}; shift || true
case "$cmd" in
  build) do_build ;;
  up) do_up ;;
  server) stage_server_ctl; in_sbx "${detach[@]}" server ;;
  client) if [ $# -gt 0 ]; then
            [ "$1" = --from ] && [ $# = 2 ] || die "usage: client [--from <installed instance folder>]"   # not-a-gate: usage text of the step
            staged=$(stage_from "$2" client)   # an assignment, so a failed stage stops here
            set -- --from "$staged"
          fi
          in_sbx "${detach[@]}" client "$@" ;;
  matrix|start|stop|status|verify) in_sbx "${detach[@]}" "$cmd" ;;
  console) in_sbx console "$@" ;;
  start-matrix) in_sbx "${detach[@]}" start-matrix "$@" ;;
  pack) [ $# -ge 2 ] || die "usage: pack <instance> <modpack zip path|url> [sha256|--unpinned] [--from <dir>]"   # not-a-gate: usage text of the step
        name=$1 src=$2; shift 2
        # sbx.sh checks the same; here it comes before the name is used in a container path
        [[ $name =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]] || die "pack: instance name '$name': letters, digits, . _ - only"   # gate:prov-pack-instance-name
        if [ -e "$src" ]; then src=$(stage_file "$src" "/tmp/sbx-pack-$name.zip"); fi
        rest=()
        while [ $# -gt 0 ]; do
          if [ "$1" = --from ]; then
            [ $# -ge 2 ] || die "pack: --from needs a directory"   # not-a-gate: usage text of the step
            staged=$(stage_from "$2" "pack-$name"); rest+=(--from "$staged"); shift 2
          else rest+=("$1"); shift; fi
        done
        in_sbx "${detach[@]}" pack "$name" "$src" "${rest[@]}" ;;
  add-mods) [ $# -ge 2 ] || die "usage: add-mods <instance> <jar|dir>..."   # not-a-gate: usage text of the step
            name=$1; shift
            podman exec -u student "$NAME" rm -rf "/tmp/sbx-mods-$name"
            podman exec -u student "$NAME" mkdir -p "/tmp/sbx-mods-$name"
            for m in "$@"; do
              if [ -d "$m" ]; then for j in "$m"/*.jar; do [ -f "$j" ] && podman cp "$j" "$NAME:/tmp/sbx-mods-$name/"; done   # not-a-gate: copies each jar of the folder
              elif [ -f "$m" ]; then podman cp "$m" "$NAME:/tmp/sbx-mods-$name/"
              else die "no such jar or directory: $m"; fi   # not-a-gate: usage, names a missing argument
            done
            podman exec -u root "$NAME" chmod -R a+rX "/tmp/sbx-mods-$name"
            in_sbx add-mods "$name" "/tmp/sbx-mods-$name" ;;
  repo) [ $# -ge 1 ] || die "usage: repo <bundle-path|git-url> [branch]"   # not-a-gate: usage text of the step
        src=$(stage_repo_src "$1"); shift; in_sbx "${detach[@]}" repo "$src" "$@" ;;
  wait) do_wait "$@" ;;
  record) [ $# -ge 1 ] || die "usage: record <seconds> [host.mp4]"   # not-a-gate: usage text of the step
          secs=$1 out=${2:-}
          rec=${out:+$(basename "$out" .mp4)}; rec=${rec:-rec-$(date -u +%Y%m%d-%H%M%S)}
          in_sbx "${detach[@]}" record "$secs" "$rec"
          if [ ${#detach[@]} = 0 ]; then fetch "recordings/$rec.mp4" "${out:-./$rec.mp4}"
          else say "after \`provision.sh wait record\`: provision.sh fetch recordings/$rec.mp4"; fi ;;
  fetch) [ $# -ge 1 ] || die "usage: fetch <path in container> [host dest]"; fetch "$@" ;;   # not-a-gate: usage text of the step
  all) [ $# -ge 1 ] || die "usage: all <bundle-path|git-url> [branch]"   # not-a-gate: usage text of the step
       do_build; do_up; stage_server_ctl; in_sbx server; in_sbx client
       src=$(stage_repo_src "$1"); shift; in_sbx repo "$src" "$@"; in_sbx start; in_sbx verify ;;
  shell) need_running; exec podman exec -it -u student -w $CHOME "$NAME" bash -l ;;
  logs) need_running
        if [ $# -ge 1 ]; then podman exec -u student "$NAME" tail -n "${2:-60}" "$CHOME/logs/$1"
        else podman exec -u student "$NAME" ls -lt $CHOME/logs; fi ;;
  down) if running; then in_sbx stop || true; podman stop -t 30 "$NAME" >/dev/null; fi; say "$NAME stopped (kept)" ;;
  destroy) [ "${1:-}" = --yes ] || die "destroy removes $NAME and volume $HOME_VOL (cache $CACHE_VOL is kept) — pass --yes"   # gate:destroy-needs-yes
           if exists; then
             labelled container "$NAME" || die "container $NAME has no ${LABEL%=*} label, so this script did not create it — not removing it"   # gate:destroy-container-label
             running && { in_sbx stop || say "stop inside $NAME failed — removing it anyway"; }   # not-a-gate: stops the game before removal, best effort
             podman rm -f -t 30 "$NAME" >/dev/null || die "could not remove container $NAME"   # gate:destroy-reports-failure
           fi
           if podman volume exists "$HOME_VOL"; then
             labelled volume "$HOME_VOL" || die "volume $HOME_VOL has no ${LABEL%=*} label, so this script did not create it — not removing it"   # gate:destroy-volume-label
             podman volume rm "$HOME_VOL" >/dev/null || die "could not remove volume $HOME_VOL"   # gate:destroy-reports-failure
           fi
           say "removed $NAME + $HOME_VOL; cache $CACHE_VOL kept" ;;
  *) sed -n '/^set -euo pipefail/q;2,$p' "${BASH_SOURCE[0]}"; [ -z "$cmd" ] || [ "$cmd" = -h ] || [ "$cmd" = help ] ;;   # gate:prov-dispatch-unknown-fails
esac
