# Gerda sandbox: a real Minecraft in a container

`scripts/sandbox/` builds a rootless **podman** container that behaves like a plain Ubuntu
24.04 PC with a real Minecraft inside it. No GPU and no screen are needed. The container holds:

- a **Minecraft client** on a virtual display (Xvfb). Mesa's llvmpipe does the OpenGL in
  software, so the game renders real frames and screenshots work.
- the **FreesmLauncher** portable launcher with an offline account. The launcher downloads
  Minecraft, the mod loader, the libraries and Java by itself.
- **jsMacros** and the **Gerda harness** (`harness/`). The harness gives each client a TCP
  bridge (`127.0.0.1:555xx` inside the container). You drive the game through that bridge with
  `./gerda ctl …` or with the MCP server (`mcp/server.py`).
- optionally, a **dedicated server** (the Monifactory modpack server that the Gerda bot plays on).

Everything comes from public downloads, kept in a cache volume, so a rebuild does not
download it again. What is checked, and how:

- **Our sha256 pins** (`pins.env`): the Monifactory server and client zips, the Forge
  installer, monilabs, the launcher, jsMacros, Fabric API, and the bun and uv archives baked
  into the image. The base image is pinned by digest. The 220 mod files of the Monifactory
  client have one sha256 each (`monifactory-0.13.4-client-files.tsv`). The launcher's own
  import downloads them (see [Modpack mods](#modpack-mods-the-launchers-import-or-your-own-install)),
  and the `client` step checks them all.
- **Mojang's sha1**: the vanilla server jars that generate the test-root worlds are checked
  against the sha1 in Mojang's version manifest.
- **Not checked by us**: what the launcher downloads by itself (Minecraft, the loaders,
  libraries, assets, Java) is checked by the launcher. Ubuntu packages come through apt from
  Ubuntu's signed archive, at the versions current on the build day. A modpack of your own
  (`pack`) is checked by the sha256 you give for its zip. Its mod files are recorded with
  their sha256, and nothing pins them.

Use the sandbox for two things:

1. **Run the Gerda bot** on the Monifactory modpack (MC 1.20.1 Forge) against its own server.
   This is the reference setup, and `verify` checks it end to end.
2. **Test your own mod or modpack in a real game**, headless and scripted: put your jar into a
   vanilla + loader instance, start the game, then check it over the bridge (mod loaded,
   screenshot, world and player state, screens, chat, raw Java calls).

## Requirements

- Linux with rootless podman 4 or newer, and internet access.
- RAM: the Monifactory setup (client heap 4 GB, server heap 8 GB) needs the default limit of
  `24g`. A vanilla + loader instance needs much less. Set `SBX_MEMORY`.
- Disk: about 3 GB for the cache volume, plus the home volume (about 4 GB with Monifactory).
- CPU: software rendering is CPU-heavy. The default is `SBX_CPUS=12`.

## Quick start: the Gerda bot on Monifactory

Run from the repo root:

```sh
scripts/sandbox/provision.sh build      # image: Ubuntu 24.04 + Java 21 + Xvfb/Mesa + bun/uv/just
scripts/sandbox/provision.sh up         # container "gerda-sandbox", own network namespace
scripts/sandbox/provision.sh server     # Monifactory 0.13.4 server, configured and running
scripts/sandbox/provision.sh client     # launcher imports the Monifactory client; + jsMacros, one warm-up launch
scripts/sandbox/provision.sh repo https://github.com/flamerix-ai/gerda   # or a local path / git bundle
scripts/sandbox/provision.sh start      # the bot joins the server; waits until the bridge answers
scripts/sandbox/provision.sh verify     # ./gerda ctl ping + ./gerda smoke (21 facade checks)
```

`provision.sh all <repo>` runs the same seven steps in a row. `server` and `client` do not
depend on each other. To run them in parallel, add `--detach` to each one and wait for both:

```sh
scripts/sandbox/provision.sh server --detach
scripts/sandbox/provision.sh client --detach
scripts/sandbox/provision.sh wait client; scripts/sandbox/provision.sh wait server
```

After the steps finish:

```sh
scripts/sandbox/provision.sh shell      # a shell as the user `student`; the clone is ~/gerda
cd ~/gerda && ./gerda ctl status        # inside the container
scripts/sandbox/provision.sh console op student_bot   # one server console command (op for arenas)
scripts/sandbox/provision.sh record 60 run.mp4        # film the client window; fails a black take
scripts/sandbox/provision.sh fetch apps/FreesmLauncher/instances/Monifactory/minecraft/screenshots/ai_shot.png
scripts/sandbox/provision.sh stop       # game killed, server stopped with a console `stop` (world saved)
scripts/sandbox/provision.sh down       # also stops the container (kept; `up` starts it again)
scripts/sandbox/provision.sh destroy --yes   # removes the container + home volume; the cache stays
```

Each step is idempotent. A finished part of a step is skipped, so you can run a step again
after a failure and it continues where it stopped. A failure prints `FAIL: <step>: <reason>`
and the log to read.

## Modpack mods: the launcher's import, or your own install

The sandbox does not download mods from CurseForge itself. The `client` step (and `pack`)
gives the modpack zip to the launcher's own import, as a player does. FreesmLauncher, a Prism
Launcher fork, gets the files through its own access to the official CurseForge API. So the
choice of each mod author holds: a file that its author keeps out of third-party launchers is
not fetched around that choice. The launcher's built-in access is enough. The first-run
offer to fetch the official CurseForge app's key stays off (`FlameKeyShouldBeFetchedOnStartup=false`).

The import is a GUI flow. The step runs it on a virtual display of its own (`:98`, or
`SBX_IMPORT_DISPLAY`), never on the display a game client draws on, and answers each launcher
window by its title. The launcher's main window is the one window that is neither a dialog nor
transient (`xprop`); every other window goes by the table, an untitled one too:

| Window | What the step does |
|---|---|
| New Instance (Import page) | presses Return. The instance gets the name of the staged zip, `Monifactory` |
| Select Optional Mods | clicks Select All, then OK. An unchecked optional mod would end up disabled |
| Please wait... | waits for the downloads |
| Blocked mods found | fails, and prints each blocked file with its CurseForge page |
| any other window, a launcher error, the launcher exiting, an instance under another name, no instance after 20 min | fails, with the launcher log and a screenshot in `~/logs` |

After the import, the instance's `mods/`, `resourcepacks/` and `shaderpacks/` must hold
exactly the 220 pinned files, each in its pinned folder, with the pinned sha256. A missing,
extra, disabled, moved or changed file fails the step, and the step then removes the instance
it made: nothing unverified stays behind. Only a verified install leaves
`~/.sbx/client-files.done`, and `repo` and `start` refuse the Monifactory instance without it
(`start-matrix` likewise refuses a `pack` instance without `~/.sbx/pack-<instance>-files.done`).
Only then are monilabs and jsMacros added.

A file that its author keeps out of third-party launchers comes from the author's own
Modrinth upload, when there is one. The launcher does this by itself. In Monifactory 0.13.4,
one file comes this way (`entityculling-forge-1.9.5-mc1.20.1.jar`), and the pin check proves
it is the same file. When a pack has a blocked file with no Modrinth copy, the launcher asks
for a manual download. The sandbox does not click through that request; the step fails
with the list.

**Fallback: your own install (`--from`).** Install the pack once in your own launcher, and
download the blocked files by hand if it asks. Then give the step that instance's folder:

```sh
scripts/sandbox/provision.sh client --from ~/.local/share/PrismLauncher/instances/Monifactory
scripts/sandbox/provision.sh pack MyPack path/to/MyPack.zip --from <instance folder>
```

The folder is the instance folder, or its `minecraft/` (or `.minecraft/`) folder. Only
`mods/`, `resourcepacks/` and `shaderpacks/` go into the container. The configs and scripts
come from the modpack zip (for Monifactory, the pinned client zip). For Monifactory, the step copies exactly
the 220 pinned files and checks each sha256; a missing one fails, and your other jars stay out.
`monilabs-0.21.2.jar` alone may be missing (an instance set up by `docs/SETUP.md` has 0.21.7),
because the step puts the pinned 0.21.7 in its place. For `pack`, the step copies every file
of those folders and records each folder, name and sha256 in `~/.sbx/pack-<instance>-files.tsv`.
An instance that is already built stays as it is. To build it again, remove the instance
folder and `~/.sbx/client-files.done` (or `~/.sbx/pack-<instance>-files.done`) first.

## Test your own mod

The full walk-through, with test arenas, a worked GregTech CEu example and video recording, is
[docs/MOD_TESTING.md](../../docs/MOD_TESTING.md). This section lists the sandbox steps.

The **test root** is a second launcher data directory with vanilla + loader + jsMacros
instances. Each instance gets a pre-generated single-player world called `New World`
(peaceful, cheats allowed, so arena commands such as `/fill` work). The Monifactory server and
client are not needed here:

```sh
scripts/sandbox/provision.sh build && scripts/sandbox/provision.sh up
scripts/sandbox/provision.sh repo https://github.com/flamerix-ai/gerda   # the harness + ./gerda
scripts/sandbox/provision.sh matrix                    # 4 instances, bridge ports 55560-55563
scripts/sandbox/provision.sh add-mods Fabric-1.20.1 path/to/yourmod.jar   # jars or a directory
scripts/sandbox/provision.sh start-matrix Fabric-1.20.1   # the game opens New World; waits for the bridge
```

`matrix` creates these instances:

| Instance | Loader | jsMacros | Opens its world by |
|---|---|---|---|
| `Vanilla-Forge-1.20.1` | Forge 47.4.13 | 1.9.2 | quick-play (`-w`) |
| `Fabric-1.20.1` | Fabric loader 0.19.5 + Fabric API | 1.9.2 | quick-play |
| `Fabric-1.21` | Fabric loader 0.19.5 + Fabric API | 1.9.3-beta | quick-play |
| `Forge-1.18.2` | Forge 40.3.0 | 1.9.2 | three scripted clicks (1.18 has no quick-play) |

`matrix` prints each instance's bridge port, and `~/matrix/mc-bots.json` keeps them. Ports
are given out in name order from 55560. Only one client of the test root runs at a time:
`stop` ends it.

Now check your mod from inside the container (`provision.sh shell`, then `cd ~/gerda`):

```sh
P=55560                                           # the instance's bridge port
./gerda ctl --port $P ping
./gerda ctl --port $P get_state                   # position, health, dimension
./gerda ctl --port $P send screenshot             # writes <instance>/minecraft/screenshots/ai_shot.png
./gerda ctl --port $P send read_screen            # the open screen's title, buttons and text fields
./gerda ctl --port $P scan                        # ores around the player
./gerda ctl --port $P send jeval '{"code":"Java.type(\"net.fabricmc.loader.api.FabricLoader\").getInstance().isModLoaded(\"yourmodid\")"}'
```

`jeval` runs JavaScript with the full jsMacros and Java scope. With it you can call your mod's
own classes, read registries and send chat or commands. On Forge, vanilla members use SRG names
(see `docs/EXTENDING.md` § SRG-mapping workflow). `eval` is the sandboxed variant, and
`mc://api` (MCP) lists every bridge command. To script checks from Python, import
`mcp/bridge_client.py` (`BridgeClient(host="127.0.0.1", port=P).send("jeval", {...})`). To
copy a screenshot to the host, use `provision.sh fetch <path>` (relative to the container
user's home, or absolute).

**Your own modpack:** `provision.sh pack <instance> <modpack.zip|url> [sha256|--unpinned]
[--from <dir>]` builds a test-root instance from any CurseForge-format modpack zip
(`manifest.json` + `overrides/`). The launcher's own import installs it (see
[Modpack mods](#modpack-mods-the-launchers-import-or-your-own-install)); with `--from`, the mod
files come from an instance you installed yourself. The step then adds jsMacros when a pinned
build matches, generates a world and deploys the harness. Then run `start-matrix <instance>`.
The instance name may hold letters, digits, `.`, `_` and `-`. A zip given by url needs its
sha256; `--unpinned` takes it unchecked instead and downloads it again on every run. The
pack's mod files are recorded with their folder and sha256 in `~/.sbx/pack-<instance>-files.tsv`, and
nothing pins them.

**Another Minecraft version or loader:** add a row to `MATRIX` in `sbx.sh` and the jsMacros
(and Fabric API) URLs + sha256 to `pins.env`, and a case to `jsmacros_pin`. jsMacros sets
the limit: which Minecraft versions and loaders have a jsMacros build is listed in
`docs/PORTABILITY.md`. The Gerda **bot** runs fully only on Forge with SRG names. On
Fabric the harness works (bridge, eyes, `jeval`, MCP), but movement refuses to run
(`RUNTIME_UNSUPPORTED`). See `docs/PORTABILITY.md`.

## What is proven, and what is not

Proven end to end in a fresh container (fresh home volume) on a 12-CPU / 24 GB limit. Times
are wall-clock; "cold" means an empty cache volume, "warm" means a cache filled by an earlier
run:

| Step | Cold | Warm | Notes |
|---|---|---|---|
| `build` | 72 s | 4 s | apt + bun + uv layers |
| `server` | 11 min | 9.5-10 min | 237 MB pack download (cold), Forge install, first boot ~4.5 min, restart for the `/home` cooldown ~3.5 min |
| `client` | not measured | 3 min | the launcher's import 65 s (it downloads the 220 files every time, cold or warm); the warm-up launch to the title screen 1.5 min here, ~6-7 min on a busier host |
| `repo` | 10 s | 14 s | clone, `bun install`, build, srg export, sync |
| `start` | 1.5 min | 2 min | bot joins the server, bridge answers |
| `verify` | 30 s | 30 s | `smoke` 21/21. Right after the join, the first smoke call timed out in 2 of 3 runs; `verify` retries after 20 s |
| **all of the above** (server and client in parallel) | not measured | **12 min** | |
| mod path: `up` → `matrix` → `add-mods` → `start-matrix Fabric-1.20.1` | | **1.5 min** | plus `repo` 14 s; jar loaded, confirmed with `jeval isModLoaded` |

- All four matrix instances reached their world with a bridge that answered. Forge 1.18.2
  needed the scripted clicks.
- The launcher's import of the Monifactory client, in a fresh home volume: 219 files from
  CurseForge's CDN and one (`entityculling`) from its author's Modrinth upload, all 220 equal
  to the pins. A `client --from` with that instance's mods (monilabs already swapped for
  0.21.7, jsMacros added) built the instance again, and the bot joined and passed `verify`.
- The blocked-files failure was run by switching off the launcher's Modrinth fallback: the
  import stopped at "Blocked mods found" and the step failed with
  `blocked: entityculling-forge-1.9.5-mc1.20.1.jar — download it by hand from <its CurseForge page>`.
  No pack with a blocked file and no Modrinth copy was tried.
- `pack` was run with the Monifactory client zip (by url + sha256) under another instance name,
  while the Monifactory client ran on the same display. The launcher imported it in 64 s, and
  the instance got a world and was synced, but it was **not launched**. `pack --from` was not
  run (it shares the copy and the check with `client --from`). No other modpack was tried.
- **Not tested:** NeoForge and Quilt instances (the code writes their launcher components, but
  none was launched); more than one client at a time in the test root; hosts other than
  Linux + rootless podman.

Nothing needs a human click. The GUI-only spots of a manual setup are scripted: the
launcher's first-run wizard (`freesmlauncher.cfg` is pre-seeded), the launcher's modpack import
(`xdotool`, by window title; the optional-mods buttons by their place in the dialog) and the
1.18.2 world selection (`xdotool`, coordinates for the launcher's default 854×480 window).

## Why it is built this way (each item caused a failure)

- **`--init`**: without a real PID 1, exited server and launcher processes stay as zombies, and
  `server-ctl.sh` keeps reporting "running".
- **`--pids-limit 8192`**: the modded client runs ~300 threads, and a limit of 2048 starved it.
- **Own network namespace, never `--network=host`**: the container uses the standard ports
  (25565, 55544). On a host that runs Minecraft itself, they would collide.
- **`LANG=C.UTF-8` + pre-seeded launcher config**: with locale `C`, the launcher's first-run
  wizard stops on the Language page and a headless start hangs there.
- **Portable launcher**: its instances live next to the binary, which `local_config.py` does
  not autodetect, so `MC_INSTANCES_ROOT` and `local.config.json` point at it.
- **jsMacros `options.json` written as version 3 before the first boot**: the first boot
  writes version 2, and the next boot migrates it to version 3 with `services: {}`. Service
  registrations made on a version-2 file are lost.
- **Server**: `server.properties` with no inline comments (a `#` after a value silently becomes
  part of it); `config/fml.toml` with `maxThreads = 1` (parallel mod loading can deadlock);
  monilabs 0.21.2 → 0.21.7 on the server and the client (0.21.2 crashes a dedicated server);
  FTB Essentials `home.cooldown` 0 (the bot uses `/home` to recover).
- **Separate launcher data root for the test instances**: the launcher is single-instance per
  data root. A second launch against the main root would be handed to the running Monifactory
  launcher.
- **Worlds from the vanilla server**: each matrix world is generated by the official vanilla
  dedicated server of that version (sha1-checked against Mojang's manifest, fixed seed). The
  client opens it like any single-player save. The server writes `allowCommands: 0`, which
  refuses every operator command in single-player; `level_cheats.py` sets it to 1.
- **Recording with x11grab, the game window only**: the client draws into the Xvfb
  framebuffer, so ffmpeg reads every frame without a compositor. The window is found by the
  game's pid, not its title (Monifactory renames it), and the rest of the 1920x1080 screen is
  left out because it is black.

## Known limits

- Software rendering: ~20-30 fps at render distance 3. The modded client loads in ~6 minutes,
  and right after a join the harness answers slowly for a minute. In testing, the first `smoke`
  or `jeval` after a join timed out more than once and then answered when retried. Wait for a
  few pings in a row, and retry the first command, before you rely on timing.
- Offline accounts only (`online-mode=false`). No Microsoft login, no Realms.
- The modpack import is the launcher's GUI, driven by window titles and two click points in
  the optional-mods dialog of FreesmLauncher 2.3.1. Another launcher version can change them. A
  dialog that does not react fails the step after a minute. For Monifactory, the pin check
  catches a missed optional mod; for `pack`, the step only prints each file the launcher
  disabled. A pack with a file blocked for third-party launchers and no Modrinth
  copy cannot be imported unattended: use `--from`.
- One cache volume (`gerda-sandbox-cache`) holds downloads, the launcher's libraries/assets/Java
  and the generated worlds. Delete it with `podman volume rm` to start over. The modpack's mod
  files are not cached: each import downloads them again.
- **The cache volume is shared and writable.** Every sandbox mounts the same volume
  read-write, and the launcher runs Minecraft and Java straight from it. A mod you test runs
  with the rights of the container user, so it can change those files, and the next client
  in any sandbox then launches the changed copy. The pinned downloads are checked again
  on each use; the launcher's libraries, assets and Java, and the generated worlds, are not. To test a mod you do not
  trust, give it a sandbox with its own cache, for example
  `SBX_NAME=untrusted SBX_CACHE_VOL=untrusted-cache provision.sh up` (a new container; pass
  the same `SBX_NAME` to every later step). Its first steps download everything again. Delete
  the container and that volume after the test.
- The bot plays as a normal non-op player (see `docs/FLEET_PLAYBOOK.md`). The sandbox gives it
  no items and no op.

## Files

| File | Role |
|---|---|
| `provision.sh` | host side: image, container, volumes; runs each step through `podman exec` |
| `sbx.sh` | container side: every step (mounted read-only at `/opt/sbx`) |
| `Containerfile` | the Ubuntu 24.04 image |
| `pins.env` | versions, URLs and sha256 of what the scripts download, the base image digest |
| `monifactory-0.13.4-client-files.tsv` | the 220 mod files of the client pack, as the launcher's import installs them: project id, file id, folder (`mods`, `resourcepacks` or `shaderpacks`), name, sha256 |
| `jsmacros-options.v3.json` | the jsMacros config written before the first boot (services `main` + `bridge`) |
| `level_cheats.py` | sets "Allow Cheats" in a test-root world (the vanilla server writes it off) |

Environment knobs (`provision.sh` header): `SBX_NAME`, `SBX_IMAGE`, `SBX_CACHE_VOL`,
`SBX_HOME_VOL`, `SBX_MEMORY`, `SBX_CPUS`, `SBX_PIDS`, `GERDA_REPO`. Logs are in `~/logs`
inside the container (`provision.sh logs`).
