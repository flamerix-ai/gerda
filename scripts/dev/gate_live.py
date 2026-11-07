#!/usr/bin/env python3
"""gate_live.py — the LOCAL pre-merge live-behavior gate.

GitHub Actions can't boot Minecraft, so the in-game behaviors (nav, mining, drill,
bridge, parkour) have NO headless CI coverage — only the mock-runtime vitest suite.
This is the manual gate you run on `dev` before merging a nav/mission change: it
build+runs the declarative test arenas (scenarios/arenas/*.json) against a CONNECTED
bot and rolls every PASS/FAIL up into ONE exit code, so a regression in live
behavior fails loudly instead of shipping.

    python scripts/dev/gate_live.py                    # FULL gate: every asserting arena + leg benches
    python scripts/dev/gate_live.py --quick            # the curated 5-arena core, no benches
    python scripts/dev/gate_live.py mine-vein drill-vein   # a named subset (no benches)
    python scripts/dev/gate_live.py --bench-only       # just the navigator leg benches
    python scripts/dev/gate_live.py --list             # list arenas/benches + gate status, exit
    just gate-live                                 # the recipe wrapper (full gate)

Exit codes: 0 = every selected arena PASSED · 1 = one or more FAILED · 2 = preflight
failed (no bot reachable on the bridge).

⚠ OP-SESSION ONLY. Arena BUILD ops use /fill /give /tp, which the server rejects for
NON-OP clients — production fleet bots are non-op, so the gate only works against an
OPPED test bot in an OP session (op the bot, run the gate, DE-OP after). It is NOT a
headless job. And the default bridge (port 55544) may
be your OWN client — the preflight prints the connected player so you can confirm it's
the test BOT before it reshapes the world around it.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # scripts/ root
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "mcp"))  # mcp/ -> canonical bridge_client
import fleet_registry  # noqa: E402  (mc-bots.json path SSOT — shared across worktrees)
import navbench  # noqa: E402
from arena import SET_PREFIX, _all_names, _load, _reset_worker, asserts, clean, run  # noqa: E402
from bridge_client import BridgeClient  # noqa: E402

REPO = Path(__file__).resolve().parents[2]  # repo root (this file lives in scripts/dev/)
BENCH_DIR = REPO / "scenarios" / "bench"


# The quick regression core: nav + mine + drill + bridge + the sustain loop (--quick). The FULL
# gate (default) is DERIVED, not curated: every arena whose spec asserts (non-empty expect.events,
# or `checks`) is in — a new asserting arena joins the gate automatically. Build-only fixtures like
# bridge-engine / parkour-gap2 / mine-down stay excluded either way (they'd PASS trivially and mean
# nothing as a gate); the greedy movement sub-machines are gated by the LEG benches instead (every
# scenarios/bench spec with legs, greedy-only, PASS = arrived — the A/B ratios were the Baritone-
# removal gate and died with Baritone). NOTE: arenas build at FIXED world coords and can kill the
# bot if they land on live terrain — run the gate in a CLEAN/flat OP test area, not the production
# base (docs/TESTING.md).
CORE = [
    "goto-travel",  # nav travel → GOTO_ARRIVED
    "mine-vein",  # surface vein mine → ORE_FOUND (mined the seeded cluster, no ERROR)
    "drill-vein",  # drill happy path → DRILL_VEIN_REACHED (reached+mined the seeded vein, no ERROR)
    "drill-gap-vein",  # EXCAVATE over a void → DRILL_VEIN_REACHED + EXCAVATE_VOID_SKIP (skips the pit, no thrash)
    "sustain-cycle",  # the mine→base→smelt economy loop → ORE_FOUND, GOTO_ARRIVED, SMELT_LOADED
]


def _asserting_names() -> list[str]:
    """Every arena that ASSERTS behavior (expect.events or checks) — the full gate set."""
    return [n for n in _all_names() if asserts(_load(n))]


def _bench_names() -> list[str]:
    """Every LEG bench (point-to-point movement aspects). Mission benches (drill-throughput,
    ore-room) are throughput measures, not pass/fail behavior — the drill arenas gate that."""
    out = []
    for p in sorted(BENCH_DIR.glob("*.json")):
        spec = json.loads(p.read_text("utf-8"))
        if spec.get("legs") and not spec.get("mission"):
            out.append(p.stem)
    return out


def _gate_bench(c: BridgeClient, names: list[str]) -> dict[str, bool]:
    """Reliability-gate the greedy navigator on each leg bench: build the structure, drive every
    leg once (one retry — live physics is noisy; a retried pass is printed as such, never silent),
    PASS = greedy ARRIVED on every leg. Uses arena's off-thread _reset_worker for the IDLE-clean
    worker (navbench.run's bare `halt` blocks main.js's Tick and can leave the whole bridge deaf)."""
    results: dict[str, bool] = {}
    for n in names:
        spec = json.loads((BENCH_DIR / f"{n}.json").read_text("utf-8"))
        spec.setdefault("name", n)  # navbench's own loader injects this from the filename
        print(f"── bench:{n} ──")
        ok = True
        try:
            navbench.build(c, spec)
            _reset_worker(c)  # probe drives from IDLE only; off-thread reload, never bare halt
            timeout = float(spec.get("timeout", 30))
            arrival = spec.get("arrival")
            for leg in spec["legs"]:
                res = navbench.race_leg(c, "greedy", spec["start"], leg["to"], arrival, timeout)
                note = ""
                if res["result"] != "arrived":  # one retry, loudly
                    retry = navbench.race_leg(c, "greedy", spec["start"], leg["to"], arrival, timeout)
                    note = f" (first try: {res['result']}, retried)"
                    res = retry
                leg_ok = res["result"] == "arrived"
                ok = ok and leg_ok
                mark = "ok" if leg_ok else "FAIL"
                print(
                    f"  [{mark}] {leg['name']:10} {res['result']:10} ticks={res['ticks']} d={res['finalDist']}{note}"
                )
        except Exception as e:  # noqa: BLE001 — a crashed bench is a FAIL, not a gate abort
            print(f"  [FAIL] bench:{n} raised: {e}")
            ok = False
        results[f"bench:{n}"] = ok
        print()
    return results


def _player_name(c: BridgeClient) -> str | None:
    """Best-effort: who is the connected client? (sandboxed eval has Player.) Used only to
    print a confirm-it's-the-bot line in the preflight — a read failure is non-fatal."""
    try:
        r = c.send(
            "eval",
            {"code": "Player.getPlayer() ? Player.getPlayer().getName().getString() : null"},
        )
        if r.get("ok"):
            return r.get("data")
    except Exception:  # noqa: BLE001 — best-effort identity read, never blocks the gate
        pass
    return None


