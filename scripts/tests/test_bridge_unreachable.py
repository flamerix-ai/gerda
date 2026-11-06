"""No bridge listening: every caller says so in ONE line that names what it dialled.

A newcomer's first command is `./gerda ctl ping` — usually before the game, jsMacros or the
services are up. It used to end in a raw Python traceback (`TimeoutError: timed out`), the `auto`
host hid the useful fact (nothing on loopback) behind a timeout from the LAN gateway, `ctl`
ignored the MC_BRIDGE_HOST the MCP server reads, and the MCP tools reported the failure as a
SUCCESSFUL call with `{"ok": false}` inside.

Pinned here: BridgeClient.send raises BridgeUnreachable naming host:port and the hint, for a
refused connect AND for a bridge that accepts but never replies; an auto-resolved fallback host
also names the loopback refusal; bridge_ctl turns that into one stderr line, rc 2, no traceback,
and dials the MC_BRIDGE_HOST it is given (127.0.0.2 — a different loopback address, so a
hard-coded 127.0.0.1 fails); mc_ping / mc_get_state / mc_send raise ToolError (isError: true).
The last is pinned on the source's AST (fastmcp is not in the stdlib gate) and, where fastmcp
is importable, live.

Every socket is an ephemeral loopback port; 192.0.2.1 (RFC 5737 TEST-NET-1) is the only other
address, used as a never-dialled auto guess. Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import ast
import asyncio
import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "mcp"))
import bridge_client  # noqa: E402
from bridge_client import NO_BRIDGE_HINT, BridgeClient, BridgeUnreachable  # noqa: E402

try:  # BridgeSilent / SILENT_HINT arrived with the deaf-lock fix; absent = the tests fail, not crash
    from bridge_client import SILENT_HINT, BridgeSilent  # noqa: E402
except ImportError:
    SILENT_HINT, BridgeSilent = "<BridgeSilent missing>", type("BridgeSilent", (Exception,), {})

HOST = "127.0.0.1"


def closed_port(host: str = HOST) -> tuple[socket.socket, int]:
    """Bound but not listening: connects are refused, and the port stays reserved."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind((host, 0))
    return s, s.getsockname()[1]


class SendTests(unittest.TestCase):
    def test_a_refused_connect_names_host_port_and_the_hint(self) -> None:
        sock, port = closed_port()
        self.addCleanup(sock.close)
        with self.assertRaises(BridgeUnreachable) as cm:
            BridgeClient(host=HOST, port=port, timeout=1.0).send("ping")
        msg = str(cm.exception)
        self.assertIn(f"no bridge at {HOST}:{port}", msg)
        self.assertIn(NO_BRIDGE_HINT, msg)
        self.assertNotIn("refused first", msg)  # explicit host: no auto story to tell
        self.assertIsInstance(cm.exception, OSError)  # existing `except OSError` paths still hold

    def test_a_silent_bridge_is_named_too(self) -> None:
        # Accepts the connection, never replies (the port is open from the title screen on).
        port = silent_port(self)
        with self.assertRaises(BridgeUnreachable) as cm:
            BridgeClient(host=HOST, port=port, timeout=0.3).send("ping")
        self.assertIn(f"bridge {HOST}:{port} accepted but did not reply", str(cm.exception))
        self.assertIn(SILENT_HINT, str(cm.exception))

    def test_a_silent_bridge_is_still_a_TimeoutError(self) -> None:
        # The deaf-lock guards (reload_worker.py, arena._reset_worker) catch TimeoutError: a
        # recv timeout means main.js is deaf, and a blind halt/start retry wedges it harder. A
        # silent bridge raised as a plain ConnectionError would skip those guards.
        port = silent_port(self)
        with self.assertRaises(BridgeSilent) as cm:
            BridgeClient(host=HOST, port=port, timeout=0.3).send("ping")
        self.assertIsInstance(cm.exception, TimeoutError)
        self.assertIsInstance(cm.exception, BridgeUnreachable)


    def test_an_auto_fallback_reports_the_loopback_refusal(self) -> None:
        # The constructor's auto guess, injected by hand (the real _resolve_host would dial this
        # machine's gateway): loopback found nothing, so the gateway was tried — and the message
        # must still say loopback refused, not only the gateway's failure.
        sock, port = closed_port()
        self.addCleanup(sock.close)
        with mock.patch.object(bridge_client, "_resolve_host", return_value="192.0.2.1"):
            bc = BridgeClient(port=port, timeout=0.2)
        with self.assertRaises(BridgeUnreachable) as cm:
            bc.send("ping")
        msg = str(cm.exception)
        self.assertIn(f"192.0.2.1:{port}", msg)
        self.assertIn(f"{HOST}:{port} refused first", msg)
        self.assertIn("MC_BRIDGE_HOST", msg)

    def test_only_an_auto_host_off_loopback_tells_the_refusal_story(self) -> None:
        # The known-good sides: an auto host that IS loopback, and an explicit non-loopback host,
        # never claim "loopback refused first".
        sock, port = closed_port()
        self.addCleanup(sock.close)
        with mock.patch.object(bridge_client, "_resolve_host", return_value=HOST):
            auto_loopback = BridgeClient(port=port, timeout=0.2)
        for bc in (auto_loopback, BridgeClient(host="192.0.2.1", port=port, timeout=0.2)):
            with self.subTest(host=bc.host, explicit=bc._host_explicit):
                with self.assertRaises(BridgeUnreachable) as cm:
                    bc.send("ping")
                self.assertNotIn("refused first", str(cm.exception))


