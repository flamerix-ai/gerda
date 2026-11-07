#!/usr/bin/env python3
"""navbench.py — navigator benchmarks: the A* and D* Lite planners on identical legs and missions.

Reuses the arena build ops (scripts/dev/arena.py) to construct a known structure, then for each
impl in the spec (`astar`, `dstar`) races point-to-point legs through the live greedy_drive
probe harness (capabilities/nav-probe.ts), reading back NAV_PROBE_DONE {impl,result,ticks,
finalDist}. The probe drives the SAME per-tick cadence production GOTO uses, so the tick count
is an honest wall-clock proxy (20 ticks = 1 s). Reports median ticks + success-rate per leg and
impl side by side; with two impls, the ratio of the second to the first. A spec with a `mission`
field instead runs that whole mission once per impl (ticks from mission_start to the drain).

    python scripts/dev/navbench.py run flat            # one bench
    python scripts/dev/navbench.py run --all           # every bench
    python scripts/dev/navbench.py build flat          # just build the structure (debug)
    python scripts/dev/navbench.py list
    python scripts/dev/navbench.py run flat --port 55545   # a fleet bot (port from mc-bots.json)

Spec (scenarios/bench/<name>.json):
    { name, desc, ops[], start[x,y,z], legs[{name,to[x,y,z]}],
      impls?=["astar"], repeats?=3, timeout?=30, arrival?=null }
`ops` build the structure + kit the bot (same op vocabulary as arena.py — NO `player` op,
the runner tp's to `start` itself before every rep). Build cheats (/fill,/tp) are TEST SETUP
only — never used by mission logic.
"""
from __future__ import annotations

import argparse
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # scripts/ root
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "mcp"))  # mcp/ -> canonical bridge_client
import json  # noqa: E402
import os  # noqa: E402

import fleet_registry  # noqa: E402  (mc-bots.json — port → instance for marker seeding)
from arena import _apply_op, _chat, _quiet, _seed_marker  # noqa: E402
from bridge_client import BridgeClient  # noqa: E402

REPO = Path(__file__).resolve().parents[2]  # repo root (this file lives in scripts/dev/)
BENCH_DIR = REPO / "scenarios" / "bench"

# How long to wait past the leg timeout for the NAV_PROBE_DONE to surface (poll slack).
_POLL_SLACK_S = 6.0
_SETTLE_S = 1.0  # let the server's movement-correction settle after a tp before driving


# ── bot control ──────────────────────────────────────────────────────────────
def _tp(c: BridgeClient, pos: list) -> None:
    _chat(c, f"/tp @s {pos[0] + 0.5} {pos[1]} {pos[2] + 0.5}")


def _alive(c: BridgeClient) -> bool:
    try:
        return float(c.send("get_state", {}).get("health", 0)) > 0
    except Exception:
        return False


def _respawn(c: BridgeClient) -> None:
    """A dead bot freezes position AND drops chat — the headless respawn is the proven
    raw LocalPlayer.respawn (SRG m_7583_) on the render thread."""
    c.send(
        "jeval",
        {"code": "Client.runOnMainThread(JavaWrapper.methodToJava(function(){try{Player.getPlayer().getRaw().m_7583_();}catch(e){}})); 'respawned';"},
    )
    time.sleep(2.0)


def _anchor(c: BridgeClient, start: list, *, tries: int = 4) -> None:
    """Robustly re-anchor the bot STANDING at `start` before a drive — the bench analogue of
    arena.py's `_ensure_bot_ready`, and the fix for the descend/detour/flat base-drift FAIL.

    Each bench's build `clear` fills-AIR a region that CONTAINS the PREVIOUS leg's target — where
    the bot is left standing — so the floor drops out from under the stationary bot MID-BUILD: it
    falls (into the void, in the javd:void test world), often dies, and respawns ~600 blocks away at
    spawn/base. A single fire-and-forget `/tp` + 1 s settle (the old path) then drove from base, and
    greedy_drive timed out crawling toward a target 600 blocks off (the d≈605 FAIL). climb/gap escaped
    it (first leg / disjoint x-range → never cleared out from under). So: respawn if dead, `/tp`, and
    VERIFY the bot actually LANDED at the start (retry up to `tries`) before returning — never drive
    from an unconfirmed position."""
    tx, tz = start[0] + 0.5, start[2] + 0.5
    p: dict = {}
    for _ in range(tries):
        if not _alive(c):
            _respawn(c)
        _tp(c, start)
        time.sleep(_SETTLE_S)  # let the server's movement-correction settle after the tp
        try:
            p = c.send("get_state", {}).get("position") or {}
        except Exception:  # noqa: BLE001 — transient bridge hiccup mid-settle; retry the tp
            continue
        if abs(p.get("x", 1e9) - tx) <= 4 and abs(p.get("z", 1e9) - tz) <= 4:
            return
    print(f"  ⚠ bench anchor: bot not at start {start} after {tries} tp tries (at {p}) — leg may drift")


