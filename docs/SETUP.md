# Setup — from zero to a driven bot

For anyone running the bot in a real game for the first time. Follow the Quickstart in order:
it starts on a machine with nothing installed and ends with a bot that answers over the
bridge. Steps 1–2 need no game; steps 3–4 install it; step 5 deploys into it; steps 6–7 need
it running.
For more than one bot, do this once, then see [SERVER_SETUP.md](SERVER_SETUP.md) and
[BOT_INSTANCE_SETUP.md](BOT_INSTANCE_SETUP.md).

What you end up with: a Minecraft 1.20.1 Forge instance of the **Monifactory** modpack with
the **jsMacros** mod, and this repo deploying the bot into it. The bot's GTCEu intelligence
(prospector, ore registry, quest tooling) is tuned to that pack. Budget about 8 GB of RAM for
one game client.

**Another Minecraft version, or no modpack?** The harness (bridge, `./gerda ctl`, MCP,
screenshots) runs on every version that has a jsMacros build, Forge or Fabric; Gerda Bot's
movement needs Forge. [PORTABILITY.md](PORTABILITY.md) has the tested support matrix and a
short recipe for a plain vanilla + jsMacros instance — follow it instead of step 3 below.

## Quickstart

### 1. Get the code

You need `git`, `curl`, `unzip` and Python 3.11 or newer. Ubuntu/Debian:

```sh
sudo apt install git curl unzip python3
```

Fedora: `sudo dnf install git curl unzip python3`. macOS: `xcode-select --install` gives git;
curl and unzip are preinstalled. Windows: `winget install --id=Git.Git` (Git Bash comes with
it).

Clone the repo and enter it — every command below runs from its root:

```sh
git clone https://github.com/flamerix-ai/gerda.git
cd gerda
```

Clone it; do not download the ZIP. The commit gates (`just hooks`) and several tools need the
`.git` directory.

### 2. Install the tools

**Have Nix on x86_64 Linux? Then this step is one command.** The repo's `flake.nix` pins every
tool below:

```sh
nix develop      # or, with nix-direnv: `direnv allow` once — the shell then loads on every cd
```

The default shell carries bun, Node 22, Python 3.12, just, ffmpeg with ffprobe, `fd` and `entr`
(for `just watch`), git, and Vineflower with JDK 21 (for `./gerda decompile`). The filming rig
has its own shell, `nix develop .#capture` (headless sway, wf-recorder, grim) — see
[RIG.md](RIG.md). The flake does not carry uv, which only the MCP server needs:
`nix shell nixpkgs#uv`. Then skip to `bun install` and `just hooks` below — those two are still
yours to run. The flake declares `x86_64-linux` only; on macOS or ARM, use the installers.

