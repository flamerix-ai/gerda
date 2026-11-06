# Dedicated server setup (multi-bot fleet)

> Runbook for the **Monifactory dedicated server** the bot fleet connects to. Verified on
> Monifactory **0.13.4** (MC 1.20.1 / Forge 47.4.13) with 4 bots in one shared world.

## Why dedicated, not "Open to LAN"

LAN-open ties the world to a host client, pauses it when the host opens a menu, picks a random
port each time, and its discovery is unreliable between instances on one host. A dedicated
server runs 24/7 and is what the fleet coordinator hub
([FLEET_PLAYBOOK § 2](FLEET_PLAYBOOK.md#2-driving-the-fleet)) expects. The bots run inside jsMacros (a client
mod), so they are ordinary clients; the server is plain Forge plus the Monifactory server mods.

## Prerequisites

- **Java 17+** (Java 21 works for Forge 47.x — verified). The server needs a system Java — the
  launcher's own Java only serves the clients. Ubuntu/Debian, with the download tools §1 uses:
  `sudo apt install openjdk-17-jre-headless curl unzip`.
- Disk: ~2 GB for the server + world.
- The matching **client** instances already installed (Prism/MultiMC/FreesmLauncher — adjust to
  your launcher), one per bot.

## 1. Get the official server pack

Monifactory is **not on Modrinth**, and the CurseForge API needs a key — but the author ships
server zips on GitHub: **`Omicron-Industries/Monifactory` → Releases** (formerly
`ThePansmith/Monifactory`). Download the `Monifactory-Beta.<version>-server.zip` matching your
client version (here `0.13.4`).

```sh
# Run from the repo root. Installs into <serverRoot>/monifactory-0.13.4; serverRoot defaults
# to ~/mc-servers. To change it, set "serverRoot" in local.config.json or export MC_SERVER_ROOT.
SRV="$(python3 scripts/local_config.py server_dir)"
mkdir -p "$SRV" && cd "$SRV"
curl -sL -o server.zip \
  https://github.com/Omicron-Industries/Monifactory/releases/download/0.13.4/Monifactory-Beta.0.13.4-server.zip
unzip -q server.zip && rm server.zip   # → config/ mods/ kubejs/ defaultconfigs/ manifest.json
```

The zip is **overrides only** (mods + configs) — no Forge, no MC jar. Install those next.

Leave `config-overrides/` (the pack's normal / hardmode / expert modes) alone: the bot is tuned
on the default mode. If you switch modes, switch the server and every client the same way.

## 2. Install the Forge server

```sh
cd "$SRV"
curl -sL -o forge-installer.jar \
  https://maven.minecraftforge.net/net/minecraftforge/forge/1.20.1-47.4.13/forge-1.20.1-47.4.13-installer.jar
java -jar forge-installer.jar --installServer   # writes run.sh, libraries/, user_jvm_args.txt
```

## 3. Two required fixes (the 0.13.4 server pack does not boot as-is)

### 3a. `monilabs` crashes the dedicated server → bump it

The 0.13.4 server pack ships **monilabs 0.21.2**, which loads a client-only render class
(`PrismFX$PositionalColor`) during `common_setup` and dies with
`Attempted to load class … for invalid dist DEDICATED_SERVER`. Fix: replace it with a later
build from `NegaNote/MoniLabs` releases (**0.21.7** verified; identical deps —
forge`[47,)` / mc`[1.20.1,)` / gtceu`[7.5.2,)`, all satisfied by the pack). This is the same
monilabs the pack itself ships in 0.13.5/0.13.6.

```sh
cd "$SRV/mods"
rm -f monilabs-0.21.2.jar
curl -sLO https://github.com/NegaNote/MoniLabs/releases/download/1.20.1-0.21.7/monilabs-0.21.7.jar
```

**Apply the same monilabs version to every CLIENT instance too** (mods/ folder) — Forge's
mod-version handshake + registry sync must match between client and server, or the client is
rejected on connect.

### 3b. Parallel mod-loading deadlock → single-thread it

The pack intermittently **deadlocks during boot** (a class-loading race between KubeJS plugin
loading, `alltheleaks`, and MixinSquared on the parallel `modloading-worker` pool — the log
freezes and `jstack <pid>` shows *"Found one Java-level deadlock"* in
`MixinLaunchPluginLegacy.handlesClass`). Force single-threaded mod loading.

The pack ships no `config/fml.toml`, and Forge writes one only on the first start — the start
that can deadlock. Create it before the first start, with only these two keys; Forge fills in
the rest:

```sh
cd "$SRV"
printf 'maxThreads = 1\nversionCheck = false\n' > config/fml.toml
```

`maxThreads = 1` (Forge's default is -1) is what Forge's ModWorkManager reads
(`FMLConfig.MAX_THREADS`). `versionCheck = false` is optional; it silences the version-check
network threads.

Boot then takes ~2 min of mod load + world-gen and reaches `Done (…)`.

> Debugging tip for any "modded server boot hangs with no log output": `jstack <pid>` — if the
> `main` thread is parked in `ModLoader.waitForTransition` and there's a deadlock cycle, it's a
> parallel-load race; `maxThreads = 1` resolves it.

## 4. Configure + run

```sh
cd "$SRV"
echo 'eula=true' > eula.txt
# user_jvm_args.txt: heap (GT server is heavy) — e.g.
printf -- '-Xms4G\n-Xmx8G\n' >> user_jvm_args.txt
```

Key `server.properties` for the fleet (loopback/LAN only — offline-mode has no auth). The
server writes this file on its first start. Either create it now with only these lines (the
server adds the other keys), or start once, stop, and edit it. A `.properties` file has no
inline comments — a `#` after a value becomes part of the value, and the server then silently
falls back to the default — so each comment sits on its own line:

```properties
# bots use fixed offline usernames: no MS auth, sessions never expire
online-mode=false
server-port=25565
# bots mine and build at spawn
spawn-protection=0
# bots do not melee-damage each other when hunting
pvp=false
# passive animals still spawn (hunt works); no hostiles, no hunger. Raise it when wanted
difficulty=peaceful
max-players=10
# offline accounts have no signed chat profile to check
enforce-secure-profile=false
```

Back in the repo root, install the control wrapper (§ `server-ctl.sh` below) and start the
server:

```sh
cp scripts/ops/server-ctl.sh "$SRV/"
"$SRV/server-ctl.sh" start
"$SRV/server-ctl.sh" log               # repeat until `Done (…)! For help`
```

Check that the port is open with `ss -ltn | grep 25565`.

On first boot, turn off the day/night cycle so the world stays in daylight (the fleet plays
always-day, see [FLEET_PLAYBOOK § 1](FLEET_PLAYBOOK.md#1-the-server-and-how-the-bots-play-read-first)).
The setting is saved with the world:

```sh
"$SRV/server-ctl.sh" cmd "time set day"
"$SRV/server-ctl.sh" cmd "gamerule doDaylightCycle false"
```

Set the FTB Essentials `/home` cooldown to 0. The bots teleport home to recover from water,
lava and the void, and FTB Essentials refuses a `/home` sent within the cooldown (default
10 s) of the previous one: the bot stays put, which it cannot tell from a missing home. The
setting is `home.cooldown` in `world/serverconfig/ftbessentials.snbt` (relative to `$SRV`); the
fleet server uses `cooldown: 0`. Restart the server after the change. With a cooldown left on,
the bot gives up on `/home` after `cfg.safety.homeNoEffectLimit` refused recoveries and tries
again `cfg.safety.homeRearmTicks` later.

## 5. Connect the bots

> Per-bot instance creation **and resource tuning** (heap + render floor so 4+ clients fit on
> one host) is its own runbook: [BOT_INSTANCE_SETUP.md](BOT_INSTANCE_SETUP.md).

1. **Create each bot instance** as in
   [BOT_INSTANCE_SETUP § 1](BOT_INSTANCE_SETUP.md#1-create-a-bot-instance). That section is the
   one place that states the naming contract (instance names, offline accounts, bridge ports)
   and how each client connects to `127.0.0.1:25565`.
2. **Leave the bots non-op.** Each bot plays like a real player; its only
   privilege is FTB Essentials teleport — the commands are listed in
   [FLEET_PLAYBOOK § 1](FLEET_PLAYBOOK.md#1-the-server-and-how-the-bots-play-read-first).
   A **test** bot is opped for one `just gate-live` session (`op <name>`, de-op after), because
   arenas build blocks.
3. **Check each bridge:** `./gerda ctl --bot <instance> ping` → `pong`.

## `server-ctl.sh` (detached run + FIFO console)

A small control wrapper so the server runs in the background and console commands
(`op`, `list`, `stop`) can be sent from any shell. It ships as
[`scripts/ops/server-ctl.sh`](https://github.com/flamerix-ai/gerda/blob/main/scripts/ops/server-ctl.sh);
copy it into `$SRV` (§ 4) — it works on the directory it sits in, and
`scripts/local_config.py server_ctl` looks for it there.

```sh
"$SRV/server-ctl.sh" start            # detached; console output goes to $SRV/console.log
"$SRV/server-ctl.sh" cmd "op bot_1"   # any console command
"$SRV/server-ctl.sh" status
"$SRV/server-ctl.sh" log              # last 40 lines of logs/latest.log
"$SRV/server-ctl.sh" stop             # waits for the world save (up to 120 s), then returns
```

Wait for `stop` to return before you start the server again. The server reads its console from
a FIFO whose write end a `sleep` process holds open; do not kill that process while the server
runs — end of input on the console stops the server without a line in the log.

The server files live outside this repo (`$SRV` = `python3 scripts/local_config.py server_dir`)
and are not committed; this runbook is how to reproduce them.
