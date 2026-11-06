# RIG.md — booting bot clients off-screen: filming and headless running

Two flows over one boot script, `scripts/ops/capture_rig.sh`:

- **Film** — record the bot doing real work (mine → smelt → restock), hands-free.
- **Run** — boot one bot client invisibly and drive it over the bridge. No camera.

Both start Minecraft inside an independent **headless sway** compositor (output `HEADLESS-1`).
Nothing appears on your monitor or steals focus. The script's header explains the capture model.
Two agent skills in Claude Code format, `/gerda-film` and `/gerda-run` (`.claude/skills/`),
follow this doc.

**Tested on:** Linux, NVIDIA GPU (proprietary driver), sway headless (wlroots) + Xwayland,
wf-recorder, ffmpeg, FreesmLauncher, Nix. It has run live only on the maintainer's machine.
Automated checks cover build and `just check` in a clean container; none boots a client.

## Shared topology

| role | instance | account | bridge | notes |
|---|---|---|---|---|
| worker | `Monifactory_bot_1` | `bot_1` | 55545 | non-op, runs the bundle |
| camera | `Monifactory_bot_2` | your op account | 55546 | op spectator: camera and item source |
| camera + shader (optional) | a copy of the camera instance | your op account | the camera's port | replaces the camera; never boot both |

Examples assume the default assignment (worker 55545, camera 55546); substitute the ports
`mc-bots.json` gave your instances.

- **Ports** come from the machine-local `mc-bots.json` (gitignored); `just sync` keeps an
  instance's existing port. Verify after every sync: the file is
  `<instanceDir>/minecraft/config/jsMacros/Macros/bridge_port.txt`, a `mc_bridge_port` GlobalVar
  overrides it, and on a running client `python3 scripts/ops/bridge_ctl.py --port <port>
  bridge_diag` reports the live value (it answers even when main is deaf). Machine state files
  (`mc-bots.json`, `mc-tasks.json`, `local.config.json`) resolve from `git rev-parse
  --git-common-dir` (`scripts/machine_root.py`), so every worktree shares one registry;
  `--separate-git-dir` clones are unsupported.
- **Names** come from `local.config.json` (copy the `.example`; env vars win):
  `cameraAccountName` / `MC_CAMERA_ACCOUNT_NAME` is the op camera account
  (`python3 scripts/local_config.py camera_account_name`); `serverRoot` / `MC_SERVER_ROOT` locates
  the server (`python3 scripts/local_config.py server_dir`, see [SERVER_SETUP.md](SERVER_SETUP.md)).
  The demo scripts refuse to run without them.
- **Server:** `"$(python3 scripts/local_config.py server_ctl)" {start|status|cmd "<console>"|log}`
  — always day, peaceful, offline mode, `localhost:25565`. The console has full op authority.
