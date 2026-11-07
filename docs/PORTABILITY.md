# Works on your Minecraft version

You play a different Minecraft version, or no modpack at all? This page says, honestly, what
runs where today, and gives a short recipe to try it on a plain vanilla instance. The rest of
the docs assume our reference setup: **Monifactory 0.13.x on Forge 1.20.1** with jsMacros 1.9.2.

Gerda is two things, and they port differently:

- **The harness** (`harness/` — bridge, main, ext, eyes & hands, `./gerda ctl`, the MCP
  server) talks to the game through jsMacros' own API and plain Java. It runs on **every
  Minecraft version that has a jsMacros build**, Forge or Fabric. Your own plain-JS bot
  ([BUILD_YOUR_OWN_BOT.md](BUILD_YOUR_OWN_BOT.md)) uses the same API, so it runs there too.
- **Gerda Bot** (the `src/` bundle — missions, navigator, reflexes) also calls raw Minecraft
  methods by their **Forge SRG names** (`m_146922_` and friends). It moves on **Forge**. On
  Fabric those names do not exist: the bot loads, but refuses to move (see below).

## Support matrix

Tested with the versions in each row, in a clean Ubuntu 24.04 container, single-player world, no modpack unless
the row says so. "Measured" cells were run live, the Fabric and 1.18.2 bot cells in a re-test
of the portability fixes.

| Minecraft | Loader | jsMacros | Harness (ctl, MCP, scan, screenshot, GUI read) | Your plain-JS bot | Gerda Bot |
|---|---|---|---|---|---|
| 1.20.1 + Monifactory | Forge 47.4 | 1.9.2 | ✅ reference setup | ✅ | ✅ reference setup |
| 1.20.1, no modpack | Forge 47.4 | 1.9.2 | ✅ measured | ✅ measured | ✅ measured: scan finds the vanilla ores without regenerating anything; `goto` arrives |
| 1.18.2, no modpack | Forge 40.3 | 1.9.2 | ✅ measured | ✅ measured | ✅ measured: smoke 21/21, `goto` arrives |
| 1.20.1, no modpack | Fabric | 1.9.2 | ✅ measured, except the SRG hands (below) | ✅ measured | ❌ measured: loads, but every movement mission stops at once with `RUNTIME_UNSUPPORTED` and the bot does not move; smoke 19/21 |
| 1.21 / 1.21.1 | Fabric | 1.9.3-**beta** | ✅ measured, except the SRG hands | ✅ measured | ❌ measured: same as Fabric 1.20.1 |
| 1.20.2 – 1.21.1 | NeoForge | 1.9.2 / 1.9.3-beta | not tested | not tested | not tested — expect the Fabric picture (Mojang names at runtime, no SRG) |
| 1.21.2 and newer | any | **none published** | ❌ | ❌ | ❌ |

The first gate is jsMacros itself: **no jsMacros build for your version, no harness and no
bot.** Builds that exist (Modrinth `jsmacros` project, up to 1.9.3-beta; the newest is a 2024
beta, nothing for 1.21.2+):

- Forge: 1.17.1, 1.18.2, 1.19.4, 1.20.1
- Fabric: 1.17.1 – 1.20.6, and 1.21 / 1.21.1 (1.9.3-beta)
- NeoForge: 1.20.2 – 1.21.1

