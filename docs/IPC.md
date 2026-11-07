# Bridge transport & IPC contract

> How the three plain-JS jsMacros services (`bridge.js` / `main.js` / `worker.js`)
> talk to each other and to host tooling — the TCP transport, the `GlobalVars` key
> namespace, and the command envelope. Every key and every wire shape is defined
> once in **`harness/ipc.js`** (the SSOT), mirrored to **`src/core/ipc/ipc.ts`** for the
> worker bundle; drift between the two fails `bun run check`
> (`test-ts/ipc-contract.test.ts`). Consult `ipc.js` if anything below looks stale.

---

## System architecture

```
┌─────────────────┐   TCP :55544   ┌─────────────┐   GlobalVars   ┌──────────────┐
│ bridge_ctl.py   │ ◄────────────► │ bridge.js   │ ──────────────►│   main.js    │
│ MCP server "mc" │                │ (Service)   │                │ (Container)  │
└─────────────────┘                └─────────────┘                └──────┬───────┘
                                                                         │
                                                               eval(code)│
                                                                         ▼
                                                                ┌──────────────┐
                                                                │   worker.js  │
                                                                │ (the bundle) │
                                                                └──────────────┘
```

- **bridge.js** — thin TCP gateway Service (default **127.0.0.1:55544**, newline-framed
  JSON). Polls a `ServerSocketChannel` each tick; no logic — it queues each request line
  into `GlobalVars` and relays the correlated response back. Override the bind host via the
  `mc_bridge_host` GlobalVar (or the port via `mc_bridge_port` / `bridge_port.txt`).
- **main.js** — always-on Container Service and stable utility/API container. Owns
  `safeEval`, the ServiceManager lifecycle, the ext-plugin registry, and bridge command
  dispatch, and publishes the render-thread-pinned world reads the worker can't do itself.
- **worker.js** — managed Service that `eval`s the built bundle
  (`dist/__gerda_bot.bundle.js`, which assigns `globalThis.Module`) and drives it
  tick-by-tick, writing a heartbeat.

The three services are isolated eval scopes with no shared module system, so each
`eval`-includes `ipc.js` and reads the global it publishes (`globalThis.__MC_IPC`).

---

## Command protocol

### Bridge → main.js (TCP JSON, `\n`-framed)

Request `{ id, type, ...params }`, response `{ ok, type, id, ...data }`:

```json
{"type": "<cmd>", "id": 42, "<field>": "..."}
{"ok": true, "type": "<cmd>", "id": 42, "<data>": "..."}
```

`id` is the one correlation id that genuinely crosses script contexts (bridge → main →
worker); the response carries the same `id` back.

**The command reference is `describe`.** The live command set is larger than the table below
and self-describing: the `describe` bridge command returns every command with its params,
merged from `main.js` HANDLERS, the `ext.js` plugins and the worker bundle's own commands. Ask
for it with `./gerda ctl send describe`, or read the `mc://api` resource of the `mc` MCP
server (the same manifest).

Core container endpoints:

| Type | Payload fields | Description |
|------|---------------|-------------|
| `describe` | — | The command manifest: every command and its params |
| `status` | — | Container status, module state, service status |
| `services` | — | List all registered services and running status |
| `get_state` | — | Full state snapshot (pos, health, phase, target, tool, inventory summary) |
| `start` | `name?` | Start managed service (default: worker) |
| `stop` | — | Stop managed service or unload module |
| `halt` | — | Hard stop (SIGKILL equivalent). It stops the worker synchronously on main's tick, so on a stuck worker it deaf-locks the whole bridge: use `reload_worker` (`./gerda reload-worker`) instead, see [FLEET_PLAYBOOK § 2.1](FLEET_PLAYBOOK.md#21-launching-relaunching-and-reconnecting-a-bot) |
| `reload_worker` | `name?`, `delay?` | Off-thread worker reload (halt + start as one command); safe on a stuck worker |
| `pause` / `resume` | — | Passthrough to worker (via GlobalVars) |
| `goto` | `x, y, z` | Passthrough to worker |
| `scan` | `radius?` | Read-only: exposed ores + player state |
| `inventory` | — | Read-only: hotbar + main inventory + fullness |
| `eval` | `code` | Evaluate JS in the main.js sandbox (`safeEval` — World/Player only, no `Java`) |
| `jeval` | `code` | Privileged escape hatch — full jsMacros/Java scope, loopback only |
| `load` | `code` | Load JS as a passive module (`loadModule`) |

### main.js ↔ worker.js (`GlobalVars`)

