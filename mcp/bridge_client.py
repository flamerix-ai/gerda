"""bridge_client — shared TCP JSON client for the mining bridge.

The canonical in-repo copy: the MCP server (mcp/server.py) and every script under
scripts/ (which put this mcp/ dir on sys.path) all use this one class.
"""
from __future__ import annotations

import json
import socket
import subprocess
import time
from pathlib import Path

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 55544
DEFAULT_TIMEOUT = 5.0
# What to check when nothing answers — the one wording every caller (bridge_ctl, the MCP
# server, scripts) prints.
NO_BRIDGE_HINT = ("is the game running, in a world, with the jsMacros services main.js + "
                  "bridge.js enabled? (docs/SETUP.md)")


# A bridge that ACCEPTS but never answers is not "no game": bridge.js is up and main.js's
# dispatch is not draining (still at the title screen, or deaf-locked by a blocking halt).
SILENT_HINT = ("bridge accepted but main.js is not answering — still at the title screen, or "
               "its dispatch is DEAF (see scripts/ops/reload_worker.py); do NOT blind-retry "
               "halt/start, that wedges it harder")


class BridgeUnreachable(ConnectionError):
    """No bridge accepted the connection (or it never replied). The message names every
    host:port tried and what to check — callers print it as one line, no traceback. A
    ConnectionError, so every existing `except OSError` keeps catching it."""


class BridgeSilent(BridgeUnreachable, TimeoutError):
    """The bridge accepted the connection but no reply came within the socket timeout. Still a
    TimeoutError, as the raw recv timeout was: the deaf-lock guards (reload_worker.py,
    arena._reset_worker) catch TimeoutError to tell "main.js is deaf" from "no bridge"."""


def _resolve_host(port: int = DEFAULT_PORT) -> str:
    """Pick the bridge host. The bridge binds 127.0.0.1 by default (game + tools on
    the same box), so try loopback FIRST; only fall back to the default-route gateway
    (the WSL → Windows-host case) when nothing is listening on loopback. Probing
    loopback first is what keeps native-Linux runs from wrongly dialing the LAN
    gateway."""
    try:
        with socket.create_connection((DEFAULT_HOST, port), timeout=0.3):
            return DEFAULT_HOST
    except OSError:
        pass
    try:
        out = subprocess.check_output(["ip", "route", "show", "default"], text=True)
        for part in out.split():
            if part.count(".") == 3:
                return part
    except Exception:
        pass
    resolv = Path("/etc/resolv.conf")
    if resolv.exists():
        try:
            with resolv.open() as f:
                for line in f:
                    line = line.strip()
                    if line.startswith("nameserver"):
                        parts = line.split()
                        if len(parts) >= 2:
                            ip = parts[1]
                            if ip not in ("127.0.0.1", "::1"):
                                return ip
        except Exception:
            pass
    return DEFAULT_HOST