Pick yours on <https://modrinth.com/mod/jsmacros/versions> (filter by game version and loader).
For Forge 1.20.1 the exact file is in [SETUP.md, Quickstart step 4](SETUP.md#4-install-jsmacros).

### What "not supported" looks like, so you recognise it

On a Fabric (or any non-SRG) runtime the harness tells you itself:

- `./gerda ctl diag` → `main.srgCheck.ok` is `"0"` and `srgCheck.runtime.reason` says
  `Fabric/intermediary runtime (Minecraft class is net.minecraft.class_310)`. The one boot log
  line for the check starts with `!!! SRG boot-check FAIL`.
- The SRG-based GUI hands — `click {x,y}`, `scroll`, `type`, `keypress` — answer an error
  naming the missing SRG method. `key`, `read_screen`, `close_screen` and the widget clicks
  `click {i}` / `click {text}` use jsMacros' own API and keep working.
- A movement mission (`goto`, `mine`, `drill`, …) releases every key on its first step and goes
  to `ERROR`; the journal (`./gerda ctl get_logs`) has `MISSION_FATAL` with
  `RUNTIME_UNSUPPORTED: player.onGround failed (…)` — or `interact.setYaw failed`, whichever
  SRG call the drive makes first (measured: `player.onGround`). The bot never walks without a
  heading: before this check, `goto` on Fabric walked straight along yaw 0 and fell 19 blocks.
- `./gerda smoke` fails two checks, `player.onGround` and `interact.setYaw(current)` (the
  navigator's steer path), even though `interact.lookAt` passes: 19/21.

Everywhere, on every version without those mods: `emi_*`, `prospect`, `drill`, and the quest
tools fail with a "class not found" error naming the class (`prospect` says
`prospect needs GregTech CEu: …`). Nothing else is affected.

If the bot bundle does not load at all, every bot command answers `no module loaded`, and
`./gerda ctl get_state` shows why under `worker.fatal` (`worker.status` is `load_failed`).

## Easy recipe — a vanilla instance on any version in the matrix

1. **Launcher.** Install a MultiMC-family launcher —
   [FreesmLauncher](https://github.com/FreesmTeam/FreesmLauncher/releases) or
   [Prism Launcher](https://prismlauncher.org) — and add an offline account
   ([SETUP.md step 3](SETUP.md#3-get-the-game), items 1–2). The launcher picks the right Java
   for the version by itself (1.21 needs Java 21).
2. **Instance.** *Add Instance → Vanilla → your version*, and under *Mod loader* pick **Forge**
   (or **Fabric** if you only want the harness). Use a name without spaces, for example
   `Forge-1.20.1`. Fabric API is not needed by jsMacros.
3. **jsMacros.** Download the ONE jar for your version and loader from
   <https://modrinth.com/mod/jsmacros/versions> into the instance's `minecraft/mods/` folder
   (launcher: right-click the instance → *Folder*). The JavaScript engine is inside that jar;
   there is nothing else to install.
4. **World and first starts.** Start the instance, *Singleplayer → Create New World* (Peaceful
   is easiest), then *Save and Quit* and close the game. Start it **once more** and close it
   again: the second start upgrades `config/jsMacros/options.json` to `"version": 3`, and
   services registered before that upgrade are lost.
5. **Deploy.** From the repo: `just sync` (point it at your launcher first if needed —
   [SETUP.md step 3, item 4](SETUP.md#3-get-the-game)). It writes into **every** instance that has
   jsMacros and gives each its own bridge port in `<instance>/minecraft/config/jsMacros/Macros/bridge_port.txt`
   (the first one gets 55544). If another client is running, add `--skip <thatInstance>`.
6. **Register the services** (game closed): add `main` and `bridge` to `core.services` in
   `options.json`, or use the in-game jsMacros GUI (default key `J`) → *Services* → `+`. Both
   ways: [SETUP.md step 6](SETUP.md#6-register-the-services-in-game-once).
7. **Check.** Start the game and open your world, then
   `./gerda ctl --port <port> --wait-ready 60 ping` → `pong`, and
   `./gerda ctl --port <port> get_state` shows your position. The MCP server works the same way
   with `MC_BRIDGE_HOST=127.0.0.1 MC_BRIDGE_PORT=<port>`. `./gerda ctl --port <port> diag`
   shows `srgCheck`: `"1"` on Forge, `"0"` with a reason on Fabric.
8. **Walk (Forge only).**
   `./gerda ctl --port <port> send mission_start '{"name": "goto", "params": {"x": 100, "y": 64, "z": 200}}'`.
   (`./gerda ctl goto` is a Baritone chat command, not our navigator.)

**Version-specific notes.** Before 1.20 there is no quick-play: open the world from
*Singleplayer → Play Selected World* yourself. The SRG names the bot uses are the same on Forge
1.18.2 and 1.20.1, so the 1.20.1 `harness/srg_names.json` is fine there; `./gerda srg` itself
reads 1.20.1 Forge mappings by default and needs `--proguard` / `--merged` paths for anything
else (`./gerda srg -h`).

## Your own bot on any version — the portable path

The plain-JS template uses only jsMacros' API, so it runs everywhere the harness runs (measured
on Forge 1.20.1, Forge 1.18.2, Fabric 1.20.1 and Fabric 1.21):

1. Copy `harness/bot_template.js` to `yourbot.js`; keep its last line,
   `globalThis.Module = MyModule;`.
2. Deploy it as the worker bundle into that one instance:
   `./gerda sync -s yourbot.js -n __gerda_bot.bundle.js --only <instance>`, then
   `./gerda ctl --port <port> send reload_worker`.
3. Every command the container does not own reaches your `command()`:
   `./gerda ctl --port <port> send my_start`.

Details: [BUILD_YOUR_OWN_BOT.md](BUILD_YOUR_OWN_BOT.md).

## Another modpack on Forge 1.20.1

Everything version-bound stays valid; only the content changes.

| Layer | Depends on | Portability |
|---|---|---|
| Kernel, FSM, capabilities, reflexes | the Runtime facade | **Pack-agnostic.** Loads on any jsMacros runtime (no host class is looked up while the bundle loads); the facade calls that need Forge SRG report their failure as a typed error. |
| Navigator (`src/shared/nav/`) | block ids + the SRG steer/ground calls | **Pack-agnostic, Forge-only** (see the matrix). |
| Missions `mine`, `goto`, `chop`, `hunt`, `fetch`, `stash`, `search`, `follow`, `loot-run`, `storage`, `craft`, `smelt`, `interact` | vanilla mechanics | **Pack-agnostic.** `mine` targets the ore table below. Without Functional Storage, deposit routing uses chests only. |
| Ore set + harvest tiers (`config/ores_live.json`) | the pack's Forge registry | **Regenerated from any pack**: `just extract-ores-live` reads the live registry (`forge:ores` tag + `*_ore` ids + `needs_*_tool` tags) through a running bot. |
| Missions `drill` and `prospect` | GTCEu HV prospector | **GregTech only.** Elsewhere, use the `mine` mission on the regenerated ore table. |
| ext.js plugins `prospect`, `emi_search`/`emi_recipe`/`emi_uses`, quest tools | GTCEu / EMI / FTB Quests | **Optional.** Each handler resolves its mod classes when called; without the mod, that one command fails loudly. |
| Quest autopilot (`scripts/objective/`) | FTB Quests (adapter) | **Optional.** The engine is mod-agnostic; adapters live in `scripts/objective/sources/`. |
| Raw-Java calls in the harness and the bundle | **Forge SRG names** | **The version and loader boundary** — next section. |

Recipe: install jsMacros, `just sync`, register the services ([SETUP.md](SETUP.md)); with a bot
in the world run `just extract-ores-live`, then `just build && just sync`; verify with
`./gerda smoke` and a few arenas (`./gerda gate`) on an opped test bot. A plain Forge 1.20.1
instance with no modpack needs no ore regeneration at all: the vanilla ores are already in the
table.

## Porting the bot to Fabric or NeoForge (contributors)

The bundle loads and fails loud on these runtimes, so a port is now a bounded job:

1. **A runtime name table.** The 17 hardcoded SRG tokens live in two tables, each entry
   commented with its Mojang signature: 7 in `harness/main.js` (screen input + the sprint
   applier), mirrored as `HARNESS_SCREEN_SRG` in `src/core/runtime/jsmacros/srg.ts`, and 10 in
   the `SRG` table of the same file. Fabric needs the **intermediary** names
   (`method_…` / `field_…`); NeoForge 1.20.5+ runs on the Mojang names. Select the table at boot
   from the runtime check that `diag` already reports (`srgCheck.runtime`,
   `src/shared/harness/srg-runtime.ts`).
2. **A mapping source for `scripts/dev/srg.py`** for that loader (today it reads Forge
   mappings), so `srg()`, `reflect` and the boot self-check work there too.
3. **Re-check movement constants.** Sprint-jump distances and water-clutch timing
   (`src/shared/config/schema.ts`, movement and physics sections) are tuned on 1.20.1; run the
   nav arenas (`scenarios/arenas/`) to catch drift.
4. **Verify** with `./gerda smoke` (all checks, including `interact.setYaw(current)`) and a
   `goto` mission that arrives.

Other contributions with the seams already in place:

- **A pack profile** = a regenerated `config/ores_live.json`, plus notes on which optional
  plugins apply. No code.
- **A non-GT vein strategy for `drill`** = another source of vein targets for the same mission.
  See [MISSIONS.md](MISSIONS.md) and `src/bot/missions/drill/`.
- **A quest adapter** = a new `ObjectiveSource` in `scripts/objective/sources/`, next to
  `ftb_quests.py` and `local_goals.py`.

Open an issue or a [Discussion](https://github.com/flamerix-ai/gerda/discussions) with your
pack and version before you start, and read
[CONTRIBUTING.md](https://github.com/flamerix-ai/gerda/blob/main/CONTRIBUTING.md) for the
gates.