def silent_port(case: unittest.TestCase) -> int:
    """Listening, never accepting or replying: connects succeed (backlog), recv times out."""
    srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    srv.bind((HOST, 0))
    srv.listen(8)
    case.addCleanup(srv.close)
    return srv.getsockname()[1]


class DeafGuardTests(unittest.TestCase):
    """Each caller that catches TimeoutError for the deaf-lock still lands in its guard."""

    def test_reload_worker_reports_deaf_rc2(self) -> None:
        port = silent_port(self)
        res = subprocess.run(
            [sys.executable, str(REPO / "scripts" / "ops" / "reload_worker.py"), "--host", HOST,
             "--port", str(port), "--timeout", "0.3"],
            capture_output=True, text=True, timeout=30)
        self.assertEqual(res.returncode, 2, res.stderr)
        self.assertIn("likely DEAF", res.stderr)
        self.assertNotIn("Traceback", res.stderr)

    def test_arena_reset_worker_raises_the_deaf_error(self) -> None:
        sys.path.insert(0, str(REPO / "scripts" / "dev"))
        import arena  # noqa: PLC0415

        port = silent_port(self)
        with self.assertRaises(RuntimeError) as cm:
            arena._reset_worker(BridgeClient(host=HOST, port=port, timeout=0.3), delay_ms=0,
                                timeout=0.1)
        self.assertIn("bridge is deaf", str(cm.exception))