def _preflight_fail(msg: str) -> None:
    """Preflight failures exit 2 — a distinct code from an arena FAIL (1), so a caller can tell
    'no bot connected' apart from 'a behavior regressed'."""
    print(f"[gate] preflight FAILED — {msg}", file=sys.stderr)
    raise SystemExit(2)


def _preflight(c: BridgeClient) -> None:
    """Confirm a bot is reachable before we start reshaping the world. Exit 2 if not."""
    try:
        st = c.status()
    except Exception as e:  # noqa: BLE001
        _preflight_fail(f"no bot on the bridge ({c.host}:{c.port}): {e}")
        return
    if not st.get("ok", True):
        _preflight_fail(f"bridge error: {st}")
        return
    who = _player_name(c)
    print(f"[gate] bridge {c.host}:{c.port} reachable · connected player: {who or '(unknown)'}")
    print("[gate] ⚠ confirm this is the TEST BOT (not your own client) before it builds arenas.")


def _park_bot(c: BridgeClient) -> None:
    """Leave the TEST BOT sane after the gate: fresh IDLE worker + off the arena site. Without this
    the last arena ends with the worker paused at the wreck and clean() yanks the blocks from under
    it — the bot is left hovering in cleared airspace with a frozen kernel (the post-gate 'jumping
    bot'). Teleport must be a legal non-op FTB command (never /tp — bots must earn
    moves). /home base is preferred: /spawn drops the bot from height over the spawn point and has
    KILLED one ("fell from a high place") — it stays only as the fallback for a test
    bot that has no home set."""
    print("[gate] parking the bot: fresh worker + /home base (fallback /spawn) off the arena site")
    try:
        _reset_worker(c)
    except Exception as e:  # noqa: BLE001 — parking is best-effort, the gate verdict stands
        print(f"[gate] ⚠ park: worker reset failed: {e}")
    try:
        def _pos() -> tuple | None:
            st = c.get_state()
            p = st.get("position") if isinstance(st, dict) else None
            return (p.get("x"), p.get("y"), p.get("z")) if isinstance(p, dict) else None

        before = _pos()
        c.send("chat", {"message": "/home base"})
        time.sleep(3.0)  # FTB teleport lands async; give it a beat
        # No chat feedback channel here, so detect the "Unknown destination!" no-op by position:
        # only a bot that did NOT move gets the /spawn fallback (sending it after a successful
        # /home base would drop the bot from height over the spawn point — the /spawn kill).
        if before is not None and _pos() == before:
            c.send("chat", {"message": "/spawn"})
            time.sleep(3.0)
    except Exception as e:  # noqa: BLE001
        print(f"[gate] ⚠ park: teleport failed: {e}")


