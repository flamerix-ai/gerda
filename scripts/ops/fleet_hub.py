#!/usr/bin/env python3
"""Coordinator hub — multi-bot coordination v2.

A standalone daemon that is simultaneously a **bridge client to every bot** and an **HTTP/JSON
fleet server** for the MCP layer (and a future web UI). The bots stay TCP servers and grow no
outbound networking; the hub connects IN exactly like bridge_ctl.py, polls each bot's
`get_state` (+ `mission_status` + `markers`), and holds the merged fleet truth.

v2 coordination (all observation-driven — bots never call in):
  • region leases — /fleet/assign records bot↔box; the disjoint {allowed, forbidden} set is
    pushed to every bot so mine scans never cross regions.
  • AUTO vein leases — the poller reads each bot's drill target (mission_status.drill) and
    leases `vein:x,z` on its behalf; peers receive it as claimedVeins and their drills skip
    veins near it (kernel cfg.fleetVeinClaimRadius).
  • fleet-shared hazards — the hub unions every instance's own recorded drowned/ravine markers
    (host-side read of each mc_world.json) and pushes the per-dimension union as
    assignment.hazards, so one bot drowning teaches the whole fleet.
  • TASK QUEUE — /fleet/enqueue backlogs mission specs; the poller hands each FREE fleet bot
    (online, IDLE, un-tasked) the next queued task as a `mission_start` push and settles the
    task from observed presence (running→False = done, PAUSED = graceful done + abort,
    ERROR = failed + abort, offline mid-task = bounded requeue). "A free bot picks up the next
    task itself" — persisted in mc-tasks.json so a hub restart keeps the backlog.
Pushes go to region-claimed bots + online *_bot_* instances (never the human's client) and are
skipped when unchanged.

Reuses mcp/bridge_client.BridgeClient (canonical client) + scripts/fleet_registry
(mc-bots.json SSOT).

    python3 scripts/ops/fleet_hub.py                      # poll all registry bots, serve :8849
    python3 scripts/ops/fleet_hub.py --http 127.0.0.1:8849 --interval 2.0
    curl -s localhost:8849/fleet/status | jq          # Step-2 gate: returns every registry bot
    curl -s localhost:8849/fleet/map | jq

Endpoints (JSON shaped so a web client attaches later without rework):
    GET  /fleet/status   presence: one row per registry bot (online flag + last snapshot)
    GET  /fleet/map      merged world-model: union of every bot's markers, by (ore,x,z)
    GET  /fleet/claims   active work-claims (lease ledger)
    POST /fleet/claim    {bot, key, ttl?}  grant/renew a lease (409 if held by another live bot)
    POST /fleet/release  {bot, key}        drop a lease the bot holds
    POST /fleet/assign   {bot, allowed:{minX,maxX,minZ,maxZ}, ttl?}  claim a mining region +
                         push the disjoint set ({allowed, forbidden=peer regions}) to every bot
    POST /fleet/unassign {bot}             drop the region + clear the bot's assignment
    GET  /fleet/queue    the task queue (backlog + in-flight + a bounded terminal tail)
    POST /fleet/enqueue  {mission, params?, bot?, ttl?}  backlog a mission; `bot` pins it,
                         else the first free fleet bot takes it (FIFO)
    POST /fleet/cancel   {id}              cancel a queued task / abort a running one
    POST /fleet/want     {resource, bots?, bot?, ttl?}  the produce-resource front door:
                         maps a resource word to the mission that PRODUCES it (ore → drill,
                         which is already the full prospect→shaft→mine chain; wood → chop)
                         and enqueues it on `bots` free fleet bots (default 1)
    GET  /healthz        liveness
"""
from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # scripts/ root
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "mcp"))  # mcp/ -> canonical bridge_client
import fleet_registry  # noqa: E402
from bridge_client import BridgeClient  # noqa: E402

POLL_TIMEOUT = 6.0  # per-bot socket timeout — generous: a freshly-joined heavy client answers
#                     get_state in seconds; offline bots refuse instantly, so this only bounds
#                     a genuinely wedged bot (it still can't stall the whole cycle for long).

VEIN_CLAIM_TTL = 90.0  # auto vein-lease TTL — renewed every poll while the bot keeps drilling,
#                        so it outlives a few missed polls but frees the vein soon after the bot
#                        moves on / dies (the sweep also drops it the moment the bot goes offline).

# Each instance's world store, relative to its registry instanceDir — the host-side read that
# makes hazards FLEET-SHARED: the hub unions every bot's own recorded drowned/ravine markers and
# pushes the union back down, so one bot drowning teaches the whole fleet.
WORLD_STORE_REL = "minecraft/config/jsMacros/Macros/mc_world.json"

