# scripts/

The repo-root **`./gerda`** CLI fronts everything here (`gerda ctl status` ==
`python3 scripts/ops/bridge_ctl.py status`; bare `./gerda` lists all commands) —
the paths below are the underlying scripts it dispatches to.

Layout is by **audience**. Root = shared libs every other script imports + lint tooling.
`ops/` = operating live bots (day-to-day fleet driving). `dev/` = development tooling
(building/testing the bot's brain, offline SRG/decompile research; the arena/bench/parkour
probes are debug-and-experiment harnesses — kept on purpose, they're how you extend the
navigator). `objective/` = the quest-autopilot engine (`./gerda objective`). `demo/` + `rig/` =
the off-screen film rig (shot runner, recorder, editor; [docs/RIG.md](../docs/RIG.md)).
`sandbox/` = a real Minecraft in a rootless container ([sandbox/README.md](sandbox/README.md)).
`tests/` + `objective/tests/` = the stdlib unittest suites (`just test-py`, also run by the git
hooks).

Everything here is invoked from the repo root (`python3 scripts/ops/<name>.py` /
`python3 scripts/dev/<name>.py`) — each script bootstraps `sys.path` to this root
(`import local_config` / `import fleet_registry`) and to `mcp/` (the canonical
`bridge_client.py` lives there, shared with the MCP server).

## Root — shared libs + lint tooling

- `local_config.py` — machine-specific paths (instances root, accounts) from env >
  `local.config.json` > launcher autodetection. Imported by nearly everything.
- `fleet_registry.py` — the multi-bot bridge registry (`mc-bots.json`) SSOT: bot name →
  bridge endpoint.
- `machine_root.py` — the directory that owns the machine STATE files (`mc-bots.json`,
  `mc-tasks.json`, `local.config.json`): the main checkout, even when called from a git
  worktree. Imported by `local_config.py` and `fleet_registry.py`.
- `check-defensive.ts` / `defensive-rules.ts` — the fail-loud structural linter (`bun run
  scripts/check-defensive.ts`, wired into `bun run check`).
- `docs_publish.sh` — build the MkDocs site (`--strict`) and push it to the `gh-pages` branch
  (`just docs-publish`, maintainer release tooling; `just docs-build` is the local build).

## ops/ — operating live bots

- `bridge_ctl.py` — CLI for the resident bridge (status/get_state/scan/inventory/pause/
  resume/goto/eval/send …). The everyday driving tool.
- `sync.py` — deploy the built bundle + service harness to every game instance and
  reconcile per-instance bridge ports (`gerda sync`; `just sync` = build + this).
- `mc_shot.py` — host-side screenshot reader (grim or in-game F2/`ai_shot.png`) for the AI
  to read a live GUI.
- `reload_worker.py` — safely reload the worker (kernel + bundle) off-thread without
  deaf-locking the bridge.
- `wedge_watchdog.py` — detect + recover the client-respawn WEDGE (`level=null` limbo),
  host-side.
- `fleet_hub.py` — the multi-bot coordinator daemon (presence, claims, `/fleet/*` HTTP API).
- `fleet_ctl.py` — operator CLI for that hub (status/map/claims/queue/want/enqueue/cancel/
  assign) — the no-MCP twin of the `mc_fleet_*` tools.
- `build_platform.py` — expand a void-base platform with filler blocks via an ops loop over
  `interact_place` (`./gerda platform`). Needs a running bot; fills the box `x0..x1 × z0..z1`
  at height `y` from the listed items, in order:

  ```sh
  ./gerda platform --port 55545 --x0 -495 --x1 -483 --z0 -351 --z1 -339 --y 77 \
      --items minecraft:cobblestone,minecraft:cobbled_deepslate
  ```
- `bind_instance_accounts.py` — bind each launcher instance to a fixed account (prevents
  bot/human account collisions).
- `tune_bot_instance.py` — tune a bot instance's `options.txt`/`instance.cfg` for minimum
  host resource use.
- `facade_smoke.py` — live smoke test of the bot's Runtime facade (raw-Java effect paths
  the mock can't cover) before a real run.
- `server-ctl.sh` — the dedicated server's detached-run + FIFO-console wrapper
  (start/stop/cmd/status/log); copied into the server dir (docs/SERVER_SETUP.md).
