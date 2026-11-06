"""`ctl status` names a worker that failed to load (or halted on a fatal tick).

A bundle that throws while loading leaves `module: null` and the managed service loaded, so the
old `status` JSON looked healthy; only `get_state` / `diag` carried `worker.fatal`. main.js's
`status` reply now carries `worker: {status, fatal}`, and bridge_ctl turns a `load_failed` /
`fatal` worker into rc 1 plus one stderr line naming the error.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import contextlib
import io
import re
import sys
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "ops"))
import bridge_ctl  # noqa: E402

LOAD_ERR = "loadBundle: Access to host class net.minecraftforge.X is not allowed or does not exist."


class _FakeBridge:
    def __init__(self, resp: dict) -> None:
        self.resp = resp

    def status(self) -> dict:
        return self.resp


def _run(resp: dict) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        rc = bridge_ctl.cmd_status(_FakeBridge(resp), None)  # type: ignore[arg-type]
    return rc, out.getvalue(), err.getvalue()


def _status(worker: dict | None) -> dict:
    resp = {"ok": True, "type": "status", "module": None,
            "service": {"name": "worker", "loaded": True, "running": True}}
    if worker is not None:
        resp["worker"] = worker
    return resp


class CtlStatusWorker(unittest.TestCase):
    def test_load_failure_is_rc1_and_named(self) -> None:
        rc, out, err = _run(_status({"status": "load_failed",
                                     "fatal": {"owner": "worker", "phase": "loadBundle", "error": LOAD_ERR}}))
        self.assertEqual(rc, 1)
        self.assertIn('"load_failed"', out)  # the JSON is still printed whole
        self.assertIn("worker load_failed", err)
        self.assertIn(LOAD_ERR, err)

    def test_fatal_tick_is_rc1(self) -> None:
        rc, _out, err = _run(_status({"status": "fatal", "fatal": {"error": "boom"}}))
        self.assertEqual(rc, 1)
        self.assertIn("worker fatal: boom", err)

    def test_running_worker_is_rc0_and_silent(self) -> None:
        rc, _out, err = _run(_status({"status": "running", "fatal": None}))
        self.assertEqual((rc, err), (0, ""))

    def test_old_main_without_worker_block_is_rc0(self) -> None:
        rc, _out, err = _run(_status(None))
        self.assertEqual((rc, err), (0, ""))

    def test_main_status_reply_carries_the_worker_block(self) -> None:
        src = (REPO / "harness" / "main.js").read_text(encoding="utf-8")
        handler = src[src.index("    status: function (_req, id) {"):]
        handler = handler[:handler.index("\n    },\n")]
        self.assertRegex(handler, r"GV\.getString\(WORKER_FATAL_KEY\)")
        self.assertTrue(re.search(r"worker: \{status: wStatus, fatal: wFatal\}", handler))


if __name__ == "__main__":
    unittest.main()
