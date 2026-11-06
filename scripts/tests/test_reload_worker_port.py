"""`./gerda reload-worker` dials the same bridge as `./gerda ctl`.

It used to default to port 55545 — the first fleet bot on the maintainer's machine. On the one
instance SETUP creates (55544) nothing listened there, so every bare call printed "main.js
dispatch is likely DEAF" while main was healthy. Both tools now resolve the endpoint through
bridge_ctl.resolve_endpoint: --host/--port, else --bot, else MC_BRIDGE_HOST / MC_BRIDGE_PORT,
else 55544. A refused connect says "no bridge at host:port", not DEAF.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import contextlib
import io
import os
import socket
import sys
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "ops"))
import bridge_ctl  # noqa: E402
import reload_worker  # noqa: E402

CLEAN_ENV = {k: v for k, v in os.environ.items() if k not in ("MC_BRIDGE_HOST", "MC_BRIDGE_PORT")}


class _Recorder:
    """Stands in for BridgeClient: records the endpoint, acks the reload."""
    seen: list[tuple[str | None, int]] = []

    def __init__(self, host: str | None = None, port: int = 0, timeout: float = 0) -> None:
        _Recorder.seen.append((host, port))
        self.host, self.port = host or "127.0.0.1", port

    def send(self, _type: str, _payload: dict) -> dict:
        return {"ok": True, "note": "reloading"}


def _dial(argv: list[str], env: dict[str, str]) -> tuple[int, tuple[str | None, int] | None, str]:
    _Recorder.seen = []
    err = io.StringIO()
    with mock.patch.dict(os.environ, env, clear=True), \
            mock.patch.object(reload_worker, "BridgeClient", _Recorder), \
            contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
        rc = reload_worker.main(argv)
    return rc, (_Recorder.seen[0] if _Recorder.seen else None), err.getvalue()


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ReloadWorkerPort(unittest.TestCase):
    def test_bare_call_dials_the_single_instance_port(self) -> None:
        rc, seen, _ = _dial([], CLEAN_ENV)
        self.assertEqual(rc, 0)
        self.assertEqual(seen, (None, 55544))

    def test_env_port_is_honoured(self) -> None:
        _rc, seen, _ = _dial([], {**CLEAN_ENV, "MC_BRIDGE_PORT": "55561", "MC_BRIDGE_HOST": "127.0.0.1"})
        self.assertEqual(seen, ("127.0.0.1", 55561))

    def test_explicit_port_wins_over_env(self) -> None:
        _rc, seen, _ = _dial(["--port", "55570"], {**CLEAN_ENV, "MC_BRIDGE_PORT": "55561"})
        self.assertEqual(seen, (None, 55570))

    def test_bad_env_port_fails_loud(self) -> None:
        rc, seen, err = _dial([], {**CLEAN_ENV, "MC_BRIDGE_PORT": "auto"})
        self.assertEqual((rc, seen), (1, None))
        self.assertIn("MC_BRIDGE_PORT", err)

    def test_ctl_and_reload_worker_resolve_alike(self) -> None:
        for env in (CLEAN_ENV, {**CLEAN_ENV, "MC_BRIDGE_PORT": "55562"}):
            with mock.patch.dict(os.environ, env, clear=True):
                ctl = bridge_ctl.resolve_endpoint(None, None, None)
            _rc, seen, _ = _dial([], env)
            self.assertEqual(ctl, seen)

    def test_nothing_listening_is_not_called_deaf(self) -> None:
        port = _free_port()
        err = io.StringIO()
        with mock.patch.dict(os.environ, CLEAN_ENV, clear=True), contextlib.redirect_stderr(err):
            rc = reload_worker.main(["--host", "127.0.0.1", "--port", str(port), "--timeout", "2"])
        self.assertEqual(rc, 2)
        self.assertIn(f"127.0.0.1:{port}", err.getvalue())
        self.assertNotIn("DEAF", err.getvalue())


if __name__ == "__main__":
    unittest.main()