class BridgeCtlTests(unittest.TestCase):
    def run_ctl(self, port: int | None, host_env: str, *argv: str,
                extra_env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
        env = {**os.environ, "MC_BRIDGE_HOST": host_env, **(extra_env or {})}
        port_args = ["--port", str(port)] if port is not None else []
        return subprocess.run(
            [sys.executable, str(REPO / "scripts" / "ops" / "bridge_ctl.py"), *port_args,
             "--timeout", "1", *(argv or ("ping",))],
            capture_output=True, text=True, env=env, timeout=30)

    def test_a_silent_bridge_is_one_line_with_the_deaf_hint(self) -> None:
        port = silent_port(self)
        res = self.run_ctl(port, HOST)
        self.assertEqual(res.returncode, 2, res.stderr)
        self.assertEqual(len(res.stderr.strip().splitlines()), 1, res.stderr)
        self.assertEqual(res.stderr.count(f"{HOST}:{port}"), 1, res.stderr)  # not double-prefixed
        self.assertIn(SILENT_HINT, res.stderr)

    def test_a_local_OSError_is_not_called_a_bridge_failure(self) -> None:
        # `load <dir>`: the path exists, reading it fails locally (IsADirectoryError) — that is
        # the caller's mistake, not a missing bridge, and must not send them to check the game.
        sock, port = closed_port()
        self.addCleanup(sock.close)
        res = self.run_ctl(port, HOST, "load", str(REPO / "scripts"))
        self.assertEqual(res.returncode, 1, res.stderr)
        self.assertIn("Is a directory", res.stderr)
        self.assertNotIn(NO_BRIDGE_HINT, res.stderr)
        self.assertNotIn("Traceback", res.stderr)

    def test_load_code_too_long_for_a_path_is_sent_as_code(self) -> None:
        # Path(code).exists() raises ENAMETOOLONG on a long code string; that is code, not a file.
        sock, port = closed_port()
        self.addCleanup(sock.close)
        res = self.run_ctl(port, HOST, "load", "x" * 5000)
        self.assertEqual(res.returncode, 2, res.stderr)
        self.assertIn(f"no bridge at {HOST}:{port}", res.stderr)
        self.assertNotIn("File name too long", res.stderr)

    def test_bot_registry_host_beats_MC_BRIDGE_HOST(self) -> None:
        # `--bot` names ONE registry endpoint; the global env must not redirect it (mcp/server.py
        # applies the env only to the target-less client, too).
        try:
            sock, port = closed_port("127.0.0.2")
        except OSError:
            self.skipTest("127.0.0.2 not bindable on this host")
        self.addCleanup(sock.close)
        reg = Path(self.enterContext(tempfile.TemporaryDirectory())) / "mc-bots.json"
        reg.write_text(json.dumps({"version": 1, "bots": [
            {"name": "b1", "host": "127.0.0.2", "port": port}]}), "utf-8")
        res = self.run_ctl(None, HOST, "--bot", "b1", "ping",
                           extra_env={"MC_BOTS_REGISTRY": str(reg)})
        self.assertEqual(res.returncode, 2, res.stderr)
        self.assertIn(f"no bridge at 127.0.0.2:{port}", res.stderr)

    def test_no_bridge_is_one_line_rc2_no_traceback(self) -> None:
        sock, port = closed_port()
        self.addCleanup(sock.close)
        res = self.run_ctl(port, HOST)
        self.assertEqual(res.returncode, 2, res.stderr)
        self.assertEqual(res.stdout, "")
        self.assertNotIn("Traceback", res.stderr)
        self.assertEqual(len(res.stderr.strip().splitlines()), 1, res.stderr)
        self.assertIn(f"ERR: no bridge at {HOST}:{port}", res.stderr)
        self.assertIn(NO_BRIDGE_HINT, res.stderr)

    def test_MC_BRIDGE_HOST_is_the_host_it_dials(self) -> None:
        # NEG-CONTROL for the env: 127.0.0.2 is loopback too, so only a ctl that READ the env
        # names it; one that ignores it (or hard-codes 127.0.0.1) names another host.
        try:
            sock, port = closed_port("127.0.0.2")
        except OSError:
            self.skipTest("127.0.0.2 not bindable on this host")
        self.addCleanup(sock.close)
        res = self.run_ctl(port, "127.0.0.2")
        self.assertEqual(res.returncode, 2, res.stderr)
        self.assertIn(f"no bridge at 127.0.0.2:{port}", res.stderr)


TOOLS = ("mc_ping", "mc_get_state", "mc_send")


class McpToolErrorTests(unittest.TestCase):
    def test_bridge_tools_raise_ToolError_instead_of_returning_ok_false(self) -> None:
        # A tool that RETURNS {"ok": false} is a successful MCP call (isError: false); raising
        # ToolError is what sets isError: true. Pinned on the source so the stdlib gate sees it.
        tree = ast.parse((REPO / "mcp" / "server.py").read_text("utf-8"))
        fns = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
        for name in TOOLS:
            with self.subTest(tool=name):
                handlers = [h for n in ast.walk(fns[name]) if isinstance(n, ast.Try) for h in n.handlers]
                self.assertTrue(handlers, f"{name} has no except handler")
                for h in handlers:
                    raises = [n for n in ast.walk(h) if isinstance(n, ast.Raise)]
                    self.assertTrue(any(isinstance(r.exc, ast.Call) and getattr(r.exc.func, "id", "")
                                        == "ToolError" for r in raises), f"{name} swallows the error")
                    self.assertFalse(any(isinstance(n, ast.Return) for n in ast.walk(h)),
                                     f"{name} returns from its except handler")

    def test_bridge_tools_return_the_reply_on_success(self) -> None:
        # NEG-CONTROL of the one above: a tool that raises ToolError unconditionally passes the
        # AST check, so the success path is RUN — each tool's def, lifted out of server.py with
        # its decorator dropped, against a stub client — and must return the reply, not raise.
        tree = ast.parse((REPO / "mcp" / "server.py").read_text("utf-8"))
        fns = {n.name: n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)}
        reply = {"ok": True, "type": "stub"}

        class ToolError(Exception):
            pass

        class Stub:
            def __getattr__(self, _name: str) -> object:
                return lambda *_a, **_k: reply

        for name in TOOLS:
            with self.subTest(tool=name):
                fn = fns[name]
                fn.decorator_list = []
                ns: dict[str, object] = {"Any": object, "ToolError": ToolError,
                                         "_client": lambda _target=None: Stub()}
                exec(compile(ast.Module([fn], []), "server.py", "exec"), ns)  # noqa: S102
                args = ("ping",) if name == "mc_send" else ()
                self.assertIs(ns[name](*args), reply)

    @unittest.skipUnless(importlib.util.find_spec("fastmcp"), "fastmcp not installed (uv run has it)")
    def test_live_call_reports_isError(self) -> None:
        sock, port = closed_port()
        self.addCleanup(sock.close)
        # Save and restore: popping would wipe a value the runner itself was started with.
        env = mock.patch.dict(os.environ, {"MC_BRIDGE_HOST": HOST, "MC_BRIDGE_PORT": str(port)})
        env.start()
        self.addCleanup(env.stop)
        spec = importlib.util.spec_from_file_location("_mc_server", REPO / "mcp" / "server.py")
        assert spec and spec.loader
        server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(server)
        from fastmcp import Client

        async def call() -> object:
            async with Client(server.mcp) as c:
                return await c.call_tool("mc_ping", {}, raise_on_error=False)

        res = asyncio.run(call())
        self.assertTrue(res.is_error)
        self.assertIn(f"no bridge at {HOST}:{port}", str(res.content))


if __name__ == "__main__":
    unittest.main()