class BridgeClient:
    """Synchronous JSON-over-TCP client for the jsMacros mining bridge."""

    def __init__(
        self,
        host: str | None = None,
        port: int = DEFAULT_PORT,
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self.host = host if host is not None else _resolve_host(port)
        self.port = port
        # An auto host other than loopback means the loopback probe found nothing listening;
        # a failure on the fallback must say so, or the useful fact is lost behind a gateway
        # timeout.
        self._loopback_refused = host is None and self.host != DEFAULT_HOST
        self.timeout = timeout
        # An explicitly passed host is the caller's decision and is never widened by the waits
        # (wait_for_port / wait_for_ready); an auto-resolved one is only a guess made at
        # construction time — while the port may still be closed — so the waits re-probe it.
        self._host_explicit = host is not None

    def wait_hosts(self) -> tuple[str, ...]:
        """The hosts a wait probes, in order — the SSOT both waits and the callers' fail-loud
        messages read, so "what did it actually dial" is never re-derived (and never guessed) in
        two places. An explicit host= is the caller's decision and is the only candidate; an
        auto-resolved one is a construction-time guess, so loopback goes first and the guess
        second. Note this is a snapshot: a successful wait overwrites `self.host` with whatever
        answered, which collapses a later call to that one proven host."""
        if self._host_explicit:
            return (self.host,)
        return tuple(dict.fromkeys((DEFAULT_HOST, self.host)))

    def wait_for_port(self, timeout: float, interval: float = 0.25) -> bool:
        """Block until the bridge port ACCEPTS a connection. True when it does (and
        `self.host` is set to the candidate that answered), False on timeout — never an
        exception, so the caller prints its own fail-loud message (nothing here degrades
        silently into "maybe it's up").

        `timeout` is a WALL-CLOCK deadline for the port coming up, which the constructor's
        `timeout` (a per-request SOCKET timeout) is not: connecting to a closed port fails
        instantly with ECONNREFUSED no matter how large the socket timeout is. That is the
        whole reason this method exists.

        Which hosts get probed: an explicit host= is the caller's decision and is the ONLY
        candidate, retry after retry. An auto-resolved host is a guess made at construction
        time — while the port was still down, so _resolve_host's loopback probe had already
        failed and it fell through to the default-route gateway (the WSL case). So the
        candidate set is loopback FIRST, then that guess, and a bridge binding loopback late
        is still found. _resolve_host is deliberately NOT re-run per retry: its loopback probe
        fails by definition while we are waiting, so every retry would re-fork `ip route` and
        aim at the LAN gateway — and any stranger listening on this port there would be
        adopted as `self.host` and reported as our bridge.
        """
        # An `interval` of 0 would busy-spin; and the connect timeout must NOT be the retry
        # interval (a tight interval would then time out a live-but-slow connect and report an
        # up port as down), so it gets its own floor.
        interval = max(interval, 0.05)
        connect_timeout = max(min(interval, 1.0), 0.5)
        candidates = self.wait_hosts()
        deadline = time.monotonic() + timeout
        while True:
            for host in candidates:
                try:
                    with socket.create_connection((host, self.port), timeout=connect_timeout):
                        self.host = host
                        return True
                except OSError:
                    pass
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return False
            time.sleep(min(interval, remaining))

    def wait_for_ready(self, timeout: float, interval: float = 1.0) -> bool:
        """Block until the bridge ANSWERS — i.e. a real `status` reply, not just an open port.
        True on the first valid reply, False on timeout — never an exception, so the caller
        prints its own fail-loud message.

        `wait_for_port` is not enough on a cold client boot: bridge.js starts listening as a
        jsMacros service while the game is still at the title screen, so the TCP connect
        succeeds long before main.js can answer anything. The next `send` then blocks on recv
        for the whole socket timeout and dies with a TimeoutError — a "bridge is up" that was
        never up. This waits for the answer instead of the socket.

        Which hosts get probed: the same RULE as `wait_for_port`, applied every round — an
        explicit host= is the caller's decision and is the ONLY candidate; an auto-resolved one is
        a guess the CONSTRUCTOR made, and it made it while the port was still closed, so
        _resolve_host's loopback probe had already failed and it fell through to the default-route
        gateway (the WSL case). Waiting for a cold client boot is exactly that window, so the
        candidate set is loopback FIRST, then that guess, and every round re-probes both: a bridge
        that binds loopback halfway through the wait is found instead of the whole wait hammering a
        gateway that will never answer (a real wait once spent 540 s dialing the gateway while the
        bridge had been answering on 127.0.0.1 for minutes). The resulting SET can differ
        from the one `wait_for_port` used on the same client: a successful wait_for_port has already
        overwritten `self.host` with the candidate that accepted, so a later wait_for_ready collapses
        to that single (already proven) host. `self.host` is left on the candidate that ANSWERED; on
        failure it is restored to the host this call entered with, so the caller's error message
        still names the host it had.

        Adopting a candidate is safer here than in `wait_for_port`: that one accepts any process
        that opens the port, this one requires a well-formed `ok` + `type=="status"` envelope from
        our own protocol, which is strictly stronger evidence that the endpoint is our bridge.
        _resolve_host is still NOT re-run per round — its loopback probe fails by definition while
        we are waiting, so re-running it would only re-fork `ip route` per retry.

        Every transport failure (refused, reset, socket timeout) and every unusable reply
        (garbage, a bare error, another command's type) is just "not ready yet" and is retried
        until the deadline. The per-attempt socket timeout is clamped so a slow attempt cannot
        overshoot the deadline it was given — with ONE exception: `timeout=0` ("probe once") is one
        round over ALL candidates at the full socket budget, so on an auto-resolved client it can
        cost up to N × the socket timeout (a mute loopback plus a gateway that drops the SYN), not
        one. Pass an explicit host, or a real deadline, if that worst case matters.
        """
        interval = max(interval, 0.05)
        deadline = time.monotonic() + timeout
        socket_timeout = self.timeout
        entry_host = self.host
        candidates = self.wait_hosts()
        first_round = True
        answered = False
        try:
            while True:
                # One round is always made. At timeout=0 (`--wait-ready 0` = probe once) its
                # probes get the FULL per-request socket budget — main.js answers off its Tick
                # loop, a tick + RTT away, so the 0.05 s floor would fail a perfectly healthy
                # bridge. Decided ONCE per round, deliberately: re-deciding it per candidate
                # would hand a full socket_timeout to candidate 2 whenever candidate 1 had just
                # eaten the last of a NON-zero deadline, overshooting it by a whole timeout.
                exempt = first_round and (deadline - time.monotonic()) <= 0
                for host in candidates:
                    self.host = host
                    remaining = deadline - time.monotonic()
                    if exempt:
                        self.timeout = socket_timeout
                    else:
                        self.timeout = max(min(socket_timeout, remaining), 0.05)
                    try:
                        reply = self.send("status", {})
                        if isinstance(reply, dict) and reply.get("ok") and reply.get("type") == "status":
                            answered = True  # keep self.host = the candidate that proved itself
                            return True
                    except (OSError, ValueError):
                        # OSError covers ECONNREFUSED/ECONNRESET and socket.timeout (== TimeoutError);
                        # ValueError covers a truncated/garbage line that json.loads chokes on.
                        pass
                first_round = False
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return False
                time.sleep(min(interval, remaining))
        finally:
            self.timeout = socket_timeout
            if not answered:
                self.host = entry_host

    def send(self, cmd: str, payload: dict | None = None) -> dict:
        """Send a command and return the parsed JSON response."""
        req = {"type": cmd}
        if payload is not None:
            req.update(payload)

        data = json.dumps(req, ensure_ascii=False)
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(self.timeout)
            try:
                s.connect((self.host, self.port))
            except OSError as e:
                raise BridgeUnreachable(self._unreachable(f"no bridge at {self.host}:{self.port} ({e})")) from e
            buf = b""
            try:
                s.sendall((data + "\n").encode("utf-8"))
                while b"\n" not in buf:
                    chunk = s.recv(4096)
                    if not chunk:
                        break
                    buf += chunk
            except TimeoutError as e:
                raise BridgeSilent(
                    f"bridge {self.host}:{self.port} accepted but did not reply within "
                    f"{self.timeout}s — {SILENT_HINT}") from e
            except OSError as e:
                raise BridgeUnreachable(self._unreachable(
                    f"bridge {self.host}:{self.port} dropped the connection ({e})")) from e
        return json.loads(buf.decode("utf-8").strip())

    def _unreachable(self, what: str) -> str:
        tried = (f"; {DEFAULT_HOST}:{self.port} refused first (auto host: loopback, then the "
                 f"WSL/default gateway — set MC_BRIDGE_HOST to pin one)"
                 if self._loopback_refused and self.host != DEFAULT_HOST else "")
        return f"{what}{tried} — {NO_BRIDGE_HINT}"

    def ping(self) -> dict:
        return self.send("ping")

    def status(self) -> dict:
        return self.send("status")

    def services(self) -> dict:
        return self.send("services")

    def get_state(self) -> dict:
        return self.send("get_state")

    def start(self, name: str = "worker") -> dict:
        return self.send("start", {"name": name})

    def stop(self) -> dict:
        return self.send("stop")

    def halt(self) -> dict:
        return self.send("halt")

    def pause(self) -> dict:
        return self.send("pause")

    def resume(self) -> dict:
        return self.send("resume")

    def goto(self, x: int, y: int, z: int) -> dict:
        return self.send("goto", {"x": x, "y": y, "z": z})

    def goto_waypoint(self, name: str | None = None) -> dict:
        # Passthrough command: main.js forwards unknown types to the worker, which
        # calls Module.command -> persistence.goto_waypoint. name omitted = nearest vein.
        payload: dict = {}
        if name is not None:
            payload["name"] = name
        return self.send("goto_waypoint", payload or None)

    def eval(self, code: str) -> dict:
        return self.send("eval", {"code": code})

    def load(self, code: str) -> dict:
        return self.send("load", {"code": code})

    def scan(self, radius: int | None = None) -> dict:
        payload: dict = {}
        if radius is not None:
            payload["radius"] = radius
        return self.send("scan", payload or None)

    def inventory(self) -> dict:
        return self.send("inventory")

    def get_logs(self, n: int | None = None) -> dict:
        payload: dict = {}
        if n is not None:
            payload["n"] = n
        return self.send("get_logs", payload or None)