def _logs_since_boot(c: BridgeClient, n: int = 300) -> list[dict]:
    """Logs since the CURRENT worker boot only (tick resets each boot — a prior-boot tick must
    not pollute a duration). Slice from the last BOOT entry."""
    logs = c.send("get_logs", {"n": n}).get("logs", [])
    last_boot = max((i for i, e in enumerate(logs) if e.get("event") == "BOOT"), default=-1)
    return logs[last_boot + 1 :] if last_boot >= 0 else logs


def _probe_dones(c: BridgeClient, n: int = 80) -> list[dict]:
    logs = c.send("get_logs", {"n": n}).get("logs", [])
    return [e for e in logs if e.get("event") == "NAV_PROBE_DONE"]


def _count_item(c: BridgeClient, item: str) -> int:
    """Whole-inventory total of `item` (ext.js count_item). The honest throughput metric is the
    DELTA of the ore DROP across a drain — what actually landed in the bag — not blocks broken (a
    MINE-transition proxy counts targets aimed at, including a break that dropped nothing into a
    full/blocked slot). 0 on any read error so a transient miss can't read as negative collection."""
    try:
        r = c.send("count_item", {"item": item})
        return int(r.get("data", {}).get("count", 0)) if r.get("ok") else 0
    except Exception:
        return 0


def _same_target(f: dict, to: list) -> bool:
    t = f.get("target", {})
    return t.get("x") == to[0] and t.get("y") == to[1] and t.get("z") == to[2]


def _engine(impl: str) -> str:
    """Map an impl name → the engine NAV_PROBE_DONE actually logs. Baritone is REMOVED and
    the old `set_nav {impl}` command with it — the surviving axis is the greedy executor's PLANNER:
    'astar' (production default) vs 'dstar' (opt-in, forced per-drive via set_dstar). 'greedy' is a
    legacy spec alias for the default engine; 'baritone' has no runtime left and fails loud (a
    silently-skipped impl would fake a clean A/B)."""
    m = {"greedy": "astar", "astar": "astar", "dstar": "dstar"}
    if impl not in m:
        raise SystemExit(f"[navbench] impl '{impl}' is gone (Baritone removed) — use astar/dstar")
    return m[impl]


# ── one race ─────────────────────────────────────────────────────────────────
def race_leg(c: BridgeClient, impl: str, start: list, to: list, arrival, timeout: float) -> dict:
    """Drive `impl` from `start` to `to` once; return {ticks,result,finalDist}.

    Matches the FRESH NAV_PROBE_DONE by (engine, target) AND tick-not-seen-before — the log ring
    keeps stale dones from prior legs/sessions, so freshness is mandatory (learned the hard way)."""
    engine = _engine(impl)
    _anchor(c, start)  # respawn-if-dead + tp + VERIFY landed (the build-clear fall recovery)
    c.send("greedy_drive_stop", {})  # release any held keys from a prior leg
    c.send("set_dstar", {"on": engine == "dstar"})  # engine override; {} form clears (astar default)
    c.send("set_arrival", {"dist": arrival if arrival else 0})
    before = {e.get("tick") for e in _probe_dones(c)}
    c.send("greedy_drive", {"x": to[0], "y": to[1], "z": to[2]})

    deadline = time.time() + timeout + _POLL_SLACK_S
    while time.time() < deadline:
        time.sleep(0.5)
        for e in _probe_dones(c):
            if e.get("tick") in before:
                continue
            f = e.get("fields", {})
            if f.get("impl") == engine and _same_target(f, to):
                return {"ticks": f.get("ticks"), "result": f.get("result"), "finalDist": f.get("finalDist")}
    return {"ticks": None, "result": "no-done", "finalDist": None}