| Key | Type | Direction | Purpose |
|-----|------|-----------|---------|
| `mc_worker_cmd` | string (JSON) | main → worker | Command payload |
| `mc_worker_cmd_flag` | int (unixtime) | main → worker | Command freshness flag |
| `mc_worker_alive` | int (tick count) | worker → main | Heartbeat, incremented at the start of every worker tick body. It does not change while a body blocks; the movement-key dead-man in main.js reads it (see [Tick pacing](#tick-pacing)) |
| `mc_worker_alive_ts` | int (unixtime) | worker → main | Heartbeat wall-clock |
| `mc_worker_status` | string | worker → main | Worker status line: `running` · `paused` · `fatal` (tick fatal, worker halted) · `load_failed` (no module: the bundle was missing, threw while loading, or exported no `Module`) · `stopped` |
| `mc_worker_last_cmd` | string | worker → main | Last handled command |
| `mc_worker_resp` | string (JSON) | worker → main | Ack `{id,ok,type,result}` (correlated by `id`) |
| `mc_worker_cmds` | string (JSON) | worker → main | Bundle's self-described command manifest |
| `mc_worker_build` | string (JSON) | worker → main | Bundle build stamp `{rev,time}` |
| `mc_worker_fatal` | string (JSON) | worker → main | `{owner,phase,tick,error,time}`: a `CoreFatalError` from a tick (→ halt), or a bundle load failure (`owner:"worker"`, `phase:"loadBundle"`, plus `path`). Shown as `worker.fatal` in `get_state` and `diag`; a successful load clears it |
| `mc_want_sprint` | string (`"1"`/`"0"`) | worker → main | Desired sprint flag; main applies it on the main thread (setSprinting off-thread races the render FOV read → CME crash) |
| `mc_worker_tick_pace` | string (JSON) | worker → main | Tick pacing stats `{lastMs,maxMs,slow,missed}`: `slow` = ticks that ran longer than 50 ms, `missed` = game ticks dropped while they ran, `maxMs` = the longest tick so far. Written at the first tick, then only when `slow` grows, so `lastMs` is the duration of the most recent slow tick, not of the latest tick. Shown as `worker.tickPace` in `get_state` and `diag` |

### Tick pacing

jsMacros 1.9 starts a new thread for every `JsMacros.on("Tick", …)` listener on every game
tick. The thread then waits for the script's one GraalJS context. If one tick body runs for a
long time, the threads pile up behind it: on a CPU-starved client a 4-minute worker tick left
4538 waiting threads, and the client died with `unable to create native thread`.

So bridge.js, main.js and worker.js tick through `IPC.paceTick` (`harness/ipc.js`). It arms
one `JsMacros.once("Tick", …)` listener and arms the next one only when the body returns.
While a body runs, no Tick listener exists and jsMacros starts no thread. The game ticks of
that time are dropped, not queued. `diag.main.tickPace` and `worker.tickPace` count them.

Because the worker runs no new body while one runs, `mc_worker_alive` stops for as long as a
worker tick blocks. main.js uses this as a **movement-key dead-man**: when the value does not
change for `DEADMAN_STALE_TICKS` (10) main ticks, main.js releases the movement, jump, sprint
and sneak keys once for that stall (docs/SAFETY.md). Each stall also writes a `DEADMAN`
record to the journal (`miner.ndjson`), so `get_logs` shows it. The record's `tick` is the
worker heartbeat (`mc_worker_alive`, the worker's tick count, as on every other record);
main's own count is `fields.mainTick`. `diag` reports the dead-man as `main.deadman`:

| Field | Meaning |
|-------|---------|
| `staleTicks` | The threshold, `DEADMAN_STALE_TICKS` |
| `stalls` | Worker stalls since main.js started. Each one released the keys, but main.js cannot see which keys the worker held, so a stall with no key down (a long `SCAN` tick) counts too. It is not a count of prevented falls. |
| `lastStallTick` | The main tick of the last release (`-1` = never) |
| `stalledTicks` | Main ticks since `mc_worker_alive` last changed |
| `tripped` | The current stall already released the keys |

### bridge.js ↔ main.js (`GlobalVars`)

| Key | Type | Purpose |
|-----|------|---------|
| `mc_bridge_cmd_count` | int | Monotonic counter for commands from the bridge |
| `mc_bridge_seq` | int | Bridge sequence cursor |
| `mc_bridge_cmd_<N>` | string (JSON) | Queued request line N |
| `mc_bridge_resp_<id>` | string (JSON) | Response line for command `id` |
| `mc_bridge_alive` | int | Container heartbeat |
| `mc_bridge_host` / `mc_bridge_port` | string / int | Runtime bind host / port override (else `bridge_port.txt` / 55544) |

### main.js boot, heartbeat & event ring

main.js also publishes its own boot/heartbeat keys — `mc_main_alive`, `mc_main_build`
(`{rev,time}`), and `mc_main_srg_ok` + `mc_main_srg_missing` (the loud SRG-resolution boot
diagnosis) — plus a bounded pull **event ring** (`mc_events_seq` / `_head` / `_size` /
`_slot_<i>`, capacity 256) that backs the `poll_events` / `get_logs` endpoints.

### Shared world model (main → worker)

Some reads are pinned to main.js's thread and deadlock or crash if the worker attempts them,
so main.js publishes them each tick and the worker mirrors them for the bundle: `mc_world_sig`
(`"<wid>|<dim>"`, for `world.signature()`), `mc_items` / `mc_mobs` / `mc_peers` / `mc_frames`
(nearby-entity JSON snapshots), `mc_assignment` (fleet region), and the `mc_world.json` file
store.

> `GlobalVars` is a thread-safe `ConcurrentHashMap` but **rejects guest (JS) objects** —
> everything above the wire is primitives / Strings / JSON by necessity, not just convention.

---

## Build & deploy

The bundle is built by **tsup** (`just build` → `dist/__gerda_bot.bundle.js`, IIFE/es2020)
and deployed with `sync.py`, which is **deploy-only** — it copies the built bundle plus the
`harness/` service files into each game instance.

```bash
just build                                  # tsup → dist/__gerda_bot.bundle.js
just sync                                   # build + deploy to every instance
python3 scripts/ops/bridge_ctl.py status    # or: ./gerda ctl status
```

**Required jsMacros services:** `main.js` and `bridge.js`, registered once in the jsMacros
Services screen ([SETUP.md](SETUP.md), Quickstart step 6). `main.js` starts and manages
`worker.js`.
