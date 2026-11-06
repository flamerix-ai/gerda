# Fleet playbook — playing alongside the bots

How to drive the co-op fleet on the dedicated server: the server rules, fleet and chat control,
FTB Quests, and prospector charging. For adding missions and plugins see
[EXTENDING.md](EXTENDING.md).

---

## 1. The server and how the bots play (read first)

Dedicated server: `<server-root>/monifactory-<version>/`, controlled with
`./server-ctl.sh {start|stop|cmd|status|log}` ([SERVER_SETUP.md](SERVER_SETUP.md)).

- **In fleet play, each bot plays like a real player:** no cheats, no handouts. Bots
  (`bot_1`..`bot_N`) are not op; only your own account `<your-account>` is. Keep it that way —
  hand-feeding a bot items bypasses the economy the bot is built to run.
- **Teleport is the bots' one privilege:** FTB Essentials `/home`, `/back`, `/spawn`, `/rtp`
  (FTB Essentials does not op-gate these by default; check its config). The bot's own recovery
  uses `/home` and `/back` (`src/bot/missions/mine/home-return.ts`, `homeCommand`/`backCommand` in
  `src/shared/config/schema.ts`). Give every bot its home once, on a safe spot:
  `./gerda ctl send chat '{"message": "/sethome base"}'`. Without it, `/home base` answers
  `Unknown destination!` and the bot does not move. After `cfg.safety.homeNoEffectLimit` such
  recovery sends in a row, each from a spot away from the bot's recorded home, the bot stops
  sending `/home` and logs `HOME_COMMAND_DISABLED` (the server kicks a non-op player who repeats
  commands too fast). A bot with no recorded home yet (it records one only where the mine mission's
  HOME leg `/home` moved it) counts every such send. It sends again `cfg.safety.homeRearmTicks` later, or at once after a chat
  `home`. Keep the `/home` cooldown at 0 ([SERVER_SETUP § 4](SERVER_SETUP.md#4-configure-run)).
- **Scaffolding goes through the server console or your op account:** `./server-ctl.sh cmd
  "setblock …"`, `cmd "give <your-account> …"`, `cmd "tp bot_N x y z"`. Arena and film-set builds
  (`scripts/dev/arena.py`) need an op client: your op account, or a test bot opped for one
  `just gate-live` session and de-opped after.
- **Server settings:** always day (`doDaylightCycle=false`), difficulty peaceful (no hunger, no
  hostile mobs), `online-mode=false`, `enforce-secure-profile=false`, no whitelist (trusted LAN).
  Generate a fresh world with a random seed on first setup.

## 2. Driving the fleet

- **Names.** `target=` and registry names are instance dirs (`Monifactory_bot_1`…); in-game and
  console names are `bot_1`….
- **Tools.** The `mc_*` tools come from the `mc` MCP server; wire it once
  ([SETUP.md § Wire the MCP server](SETUP.md#wire-the-mcp-server-optional-for-llm-operators)). Every MCP call
  has a shell equivalent: `./gerda ctl --bot <instance> …` for one bot, `./gerda fleet …` for
  the hub.
- **One bot:** `mc_send` / `mc_get_state` / `mc_ping` with `target=Monifactory_bot_N`, or
  `./gerda ctl --bot Monifactory_bot_N status`. Talks to that bot's bridge directly; no hub
  needed.
- **Fleet state:** `mc_fleet_status` / `mc_fleet_map` / `mc_fleet_claims` / `mc_fleet_assign` /
  `mc_fleet_unassign` need the coordinator hub: `./gerda hub` (`scripts/ops/fleet_hub.py`,
  port 8849). Track its PID; do not `pkill -f fleet_hub` (the pattern can match your own shell
  and kill it). From a shell,
  `./gerda fleet status|map|claims|queue|want|enqueue|cancel|assign|unassign` talks to the same hub:

  ```bash
  ./gerda hub --http 127.0.0.1:8849 --interval 2.0          # the hub (a daemon; keep it running)
  ./gerda fleet want iron --bots 2                          # two bots drill iron
  ./gerda fleet enqueue drill '{"ore":"iron"}' --bot Monifactory_bot_2 --ttl 1800
  ./gerda fleet assign Monifactory_bot_1 -520 -460 -380 -320  # region lease: minX maxX minZ maxZ
  ```
- **Regions** keep two bots off one vein: `mc_fleet_assign {bot, allowed:{minX,maxX,minZ,maxZ}}`.
  The hub pushes each bot its `allowed` box plus `forbidden` = the peers' boxes (`mc_assignment`).
  The assignment has no TTL — always `mc_fleet_unassign`.
- **Task queue** — say what you need; free bots pick it up:
  `curl -X POST localhost:8849/fleet/enqueue -d '{"mission":"drill","params":{"ore":"iron"}}'`. Optional
  `"bot":"Monifactory_bot_2"` pins it, `"ttl":1800` bounds it; without `bot` the first free bot
  takes it (FIFO). Only online, IDLE, untasked fleet instances are dispatched: `*_bot_*` names,
  plus the instances listed in `local.config.json` `"fleetInstances": ["Monifactory"]` (env
  `MC_FLEET_INSTANCES`). Any other instance counts as the human's own client and gets no task.
  On the one-instance setup of SETUP.md, list `Monifactory` there, or the queue never runs; while
  no fleet instance is online, `enqueue` and `want` reply with a `warning` that says so.
  Outcome is read from the bot: finished run = done; PAUSED = done and aborted;
  ERROR = failed and aborted; bot offline = bounded requeue; TTL as backstop. `GET /fleet/queue`
  lists, `POST /fleet/cancel {id}` cancels. The queue persists in `mc-tasks.json`. MCP:
  `mc_fleet_enqueue` / `mc_fleet_queue` / `mc_fleet_cancel`.
- **Want presets** — ask for a resource:
  `curl -X POST localhost:8849/fleet/want -d '{"resource":"iron"}'` enqueues the mission that produces it
  (`bots:N` fans out, `bot:` pins, `ttl:` bounds). Ore words → `drill {ore}` (prospect → shaft →
  mine); `wood` → `chop`; `food` → `hunt` (`WANT_PRESETS` in `fleet_hub.py`). Unknown words become
  `drill {ore:<word>}`, which skips gracefully if no vein is found. MCP: `mc_fleet_want`.

### 2.0 Driving a bot from in-game chat

A player near the bots can drive them from chat — no bridge, no MCP:

```
!<botname|all> <verb> [args…]      e.g.  !bot_2 goto 120 70 -40      !all pause
```

- **Addressing.** `!bot_2 …` reaches the bot named `bot_2` (case-insensitive); `!all …` reaches
  every bot in earshot. Lines for other bots are ignored; a bot never acts on its own output.
- **Verbs:** `status`, `pause`, `resume`, `stop`/`abort`, `home`, `mine`, `drill [ore]`,
  `chop [n]`, `hunt [n]`, `goto <x> <y> <z>`, `follow <player>`. Each routes through the same
  commands as the bridge, so the reply reports what actually happened (`failed: …` on a no-op).
  `home` stops movement and the mission, then sends the `cfg.homeCommand` teleport, also when the
  bot had disabled it after `HOME_COMMAND_DISABLED`. Numbers must
  be whole decimals within `chat.maxCoordXZ` / `minCoordY` / `maxCoordY` / `maxCount`; `chop -5`,
  `goto 0x10 70 0` and surplus args are refused with a reply.
- **Trust.** `cfg.chat.trustedPlayers` in `src/shared/config/schema.ts` is empty by default, which
  admits nobody. The shipped pack profile (`src/bot/profile/pack.ts`) sets `["*"]` (anyone) for a
  private, peaceful, offline-mode server. On a shared server list your own names:
  `chat: { trustedPlayers: ["Alex", "…"] }`. Matching is exact and case-sensitive. This is not
  authentication — on an offline-mode server anyone can log in under any name. Untrusted lines
  addressed by name get one refusal per sender per `chat.denyReplyTicks`; untrusted broadcasts are
  logged, never answered.
- **Replies** start with `cfg.chat.replyPrefix` (`[gerda] `), so a reply never parses as a
  command. The `home` teleport is sent verbatim.
- **Troubleshooting.** Chat is queued on the listener thread (bounded by `chat.queueCapacity`,
  drop-oldest) and handled on the tick thread. The parser expects vanilla `<Name> text`; on a
  server that decorates chat, look for `CHAT_NO_PARSE` in `get_logs`. If nothing shows, lower the
  log level (`trace`) and look for `CHAT_SELF` (DBG): it proves the bot hears chat; its absence
  means the listener never fired.

### 2.1 Launching, relaunching and reconnecting a bot

Four levels of restart — use the lightest that works:

- **`reload_ext`** — re-evaluates `ext.js` (mod-API plugins).
- **`reload_main`** — re-reads `main.js` headlessly; the worker keeps running.
- **`reload_worker`** — restarts the worker (kernel + bundle) off-thread: `./gerda reload-worker`
  (`scripts/ops/reload_worker.py`). It dials the same bridge as `./gerda ctl`: `--port` or `--bot`,
  else `MC_BRIDGE_PORT`, else 55544. Do not send a bare `halt` to a stuck worker: it blocks
  main.js's tick and the whole bridge goes deaf.
  Example: `./gerda reload-worker --bot Monifactory_bot_1 --timeout 60`. On an ack timeout it
  reports and does not retry; check `./gerda ctl --bot Monifactory_bot_1 status` before you
  send it again.
  If one worker tick runs for minutes (a CPU-starved client, software rendering), the reload
  waits behind it. Then `./gerda ctl restart_service worker` stops the worker from bridge.js and
  leaves it stopped; `./gerda ctl start` starts it again. `get_state.worker.tickPace` counts the
  slow ticks.
- **Cold JVM launch** — full client restart, for a crashed or wedged client or a new account
  binding. Launch and join in one launcher command (adjust for your launcher):

  ```bash
  freesmlauncher -l Monifactory_bot_1 -s localhost:25565 -a bot_1
  ```

  `-l` instance dir, `-s host:port` joins on launch, `-a` offline account. Stop the old client
  first (`kill -TERM <javaPID>`; find it by `-Djava.library.path=…/instances/<inst>/natives` in
  `ps`). Ports: `./gerda sync` assigns each instance a bridge port from 55544 up, keeps it
  across deploys and records it in `mc-bots.json`. A cold boot starts the worker in IDLE once
  the world loads; survival reflexes are always on, no `start` needed.
- **Reconnect after a disconnect screen.** Drive it headless: `click{i:0}` → Multiplayer →
  `click "Direct Connection"` → `click "Join Server"` (the address field keeps the last host). A
  relog returns the player to where it logged out; if that spot is unsafe, move it from the
  console (`server-ctl.sh cmd "tp bot_N x y z"`).
- **Keep-alive timeouts.** A freshly booted modded client can stall past the server's keep-alive
  window if loaded hard at once (bulk `/fill`, teleports into loading chunks). Let chunks settle
  10–20 s after boot.

## 3. FTB Quests (read, complete, claim)

The bot drives FTB Quests through its native API — no GUI or screenshots.

- **Read the tree from disk:** ids, grid positions, `dependencies`, task `type` and items live in
  `$INST/config/ftbquests/quests/chapters/*.snbt`; title keys (`{moni.quest.*}`, `{moni.task.*}`)
  resolve via `$INST/kubejs/assets/ftbquests/lang/en_us.json`. `$INST =
  <instances-root>/Monifactory/minecraft`; `./gerda config instances_root` prints the root.
- **Live state and actions** (ext.js bridge commands):
  - `quests {…}` — quest and task state from `ClientQuestFile`.
  - `count_item {…}` — how many of an item the bot holds.
  - `quest_complete {…}` — **mutating**: submits task(s) via `SubmitTaskMessage`. Item tasks need
    the item in inventory (not consumed when `consume_items=false`); `checkmark` tasks complete on
    submit.
  - `quest_claim {…}` — **mutating**: claims only the named quest's rewards (`ClaimRewardMessage`
    per reward).
  - Quest and reward ids are 16-hex unsigned longs: `java.lang.Long.parseUnsignedLong(hex,16)`.
- **Autopilot:** `scripts/objective/` (mod-agnostic; FTB adapter in `sources/ftb_quests.py`) runs
  multi-step chains behind an approve-each gate. Use the raw commands for one-offs. Needs a
  running bot; preview first, then approve one quest:

  ```bash
  ./gerda objective --dry-run --chapter genesis   # next objective + its plan, mutates nothing
  ./gerda objective --once --chapter genesis      # asks, then acts on at most one quest
  ```

  `--chapter` takes a chapter file name from `chapters/*.snbt`, `--quest <16-hex id>` targets
  one quest, and `--mode auto --allow-mine` runs unattended with the mining tier on.
- **Item tasks** detect the item when the bot holds it: the bot mines or crafts the item, holds it,
  then `quest_complete`.

## 4. Charging the prospector

The HV prospector runs on EU and is charged the way a player charges it:

- A **Turbo Charger** (quest "Charging Items", id `06E9B9DDDB245F38`) charges RF and EU. The
  Tinker's Workstation and Wireless Charger are RF-only and do not charge it.
- `prospector_status` reads the stored charge (`lowPct` threshold, default 15 %). When the
  prospector is empty, prospecting reports "out of energy" and the drill pauses instead of
  failing. Put the prospector in the charger, then run `prospect` and `resume`. Operating GTCEu
  machines is the player's part of the co-op — the bot runs the basic vanilla economy.

## 5. Seeing players and peers

The mob feed (`publishMobs`) excludes players. Players and other bots come from a separate feed:

- **`mc_peers`** — `main.js` publishes player positions, `worker.js` mirrors them to
  `__MC_PEERS`, and the facade exposes `world.peers()`. The `follow` mission uses it.
- **Peers are obstacles** — the planner treats columns near peers as blocked
  (`cfg.nav.peerObstacle`, rebuilt from `world.peers()` every plan); the goal column is exempt, so
  `follow` can still walk to a peer.
- **One-off scouting without a mission:** poll `./server-ctl.sh cmd "data get entity <name> Pos"`
  and push a `greedy_drive` target every few ticks.

## 6. Coordination features

- **Vein claims** — the hub reads each bot's drill target (`mission_status` → `drill.vein`) and
  leases `vein:x,z` for it (TTL 90 s, renewed per poll). Peers skip veins within
  `cfg.fleetVeinClaimRadius` (8) of another bot's claim (`DRILL_CLAIM_SKIP`).
- **Shared hazards** — each bot records ravines and drowned columns in `mc_world.json` `hazards`.
  The hub merges them per dimension and pushes `assignment.hazards` to every bot, so one bot's
  hazard is avoided by all.
- **Pushes** go only to region-claimed bots and online `*_bot_*` instances (never the human's
  client) and are skipped when unchanged. Offline tests: `test-ts/fleet-coordination.test.ts`.
- **Live gate:** `just gate-live` runs every asserting arena plus the navigator benches with one
  exit code (`--quick` = core set). It needs a live opped test bot, so you run it locally by hand
  ([TESTING.md](TESTING.md)).