TASK_TTL_DEFAULT = 1800.0  # a task that runs past this is aborted + failed (runaway backstop)
# A task that reads PAUSED within this window after assignment gets a `resume` instead of being
# counted done: a safety pause (e.g. the human-input latch a console tp leaves armed) fires within
# seconds of mission start and is indistinguishable from the drill's graceful park by phase alone —
# without the grace the hub burns the whole queue in one poll sweep marking everything "done"
# (live: 6 tasks "done" in 12 s, both bots PAUSED at spawn-in).
PAUSE_GRACE_SEC = 60.0
TASK_MAX_ATTEMPTS = 3      # dispatch/requeue budget before a task is marked failed
TASK_HISTORY_KEEP = 50     # terminal tasks kept in the store as an ops tail

# «I need X» presets (/fleet/want) — resource word → the mission that PRODUCES it. drill is
# already the full prospect→shaft→mine chain, so an ore preset is ONE task, not a plan. Any
# resource not listed here falls through to drill {ore: <resource>} — the drill's marker/
# prospect layer is the validator (an unknown ore just ends in a graceful no-vein skip).
WANT_PRESETS: dict[str, tuple[str, dict]] = {
    "wood": ("chop", {"count": 16}),
    "food": ("hunt", {}),
}
WANT_MAX_BOTS = 8  # cap a single want fan-out (the fleet is 4 bots; 8 = headroom, not a flood)