# ── one mission drain (mission-mode A/B) ──────────────────────────────────────
def race_mission(c: BridgeClient, impl: str, spec: dict, timeout: float) -> dict:
    """Run the mission once under `impl`, return {ticks,result,mined}. Measures kernel ticks from
    mission_start to SCAN_EXHAUSTED (full drain). The set_nav override lives in the WORKER, so it
    must be set AFTER halt/start (a fresh boot resets it). Re-builds the ore body each call (the
    prior rep consumed it)."""
    build(c, spec)
    c.send("halt")
    time.sleep(1.0)
    c.send("start")
    time.sleep(2.0)
    if not _alive(c):
        _respawn(c)
    c.send("set_dstar", {"on": _engine(impl) == "dstar"})  # engine override for the WHOLE mission
    # A drill scenario needs its prospector vein seeded AFTER the restart (the drill's init reads the
    # nearest cached vein fresh — a pre-restart seed risks a worker clobber), mirroring arena.py.
    marker = spec.get("marker")
    if marker:
        _seed_marker(c, marker["ore"], int(marker["x"]), int(marker["z"]))
    _anchor(c, spec["start"])  # respawn-if-dead + tp + VERIFY landed (build-clear fall recovery)
    # Baseline = highest kernel tick already logged this boot (mission_start is a few ticks in).
    pre = _logs_since_boot(c)
    baseline = max((e.get("tick", 0) for e in pre), default=0)
    # Ore-collected metric (primary throughput): count the drop item in the bag BEFORE the drain.
    collect = spec.get("collect")
    coll_before = _count_item(c, collect) if collect else None
    m = spec["mission"]
    c.send("mission_start", {"name": m["name"], "params": m.get("params", {})})

    # Completion event is mission-shaped: the mine mission drains to SCAN_EXHAUSTED; the drill mission
    # finishes a vein at VEINS_DEPLETED. A scenario overrides it with "done_event".
    done_event = spec.get("done_event", "SCAN_EXHAUSTED")
    done_tick = None
    erred = False
    deadline = time.time() + timeout
    while time.time() < deadline:
        time.sleep(1.0)
        for e in _logs_since_boot(c):
            ev = e.get("event")
            if ev == "TRANSITION" and e.get("fields", {}).get("to") == "ERROR":
                erred = True
            elif ev == done_event:
                done_tick = e.get("tick")
        if done_tick is not None or erred:
            break

    # PRIMARY metric: ore actually COLLECTED (bag delta), measured BEFORE the halt (a halt may drop
    # held state). Counts what the bot picked up — the honest "room of ore" yield.
    collected = (_count_item(c, collect) - coll_before) if collect and coll_before is not None else None
    # Secondary diagnostic: each entry into MINE = a block targeted (the per-break BREAK event is not
    # reliably logged; MINE transitions are). Useful to spot "broke a lot but collected little".
    mined = len(
        [e for e in _logs_since_boot(c, 800) if e.get("event") == "TRANSITION" and e.get("fields", {}).get("to") == "MINE"]
    )
    c.send("halt")  # stop the miner before the next rep rebuilds
    if done_tick is not None:
        return {"ticks": done_tick - baseline, "result": "drained", "mined": mined, "collected": collected}
    return {"ticks": None, "result": "error" if erred else "timeout", "mined": mined, "collected": collected}


def run_mission(c: BridgeClient, spec: dict) -> dict:
    impls = spec.get("impls", ["astar"])
    repeats = int(spec.get("repeats", 2))
    timeout = float(spec.get("timeout", 220))
    table: dict[str, dict] = {}
    for impl in impls:
        samples = []
        for r in range(repeats):
            res = race_mission(c, impl, spec, timeout)
            samples.append(res)
            print(
                f"  drain {impl:9} #{r + 1}: {res['result']:9} ticks={res['ticks']} "
                f"collected={res['collected']} mined={res['mined']}"
            )
        oks = [s["ticks"] for s in samples if s["result"] == "drained" and s["ticks"] is not None]
        table[impl] = {
            "n": len(samples),
            "drained": len(oks),
            "median": round(statistics.median(oks), 1) if oks else None,
            "mined": [s["mined"] for s in samples],
            "collected": [s["collected"] for s in samples],
        }
    _report_mission(spec, table)
    return table


def _ratio(stats: list[dict]) -> str:
    """Second impl's median over the first's (lower = the second is faster); '' unless exactly two
    impls both finished at least once."""
    if len(stats) != 2 or not stats[0].get("median") or not stats[1].get("median"):
        return ""
    return f"{round(stats[1]['median'] / stats[0]['median'], 2)}x"


def _report_mission(spec: dict, table: dict) -> None:
    print(f"\n=== {spec['name']} — mission drain per impl (ticks to the drain; 20t=1s) ===")
    for impl, t in table.items():
        print(
            f"  {impl:9} median={t['median']} drained={t['drained']}/{t['n']} "
            f"collected={t['collected']} mined={t['mined']}"
        )
    ratio = _ratio(list(table.values()))
    if ratio:
        print(f"  {'/'.join(reversed(list(table)))} = {ratio}")