- **The bot plays like a real player:** no cheats; its only server privilege is teleport. What
  the filmed scenes hand it and reset around it is listed in
  [What the filmed scenes stage](#what-the-filmed-scenes-stage).
- **Devshell:** boot and record commands run under `nix develop .#capture -c …` (sway, Xwayland,
  wf-recorder, ffmpeg, grim, fontconfig, python3). `freesmlauncher` must be on `PATH`. Bridge
  driving is plain `python3`.
- **Boot serially.** Two modded clients booting at once deadlock mod loading. Worker first, wait
  for its bridge, then the camera.
- **Co-launch guard.** A same-name login kicks whoever holds the account, so `capture_rig.sh`
  refuses to launch while another launcher client runs. Booting the camera over your own worker
  needs `ALLOW_CONCURRENT=1`.

## What the filmed scenes stage

The filmed scenes are staged. Scripts, the server console and the op camera build each scene,
supply the bot and reset the scene between laps. Once a mission or plan runs, the bot's moves are
its own.

No `/give` targets the bot. Every item it is handed goes the same way: the server console gives
it to the op camera account, the camera drops it, and the bot picks it up.

- **Sets.** The server console builds the sustain-loop stage (`sustain_live.py build`). The
  other sets were built live (console fills) and later captured as data; `arena.py build`
  restages them (see § Sets below).
- **Position.** The shot list's `console` lines teleport the bot into place for `01_clutch`,
  `02a_prospect` and `05_economy` (`scenarios/shots/teaser.json`).
- **Stage seal** (sustain loop). `sustain_live.py build` also makes the stage floor bedrock and
  lays a ring of invisible barrier blocks around it, so the bot cannot dig a pit or walk off,
  and it empties the bot's cached prospect veins so that the plan does not walk to a far vein.
  `sustain_live.py storage` places the deposit chest and registers it with the bot
  (`storage_add`).
- **Starter kit** (sustain loop). The camera gets 32 coal, 32 cobblestone and 1 crafting table
  and drops them; a console `tp @e[type=item]` moves the dropped items onto the bot
  (`sustain_live.py supply`). Film staging only — fleet play never hands the bot items (see
  [FLEET_PLAYBOOK § 1](FLEET_PLAYBOOK.md#1-the-server-and-how-the-bots-play-read-first)).
- **Pickaxe** (sustain loop). The bot's diamond pickaxe came the same way, as a manual step
  before filming; no script does it. The plan crafts only the spare
  (`src/bot/plans/sustain-cycle.ts`).
- **Between laps** (sustain loop). Each lap (driven by `sustain_live.py loop`) aborts the
  plan, replaces the three furnaces with empty ones, refills the 25-block iron-ore patch, teleports the bot back to
  (3, 101, 1) and fills the two outer furnaces with console data so that they glow. The bot loads
  only the centre furnace. Each lap ends by restarting the plan; `loop` waits `LAP_DWELL_S`
  seconds after each lap.
- **Vein shot** (`03_vein`). The bot mines a built room lined with iron ore and lit by invisible
  light blocks (set `03_ore_chamber`).
- **Shaft shot** (`02b_shaft`). The vein is chosen in advance; for the filmed take the marker was
  edited by hand. On a restage, the `marker` op of set `03_ore_chamber` writes an
  iron vein on column (-343, -70) into the world store of the instance in `MC_INST` (the bot's
  instance, see § Sets), so `drill` sinks its shaft there, through natural rock into the ore room.
- **Clutch shot** (`01_clutch`). The water bucket came the same way, as a manual step; the shot
  list notes it, and no script runs it. `scripts/demo/walk_off.sh` presses the forward key for
  500 ms to step the bot off the ledge. The water placement and the scoop back are the bot's
  reflex.

The teaser caption "Every block earned — no /give, no cheats" describes the bot: no `/give`
targets it, and it runs no cheat command. "Every block earned" is not literal: the kit's
cobblestone and crafting table were dropped to the bot, and the console places and refills the
ore it mines in the sustain loop. The scene around the bot is staged as listed here.

## `capture_rig.sh` flags

```
-a account  -l instance   FreesmLauncher profile + instance dir (required)
-s host:port              join a server after boot (else title screen)
-R WxH                    headless resolution (default 1920x1080, always @60Hz)
-c codec                  encoder (default libx264; h264_nvenc only once NVENC works on your driver)
-o out.mp4  -t seconds    record file / duration (0 = until client exit or Ctrl-C)
-H "cmd"                  READY hook, run once before recording
-K                        boot and keep alive; do not record
-P                        use the capture options profile; restore the playing one on exit
```

`-P` swaps `options.txt` for the recording profile: no view bob, no FOV pulse, no screen warp,
gamma 1.0, FOV about 90, render distance 16, `enableVsync:false`. Use it on the camera for every
take. A failed swap is fatal. `scripts/rig/teardown.sh` also restores the profile, so a client
killed from outside does not stay on it.

The `-H` hook gets `CAM_WAYLAND` (the camera's sway display), `CAM_SWAYSOCK`, `CAM_XDISPLAY`,
`MC_INSTANCE` and `MC_LOG`. A hook failure is a warning.

---

## Film — hands-free capture

### 0. Deploy before the camera boots

A sync rewrites the service files in every instance; jsMacros restarts them, and the camera's
per-frame Forge listener (from `harness/ext.js`) cannot be unregistered, so the camera crashes.
**Deploy first, boot the camera second.** If the camera is already up:

```
./gerda sync --skip <camera-instance>     # or: just sync --skip <camera-instance>
```

`--skip` is repeatable, excludes the instance from bundle, services and `bridge_port.txt`, and
errors on an unknown name. The worker tolerates a live sync.

### 1. Boot the worker and wait for its bridge

```
nix develop .#capture -c scripts/ops/capture_rig.sh \
  -a bot_1 -l Monifactory_bot_1 -s localhost:25565 -K &
python3 scripts/ops/bridge_ctl.py --port 55545 --wait-ready 90 status
```

`--wait-ready` retries until `status` answers. `--wait` only waits for the port to open (the bridge
listens from the title screen but answers only in-world), and `--timeout` does not wait at all. For
a guaranteed in-world state, check that `get_state` reports a position.

### 2. Stage the scene

`scripts/demo/sustain_live.py` builds the `sustain-cycle` arena through the server console:

```
python3 scripts/demo/sustain_live.py build     # floor + 25-block ore patch + 3 furnaces, sealed; clears prospect cache
python3 scripts/demo/sustain_live.py supply    # drop coal/cobble/table for the bot — needs the camera on 55546
python3 scripts/demo/sustain_live.py storage   # place + register the deposit chest — after supply
```

Order: `build`, boot the camera (step 3), then `supply` and `storage` (the step 3 hook runs
them). `supply` acts through the op player on `CAM_PORT` (55546, or `SHOOT_CAM_PORT`); `storage`
places the chest from the console and registers it over the bot's bridge. The sealed floor and barrier walls keep the bot
in the arena; the cleared cache makes a mined-out patch return `PROSPECT_EMPTY` at once. `loop`
re-arms the patch every 30 s.

### 3. Boot the camera with a READY hook

`$RIG_TMP` is any scratch dir (`export RIG_TMP=$(mktemp -d)`):

```bash
# $RIG_TMP/film_hook.sh
set -e
cd <repo>
python3 scripts/demo/sustain_live.py wait       # hook fires at the title menu: block until in-world
python3 scripts/demo/sustain_live.py supply     # kit drop — puts the camera in survival on the bot
python3 scripts/demo/sustain_live.py storage    # place + register the deposit chest
python3 scripts/demo/sustain_live.py frame      # LAST: camera pose + spectator + HUD off
WAYLAND_DISPLAY=$CAM_WAYLAND \
  ON_START="python3 scripts/demo/sustain_live.py loop 3 &" \
  scripts/rig/record.sh "$RIG_TMP/sustain_raw.mp4" 150 HEADLESS-1 60
```

```
ALLOW_CONCURRENT=1 nix develop .#capture -c scripts/ops/capture_rig.sh \
  -a "$(python3 scripts/local_config.py camera_account_name)" -l Monifactory_bot_2 -s localhost:25565 \
  -K -t 170 -H "bash $RIG_TMP/film_hook.sh"
```

- **Use `-K`.** `record.sh` in the hook owns the recording; without `-K` a second recorder starts
  and its frame guard kills the keep-alive.
- **`wait` is the hook's first line.** The hook runs before the camera's bridge listens; without it
  `supply` and `frame` get `Connection refused`.
- **`frame` runs after `supply`.** `supply` switches the camera to survival and moves it onto the
  bot to drop the kit; `frame` puts it back in spectator at its pose. In the other order the take
  records from the bot's spawn cell.
- **`record.sh` runs wf-recorder with `-D`**, so a static scene still records at a constant frame
  rate. If its frame guard fires anyway, the output is stuck: check `swaymsg -t get_outputs` (dead
  sway, wrong output name, mode not @60Hz).

### 4. Encode

```
nix develop .#capture -c scripts/rig/encode.sh "$RIG_TMP/sustain_raw.mp4" release/gerda_sustain_demo.mp4
```

h264, crf 20, preset slow, +faststart, no audio. A trailing `1440`/`1080`/`720` downscales.
`release/` is gitignored.

### 5. Verify and tear down

- `ffprobe` the encode and extract a few frames (`ffmpeg -ss <t> -i out.mp4 -frames:v 1 f.png`):
  bot mining, furnace lit, bot hauling to the chest.
- Check motion with `scripts/rig/motion_probe.py` (§ Take acceptance).
- `scripts/rig/teardown.sh Monifactory_bot_1 Monifactory_bot_2` — kills the clients, leaves server
  and compositor up, restores any capture profile.

---

## Camera — posing, aiming, shot runner

### Cinema commands (ext.js, camera bridge 55546)

| command | args | effect |
|---|---|---|
| `cam_pose` | `x,y,z,yaw?,pitch?,spectator?` | teleport the camera (`/tp`, optional `/gamemode spectator`) |
| `cam_aim` | `yaw,pitch,roll?,smooth?` | set target angles; the per-frame hook eases toward them |
| `cam_look_at` | `x,y,z,smooth?` | aim at a world point |
| `cam_free` | — | release the hook |
| `cam_spectate` | `target?` | `/spectate <player>`; no arg releases |
| `cam_hud` | `hide?` | toggle `Options.hideGui` (F1) |
| `cam_state` | — | mode, hooked, frame count, angles, last error |

Scripted rotation is applied per tick and vanilla does not interpolate it, so the camera uses a
Forge `ViewportEvent.ComputeCameraAngles` listener that eases angles every frame. From GraalJS,
register with the explicit overload `addListener(priority, receiveCancelled, EventClass, consumer)`
and wrap floats in `Math.fround`. **Liveness:** `cam_state.frames` climbs at about 60/s. 20/s means
a tick fallback; 0 means the hook never registered (see `cam_state.error`).

### Shot runner

```
python3 scripts/demo/shoot.py list  scenarios/shots/teaser.json               # list shots
python3 scripts/demo/shoot.py pose  scenarios/shots/teaser.json 05_economy    # frame only
just shoot 05_economy                                                         # roll one or more ids
SHOTLIST=scenarios/shots/other.json just shoot 03_vein                        # another shot list
```

A shot declares camera pose, optional `track` (aim at the bot about 4×/s), console staging, bot
command and duration. `shoot.py` poses, drives, records and writes `<out_dir>/<id>.mp4`. It boots
nothing: bring up the worker and the camera (`-K`, camera with `-P`) first. A shot whose staging
fails is skipped.

- **Roll with `just shoot`.** It runs inside the capture devShell and finds the camera's display
  from the client on the camera port (`SHOOT_CAM_PORT`, default 55546). `CAM_WAYLAND=wayland-N`
  pins it (still verified). Every miss exits non-zero before staging.
- **A take counts only if ffprobe opens it** and its duration is at least 0.8 × the shot's
  `seconds` (`MIN_TAKE_RATIO`). `record.sh` fails the take on any recorder error (135 = SIGBUS,
  137 = SIGKILL). File size is never the verdict.
- **Open-world shots** (`teaser.json` 01–04) have no camera coords. Fly the camera, screenshot,
  write the pose into the JSON, `pose` to confirm, then roll. Read the camera's screenshot from its
  own instance: `MC_INST=<instances>/Monifactory_bot_2/minecraft python3 scripts/ops/mc_shot.py
  --file -s 0.4`. Without `MC_INST`, `mc_shot.py` reads the human instance.

### Take acceptance

```
python3 scripts/rig/motion_probe.py take.mp4                                   # full frame
python3 scripts/rig/motion_probe.py take.mp4 --crop 780,420,360x360            # around the bot
python3 scripts/rig/motion_probe.py take.mp4 --in 20.6 --out 24.2              # only the used range
python3 scripts/rig/motion_probe.py take.mp4 --crop 780,420,360x360 --max-static 2.0   # as a gate
python3 scripts/rig/motion_probe.py 01_clutch.mp4 --in 3.2 --out 5.3 --preset static-hook
./gerda motion-probe take.mp4 --json
```

`motion_probe.py` measures the mean absolute difference (MAD) between neighbouring downsampled
frames and prints live windows, static runs and the longest freeze. `--max-static N` gates on the
longest freeze: exit 1 = fail, exit 2 = could not measure.

- **Run it twice:** full frame (does the world move?) and `--crop` around the bot (does the bot
  move?). Crop coords are source pixels.
- **Read `duty`** — the share of live samples. The gate sees only the longest freeze, so a take of
  short blinks passes it. Duty is reported, never gated.
- **Measure the used range** with `--in`/`--out`; timestamps stay absolute. A range that is empty,
  inverted or not fully inside the file exits 2, and the message says whether the take is short or
  the container's `start_time` is offset (then subtract it or re-mux). The last ~0.2 s of a range
  (2/`--fps`) carries no measurement.
- **A short take plays fast.** wf-recorder writes 60 fps timestamps, so a recorder that falls
  behind yields a shorter, sped-up file. The 0.8 duration floor is the only detector. A healthy
  take is 3.5–4 s longer than `seconds`.

Read duty relatively; there is no absolute floor. For reference, these values come from the
maintainer's teaser takes: accepted segments of `scenarios/shots/teaser_cut.json` span 0–74 %
(defaults, full frame), for example:

| segment | take | in–out | duty | longest static |
|---|---|---|---|---|
| `economy_mine` | 05_economy | 20.6–24.2 | 74.3 % | 0.6 s |
| `climb` | 04_nav | 0.6–5.8 | 56.9 % | 0.1 s |
| `vein` | 03_vein | 6.0–60.0 | 10.4 % | 18.0 s |
| `hook_clutch` | 01_clutch | 3.2–5.3 | 0.0 % | 2.0 s |

Static shots (in-pit camera, GUI insert, timelapse) read 0.0 % by design. Judge a take against a
comparable reference — the same shot's good take, or its crop run. (A maintainer-only test pins
these rows against the original footage; it skips without it.)

**Driver log.** A shot's `during` command logs to `<out_dir>/<id>.during.log`. `sustain_live.py`
writes a plan witness per lap (`STARTED` / `UNKNOWN_PLAN` / `no-evidence`) and a `mission_status`
line every 10 s, read from the worker journal
`<instances>/Monifactory_bot_1/minecraft/config/jsMacros/Macros/miner.ndjson`
(`MC_WORKER_JOURNAL` overrides). The probe says when the picture froze; the log says why.

### Static hook shots

A static hook is a still camera around one brief event: the `01_clutch` water clutch, about 0.3 s
of motion in the 3.2–5.3 cut. The defaults miss it. `--preset static-hook` uses measured values
and gates on the event:

| knob | preset | default | why |
|---|---|---|---|
| `--thresh` | 0.3 | 1.0 | well above dead-footage noise, well below the event's motion |
| `--min-live` | 0.2 s | 0.5 s | 2 samples; a brief event holds about 3 |
| gate | `--min-windows 1` | — | on a still shot the question is "did the event happen" |
| `--fps` / `--scale` / `--bridge` | 10 / 192x108 / 0.5 | same | calibration values |

The preset runs full frame; `--crop` is refused (exit 2). An explicit sensitivity flag overrides it
with a `WARN`. On the maintainer's takes, the preset finds the clutch as one live window and fails
both the clutch's dead tail and a parked-bot shot; the defaults find no window in any of them.

Limit: a single odd frame yields two MADs, which 0.2 s accepts; the threshold guards against it.

### GUI inserts

wf-recorder records an output, not a window. To film the bot's own GUI (`02a_prospect`), make the
bot's window fullscreen on the shared output:

```
scripts/rig/fullscreen.sh --list                 # MC windows, instances, outputs
scripts/rig/fullscreen.sh Monifactory_bot_1      # bot's screen is recorded
scripts/rig/fullscreen.sh Monifactory_bot_2      # camera back
```

`SWAYSOCK` (or `CAM_SWAYSOCK`) pins one compositor. Needs the capture devShell.

### Shader camera instance (optional)

A shader camera is not required. To film with shaders:

1. Copy the camera instance to a new instance. Name it `Monifactory_cam_shader` and
   `./gerda bind-accounts` gives it the camera's account; under any other name, set the
   account yourself.
2. Add Oculus to its `mods/` and a shaderpack to its `shaderpacks/`, and enable the pack in
   `config/oculus.properties` (`shaderPack=…`, `enableShaders=true`).
3. Give it the camera's account and bridge port (set its `port` in `mc-bots.json` to the
   camera's). It replaces the camera: never boot both, and pass `--skip <shader-instance>` to a
   sync while it runs.

- Keep `enableVsync:false` (every rig instance): with vsync on, an off-screen window stops rendering.
- Read the frame rate: `python3 scripts/ops/bridge_ctl.py --port <camera-port> send jeval
  '{"code":"Client.getMinecraft()[srg(\"Minecraft\",\"getFps\")]()"}'`.
- Screenshots: `MC_INST=<instances>/<shader-instance>/minecraft python3 scripts/ops/mc_shot.py --file -s 0.4`.

---

## Sets — restage the world from data

A film set is staged scenery stored as data: the arena spec format without a mission.

```
scenarios/arenas/<name>.json   ops + mission + expect   → `just gate-live` runs these
scenarios/sets/<name>.json     ops + snapshot, no mission → staging only, never in the gate
```

Shipped sets: `03_ore_chamber` (shots 03_vein, 02b_shaft; carries the drill `marker`), `04b_gap`
(shot 04b), `02_mesa_clutch` (shot 01_clutch). A set that declares `mission`/`plan`/`expect` is
refused.

```
python3 scripts/dev/arena.py list                                          # arenas + sets
python3 scripts/dev/arena.py snapshot sets/03_ore_chamber --port 55546     # live world → ops
python3 scripts/dev/arena.py build    sets/03_ore_chamber --port 55546     # data → world
python3 scripts/dev/arena.py clean    sets/03_ore_chamber --port 55546     # back to air
```

- **Keys:** [SCENARIOS.md § Film sets](SCENARIOS.md#film-sets).
- **Always pass `--port`.** The default, 55544, is the human's instance.
- **Spec shape.** `snapshot.boxes` is the input; `ops_generated` is written by `snapshot` — never
  by hand. Hand-written setup (`marker`, `give`, `player`, `select`, `wait`) goes in `ops`.
  `build` applies `ops_generated`, then `ops`.
- **Snapshot before you change the world**; a set restores only what was captured. Capture is 1:1
  including air, by block id only: stairs and slabs restage in default orientation, so put them
  in `ops`. Oversized boxes, bad reads, unloaded chunks and builds over 2000 ops abort.
- **`build` needs an op client** (chat `/fill`, `/setblock`): drive it from the camera, or op a test
  bot for the session and de-op after. It re-reads a sub-box and aborts on a mismatch.
- **`snapshot` needs loaded chunks, no fluids in the box** (a fluid restages as a permanent
  source), and stamps the dimension; `build` refuses a client in another dimension.
- **`marker` writes the world store of the instance in `MC_INST`** (default: human). For a drill
  target: `MC_INST=<instances>/Monifactory_bot_1/minecraft python3 scripts/dev/arena.py build
  sets/03_ore_chamber --port 55546`.

---

## Edit — cut list → deliverable

`scenarios/shots/<name>.json` is the shoot half; `<name>_cut.json` is the edit half (take, in/out,
speed, reason). `scripts/rig/assemble.py` cuts the film in one ffmpeg call:

```
python3 scripts/rig/assemble.py scenarios/shots/teaser_cut.json --dry-run     # command + durations
python3 scripts/rig/assemble.py scenarios/shots/teaser_cut.json               # cut it
python3 scripts/rig/assemble.py scenarios/shots/teaser_cut.json --only vein,finale
```

Segments are trimmed (optional `speed`, per-segment `filters`), normalised to the list's
`width`/`height`/`fps`, concatenated and faded, with `encode.sh`'s delivery settings. A missing
take, an `out` past the source, `out <= in`, an unknown `--only` id or a bad `speed` aborts.

**Captions** (`captions.cues[]`) anchor to a segment (`seg`, `at`/`dur` in output seconds). Layers:
`label` (caps tag, top left) and `line` (narrative, bottom third). They render to `<out>.en.ass`
and are burned in. Readability limits live in `assemble.py` (`MIN_HOLD_S`, `MAX_LINE`, `MAX_CPS`)
and abort the cut. Write a segment's speed as `{speed}`, not a typed `3×`; write sizes unspaced
(`3×3`). Fonts must resolve in `fc-match`.

**Measure every `in`/`out` on the take** (`ffmpeg -ss <t> -i take.mp4 -frames:v 1 f.png`, or the
static runs from `motion_probe.py`) and put the reason in the segment's `note`.

### Showcase and console cards

`scenarios/shots/showcase.json` and `showcase_cut.json` are a second shoot/edit pair: one
goal-driven chain from a worn stone pickaxe to a crafted iron one, then the live gate. Its
`in`/`out` values are placeholders until the takes are measured, and its `_doc` blocks list the
shoot-day order and the poses still to measure. The two console inserts are takes rendered by
`scripts/rig/console_card.py` from `scenarios/shots/cards/*.json` at the cut's size and fps. A
number that only a run can give is a `<FILL:name>` token copied from that run: a render with an
unfilled token aborts, and `--draft` previews the layout. The gate card is the literal all-PASS
summary of the default gate set. It carries `from_log`, so its render needs `--log` with the log
of a real run and refuses unless that log prints the same lines, the `[gate] N/M passed` line
included. The script's docstring holds the spec schema; it needs the
capture devShell (ffmpeg, fontconfig).

---

## Run — one client, headless, no camera

Commands and missions: [FLEET_PLAYBOOK.md](FLEET_PLAYBOOK.md), [EXTENDING.md](EXTENDING.md).

Run the launcher once with a display first and finish its first-run wizard (language,
account). A headless launch stops on that wizard and never boots the game; under a `C` locale
the language page comes back every start until `Language=en_US` is set in the launcher's
`freesmlauncher.cfg`.

```
# boot one client, keep-alive, no recording (drop -s for single-player)
nix develop .#capture -c scripts/ops/capture_rig.sh -a bot_1 -l Monifactory_bot_1 -s localhost:25565 -K &
python3 scripts/ops/bridge_ctl.py --port 55545 --wait-ready 120 status

# drive it (or the `mc` MCP tools: mc_get_state / mc_send / mc_fleet_*)
python3 scripts/ops/bridge_ctl.py --port 55545 get_state
python3 scripts/ops/bridge_ctl.py --port 55545 send mission_start '{"name":"mine"}'   # or plan_start '{"name":"sustain-cycle"}'

# see its screen, read from THAT instance
python3 scripts/ops/bridge_ctl.py --port 55545 send screenshot
MC_INST=$(python3 scripts/local_config.py instances_root)/Monifactory_bot_1/minecraft \
  python3 scripts/ops/mc_shot.py --file -s 0.4

scripts/rig/teardown.sh Monifactory_bot_1
```

`get_logs` tails a file. For live progress read the worker journal (`…/Macros/miner.ndjson`) and
check its mtime.

---

## Rules

- **Capture through headless sway.** gamescope → PipeWire records black on the NVIDIA driver.
- **Run the client under Xwayland.** The modded client crashes on native Wayland.
- **The headless output must be `@60Hz`**, or it emits no frame callbacks and records one frame.
- **Never `pkill -f` / `pgrep -f` an instance name** — it matches your own shell and kills it
  (exit 144). Use `scripts/rig/teardown.sh`. To list or count clients use
  `scripts/rig/mc_clients.sh [instance]` (`… | grep -c .` counts).
- **Furnace input caps at 64**; smelt-load fails if it cannot load the whole stack.
  `sustain_live.py loop` empties each furnace per lap.
- **Hide the HUD on the camera**; `sustain_live.py frame` does it and warns loudly if it cannot.

## Relocating the scene

The `sustain-cycle` plan targets the furnace bank at `cfg.sustain.basePos = {5,101,1}`
(`src/bot/profile/pack.ts`, compiled into the bundle). To film elsewhere, change `basePos`, rebuild,
redeploy, and set `ANCHOR` in `sustain_live.py`. `ANCHOR=(0,0,0)` equals the arena fixture.