class FleetState:
    """Shared, lock-guarded snapshot the poller writes and the HTTP handlers read."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._bots: dict[str, dict] = {}      # name -> presence row
        self._markers: dict[str, dict] = {}   # name -> raw markers response
        self._poll_ts: float = 0.0

    def update(self, name: str, presence: dict, markers: dict | None, now: float) -> None:
        with self._lock:
            self._bots[name] = presence
            if markers is not None:
                self._markers[name] = markers
            self._poll_ts = now

    def status(self) -> dict:
        with self._lock:
            return {
                "ts": self._poll_ts,
                "bots": [self._bots[n] for n in sorted(self._bots)],
            }

    def online_rows(self) -> list[dict]:
        """Presence rows for the currently-online bots (the fleet-state push target set)."""
        with self._lock:
            return [dict(r) for r in self._bots.values() if r.get("online")]

    def fleet_map(self) -> dict:
        with self._lock:
            markers = dict(self._markers)
            sigs = {b.get("dimension") for b in self._bots.values() if b.get("dimension")}
        merged: dict[tuple, dict] = {}
        for name, resp in markers.items():
            for r in _extract_resources(resp):
                ore = r.get("ore") or r.get("name") or r.get("vein")
                x, z = r.get("x"), r.get("z")
                if ore is None or x is None or z is None:
                    continue
                key = (str(ore), round(float(x)), round(float(z)))
                cell = merged.setdefault(
                    key, {"ore": str(ore), "x": key[1], "z": key[2], "from": []}
                )
                if name not in cell["from"]:
                    cell["from"].append(name)
        return {
            "ts": self._poll_ts,
            "dimensions": sorted(s for s in sigs if s),
            "resources": sorted(merged.values(), key=lambda c: (c["ore"], c["x"], c["z"])),
        }


class ClaimLedger:
    """Lease-based work-claim ledger (fleet hub assignment) — the central arbiter so two bots never path
    to the same vein/region. A claim is one holder per `key` with a TTL; it is released on
    explicit release, TTL expiry, or the holder going offline (death). Re-claiming the same key
    as the same holder RENEWS the lease (extends the TTL). All state is hub-owned; bots never
    call in (they consume pushed assignments — the kernel-side step)."""

    DEFAULT_TTL = 120.0

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._claims: dict[str, dict] = {}  # key -> {key, bot, granted_ts, expires_ts}

    def claim(
        self, bot: str, key: str, ttl: float, now: float, box: dict | None = None
    ) -> tuple[bool, dict]:
        with self._lock:
            cur = self._claims.get(key)
            if cur and cur["expires_ts"] > now and cur["bot"] != bot:
                return False, dict(cur)  # held by another LIVE lease — deny
            granted = cur["granted_ts"] if (cur and cur["bot"] == bot) else now
            rec = {"key": key, "bot": bot, "granted_ts": granted, "expires_ts": now + ttl}
            if box is not None:
                rec["box"] = box
            self._claims[key] = rec
            return True, dict(rec)

    def region_claims(self, now: float) -> list[dict]:
        """Active claims that carry a region box — the input to disjoint-region assignment."""
        with self._lock:
            return [
                {"bot": v["bot"], "box": v["box"]}
                for v in self._claims.values()
                if v["expires_ts"] > now and "box" in v
            ]

    def release_prefix(self, bot: str, prefix: str, keep_key: str | None = None) -> list[str]:
        """Drop every lease `bot` holds under `prefix` except `keep_key`. A drill works ONE vein
        at a time — moving to a new vein releases the old lease immediately instead of letting
        it shadow the vein for the rest of its TTL."""
        with self._lock:
            gone = [
                k for k, v in self._claims.items()
                if v["bot"] == bot and k.startswith(prefix) and k != keep_key
            ]
            for k in gone:
                del self._claims[k]
            return gone

    def vein_claims(self, now: float) -> list[dict]:
        """Active auto vein leases (`vein:x,z`) → [{bot, x, z}] — the claimedVeins push feed."""
        with self._lock:
            out = []
            for k, v in self._claims.items():
                if v["expires_ts"] > now and k.startswith("vein:"):
                    try:
                        x_s, z_s = k[5:].split(",", 1)
                        out.append({"bot": v["bot"], "x": int(x_s), "z": int(z_s)})
                    except ValueError:
                        continue  # malformed manual claim — not a vein lease
            return out

    def release(self, bot: str, key: str) -> bool:
        with self._lock:
            cur = self._claims.get(key)
            if cur and cur["bot"] == bot:
                del self._claims[key]
                return True
            return False

    def sweep(self, now: float, online: set[str] | None) -> list[dict]:
        """Drop expired leases + leases held by a bot no longer online. Returns the dropped."""
        with self._lock:
            dropped = [
                v for k, v in self._claims.items()
                if v["expires_ts"] <= now or (online is not None and v["bot"] not in online)
            ]
            for v in dropped:
                self._claims.pop(v["key"], None)
            return dropped

    def active(self, now: float) -> list[dict]:
        with self._lock:
            return sorted(
                (dict(v, ttl_left=round(v["expires_ts"] - now, 1))
                 for v in self._claims.values() if v["expires_ts"] > now),
                key=lambda c: c["key"],
            )


class TaskQueue:
    """Hub-owned mission backlog ("a free bot picks up the next task itself"). Observation-
    driven like every other v2 mechanism — bots never call in: the poller watches presence for
    a FREE fleet bot and dispatches the next queued task to it as a `mission_start` push, then
    settles the task from what it OBSERVES (never from what it hopes). Persisted after every
    mutation so a hub restart keeps the backlog; in-flight tasks are requeued on restart (the
    hub can no longer prove they run — the bounded attempts budget stops a crash-loop)."""

    def __init__(self, path: Path) -> None:
        self._lock = threading.Lock()
        self._path = path
        self._tasks: list[dict] = []
        self._next_id = 1
        self._load()

    def _load(self) -> None:
        try:
            data = json.loads(self._path.read_text("utf-8"))
        except (OSError, ValueError):
            return  # no store yet — start empty
        if not (isinstance(data, dict) and isinstance(data.get("tasks"), list)):
            return
        self._tasks = [t for t in data["tasks"] if isinstance(t, dict) and t.get("id")]
        try:
            self._next_id = max(1, int(data.get("nextId") or 1))
        except (TypeError, ValueError):
            self._next_id = 1
        for t in self._tasks:
            if t.get("status") == "running":
                t["status"] = "queued"
                t["bot"] = None
                t["note"] = "requeued: hub restart"

    def _save(self) -> None:
        """Persist (call with the lock held). Live tasks stay in enqueue order; terminal ones
        are a bounded tail so the store can't grow without bound."""
        live = [t for t in self._tasks if t.get("status") in ("queued", "running")]
        done = [t for t in self._tasks if t.get("status") not in ("queued", "running")]
        self._tasks = live + done[-TASK_HISTORY_KEEP:]
        body = json.dumps(
            {"version": 1, "nextId": self._next_id, "tasks": self._tasks},
            indent=2, ensure_ascii=False,
        )
        tmp = self._path.with_suffix(".json.tmp")
        try:
            tmp.write_text(body + "\n", "utf-8")
            tmp.replace(self._path)
        except OSError as e:
            print(f"[hub] task store write failed: {e}", file=sys.stderr)

    def enqueue(self, mission: str, params: dict, pin: str | None, ttl: float | None) -> dict:
        with self._lock:
            t = {
                "id": f"t{self._next_id}",
                "mission": mission,
                "params": params,
                "pin": pin,          # a specific bot, or None = first free fleet bot
                "status": "queued",
                "bot": None,
                "attempts": 0,
                "ttl": float(ttl or TASK_TTL_DEFAULT),
                "enqueued_ts": time.time(),
            }
            self._next_id += 1
            self._tasks.append(t)
            self._save()
            return dict(t)

    def cancel(self, tid: str) -> dict | None:
        """Cancel a live task. Returns the task as it was (caller aborts the bot if it ran)."""
        with self._lock:
            for t in self._tasks:
                if t.get("id") == tid and t.get("status") in ("queued", "running"):
                    was = dict(t)
                    t["status"] = "cancelled"
                    t["ended_ts"] = time.time()
                    self._save()
                    return was
            return None

    def snapshot(self) -> list[dict]:
        with self._lock:
            return [dict(t) for t in self._tasks]

    def running(self) -> list[dict]:
        with self._lock:
            return [dict(t) for t in self._tasks if t.get("status") == "running"]

    def next_for(self, bot: str) -> dict | None:
        """FIFO next queued task this bot may take: unpinned, or pinned to exactly it. A task
        pinned to an offline bot never blocks the rest of the backlog."""
        with self._lock:
            for t in self._tasks:
                if t.get("status") == "queued" and (not t.get("pin") or t["pin"] == bot):
                    return dict(t)
            return None

    def mark(self, tid: str, **fields) -> None:
        with self._lock:
            for t in self._tasks:
                if t.get("id") == tid:
                    t.update(fields)
                    self._save()
                    return