# ── build ────────────────────────────────────────────────────────────────────
def build(c: BridgeClient, spec: dict) -> None:
    print(f"building '{spec['name']}': {spec.get('desc', '')[:80]}")
    _quiet(c, False)
    try:
        for op in spec.get("ops", []):
            _apply_op(c, op)
    finally:
        _quiet(c, True)
    print(f"  {len(spec.get('ops', []))} ops applied")


# ── run ──────────────────────────────────────────────────────────────────────
def _agg(samples: list[dict]) -> dict:
    oks = [s["ticks"] for s in samples if s["result"] == "arrived" and s["ticks"] is not None]
    return {
        "n": len(samples),
        "arrived": len(oks),
        "median": round(statistics.median(oks), 1) if oks else None,
        "best": min(oks) if oks else None,
        "results": [s["result"] for s in samples],
    }


def run(c: BridgeClient, spec: dict) -> dict:
    if spec.get("mission"):
        return run_mission(c, spec)
    build(c, spec)
    c.send("halt")  # mission-clean; the probe drives from IDLE only
    time.sleep(1.0)
    c.send("start")
    time.sleep(2.0)

    start = spec["start"]
    impls = spec.get("impls", ["astar"])  # Baritone removed; compare vs "dstar" on demand
    repeats = int(spec.get("repeats", 3))
    timeout = float(spec.get("timeout", 30))
    arrival = spec.get("arrival")

    table: dict[str, dict[str, dict]] = {}
    for leg in spec["legs"]:
        name, to = leg["name"], leg["to"]
        table[name] = {}
        for impl in impls:
            samples = []
            for r in range(repeats):
                res = race_leg(c, impl, start, to, arrival, timeout)
                samples.append(res)
                print(f"  {name:10} {impl:9} #{r + 1}: {res['result']:10} ticks={res['ticks']} d={res['finalDist']}")
            table[name][impl] = _agg(samples)
    _report(spec, table)
    return table


def _report(spec: dict, table: dict) -> None:
    print(f"\n=== {spec['name']} — median ticks/arrived per impl (lower=faster; 20t=1s) ===")
    for name, byimpl in table.items():
        cells = "  ".join(f"{impl} {s['median']}/{s['arrived']}of{s['n']}" for impl, s in byimpl.items())
        ratio = _ratio(list(byimpl.values()))
        print(f"  {name:10} {cells}" + (f"  ratio {ratio}" if ratio else ""))


# ── cli ──────────────────────────────────────────────────────────────────────
def _load(name: str) -> dict:
    path = BENCH_DIR / f"{name}.json"
    if not path.exists():
        sys.exit(f"no bench '{name}' at {path}")
    spec = json.loads(path.read_text("utf-8"))
    spec.setdefault("name", name)
    return spec


def _all_names() -> list[str]:
    return sorted(p.stem for p in BENCH_DIR.glob("*.json")) if BENCH_DIR.exists() else []


def _client(port: int | None) -> BridgeClient:
    """The bench's bridge: the default one (BridgeClient's port, 55544), or with `--port` that
    fleet bot's — plus its OWN world store for a mission bench's marker seeding, as gate_live.py
    does (arena.py otherwise seeds the main instance's store, which that bot never reads)."""
    if port is None:
        return BridgeClient()
    try:
        game_dir = fleet_registry.game_dir_for_port(port)
    except fleet_registry.RegistryUnreadable as e:
        sys.exit(f"[bench] can't locate port {port}'s world store: {e}")
    if game_dir is None:
        sys.exit(f"[bench] port {port} not in mc-bots.json — can't locate its world store")
    os.environ["MC_INST"] = str(game_dir)
    print(f"[bench] world store → {game_dir}")
    return BridgeClient(port=port)


def main() -> None:
    ap = argparse.ArgumentParser(description="Navigator benchmarks: A* (D* Lite on demand), leg + mission")
    ap.add_argument("cmd", choices=["build", "run", "list"])
    ap.add_argument("name", nargs="?")
    ap.add_argument("--all", action="store_true")
    ap.add_argument(
        "--port", type=int, default=None, help="bridge port of the test bot (default 55544; fleet bots: mc-bots.json)"
    )
    args = ap.parse_args()

    if args.cmd == "list":
        for n in _all_names():
            print(f"  {n:14} {_load(n).get('desc', '')[:70]}")
        return

    c = _client(args.port)
    names = _all_names() if args.all else ([args.name] if args.name else [])
    if not names:
        sys.exit("need a bench name (or --all)")

    for n in names:
        spec = _load(n)
        if args.cmd == "build":
            build(c, spec)
        elif args.cmd == "run":
            run(c, spec)


if __name__ == "__main__":
    main()