Without Nix: [bun](https://bun.sh) builds the bot, [just](https://github.com/casey/just) runs the recipes,
[ffmpeg](https://ffmpeg.org) (with its `ffprobe`) is needed by `just check`, whose python suites
run real clips, and [uv](https://docs.astral.sh/uv/) runs the MCP server (optional — only for
LLM operators).

```sh
# Linux / macOS
curl -fsSL https://bun.sh/install | bash        # bun
curl -LsSf https://astral.sh/uv/install.sh | sh # uv (optional, for the MCP server)
sudo apt install just ffmpeg                    # Ubuntu 24.04+; dnf / pacman -S / brew install just ffmpeg
```

Both installers add their directory to `PATH` through your shell profile: open a new terminal
before you go on.

```powershell
# Windows (PowerShell)
powershell -c "irm bun.sh/install.ps1 | iex"    # bun
winget install --id=astral-sh.uv                # uv (optional)
winget install --id=Python.Python.3.12         # python
winget install --id=Casey.Just                  # just
winget install --id=Gyan.FFmpeg                 # ffmpeg + ffprobe
```

winget and the bun installer add their directories to `PATH` for new terminals only (`Path
environment variable modified; restart your shell`), so open a new Git Bash before you go on.

**On Windows**, run the commands of this guide in **Git Bash** (it came with Git in step 1):
`just` runs its recipes through Git's bash, which it finds through the `PATH` of Git Bash; from
cmd or PowerShell it stops with "could not find the shell `env`", unless Git's `usr\bin` is on
the system `PATH`. With WSL installed, a bare `bash` typed in cmd or PowerShell is WSL's
`bash.exe`, not Git's. Two names differ in Git Bash:

- `python`, not `python3`. The Python installer provides `python` and `py`; `python3` starts
  the Microsoft Store stub (`Python was not found`, exit 49). The `just` recipes pick `python`
  on their own.
- `python gerda <cmd>`, not `./gerda <cmd>`: the script's first line asks for `python3`. From
  cmd or PowerShell, `gerda.cmd <cmd>` works too, but the JSON of `ctl send` needs other
  quoting there than in the examples below.

The Python host-tool suites assume Linux or macOS, so `just check` and the pre-push hook fail on
Windows. Run `just check-ts`, the TypeScript half that the pre-commit hook runs, and contribute
from WSL.

Then install the TypeScript toolchain and point git at the repo's gates:

```sh
bun install     # the TS toolchain, into node_modules/
just hooks      # the versioned git hooks (no CI — they ARE the gate; stages: docs/TESTING.md)
```

Optional extras:

- `just watch` (rebuild + redeploy on every save) needs `fd` and `entr`. Ubuntu names the `fd`
  binary `fdfind`: `sudo apt install fd-find entr`, then
  `mkdir -p ~/.local/bin && ln -s "$(command -v fdfind)" ~/.local/bin/fd`.
- `./gerda decompile` needs vineflower and a JDK; `./gerda capture` and
  `./gerda parkour --video` need the Nix capture shell (Wayland tools). Each one's `-h` says what it needs.

### 3. Get the game

A launcher keeps each modpack in its own **instance**: a folder `instances/<name>/` with its
own mods, configs and worlds; the game files live in `instances/<name>/minecraft/`. The bot
deploys into that `minecraft/` folder.

1. **Install a MultiMC-format launcher.** [FreesmLauncher](https://github.com/FreesmTeam/FreesmLauncher/releases)
   (supports offline accounts; on Linux the portable tarball or the AppImage, on Windows the
   `FreesmLauncher-Windows-MSVC-Setup-<version>.exe` installer, `-MSVC-arm64-Setup-` on ARM) or
   [Prism Launcher](https://prismlauncher.org) (offline accounts need one Microsoft login
   first). The launcher downloads the Java the game needs; you do not install Java for the
   client. (A dedicated server needs a system Java — [SERVER_SETUP.md](SERVER_SETUP.md).)
2. **Add an account.** Accounts → Add Offline → a name such as `bot_1`. If the launcher's
   first-run wizard offers to fetch the official launcher's key, skip it; this pack does not
   need it.
3. **Import the Monifactory 0.13.4 client.** Add Instance → Import → paste
   `https://github.com/Omicron-Industries/Monifactory/releases/download/0.13.4/Monifactory-Beta.0.13.4-client.zip`
   and name the instance **`Monifactory`** — the tools assume that name for your own instance
   ([BOT_INSTANCE_SETUP § 1](BOT_INSTANCE_SETUP.md#1-create-a-bot-instance) has the naming
   rules). Accept the optional-mods dialog. The launcher then downloads about 220 mods; this
   takes a few minutes. Keep the client on 0.13.4: a dedicated server must run the same
   version. Joining the dedicated server? Swap monilabs on this client too
   ([SERVER_SETUP §3a](SERVER_SETUP.md)).
4. **Tell the repo where the instances are.** `just sync` autodetects the launcher's
   `instances/` dir only for installed launchers (`~/.local/share/{FreesmLauncher,PrismLauncher,MultiMC}`,
   the Prism flatpak, and the macOS/Windows equivalents). A **portable** launcher (the
   FreesmLauncher tarball, MultiMC) keeps `instances/` next to its own binary, and autodetect
   misses it. The launcher opens that folder from its toolbar: Folders → Instances. Set it
   once:

   ```sh
   cp local.config.json.example local.config.json
   # edit local.config.json: "instancesRoot": "~/apps/FreesmLauncher/instances"
   # (or: export MC_INSTANCES_ROOT=~/apps/FreesmLauncher/instances)
   ```

   For one bot, `instancesRoot` is the only key you need; the account keys in the example are
   for the multi-bot and filming tools, which ask for them when they run.

### 4. Install jsMacros

The bot runs inside the [jsMacros](https://jsmacros.wagyourtail.xyz/) mod. Download ONE file —
jsMacros 1.9.2 for Forge 1.20.1 — into the instance's `mods/` folder:

```sh
MODS="$(python3 scripts/local_config.py instance_dir Monifactory)/minecraft/mods"
curl -L -o "$MODS/jsmacros-1.20.1-1.9.2-forge.jar" \
  https://cdn.modrinth.com/data/3wGWhm8A/versions/7kPvvJff/jsmacros-1.20.1-1.9.2-forge.jar
```

(The same file is on [Modrinth](https://modrinth.com/mod/jsmacros/versions) — Forge, 1.20.1 —
and in the [jsMacros GitHub releases](https://github.com/wagyourtail/JsMacros/releases).)
The jar already contains the JavaScript language (GraalJS, ES2022 — what the bundle targets)
and unpacks it into `config/jsMacros/LanguageExtensions/` on the first start; there is no
separate extension to install.

Start the instance from the launcher, wait for the title screen, and quit (Quit Game). Then do
it **once more**. The first start creates `minecraft/config/jsMacros/Macros/` — `just sync`
deploys into it — and a `config/jsMacros/options.json` with `"version": 2`; the second start
migrates that file to `"version": 3` and empties its service list. Services registered before
that migration are lost, so step 6 waits for version 3. A `Config Failed To Load` line in the
first log is harmless.

### 5. Build and deploy

```sh
just check      # tsc + biome + defensive-checker + vitest + python suites — offline, no game needed
just build      # tsup → dist/__gerda_bot.bundle.js
just sync       # build + copy the bundle and the service harness into the instance
```

`just sync` writes the bundle plus the services (`bridge.js`, `main.js`, `worker.js`,
`ext.js`, shared modules) into `<instance>/minecraft/config/jsMacros/Macros/` of **every**
instance that has that folder, and gives each a distinct bridge port (`bridge_port.txt`;
registry in the gitignored `mc-bots.json`, which keeps existing ports across syncs). How
instances are named and how ports are handed out:
[BOT_INSTANCE_SETUP.md § 1](BOT_INSTANCE_SETUP.md#1-create-a-bot-instance). If it says
`No deploy targets`, go back to step 4: the game has not been started with jsMacros yet.
Rewriting the service files under a running client restarts its jsMacros services, so while
another client is running, keep it out with `just sync --skip <thatInstance>` (repeatable).

**Generate the SRG name map (once per Minecraft version).** Forge keeps obfuscated SRG names
for class members (`m_7583_`). The harness resolves them through `harness/srg_names.json`, a
generated file that is not in the repo. Build it from the mappings your launcher downloaded
when you started the instance in step 4, then deploy it:

```sh
./gerda srg --build                           # index the on-disk mappings
./gerda srg --export harness/srg_names.json   # write the SRG → Mojang map
just sync                                     # ship it next to the services
```

This enables the `srg()` helper in `jeval`, the Mojang names in `reflect`, and the boot
self-check of every hardcoded SRG name (`diag` reports it as `srgCheck`). Without the file
the bot still runs, but the self-check is skipped and `srgCheck` reads `unknown`.
Regenerate it after a Minecraft or Forge version change.

### 6. Register the services (in-game, once)

`bridge.js` and `main.js` are jsMacros **Service** scripts; register each once. Do not register
`worker.js`: `main.js` registers and starts it itself. First check that
`<instance>/minecraft/config/jsMacros/options.json` says `"version": 3` — if it says 2, start
the game once more and quit (step 4).

**In the game (GUI).** Start the game and enter a world (single-player, or your server).

1. Open the jsMacros GUI: Esc → **Mods** → search `JS` (the mod is listed as "JS Macros";
   searching `jsmacros` finds nothing) → **JS Macros** → **Config**. jsMacros' default key `J`
   does not work in Monifactory — JourneyMap takes it. For a hotkey, rebind "JS Macros GUI"
   under Options → Controls → Key Binds.
2. Open the **Services** tab.
3. Click **+**, type `main`, Confirm. In the new row, click the file cell (`./`), pick
   `main.js`, Select. Click **Disabled** so it reads Enabled, and **Stopped** so it reads
   Running.
4. The same for `bridge`: **+** → `bridge` → Confirm → file `bridge.js` → Enabled → Running.
   The file picker truncates names: `bridge.js` and `bridge_port.txt` both show as `bridge…`;
   `bridge.js` is the first.
5. Leave with Esc, and end the session with Quit Game: jsMacros saves the list on a clean quit,
   and a crash loses changes made in that session.

**Without the GUI (config file).** With the game closed, add both services to `core.services`
in `options.json`. The `file` path is relative to `config/jsMacros/Macros/`:

```json
"services": {
  "main":   {"file": "main.js",   "enabled": true},
  "bridge": {"file": "bridge.js", "enabled": true}
}
```

Or let a script make that edit (game closed, file at version 3):

```sh
OPTS="$(python3 scripts/local_config.py instance_dir Monifactory)/minecraft/config/jsMacros/options.json"
python3 -c 'import json,sys; p=sys.argv[1]; o=json.load(open(p)); assert o["version"]==3, "start the game once more first"; o["core"]["services"].update({"main":{"file":"main.js","enabled":True},"bridge":{"file":"bridge.js","enabled":True}}); json.dump(o,open(p,"w"),indent=2)' "$OPTS"
```

Edit the file only while the game is closed: a running game keeps the list in memory and
writes it back over the file. On the next start the services start by themselves, before you
join a world.

From then on everything reloads headlessly (`reload_main`, `reload_ext`, `reload_worker`
bridge commands) — you never need the GUI again.

### 7. Check it works

```sh
./gerda ctl ping        # → pong (bridge reachable)
./gerda ctl status      # services + worker heartbeat
./gerda ctl get_state   # position, health, held tool, worker status
./gerda ctl send mission_start '{"name": "goto", "params": {"x": 100, "y": 64, "z": 200}}'   # the navigator walks there
```

For `goto`, pick a point about 20 blocks from the `pos` that `get_state` printed: a far target
in unexplored terrain takes long to reach. In single-player the game pauses while its window
does not have focus, and the bot stops with it. To keep it running while you type in the
terminal, press F3+P in the game once, or set `pauseOnLostFocus:false` in the instance's
`options.txt` with the game closed.

With no bridge, `ctl` prints one `ERR: no bridge at <host>:<port> …` line saying what to check
(the game running, in a world, with `main` and `bridge` enabled). If the bot bundle did not
load, every bot command answers `no module loaded`, `ctl status` exits 1 with an
`ERR: worker load_failed: …` line, and `get_state` has the detail under `worker.fatal`.

`./gerda` is the repo-root CLI fronting every host tool; `./gerda ctl` is sugar for
`python3 scripts/ops/bridge_ctl.py`. Run `./gerda` bare for the full list, and
`./gerda <cmd> -h` for any tool's help. None of this starts the autonomous loop; the `goto`
mission walks only to the point you give it ([MISSIONS.md § goto](MISSIONS.md#goto)). Note
that `./gerda ctl goto x y z` is something else: a Baritone `#goto` chat command, which without
Baritone only posts `#goto …` in chat — on a server, for everyone to read.

## Wire the MCP server (optional, for LLM operators)

```sh
cp .mcp.json.example .mcp.json    # gitignored; adjust port if not 55544
```

Claude Code started in the repo root reads that file. For any other MCP client, register the
stdio command `uv run mcp/server.py` in that client, with the same environment variables.
Either way the client gets the `mc_*` tools: `mc_ping`, `mc_get_state`, and the generic
`mc_send(type, args)` for every bridge command — discover the full set via the `mc://api`
resource. On a single machine, set `MC_BRIDGE_HOST` to `127.0.0.1`; `auto` also tries the WSL
gateway. Details, environment variables, and the fleet tools:
[mcp/README.md](https://github.com/flamerix-ai/gerda/blob/main/mcp/README.md). The
server reads its config once at startup — reconnect it after changing `.mcp.json`.

## Push metrics (optional)

Telemetry is off by default. The bot can push its counters and gauges (blocks mined, phase,
health, deaths, …) as Prometheus text to a VictoriaMetrics import endpoint. To turn it on, put
the URL in the gitignored `config/local.overrides.json`, then `just sync` and
`./gerda reload-worker`:

```json
{"telemetry": {"pushUrl": "http://127.0.0.1:8428/api/v1/import/prometheus"}}
```

Metric names start with `miner_` (`cfg.telemetry.prefix`); a push goes out every
`cfg.telemetry.interval` ticks. If the endpoint is down, the journal gets one
`TELEMETRY_PUSH_FAIL` per outage and a `TELEMETRY_PUSH_RECOVERED` when pushes work again.

## Run a mission

First, once, give the bot a home on a safe spot. Its recovery and low-health retreat teleport
there with `/home base`:

```sh
./gerda ctl send chat '{"message": "/sethome base"}'
```

Then a mission a fresh bot can do with an empty bag:

```sh
./gerda ctl send mission_start '{"name": "chop", "params": {"count": 4}}'
./gerda ctl send mission_status
./gerda ctl pause     # hand control back
./gerda ctl resume
```

`chop` finds trees near the bot, walks to them and fells them; it stops after 4 logs, or sooner
if it finds no more. Without an axe it logs `MISSION_TOOL_MISSING` and breaks the logs by hand,
slowly. Trees inside spawn protection can't be cut: the server refuses a non-op player's break
within the `spawn-protection` radius of `server.properties` (16 blocks by default) and inside
claimed chunks. Walk or teleport a few dozen blocks away from spawn first.

The other missions need gear the bot has to earn first. `mine {"count": 8}` breaks the ore it
scans and needs a pickaxe of the ore's tier. `drill` needs a pickaxe and a prospected vein,
which needs a charged HV prospector (mid-game): on a fresh install it pauses with
`DRILL_NEEDS_PROSPECT` (see [MISSIONS.md § drill](MISSIONS.md#drill)).

The bot also yields on its own: low health → home, worn tool → hot-swap, and **any
manual movement input → PAUSED**, so you can take over just by moving.

## Going further

- Multiple bots / co-op fleet: [FLEET_PLAYBOOK.md](FLEET_PLAYBOOK.md) +
  [BOT_INSTANCE_SETUP.md](BOT_INSTANCE_SETUP.md).
- Writing missions/capabilities/ext plugins: [EXTENDING.md](EXTENDING.md).
- The three test layers incl. in-game arenas: [TESTING.md](TESTING.md).

## Notes

- The bridge binds loopback only (`127.0.0.1:<port>`); override via the
  `mc_bridge_host` GlobalVar only if you know what you're exposing.
- The bot's world knowledge (waypoints, storages, prospected veins) persists to
  `<Macros>/mc_world.json`; the NDJSON journal is `<Macros>/miner.ndjson` (`get_logs`
  tails it).
- Headless screenshots need `enableVsync:false` in the instance's `options.txt`
  (otherwise off-screen frames go stale). Screenshots and GUI clicks:
  [Eyes & hands](EYES_HANDS.md).