- `capture_rig.sh` — boot a client inside an independent headless sway and record it, nothing
  on your monitor (`./gerda capture`, run under `nix develop .#capture`); `-K` boots and keeps
  it alive without recording. Flags: [docs/RIG.md](../docs/RIG.md) § `capture_rig.sh` flags.
- `capture_profile.py` — swap an instance's `options.txt` to the demo-capture profile and back
  (`apply` / `restore` / `status <instance>`; `./gerda capture-profile`), keeping the playing
  config in a sidecar. `capture_rig.sh -P` and `rig/teardown.sh` call it.

## dev/ — development tooling

- `arena.py` — declarative in-game test arena harness (build → mission → assert events);
  spec + CLI for `scenarios/arenas/*.json`.
- `gate_live.py` — the consolidated pre-merge live-behavior gate: rolls up every asserting
  arena + navigator leg bench into one PASS/FAIL.
- `navbench.py` — navigator benchmarks: A* (D* Lite on demand), leg + mission; see
  `docs/navbench.md`.
- `parkour_exp.py` — parkour-leg experiment/trace driver (build + drive + trace + svg/mp4).
- `srg.py` — offline Forge SRG↔Mojang name resolver (mappings-file based, no in-game
  trial-calls).
- `decompile.sh` — Vineflower-decompile the MC/mod jar to Mojang-named source (uses
  `srg.py --remap`).
- `extract_gtceu_ores.py` — extract the GTCEu ore list from upstream GitHub source (legacy/
  future pack profile).
- `extract_ores_live.py` — regenerate `config/ores_live.json` from the LIVE Forge registry
  via a running bot (`just extract-ores-live`).
- `resolve_craft_chain.py` — derive a craft chain from EMI's recipe API.
- `mutants.py` — prove each tagged guard of the host tools by breaking it in a throw-away copy
  of the tree, and lint that every guard-shaped line is tagged (`just mutants`, `just
  gate-tags`). Mutant data: `dev/mutants/<area>.toml`; the rules: docs/TESTING.md § Mutants
  of the host-tool guards.
- `smoke_clean.sh` — clean-machine bring-up smoke in a rootless podman container: clone the
  committed state, run the full check, build, deploy into a fake instance (`just smoke-clean
  [image]`, `./gerda smoke-clean`). `smoke_clean_inner.sh` is its in-container half.

## objective/

Mod-agnostic quest-autopilot engine: `core.py` speaks only Objective/Requirement/Effect
against an `ObjectiveSource` protocol; `acquire.py` resolves items (HAVE → CRAFT via
`dev/resolve_craft_chain.py` → MINE via the drill mission); `sources/` holds game/mod
adapters (FTB Quests `ftb_quests.py`, local goals `local_goals.py`); `snbt.py` parses the quest-chapter format. The CLI is
`engine.py` (`./gerda objective --dry-run` previews without mutating; approve mode asks
per quest). Its tests live in `objective/tests/` and run under `just test-py`. A worked run:
[docs/FLEET_PLAYBOOK.md](../docs/FLEET_PLAYBOOK.md) § 3.

## demo/ — staging and driving filmed scenes

The full film flow: [docs/RIG.md](../docs/RIG.md) (Film, Shot runner).

- `shoot.py` — declarative shot runner: turns a shot-list JSON (`scenarios/shots/*.json`) into
  a folder of takes (`list` / `pose` here; rolling goes through `just shoot <id>`). Boots
  nothing: the worker and camera clients must already be up.
- `sustain_live.py` — reproducible live stager for the sustain-cycle demo: rebuilds
  `scenarios/arenas/sustain-cycle.json` on the dedicated server from the server console and
  runs the mine→smelt→restock plan (`build` / `supply` / `frame` / `run` / `loop [N]` …).
- `trigger_bot.sh` — generic `during` trigger of a shot: wait until the recording rolls, then
  send ONE bridge command to the worker (`trigger_bot.sh <sleep_s> <type> <json> [port]
  [timeout_s]`).
- `walk_off.sh` — `during` trigger of the clutch shot: once the take rolls, tap W in-game for
  500 ms so the bot steps off the ledge.

## rig/ — recording, editing, rig housekeeping

Shared by both RIG flows (film and headless run): [docs/RIG.md](../docs/RIG.md).