def _abort_mission(bot: str) -> None:
    """Best-effort mission_abort so a finished/wrecked bot returns to the free pool."""
    resolved = fleet_registry.resolve(bot)
    if resolved is None:
        return
    try:
        BridgeClient(host=resolved[0], port=resolved[1], timeout=POLL_TIMEOUT).send("mission_abort")
    except Exception:  # noqa: BLE001 — the settle verdict already stands; abort is a courtesy
        pass


def _resume_mission(bot: str) -> None:
    """Best-effort resume — clears a safety PAUSED (human-input latch etc.) on a young task."""
    resolved = fleet_registry.resolve(bot)
    if resolved is None:
        return
    try:
        BridgeClient(host=resolved[0], port=resolved[1], timeout=POLL_TIMEOUT).send("resume")
    except Exception:  # noqa: BLE001 — best-effort; the next poll retries or the ttl reaps it
        pass


def dispatch_tasks(queue: TaskQueue, state: FleetState, now: float) -> None:
    """One task-queue step per poll cycle. Settle in-flight tasks from OBSERVED presence first,
    then hand each free fleet bot the next queued task. Eligibility is deliberately narrow:
    online + not stalled + running=False + phase IDLE/None — a PAUSED or ERROR leftover that
    the queue did not create is an operator's call, never auto-tasked over."""
    rows = {r["name"]: r for r in state.online_rows() if _is_fleet_bot(r["name"])}

    for t in queue.running():
        bot = t.get("bot") or ""
        row = rows.get(bot)
        if row is None:
            # Client died / logged out mid-task: the work is not provably done → bounded requeue.
            att = int(t.get("attempts") or 0)
            if att >= TASK_MAX_ATTEMPTS:
                queue.mark(t["id"], status="failed", ended_ts=now, note=f"{bot} lost; attempts exhausted")
                print(f"[hub] task {t['id']} FAILED: {bot} offline, attempts exhausted")
            else:
                queue.mark(t["id"], status="queued", bot=None, note=f"requeued: {bot} went offline")
                print(f"[hub] task {t['id']} requeued: {bot} went offline")
            continue
        phase, running = row.get("phase"), bool(row.get("running"))
        started = float(t.get("started_ts") or now)
        # Only the WORKER's mission_status is the truth about a running mission — get_state's
        # phase/running never see the worker. A poll where the mission_status override failed
        # (missionTruth unset) must not settle anything: skipping a cycle is harmless, a false
        # "done" aborts a healthy drill mid-vein (the third queue burn).
        if not row.get("missionTruth"):
            continue
        if phase == "ERROR":
            _abort_mission(bot)
            queue.mark(t["id"], status="failed", ended_ts=now, note="mission ERROR")
            print(f"[hub] task {t['id']} FAILED on {bot}: mission ERROR")
        elif not running:
            queue.mark(t["id"], status="done", ended_ts=now)
            print(f"[hub] task {t['id']} done on {bot}")
        elif phase == "PAUSED":
            if now - started < PAUSE_GRACE_SEC:
                # Too young to be a graceful park — almost certainly a safety pause (human-input
                # latch / reflex divert) that fired at mission start. Resume and keep the task.
                _resume_mission(bot)
                print(f"[hub] task {t['id']} PAUSED early on {bot} — sent resume (grace)")
            else:
                # Graceful end-state (e.g. the drill parks in PAUSED when the depth floor/vein set
                # is exhausted) — count it done and free the bot for the next task.
                _abort_mission(bot)
                queue.mark(t["id"], status="done", ended_ts=now, note="ended PAUSED")
                print(f"[hub] task {t['id']} done on {bot} (ended PAUSED)")
        elif now - started > float(t.get("ttl") or TASK_TTL_DEFAULT):
            _abort_mission(bot)
            queue.mark(t["id"], status="failed", ended_ts=now, note="task ttl exceeded")
            print(f"[hub] task {t['id']} FAILED on {bot}: ttl exceeded")

    busy = {t["bot"] for t in queue.running() if t.get("bot")}
    for name in sorted(rows):
        row = rows[name]
        if (
            name in busy
            or row.get("stalled")
            or not row.get("missionTruth")  # no worker truth this cycle → can't prove the bot is free
            or bool(row.get("running"))
            or row.get("phase") not in (None, "IDLE")
        ):
            continue
        t = queue.next_for(name)
        if t is None:
            continue
        resolved = fleet_registry.resolve(name)
        if resolved is None:
            continue
        att = int(t.get("attempts") or 0) + 1
        try:
            r = BridgeClient(host=resolved[0], port=resolved[1], timeout=POLL_TIMEOUT).send(
                "mission_start", {"name": t["mission"], "params": t["params"]}
            )
            ok = bool(r.get("ok")) and bool((r.get("result") or {}).get("ok"))
            err = None if ok else str(r)[:200]
        except Exception as e:  # noqa: BLE001 — a refused dispatch is data, not a crash
            ok, err = False, f"{type(e).__name__}: {e}"
        if ok:
            queue.mark(t["id"], status="running", bot=name, started_ts=now, attempts=att, note=None)
            busy.add(name)
            print(f"[hub] task {t['id']} → {name}: {t['mission']} {json.dumps(t['params'])}")
        elif att >= TASK_MAX_ATTEMPTS:
            queue.mark(t["id"], status="failed", ended_ts=now, attempts=att, note=f"mission_start rejected: {err}")
            print(f"[hub] task {t['id']} FAILED: mission_start rejected by {name}: {err}")
        else:
            queue.mark(t["id"], attempts=att, note=f"mission_start failed ({err}); will retry")


