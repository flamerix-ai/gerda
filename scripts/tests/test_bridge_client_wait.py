"""Unit tests for BridgeClient.wait_for_port / .wait_for_ready (mcp/bridge_client.py) — the
wall-clock waits for a bridge that is not up YET (a client still booting).

Neg-control-first: the timeout case is asserted as hard as the success case, because the
failure this replaces was a wait that never waited (the constructor's `timeout` is a
per-request SOCKET timeout — a closed port is refused instantly however large it is). The
wait_for_ready half repeats that discipline one level up: an OPEN port that never answers,
and an answer that is not a status, must both come back False rather than "close enough".
The host half is the same discipline sideways: an auto-resolved host is a GUESS the
constructor made while the port was still closed (typically the default-route gateway), so
both waits must re-probe loopback every round — and an explicit one must never be widened.
Every test binds an ephemeral loopback port; the only non-loopback address used is
192.0.2.1 (RFC 5737 TEST-NET-1, routed nowhere), so nothing here reaches a real host, a
real bridge, or `ip route` — a guess is injected by hand instead of resolved. Total sleep
budget ≈ 5s.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import json
import socket
import sys
import threading
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "mcp"))
from bridge_client import BridgeClient  # noqa: E402

HOST = "127.0.0.1"


def reserve_port() -> tuple[socket.socket, int]:
    """A socket BOUND to an ephemeral port but NOT listening: connects are refused until
    listen() is called, which is exactly the "bridge not up yet" state — and it keeps the
    port reserved, so nothing else can steal it mid-test."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.bind((HOST, 0))
    return s, s.getsockname()[1]


class WaitForPortTests(unittest.TestCase):
    def test_no_listener_returns_False_within_the_deadline(self) -> None:
        sock, port = reserve_port()
        self.addCleanup(sock.close)
        bc = BridgeClient(host=HOST, port=port, timeout=5.0)
        t0 = time.monotonic()
        ok = bc.wait_for_port(0.5, interval=0.05)
        elapsed = time.monotonic() - t0
        self.assertFalse(ok)  # fail-loud: never "maybe it's up"
        self.assertGreaterEqual(elapsed, 0.4)  # it really waited out the deadline…
        self.assertLess(elapsed, 3.0)  # …and did not hang past it

    def test_a_listener_that_appears_late_is_detected(self) -> None:
        sock, port = reserve_port()
        self.addCleanup(sock.close)
        # The bridge "comes up" 0.3s after the wait starts — i.e. AFTER the first attempt
        # has already been refused, which is the whole point of retrying.
        started = threading.Event()

        def late_listen() -> None:
            time.sleep(0.3)
            sock.listen(1)
            started.set()

        t = threading.Thread(target=late_listen, daemon=True)
        t.start()
        self.addCleanup(t.join)

        bc = BridgeClient(host=HOST, port=port, timeout=5.0)
        t0 = time.monotonic()
        ok = bc.wait_for_port(2.0, interval=0.05)
        elapsed = time.monotonic() - t0
        self.assertTrue(ok, "a port that opened mid-wait must be detected")
        self.assertTrue(started.is_set())
        self.assertGreaterEqual(elapsed, 0.25)  # it did NOT succeed before the port opened
        self.assertLess(elapsed, 2.0)

    def test_an_already_listening_port_returns_immediately(self) -> None:
        sock, port = reserve_port()
        sock.listen(1)
        self.addCleanup(sock.close)
        bc = BridgeClient(host=HOST, port=port, timeout=5.0)
        t0 = time.monotonic()
        self.assertTrue(bc.wait_for_port(2.0, interval=0.05))
        self.assertLess(time.monotonic() - t0, 0.5)

    def test_zero_timeout_still_makes_one_attempt(self) -> None:
        # Boundary: `--wait 0` (and interval 0) must probe once and answer honestly — neither
        # skipping the probe nor busy-spinning. Both sockets stay OPEN for the assertions:
        # closing the down one would hand its port back to the kernel and let something else
        # bind it mid-test, so it is kept bound-but-not-listening (Linux refuses those).
        up, up_port = reserve_port()
        up.listen(1)
        self.addCleanup(up.close)
        self.assertTrue(BridgeClient(host=HOST, port=up_port).wait_for_port(0, interval=0))

        down, down_port = reserve_port()
        self.addCleanup(down.close)
        self.assertFalse(BridgeClient(host=HOST, port=down_port).wait_for_port(0, interval=0))

    def test_an_explicit_host_is_the_ONLY_candidate(self) -> None:
        # An explicit host= is the caller's decision: it must survive a failed wait untouched,
        # and must NOT be silently widened to loopback — even though a listener IS live there.
        # (A wait that "helpfully" found some other host would report a stranger as our bridge.)
        sock, port = reserve_port()
        sock.listen(1)
        self.addCleanup(sock.close)
        bc = BridgeClient(host="192.0.2.1", port=port)  # TEST-NET-1: routed nowhere
        self.assertFalse(bc.wait_for_port(0.2, interval=0.05))
        self.assertEqual(bc.host, "192.0.2.1")

    def test_an_auto_resolved_host_probes_LOOPBACK_first(self) -> None:
        # The auto-resolved host is a guess made while the port was down — _resolve_host's
        # loopback probe had already failed, so it is typically the LAN gateway. Loopback must
        # therefore be tried FIRST every retry (and _resolve_host must NOT be re-run per retry,
        # which would keep re-forking `ip route` and aiming SYNs at that gateway).
        sock, port = reserve_port()
        sock.listen(1)
        self.addCleanup(sock.close)
        bc = BridgeClient(port=port)  # auto: resolves to loopback, the listener is up
        bc.host = "192.0.2.1"  # …now pretend it had guessed the gateway instead
        t0 = time.monotonic()
        self.assertTrue(bc.wait_for_port(2.0, interval=0.05))
        # Fast AND corrected: the unroutable guess was never even dialed before loopback won.
        self.assertLess(time.monotonic() - t0, 0.5)
        self.assertEqual(bc.host, HOST)