- `shoot.sh` — the body of `just shoot`: rolls shot-list takes against the RUNNING rig inside
  the `capture` devShell, with `WAYLAND_DISPLAY` resolved from the camera client.
- `record.sh` — record a headless-sway output to mp4 for a fixed duration, off-screen
  (`WAYLAND_DISPLAY=wayland-N scripts/rig/record.sh <out.mp4> <seconds> [output] [fps]`); a
  recorder that did not exit cleanly is a failed take.
- `encode.sh` — final delivery encode of a raw capture (h264, crf 20, faststart, no audio):
  `scripts/rig/encode.sh <raw.mp4> <out.mp4> [1440|1080|720]`.
- `assemble.py` — declarative editor: turns a cut-list JSON (`scenarios/shots/*_cut.json`)
  into one cut mp4 (`--dry-run`, `--only <ids>`).
- `console_card.py` — render a stylized console card (a full-frame terminal still) as an mp4
  that drops into a cut list as a plain segment (`scenarios/shots/cards/*.json`).
- `motion_probe.py` — numeric liveness check of a take: per-frame MAD, live windows, static
  runs, a `--max-static` gate (`./gerda motion-probe <take.mp4>`).
- `sway_windows.py` — which Minecraft client lives in which headless sway and on what display
  (`list` / `fullscreen <instance>` / `display`).
- `fullscreen.sh` — pick which client a headless capture records: fullscreen that instance's
  window (`--list` / `<instance>`; a wrapper over `sway_windows.py`).
- `mc_clients.sh` — list real Minecraft client PIDs (`PID <instance>`) without the
  `pgrep -f` self-match.
- `teardown.sh` — kill the rig's clients by instance signature and restore any capture
  profile left applied (`scripts/rig/teardown.sh <instance> …`); use it instead of `pkill -f`.

## sandbox/ — a real Minecraft in a container

A rootless podman container that plays a plain Ubuntu PC: real client on software GL, dedicated
server, jsMacros and the harness installed unattended. Guide: [sandbox/README.md](sandbox/README.md);
testing your own mod with it: [docs/MOD_TESTING.md](../docs/MOD_TESTING.md).

- `provision.sh` — host half: build the image, create the container, run each step inside it
  (`provision.sh all <bundle|url>`, `server`, `client`, `repo`, `start`, `verify`, `down` …).
- `sbx.sh` — in-container half, run as `student` through `podman exec`; every step is
  idempotent, so re-running resumes.
- `level_cheats.py` — turn "Allow Cheats" on in a single-player world's `level.dat`, so an
  arena can build its scene (`python3 level_cheats.py <world dir or level.dat>`).

## Generated files — what regenerates what

| Generator | Output | Consumed by | Regenerate when |
|---|---|---|---|
| `dev/srg.py --export` | `harness/srg_names.json` (gitignored) | `srg()` in ext.js, `reflect`; deployed by `gerda sync` | game/MC-version change ([PORTABILITY](../docs/PORTABILITY.md), porting section) |
| `dev/extract_ores_live.py` | `config/ores_live.json` (tracked) + `config/ore_tool_tiers.json` (audit) | `src/bot/profile/pack.ts` at build time | new modpack / ore-registry change |
| `dev/extract_gtceu_ores.py` | `config/gtceu_ores.json` (tracked) | nothing yet (future pack profile) | rarely; prefer `extract_ores_live` |
| `just commands-ref` (`test-ts/commands-ref.test.ts`) | `docs/COMMANDS.md` (tracked) | the bridge command reference | a command row changes in `harness/main.js` `META_COMMANDS`, an `harness/ext.js` plugin meta or `WORKER_COMMAND_DOCS`; the same test fails the commit while the file is stale |
| `ops/sync.py` (via `fleet_registry.py`) | `mc-bots.json` (gitignored) | hub, ctl, sync port reconciliation | automatic on sync |
| `ops/fleet_hub.py` | `mc-tasks.json` (gitignored) | task-queue persistence | automatic while the hub runs |
| `tsup` (`bun run build`) | `dist/__gerda_bot.bundle.js` | `worker.js` eval-loads it | any `src/` change |
| `ops/mc_shot.py` | `/tmp/mc_shot.png` | your eyes | every call |
| `dev/parkour_exp.py` | `out/parkour/*` (gitignored) | trace analysis | per experiment |