def _norm_box(b: dict) -> dict:
    """Validate + normalize an XZ box to {minX,maxX,minZ,maxZ} (min<=max). Raises on bad input."""
    vals = {k: float(b[k]) for k in ("minX", "maxX", "minZ", "maxZ")}
    return {
        "minX": min(vals["minX"], vals["maxX"]),
        "maxX": max(vals["minX"], vals["maxX"]),
        "minZ": min(vals["minZ"], vals["maxZ"]),
        "maxZ": max(vals["minZ"], vals["maxZ"]),
    }


def _server_sig(sig: str) -> bool:
    """A world signature that names a real server world ("host|dimension"). LOCAL_/UNKNOWN_
    sigs are single-player or transient identities — never fleet-shared."""
    return "|" in sig and not sig.startswith(("LOCAL_", "UNKNOWN_"))


def collect_fleet_hazards() -> dict[str, list[dict]]:
    """Union every registry instance's RECORDED hazards (host-side read of each bot's own
    mc_world.json — bots have no outbound networking, the hub reads their files), grouped by
    world signature, deduped by (kind,x,z). The push then hands each bot the union for the
    world it is actually in."""
    by_sig: dict[str, dict[tuple, dict]] = {}
    for info in fleet_registry.load().get("bots", []):
        inst = info.get("instanceDir")
        if not inst:
            continue
        path = Path(inst) / WORLD_STORE_REL
        try:
            worlds = (json.loads(path.read_text("utf-8")) or {}).get("worlds", {})
        except (OSError, ValueError):
            continue  # no store yet / mid-write torn read — this cycle just sees fewer hazards
        if not isinstance(worlds, dict):
            continue
        for sig, section in worlds.items():
            if not (isinstance(section, dict) and _server_sig(str(sig))):
                continue
            for h in section.get("hazards") or []:
                if not isinstance(h, dict):
                    continue
                try:
                    x, z = int(h["x"]), int(h["z"])
                except (KeyError, TypeError, ValueError):
                    continue
                kind = str(h.get("kind") or "unknown")
                by_sig.setdefault(str(sig), {})[(kind, x, z)] = {"kind": kind, "x": x, "z": z}
    return {
        sig: sorted(cells.values(), key=lambda c: (c["kind"], c["x"], c["z"]))
        for sig, cells in by_sig.items()
    }


def _is_fleet_bot(name: str) -> bool:
    """Registry rows cover the HUMAN's own client too (port 55544) — it must never receive an
    unsolicited fleet push. Fleet instances are named *_bot_N; a region-claimed bot is pushed
    regardless (an explicit /fleet/assign is opt-in). The naming rule's home is fleet_registry."""
    return fleet_registry.is_bot_instance(name)


NOT_A_FLEET_BOT = ("bot must be a fleet instance: a *_bot_* name, or one listed in "
                   "local.config.json fleetInstances (docs/FLEET_PLAYBOOK.md § 2)")


def _with_dispatch_warning(reply: dict, state: FleetState | None) -> dict:
    """Add `warning` to an enqueue/want reply when no fleet instance is online to take the task.

    Otherwise a one-instance setup (`Monifactory`, the human's client by name) saw its tasks sit
    `queued` forever with no hint why."""
    online = [r["name"] for r in (state.online_rows() if state else [])]
    if any(_is_fleet_bot(n) for n in online):
        return reply
    seen = ", ".join(online) or "none"
    return {**reply, "warning": (
        f"no fleet instance online (online: {seen}) — the task waits in the queue. The queue "
        "dispatches only to *_bot_* instances and those in local.config.json fleetInstances")}


_LAST_PUSH: dict[str, str] = {}  # bot -> canonical JSON of the last payload actually pushed