def serve_replies(sock: socket.socket, reply: object | None) -> threading.Thread:
    """Accept connections on `sock` and answer each with one newline-framed JSON line.

    `reply=None` is the load-bearing case: a socket that accepts and then says NOTHING — the
    cold-boot bridge, listening from the title screen before it can answer anything.
    """
    sock.listen(8)

    def loop() -> None:
        while True:
            try:
                conn, _ = sock.accept()
            except OSError:  # the test closed the listener — we're done
                return
            with conn:
                try:
                    conn.recv(4096)  # drain the request line
                    if reply is not None:
                        conn.sendall((json.dumps(reply) + "\n").encode("utf-8"))
                    else:
                        time.sleep(2.0)  # mute: let the client's socket timeout fire
                except OSError:
                    pass

    t = threading.Thread(target=loop, daemon=True)
    t.start()
    return t


class WaitForReadyTests(unittest.TestCase):
    """The port is not the bridge: these assert the ANSWER, not the connection."""

    def test_an_open_but_mute_port_returns_False(self) -> None:
        # THE bug this method exists for: connect succeeds, nothing ever comes back, and the
        # old --wait reported the bridge up (the next command then died in recv).
        sock, port = reserve_port()
        self.addCleanup(sock.close)
        serve_replies(sock, None)
        bc = BridgeClient(host=HOST, port=port, timeout=5.0)
        t0 = time.monotonic()
        ok = bc.wait_for_ready(0.6, interval=0.05)
        elapsed = time.monotonic() - t0
        self.assertFalse(ok)
        self.assertGreaterEqual(elapsed, 0.5)  # it waited out its own deadline…
        # …and the per-attempt SOCKET timeout (5s) did not overshoot it.
        self.assertLess(elapsed, 2.0)

    def test_a_valid_status_reply_is_ready(self) -> None:  # positive control
        sock, port = reserve_port()
        self.addCleanup(sock.close)
        serve_replies(sock, {"ok": True, "type": "status", "id": 1, "running": True})
        bc = BridgeClient(host=HOST, port=port, timeout=2.0)
        t0 = time.monotonic()
        self.assertTrue(bc.wait_for_ready(2.0, interval=0.05))
        self.assertLess(time.monotonic() - t0, 1.0)

    def test_a_reply_that_is_not_a_ready_status_is_refused(self) -> None:  # NEG-CONTROL
        # Well-formed JSON, wrong content: an error envelope must never read as "bridge ready",
        # or the guard passes on exactly the boot window it was written for.
        for bad in ({"ok": False, "type": "status", "error": "no worker"}, {"ok": True, "type": "ping"}):
            with self.subTest(reply=bad):
                sock, port = reserve_port()
                self.addCleanup(sock.close)
                serve_replies(sock, bad)
                bc = BridgeClient(host=HOST, port=port, timeout=1.0)
                self.assertFalse(bc.wait_for_ready(0.4, interval=0.05))

    def test_garbage_on_the_wire_is_not_ready(self) -> None:  # NEG-CONTROL
        sock, port = reserve_port()
        self.addCleanup(sock.close)
        sock.listen(8)

        def loop() -> None:
            while True:
                try:
                    conn, _ = sock.accept()
                except OSError:
                    return
                with conn:
                    try:
                        conn.recv(4096)
                        conn.sendall(b"<html>not the bridge</html>\n")
                    except OSError:
                        pass

        threading.Thread(target=loop, daemon=True).start()
        bc = BridgeClient(host=HOST, port=port, timeout=1.0)
        self.assertFalse(bc.wait_for_ready(0.4, interval=0.05))

    def test_a_closed_port_is_not_ready(self) -> None:  # NEG-CONTROL
        sock, port = reserve_port()  # bound, never listening → connects are refused
        self.addCleanup(sock.close)
        bc = BridgeClient(host=HOST, port=port, timeout=1.0)
        t0 = time.monotonic()
        self.assertFalse(bc.wait_for_ready(0.4, interval=0.05))
        self.assertLess(time.monotonic() - t0, 2.0)

    def test_a_bridge_that_answers_late_is_detected(self) -> None:
        # Retry, not one shot: the answer arrives after the first attempts were refused.
        sock, port = reserve_port()
        self.addCleanup(sock.close)

        def late() -> None:
            time.sleep(0.3)
            serve_replies(sock, {"ok": True, "type": "status"})

        t = threading.Thread(target=late, daemon=True)
        t.start()
        self.addCleanup(t.join)
        bc = BridgeClient(host=HOST, port=port, timeout=1.0)
        t0 = time.monotonic()
        self.assertTrue(bc.wait_for_ready(2.0, interval=0.05))
        self.assertGreaterEqual(time.monotonic() - t0, 0.25)  # it did NOT pass before the bridge answered

    def test_zero_timeout_probes_once_with_the_full_socket_budget(self) -> None:
        # `--wait-ready 0` = probe once. main.js answers off its Tick loop (a tick + RTT away),
        # so that one probe must get the client's FULL per-request socket budget — clamping it
        # to the deadline floor (50 ms) would fail a perfectly healthy bridge. The reply here is
        # delayed past the floor to catch exactly that regression.
        sock, port = reserve_port()
        self.addCleanup(sock.close)
        sock.listen(8)

        def loop() -> None:
            while True:
                try:
                    conn, _ = sock.accept()
                except OSError:
                    return
                with conn:
                    try:
                        conn.recv(4096)
                        time.sleep(0.25)  # slower than the 0.05s floor, well inside self.timeout
                        conn.sendall((json.dumps({"ok": True, "type": "status"}) + "\n").encode("utf-8"))
                    except OSError:
                        pass

        threading.Thread(target=loop, daemon=True).start()
        bc = BridgeClient(host=HOST, port=port, timeout=2.0)
        t0 = time.monotonic()
        self.assertTrue(bc.wait_for_ready(0))
        self.assertLess(time.monotonic() - t0, 1.5)  # one probe, not a retry loop
        self.assertEqual(bc.timeout, 2.0)

    def test_an_auto_resolved_host_re_probes_LOOPBACK_every_round(self) -> None:
        # A real incident, reproduced: the constructor resolved the host while the port
        # was still closed, so _resolve_host fell through to the default-route gateway — and the
        # old wait_for_ready kept every retry aimed there, burning the whole 540 s window while
        # the bridge had come up on loopback minutes earlier. Loopback must be re-probed EACH
        # round, and the candidate that answers must become self.host.
        sock, port = reserve_port()
        self.addCleanup(sock.close)

        def late() -> None:
            time.sleep(0.3)  # the bridge binds loopback AFTER the wait has already started
            serve_replies(sock, {"ok": True, "type": "status"})

        t = threading.Thread(target=late, daemon=True)
        t.start()
        self.addCleanup(t.join)

        # Constructed with the guess handed in, then marked auto: calling the real _resolve_host
        # here would fork `ip route` and aim at this machine's actual gateway (the port is down at
        # construction time, so its loopback probe fails) — the test must reach nothing real.
        bc = BridgeClient(host="192.0.2.1", port=port, timeout=0.4)
        bc._host_explicit = False  # as if the constructor had guessed the gateway
        t0 = time.monotonic()
        ok = bc.wait_for_ready(2.0, interval=0.05)
        elapsed = time.monotonic() - t0
        self.assertTrue(ok, "a bridge that binds loopback mid-wait must be found")
        self.assertEqual(bc.host, HOST)  # self.host now names the endpoint that ANSWERED
        self.assertGreaterEqual(elapsed, 0.25)  # it did NOT pass before the bridge answered…
        self.assertLess(elapsed, 2.0)  # …and it beat the deadline instead of timing out on 192.0.2.1

    def test_a_multi_candidate_round_does_not_overshoot_the_deadline(self) -> None:  # NEG-CONTROL
        # The per-candidate loop must not multiply the wall-clock deadline by the candidate count.
        # The full-socket-budget exemption ("probe once" at timeout=0) is decided ONCE per round:
        # deciding it per candidate meant that as soon as candidate 1 ate the last of a NON-zero
        # deadline, `remaining <= 0` read as "exempt" and candidate 2 got the whole socket timeout
        # — measured 5.63 s spent on a 0.6 s deadline. Loopback here is OPEN but MUTE (the cold-boot
        # bridge), so candidate 1 always burns its full clamped budget before candidate 2 is dialed.
        sock, port = reserve_port()
        self.addCleanup(sock.close)
        serve_replies(sock, None)  # accepts, never answers
        bc = BridgeClient(host="192.0.2.1", port=port, timeout=2.0)  # socket budget >> deadline
        bc._host_explicit = False  # auto-resolved: loopback first, then this guess
        t0 = time.monotonic()
        ok = bc.wait_for_ready(0.6, interval=0.05)
        elapsed = time.monotonic() - t0
        self.assertFalse(ok)
        self.assertGreaterEqual(elapsed, 0.5)  # it did wait out its deadline…
        self.assertLess(elapsed, 1.2)  # …and did not overshoot it by a second socket timeout

    def test_an_explicit_host_is_the_ONLY_candidate(self) -> None:  # NEG-CONTROL
        # The mirror of the above: with an explicit host= the loopback bridge is LIVE and answering,
        # and the wait must still fail. Adopting it would mean a `--host` a human typed silently
        # became "whatever answers on this port locally" — a stranger reported as their bridge.
        sock, port = reserve_port()
        self.addCleanup(sock.close)
        serve_replies(sock, {"ok": True, "type": "status"})
        bc = BridgeClient(host="192.0.2.1", port=port, timeout=0.3)  # TEST-NET-1: routed nowhere
        self.assertFalse(bc.wait_for_ready(0.7, interval=0.05))
        self.assertEqual(bc.host, "192.0.2.1")  # untouched, so the caller's error names it

    def test_the_socket_timeout_is_restored_after_the_wait(self) -> None:
        # wait_for_ready clamps self.timeout per attempt; leaking that clamp would silently
        # shorten every later request on the same client.
        sock, port = reserve_port()
        self.addCleanup(sock.close)
        serve_replies(sock, {"ok": True, "type": "status"})
        bc = BridgeClient(host=HOST, port=port, timeout=3.5)
        self.assertTrue(bc.wait_for_ready(1.0, interval=0.05))
        self.assertEqual(bc.timeout, 3.5)
        down, down_port = reserve_port()  # bound-not-listening: kept open so nothing steals it
        self.addCleanup(down.close)
        bc2 = BridgeClient(host=HOST, port=down_port, timeout=3.5)  # the failing path restores it too
        self.assertFalse(bc2.wait_for_ready(0.2, interval=0.05))
        self.assertEqual(bc2.timeout, 3.5)


if __name__ == "__main__":
    unittest.main()
