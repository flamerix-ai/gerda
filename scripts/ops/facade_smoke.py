#!/usr/bin/env python3
"""facade_smoke.py — live smoke test of the bot's Runtime facade.

The kernel's facade methods that touch raw Java (player sensors via getRaw()+SRG
calls, interact.eat/respawn via Client.runOnMainThread) can pass the mock unit
tests AND `bun run check` yet still FAIL in-game — a wrong SRG name, or a closure
created on the worker thread that the render thread won't run. The mock can't catch
that: it never executes the real Java.

This drives the worker's `smoke` command (capabilities/diagnostics.ts), which runs
those probes in the real worker context and logs one SMOKE record per check plus a
SMOKE_DONE summary. We read them back over the bridge and print a table, exiting
non-zero if any check failed — so a broken facade method is caught here, not in combat.

  scripts/ops/facade_smoke.py             # safe, read-only probes
  scripts/ops/facade_smoke.py --eat       # also dispatch one real bite + verify food rose
  scripts/ops/facade_smoke.py --json      # machine-readable

Loopback bridge (127.0.0.1:55544) is auto-probed; no --host needed.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1]  # scripts/ root (this file lives in scripts/ops/)
sys.path.insert(0, str(SCRIPT_DIR))
sys.path.insert(0, str(SCRIPT_DIR.parent / "mcp"))  # mcp/ -> canonical bridge_client
from bridge_client import BridgeClient


def _records(bc: BridgeClient, n: int = 120) -> list[dict]:
    """Recent NDJSON journal records (each {tick, level, event, fields?})."""
    resp = bc.get_logs(n=n)
    data = resp.get("data", resp)
    lines = data.get("logs", data) if isinstance(data, dict) else data
    out: list[dict] = []
    for ln in lines or []:
        if isinstance(ln, dict):
            out.append(ln)
        elif isinstance(ln, str):
            try:
                out.append(json.loads(ln))
            except json.JSONDecodeError:
                pass
    return out


def _latest_smoke_batch(recs: list[dict]) -> tuple[list[dict], dict | None, dict | None]:
    """SMOKE records + the SMOKE_DONE + SMOKE_EAT from the most recent run. All records
    of one `smoke` command share a tickCount (no tick advances inside a command), so the
    last SMOKE_DONE's tick keys the batch."""
    dones = [r for r in recs if r.get("event") == "SMOKE_DONE"]
    if not dones:
        return [], None, None
    done = dones[-1]
    tick = done.get("tick")
    batch = [r for r in recs if r.get("event") == "SMOKE" and r.get("tick") == tick]
    eats = [r for r in recs if r.get("event") == "SMOKE_EAT" and r.get("tick") == tick]
    return batch, done, (eats[-1] if eats else None)


def _food_from_batch(batch: list[dict]) -> float | None:
    for r in batch:
        f = r.get("fields", {})
        if f.get("check") == "player.food" and f.get("ok"):
            try:
                return float(f.get("detail"))
            except (TypeError, ValueError):
                return None
    return None


def run(bc: BridgeClient, eat: bool, as_json: bool) -> int:
    ack = bc.send("smoke", {"eat": True} if eat else None)
    if not ack.get("ok", True):
        print(f"smoke command not acked: {ack}", file=sys.stderr)
        return 2
    time.sleep(0.4)  # let the worker flush the SMOKE records to the journal
    batch, done, eat_rec = _latest_smoke_batch(_records(bc))
    if done is None:
        print("no SMOKE_DONE in the journal — is the bot worker running?", file=sys.stderr)
        return 2

    checks = sorted(
        ({"check": r["fields"]["check"], "ok": r["fields"]["ok"], "detail": r["fields"]["detail"]} for r in batch),
        key=lambda c: c["check"],
    )
    result: dict = {"checks": checks, "summary": done.get("fields", {})}

    # Effect verification for the opt-in destructive bite: poll until food rises (a
    # dispatched-but-ineffective eat — the exact bug we hit — fails HERE, not in combat).
    if eat and eat_rec is not None:
        before = eat_rec.get("fields", {}).get("foodBefore", -1)
        after = before
        for _ in range(10):
            time.sleep(0.3)
            bc.send("smoke")  # re-probe to log a fresh player.food reading
            time.sleep(0.3)
            b2, _, _ = _latest_smoke_batch(_records(bc))
            f = _food_from_batch(b2)
            if f is not None:
                after = f
                if after > before:
                    break
        eat_ok = after > before or before >= 20
        result["eat"] = {"foodBefore": before, "foodAfter": after, "effective": eat_ok}

    if as_json:
        print(json.dumps(result, indent=2, ensure_ascii=False))
    else:
        for c in checks:
            mark = "PASS" if c["ok"] else "FAIL"
            print(f"  {mark}  {c['check']:<26} {c['detail']}")
        s = result["summary"]
        print(f"  ---- {s.get('pass', '?')}/{s.get('total', '?')} passed, {s.get('fail', '?')} failed ----")
        if "eat" in result:
            e = result["eat"]
            mark = "PASS" if e["effective"] else "FAIL"
            print(f"  {mark}  interact.eat (effect)      food {e['foodBefore']} -> {e['foodAfter']}")

    failed = int(result["summary"].get("fail", 0))
    if "eat" in result and not result["eat"]["effective"]:
        failed += 1
    return 1 if failed else 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Live Runtime-facade smoke test over the bridge")
    ap.add_argument("--eat", action="store_true", help="also dispatch one real bite + verify food rose (destructive)")
    ap.add_argument("--json", action="store_true", help="machine-readable output")
    ap.add_argument("--host", help="bridge host (default: loopback auto-probe)")
    ap.add_argument("--port", type=int, default=55544)
    args = ap.parse_args()
    bc = BridgeClient(host=args.host, port=args.port)
    return run(bc, args.eat, args.json)


if __name__ == "__main__":
    sys.exit(main())