def push_all_assignments(ledger: ClaimLedger, now: float, state: FleetState | None = None) -> dict:
    """Push each fleet bot its full coordination view via its `assign` bridge command:
    {allowed, forbidden} (the disjoint region set) + claimedVeins (peers' vein leases) +
    hazards (the fleet union for the bot's current dimension). Targets = every region-claimed
    bot (explicit opt-in) + every ONLINE *_bot_* instance (the poll loop calls this each cycle);
    an unchanged payload is skipped, so steady state costs zero bridge calls."""
    regions = ledger.region_claims(now)
    veins = ledger.vein_claims(now)
    hazards_by_sig = collect_fleet_hazards()
    region_by_bot = {c["bot"]: c["box"] for c in regions}
    rows = {r["name"]: r for r in (state.online_rows() if state else [])}

    targets = set(region_by_bot) | {n for n in rows if _is_fleet_bot(n)}
    results: dict = {}
    for bot in sorted(targets):
        dim = (rows.get(bot) or {}).get("dimension")
        hazards: list[dict] = []
        if dim:
            for sig, cells in hazards_by_sig.items():
                if sig.endswith(f"|{dim}"):
                    hazards.extend(cells)
        payload = {
            "allowed": region_by_bot.get(bot),  # None → whole world
            "forbidden": [b for o, b in region_by_bot.items() if o != bot],
            "claimedVeins": [{"x": v["x"], "z": v["z"]} for v in veins if v["bot"] != bot],
            "hazards": hazards,
        }
        canon = json.dumps(payload, sort_keys=True)
        empty = not (payload["allowed"] or payload["forbidden"]
                     or payload["claimedVeins"] or payload["hazards"])
        if _LAST_PUSH.get(bot) == canon or (empty and bot not in _LAST_PUSH):
            continue  # unchanged (or nothing to say and never pushed) — no bridge chatter
        resolved = fleet_registry.resolve(bot)
        if resolved is None:
            results[bot] = {"ok": False, "error": "not in mc-bots.json registry"}
            continue
        host, port = resolved
        try:
            r = BridgeClient(host=host, port=port, timeout=POLL_TIMEOUT).send("assign", payload)
            ok = bool(r.get("ok"))
            if ok:
                _LAST_PUSH[bot] = canon
                print(
                    f"[hub] pushed → {bot}: region={'yes' if payload['allowed'] else 'no'} "
                    f"forbidden={len(payload['forbidden'])} claims={len(payload['claimedVeins'])} "
                    f"hazards={len(hazards)}"
                )
            results[bot] = {"ok": ok, **payload}
        except Exception as e:  # noqa: BLE001 — an offline bot is a normal, surfaced outcome
            results[bot] = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    return results


def _extract_resources(resp: dict) -> list[dict]:
    """markers/prospect responses have shifted shape over time — accept the known carriers."""
    if not isinstance(resp, dict):
        return []
    for key in ("resources", "markers", "veins", "data"):
        val = resp.get(key)
        if isinstance(val, list):
            return [r for r in val if isinstance(r, dict)]
    return []


def _presence(name: str, host: str, port: int) -> tuple[dict, dict | None]:
    """Poll one bot. Always returns a presence row; offline rows carry the error, not an
    exception — one dead bot never breaks the cycle or the fleet view."""
    row: dict = {"name": name, "host": host, "port": port, "online": False}
    try:
        bc = BridgeClient(host=host, port=port, timeout=POLL_TIMEOUT)
        st = bc.get_state()
    except Exception as e:  # noqa: BLE001 — offline/wedged is a normal state, surfaced as data
        row["error"] = f"{type(e).__name__}: {e}"
        return row, None
    row.update(
        online=True,
        phase=st.get("phase"),
        running=bool(st.get("running")),
        position=st.get("position"),
        health=st.get("health"),
        dimension=st.get("dimension"),
        targetOre=st.get("targetOre"),
        tool=st.get("tool"),
        stalled=bool((st.get("worker") or {}).get("stalled")),
    )
    # The mission truth lives in the WORKER (mission_status), not get_state — main.js's get_state
    # only sees the passive modules, so its phase/running read None/False during a live mission.
    # Overriding here is what keeps dispatch_tasks honest (it burned whole queues as "done on
    # first poll" when presence said running=False for a bot mid-DESCEND).
    try:
        ms = bc.send("mission_status")
        # Worker-ack envelope: the structured reply rides under result.data (ctx.reply()).
        res = ms.get("result") if isinstance(ms.get("result"), dict) else {}
        data = res.get("data") if isinstance(res.get("data"), dict) else {}
        if data:
            row["phase"] = data.get("phase")
            row["running"] = bool(data.get("running"))
            row["mission"] = data.get("active")
            # The settle logic may TRUST running=False only when this override actually landed —
            # a timed-out/failed mission_status would otherwise leave get_state's perpetual
            # running=False in the row, and one missed poll falsely "done"-settled a healthy
            # mid-EXCAVATE drill (live, the third queue burn).
            row["missionTruth"] = True
        dr = data.get("drill") if isinstance(data.get("drill"), dict) else None
        vein = dr.get("vein") if dr and isinstance(dr.get("vein"), dict) else None
        if vein is not None and bool(data.get("running")):
            row["drill"] = {"x": int(vein["x"]), "z": int(vein["z"]), "ore": dr.get("ore")}
    except Exception:  # noqa: BLE001 — best-effort observation; no drill info = no vein lease
        pass
    markers = None
    try:
        markers = bc.send("markers")
    except Exception:  # noqa: BLE001 — markers is best-effort enrichment, not required for presence
        pass
    return row, markers