def main() -> None:
    ap = argparse.ArgumentParser(description="local pre-merge live-behavior gate (in-game arenas)")
    ap.add_argument(
        "arenas", nargs="*", help="arena names to gate on (default: every asserting arena + leg benches)"
    )
    ap.add_argument(
        "--all", action="store_true", help="alias for the default full gate (kept for muscle memory)"
    )
    ap.add_argument("--quick", action="store_true", help="the curated 5-arena core, no benches")
    ap.add_argument("--no-bench", action="store_true", help="skip the navigator leg benches")
    ap.add_argument("--bench-only", action="store_true", help="run ONLY the navigator leg benches")
    ap.add_argument("--list", action="store_true", help="list available arenas + benches and exit")
    ap.add_argument(
        "--port", type=int, default=None, help="bridge port of the test bot (default 55544; fleet bots: mc-bots.json)"
    )
    args = ap.parse_args()

    asserting = _asserting_names()
    if args.list:
        for n in _all_names():
            tag = "core" if n in CORE else ("gated" if n in asserting else "build-only")
            if _load(n).get("known_bad"):
                tag += " (known-bad: its wrong checks must be refused)"
            print(f"  {n:16} {tag}")
        for n in _bench_names():
            print(f"  bench:{n:10} gated")
        return

    bench = not (args.no_bench or args.quick)
    if args.bench_only:
        names, bench = [], True
    elif args.arenas:
        names, bench = args.arenas, False  # a named subset gates exactly what you asked for
    elif args.quick:
        names = CORE
    else:  # default (and --all): the FULL gate
        names = asserting
    # A film SET is staging, not a test: it has no mission and no expect, so gating one would
    # "PASS" on a build with nothing asserted — and it would reshape a shoot location mid-gate.
    # Rejected by NAME here, explicitly, rather than relying on it merely being absent from
    # _all_names() (docs/RIG.md § Sets).
    strays = [n for n in names if n.startswith(SET_PREFIX)]
    if strays:
        sys.exit(
            f"[gate] {', '.join(strays)}: film sets are staging only and are never gated — "
            "build them with `arena.py build sets/<name>` (docs/RIG.md § Sets)"
        )
    missing = [n for n in names if n not in _all_names()]
    if missing:
        sys.exit(f"[gate] unknown arena(s): {', '.join(missing)} (see --list)")

    c = BridgeClient(port=args.port) if args.port else BridgeClient()
    _preflight(c)

    # Point the arena's host-side marker seeding (_world_store_path) at THIS bot's own instance, so a
    # fleet bot's drill reads the store the seed actually landed in (arena.py defaults to the main
    # Monifactory instance). MC_INST is read at seed time, so setting it here is enough.
    if args.port:
        try:
            inst = fleet_registry.game_dir_for_port(args.port)
        except fleet_registry.RegistryUnreadable as e:
            _preflight_fail(f"can't locate port {args.port}'s world store: {e}")
        if inst is None:
            _preflight_fail(f"port {args.port} not in mc-bots.json — can't locate its world store")
        os.environ["MC_INST"] = str(inst)
        print(f"[gate] world store → {inst}")
    bench_names = _bench_names() if bench else []
    plan = ", ".join(names + [f"bench:{b}" for b in bench_names])
    print(f"[gate] running {len(names)} arena(s) + {len(bench_names)} bench(es): {plan}\n")

    results, not_run, aborted = _gate_arenas(c, names)
    if aborted:
        # Branch on the abort itself, not on the not-run list: when the LAST arena's clean()
        # fails nothing is left in it, yet the bridge is just as dead for the benches and the park.
        not_run += [f"bench:{b}" for b in bench_names]
    else:
        if bench_names:
            results.update(_gate_bench(c, bench_names))
        _park_bot(c)  # never leave the bot paused/hovering over the cleared arena site

    print("=== gate summary ===")
    for n, ok in results.items():
        print(f"  {'PASS' if ok else 'FAIL'}  {n}")
    for n in not_run:
        print(f"  ----  {n} (not run)")
    passed = sum(results.values())
    print(f"[gate] {passed}/{len(results)} passed" + (f", {len(not_run)} not run" if not_run else ""))
    if aborted:
        sys.exit(2)  # the bridge stopped answering: no verdict for the rest, like "no bot"
    sys.exit(0 if results and all(results.values()) else 1)


def _gate_arenas(c: BridgeClient, names: list[str]) -> tuple[dict[str, bool], list[str], bool]:
    """Build, run and clean each arena; returns (verdicts, arenas not run, aborted).

    A crashed arena is a FAIL and the gate goes on. A clean() that raises is different: clean is
    a plain chain of chat commands, so when it fails the bridge has stopped answering (a dead or
    starved client). The gate then stops with the rest listed as not run, instead of dying with a
    traceback (or running every later arena against a dead client). `aborted` says so on its
    own: after the last arena the not-run list is empty, and the caller must still stop.
    """
    results: dict[str, bool] = {}
    for i, n in enumerate(names):
        spec = _load(n)
        print(f"── {n} ──")
        try:
            # run() builds internally — an extra build() here would double the window where a
            # `clear` op yanks the floor out from under the bot (the cross-arena fall/death flake).
            results[n] = run(c, spec)
        except Exception as e:  # noqa: BLE001 — a crashed arena is a FAIL, not a gate abort
            print(f"  [FAIL] {n} raised: {e}")
            results[n] = False
        try:
            clean(c, spec)  # leave the world as we found it, pass or fail
        except Exception as e:  # noqa: BLE001 — reported, then the gate stops
            print(f"  [ABORT] clean after {n} failed: {e}")
            print("  the bridge stopped answering; check the client (latest.log), then re-run the rest")
            return results, list(names[i + 1 :]), True
        print()
    return results, [], False


if __name__ == "__main__":
    main()
