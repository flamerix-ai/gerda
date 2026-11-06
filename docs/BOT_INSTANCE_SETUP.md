# Per-bot client instance setup & tuning

> How to add **one bot** as its own launcher instance (Prism/MultiMC/FreesmLauncher — adjust to
> your launcher) and tune it to use the least host resources while still able to mine and fight.
> Companion to the [server runbook](SERVER_SETUP.md). Each bot is an ordinary MC **client**
> running the bundle inside jsMacros.

## Why this matters

Each bot is a full modded Minecraft client, so the host ceiling for *N* of them is
**memory**, not CPU. On hosts with strict memory overcommit (`vm.overcommit_memory=2`), a
client crashes with `mmap failed` once the system-wide `Committed_AS` reaches `CommitLimit`,
even with RAM free. Modpack instances often ship a large heap; at, say, **`-Xmx16G -Xms8G` per
instance**, four bots would reserve 64 GB. Nobody watches a bot, so desktop render settings (render distance 12, 90 fps, fancy
graphics, AO, mipmaps, shadows) are waste × N. A low heap and a render floor make 4+ bots on one
host viable.

## 1. Create a bot instance

Each bot = its own instance so its `options.txt`, account, mods, and **bridge port** are
independent (two bridges cannot share one port).

1. **Clone the play instance.** In your launcher, right-click `Monifactory` → **Copy instance**,
   name it `Monifactory_bot_<N>` (the `_bot_` part matters, see the naming contract below).
   Cloning guarantees the exact mod-set + version the server handshake requires — see the
   monilabs parity note in
   [SERVER_SETUP § 3a](SERVER_SETUP.md#3a-monilabs-crashes-the-dedicated-server-bump-it).
2. **Offline account.** Accounts → add an **offline** account with a unique username
   (`bot_<N>`). Then pin each instance to its account, so no instance rides the launcher's
   globally active one. Close the launcher GUI first (it rewrites `instance.cfg` on close):

   ```sh
   ./gerda bind-accounts   # = python3 scripts/ops/bind_instance_accounts.py; idempotent
   ```

   It binds `Monifactory_bot_1`…`_4` to `bot_1`…`bot_4`, your play instance to
   `humanAccountName` and the shader camera to `cameraAccountName`; both names come from
   `local.config.json` (`local.config.json.example`), and it stops with an error if one is
   missing.
3. **Connect.** Launch it, Multiplayer → Direct Connection → `127.0.0.1:25565` (or launch with
   the launcher's `-s 127.0.0.1:25565` flag, which joins on its own). Leave the bot
   non-op: it plays like a real player
   ([FLEET_PLAYBOOK § 1](FLEET_PLAYBOOK.md#1-the-server-and-how-the-bots-play-read-first)).
4. **Deploy the bundle.** `just sync` (or `./gerda sync` = `scripts/ops/sync.py`) ships the
   bundle to *every* instance and gives each its own bridge port. Verify:
   `./gerda ctl --bot Monifactory_bot_<N> ping` → `pong`.

### Naming, accounts and ports — the contract

The host tools find instances by name. This is the one place the rules are written down:

- **Your play instance** keeps its plain name: `Monifactory` by default. If yours is named
  differently, set `humanInstance` in `local.config.json`. Host tools that read *your* screen
  or quest book use it.
- **Every bot instance name contains `_bot_`.** The fleet hub dispatches queued tasks and
  pushes its routine updates only to `*_bot_*` instances, and refuses to pin a task to any
  other name, so it never drives your own client unasked. `Monifactory_bot_<N>` is the
  convention. An instance that runs a bot under another name (one game instance, with the bot
  account in it) joins the fleet when you list it in `local.config.json`
  `"fleetInstances": ["Monifactory"]`.
- **Instance name vs player name.** `--bot`, the MCP `target=` and `mc-bots.json` use the
  instance name (`Monifactory_bot_2`). In game and in the server console, the bot is its
  account name (`bot_2`).
- **One offline account per instance**, each with a unique username. The server runs
  `online-mode=false`, so no paid account is needed. Two instances cannot be online under the
  same username at once.
- **Bridge ports.** `just sync` gives every instance that has a jsMacros `Macros` folder its own
  bridge port, writes it to that instance's `bridge_port.txt`, and records it in the
  gitignored `mc-bots.json` (two bridges cannot share a port). A newly seen instance gets the
  lowest free port from 55544 up, and keeps it on every later sync. On a first sync the
  instances are taken in name order, so `Monifactory` gets 55544 and `Monifactory_bot_1` gets
  55545; an instance you add later takes the next free port. `mc-bots.json` holds the actual
  ports, and `--bot <instance>` looks them up there.
- **The tuner's default set.** `./gerda tune` with no arguments tunes every instance whose name
  contains `_bot_` that `mc-bots.json` or your launcher's instances folder knows. It never tunes
  your play instance (`humanInstance`), and it stops with an error when it finds no bot
  instance. Name an instance to tune only that one.

## 2. Tune it for minimum resource use

```sh
# stop the bot first — a RUNNING MC rewrites options.txt on quit and would clobber the edit.
./gerda tune Monifactory_bot_<N>     # = python3 scripts/ops/tune_bot_instance.py
# no args = every *_bot_* instance in mc-bots.json or the instances folder (never humanInstance)
```

`./gerda tune` (`scripts/ops/tune_bot_instance.py`) is idempotent and edits two files. It deliberately leaves
**`enableVsync:false`** (off-screen screenshots need it) and **`guiScale:4`** (the eyes/hands
click math is screenshot-pixel ÷ 4) untouched.

**`options.txt` (render floor):**

| key | value | why |
|---|---|---|
| `renderDistance` / `simulationDistance` | `5` | ~64-block sensory horizon — enough for mining, local nav, melee hunt; the bot's `World.getBlock`/entity sensing only sees loaded chunks, and the server simulates in MP anyway |
| `maxFps` | `30` | the bot tick runs on the **worker thread**, not the render thread, so it isn't fps-bound; screenshots/clicks are event-driven. 30 just trims GPU/CPU |
| `graphicsMode` | `0` (fast) | no fancy/fabulous |
| `ao` `entityShadows` `renderClouds` `bobView` | off | cosmetic-only |
| `biomeBlendRadius` / `mipmapLevels` | `0` | drop colour-blend + texture-mip work |
| `entityDistanceScaling` | `0.75` | render-cull only — entities still **exist** in the client world for hunt sensing |
| `particles` | `2` (minimal) | |
| `soundCategory_master` | `0.0` | mute → no sound-engine cost |

**`instance.cfg` (heap):** `OverrideMemory=true`, `MinMemAlloc=2048`, `MaxMemAlloc=4096`.
4 GB max fits a render-5 bot; low `Xms` stops the JVM from committing a large heap up front at launch. **Bump
to 5–6 GB only if a specific bot OOMs** under heavy chunk loading (GTCEu registry spikes).

> **GOTCHA — `instance.cfg` is launcher-owned, not game-owned.** Prism, MultiMC and
> FreesmLauncher cache each instance's settings in memory and **rewrite `instance.cfg` from that
> cache** (on instance launch / settings-dialog save / launcher exit), so editing the file
> **while the launcher is running is clobbered** — the bot launches with the old heap and you
> get duplicate keys. Set the heap one of two ways: **(a) in the GUI** — Edit Instance →
> Settings → Memory → override → Max 4096 / Min 2048 (authoritative, writes the file cleanly);
> or **(b) run the tuner with the launcher fully CLOSED**, then reopen. The tuner detects your
> own running Prism, MultiMC or FreesmLauncher by process name and then skips the heap edit;
> another user's launcher and a defunct (zombie) launcher process do not count. A launcher that
> runs under another process name is not detected, so close it yourself first.
> `options.txt` has no such problem — it's
> read by **MC itself** at game launch, so the tuner's render edits stick as long as that bot is
> stopped when you run it.

### Combat-ready vs minimal — the dial

The bot stays fully combat-capable under all of the above: bot logic reads server-driven
world and entity state on the worker thread, independent of render quality. Two knobs trade
capability for resources:

- **`renderDistance`** is the bot's sensory horizon. 5 is the floor for mine/hunt; raise to 6–8
  if a mission needs more lookahead, drop to 4 for absolute minimum.
- **`maxFps`** can go to 10–15 for the leanest GPU footprint; keep ≥30 if you screenshot-drive
  the GUI rapidly (each `screenshot` forces a render, but a higher cap keeps the off-screen
  frame fresher between shots).

## 3. Apply to the already-running bots

Editing a *running* instance's `options.txt` is futile — MC overwrites it from memory on quit.
So tune each running bot **while stopped**: in the launcher, stop bot → run the tuner for it →
relaunch. The heap change (`instance.cfg`) only takes effect on the next launch regardless.

## Non-goals

- A no-GL client: vanilla MC needs a GL context. For an off-screen client see
  [RIG.md § Run](RIG.md#run-one-client-headless-no-camera).
- Removing mods: client-only mods (jsMacros, EMI, JourneyMap) power the bot's own features, and
  removing server-matched mods breaks the handshake. Render settings give the savings without
  that risk.