def poll_loop(
    state: FleetState,
    ledger: ClaimLedger,
    tasks: TaskQueue,
    interval: float,
    stop: threading.Event,
) -> None:
    last_online: dict[str, bool] = {}
    while not stop.is_set():
        bots = fleet_registry.load().get("bots", [])
        if not bots:
            print("[hub] mc-bots.json has no bots — run `./gerda sync` first", file=sys.stderr)
        now = time.time()
        online: set[str] = set()
        for info in bots:
            name = info.get("name")
            host = info.get("host", fleet_registry.DEFAULT_HOST)
            port = info.get("port")
            if name is None or port is None:
                continue
            row, markers = _presence(name, host, port)
            state.update(name, row, markers, now)
            if row["online"]:
                online.add(name)
            if last_online.get(name) != row["online"]:
                where = f"{host}:{port}"
                print(f"[hub] {name} {'ONLINE' if row['online'] else 'offline'} ({where})")
                last_online[name] = row["online"]
            # AUTO VEIN-CLAIM (fleet coordination): lease the vein this bot is observed drilling. Same
            # holder re-claiming = renewal; a denied claim (peer already holds it) is fine — the
            # denied bot receives it in claimedVeins and skips it at its next vein selection.
            drill = row.get("drill")
            if drill:
                key = f"vein:{drill['x']},{drill['z']}"
                granted, rec = ledger.claim(name, key, VEIN_CLAIM_TTL, now)
                if granted and rec["granted_ts"] == now:
                    print(f"[hub] vein lease: {key} → {name}")
                ledger.release_prefix(name, "vein:", keep_key=key)  # one vein per drill
            elif row["online"]:
                for k in ledger.release_prefix(name, "vein:"):
                    print(f"[hub] vein lease released (drill idle): {k} (was {name})")
        for d in ledger.sweep(now, online):
            print(f"[hub] claim expired/released: {d['key']} (was {d['bot']})")
        # Re-push the fleet view each cycle — claims/hazards changed above; unchanged payloads
        # are skipped inside, so a steady fleet costs zero bridge calls here.
        push_all_assignments(ledger, now, state)
        # Task queue: settle in-flight tasks from the presence just polled, then hand free
        # fleet bots the next backlog entries ("a free bot picks up the next task itself").
        dispatch_tasks(tasks, state, now)
        stop.wait(interval)


class Handler(BaseHTTPRequestHandler):
    state: FleetState
    ledger: ClaimLedger
    tasks: TaskQueue

    def _send(self, code: int, body: dict) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8")) or {}
        except (ValueError, UnicodeDecodeError):
            return {}

    def do_GET(self) -> None:  # noqa: N802 — http.server API
        route = self.path.split("?", 1)[0].rstrip("/")
        if route in ("/fleet/status", "/fleet"):
            self._send(200, self.state.status())
        elif route == "/fleet/map":
            self._send(200, self.state.fleet_map())
        elif route == "/fleet/claims":
            self._send(200, {"ts": time.time(), "claims": self.ledger.active(time.time())})
        elif route == "/fleet/queue":
            self._send(200, {"ts": time.time(), "tasks": self.tasks.snapshot()})
        elif route in ("/healthz", ""):
            self._send(200, {"ok": True})
        else:
            self._send(404, {"ok": False, "error": f"no route {route}"})

    def do_POST(self) -> None:  # noqa: N802 — http.server API
        route = self.path.split("?", 1)[0].rstrip("/")
        body = self._body()
        bot, key = body.get("bot"), body.get("key")
        if route == "/fleet/claim":
            if not bot or not key:
                return self._send(400, {"ok": False, "error": "claim needs {bot, key, ttl?}"})
            ttl = float(body.get("ttl") or ClaimLedger.DEFAULT_TTL)
            granted, rec = self.ledger.claim(bot, key, ttl, time.time())
            self._send(200 if granted else 409, {"ok": granted, "granted": granted, "claim": rec})
        elif route == "/fleet/release":
            if not bot or not key:
                return self._send(400, {"ok": False, "error": "release needs {bot, key}"})
            self._send(200, {"ok": True, "released": self.ledger.release(bot, key)})
        elif route == "/fleet/enqueue":
            mission = body.get("mission")
            if not mission or not isinstance(mission, str):
                return self._send(400, {"ok": False, "error": "enqueue needs {mission, params?, bot?, ttl?}"})
            params = body.get("params")
            if params is not None and not isinstance(params, dict):
                return self._send(400, {"ok": False, "error": "params must be an object"})
            pin = body.get("bot")
            if pin is not None and not (isinstance(pin, str) and _is_fleet_bot(pin)):
                return self._send(400, {"ok": False, "error": NOT_A_FLEET_BOT})
            try:
                ttl = float(body["ttl"]) if body.get("ttl") is not None else None
            except (TypeError, ValueError):
                return self._send(400, {"ok": False, "error": "ttl must be a number (seconds)"})
            reply = {"ok": True, "task": self.tasks.enqueue(mission, params or {}, pin, ttl)}
            self._send(200, _with_dispatch_warning(reply, self.state))
        elif route == "/fleet/want":
            resource = body.get("resource")
            if not resource or not isinstance(resource, str):
                return self._send(400, {"ok": False, "error": "want needs {resource, bots?, bot?, ttl?}"})
            try:
                n = int(body.get("bots") or 1)
            except (TypeError, ValueError):
                return self._send(400, {"ok": False, "error": "bots must be an integer"})
            if not 1 <= n <= WANT_MAX_BOTS:
                return self._send(400, {"ok": False, "error": f"bots must be 1..{WANT_MAX_BOTS}"})
            pin = body.get("bot")
            if pin is not None and not (isinstance(pin, str) and _is_fleet_bot(pin)):
                return self._send(400, {"ok": False, "error": NOT_A_FLEET_BOT})
            try:
                ttl = float(body["ttl"]) if body.get("ttl") is not None else None
            except (TypeError, ValueError):
                return self._send(400, {"ok": False, "error": "ttl must be a number (seconds)"})
            mission, params = WANT_PRESETS.get(resource.lower(), ("drill", {"ore": resource.lower()}))
            tasks = [self.tasks.enqueue(mission, dict(params), pin, ttl) for _ in range(n)]
            reply = {"ok": True, "resource": resource, "mission": mission, "tasks": tasks}
            self._send(200, _with_dispatch_warning(reply, self.state))
        elif route == "/fleet/cancel":
            tid = body.get("id")
            if not tid:
                return self._send(400, {"ok": False, "error": "cancel needs {id}"})
            was = self.tasks.cancel(str(tid))
            if was is None:
                return self._send(404, {"ok": False, "error": f"no live task {tid}"})
            if was.get("status") == "running" and was.get("bot"):
                _abort_mission(was["bot"])  # free the bot; the task is already cancelled
            self._send(200, {"ok": True, "cancelled": was})
        elif route == "/fleet/assign":
            self._assign(body, bot)
        elif route == "/fleet/unassign":
            if not bot:
                return self._send(400, {"ok": False, "error": "unassign needs {bot}"})
            self.ledger.release(bot, f"region:{bot}")
            try:
                resolved = fleet_registry.resolve(bot)
                if resolved:
                    BridgeClient(host=resolved[0], port=resolved[1], timeout=POLL_TIMEOUT).send(
                        "unassign"
                    )
            except Exception:  # noqa: BLE001 — offline bot; the lease is already dropped
                pass
            self._send(200, {"ok": True, "assignments": push_all_assignments(self.ledger, time.time(), self.state)})
        else:
            self._send(404, {"ok": False, "error": f"no route {route}"})

    def _assign(self, body: dict, bot: str | None) -> None:
        """Record bot↔region as a lease + re-push the whole disjoint set to the live bots."""
        if not bot or not isinstance(body.get("allowed"), dict):
            return self._send(400, {"ok": False, "error": "assign needs {bot, allowed:{minX..maxZ}, ttl?}"})
        try:
            box = _norm_box(body["allowed"])
        except (KeyError, TypeError, ValueError) as e:
            return self._send(400, {"ok": False, "error": f"bad allowed box: {e}"})
        ttl = float(body.get("ttl") or ClaimLedger.DEFAULT_TTL)
        self.ledger.claim(bot, f"region:{bot}", ttl, time.time(), box=box)
        self._send(200, {"ok": True, "assignments": push_all_assignments(self.ledger, time.time(), self.state)})

    def log_message(self, *_args) -> None:  # silence per-request stderr noise
        pass


def main() -> int:
    ap = argparse.ArgumentParser(description="Minecraft fleet coordinator hub")
    ap.add_argument("--http", default="127.0.0.1:8849", help="host:port for the JSON fleet API")
    ap.add_argument("--interval", type=float, default=2.0, help="poll interval seconds")
    args = ap.parse_args()
    host, _, port_s = args.http.rpartition(":")
    bind = (host or "127.0.0.1", int(port_s))

    state = FleetState()
    ledger = ClaimLedger()
    tasks = TaskQueue(fleet_registry.tasks_path())
    Handler.state = state
    Handler.ledger = ledger
    Handler.tasks = tasks
    stop = threading.Event()
    poller = threading.Thread(
        target=poll_loop, args=(state, ledger, tasks, args.interval, stop), daemon=True
    )
    poller.start()

    httpd = ThreadingHTTPServer(bind, Handler)
    print(f"[hub] fleet API on http://{bind[0]}:{bind[1]}  (poll every {args.interval}s)")
    print(f"[hub]   GET  /fleet/status  /fleet/map  /fleet/claims  /fleet/queue  /healthz")
    print(f"[hub]   POST /fleet/claim  /fleet/release  /fleet/assign {{bot,allowed}}  /fleet/unassign")
    print(f"[hub]   POST /fleet/enqueue {{mission,params?,bot?,ttl?}}  /fleet/cancel {{id}}")
    print(f"[hub]   POST /fleet/want {{resource,bots?,bot?,ttl?}}  (ore→drill, wood→chop, food→hunt)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[hub] shutting down")
    finally:
        stop.set()
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
