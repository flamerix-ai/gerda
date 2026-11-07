"""Unit tests for `just shoot` — the camera-display resolution and the refuse-before-staging gates.

WHY. Once scripts/demo/shoot.py ran outside the capture devShell: the shot was posed,
staged and the bot command FIRED, and only then did record.sh find no wf-recorder — a lost take.
`just shoot` (scripts/rig/shoot.sh) runs inside `nix develop .#capture` and hands shoot.py the
CAMERA's headless display, resolved by scripts/rig/sway_windows.py; shoot.py itself now refuses
before staging when it cannot record. What is pinned here, negatives first:

  * sway_windows — the camera is the MC window whose process LISTENS on the camera port, and its
    display is the wayland socket its sway holds. Every step that finds nothing or too much is a
    NAMED refusal (nothing listening, no windows, listener outside any sway, camera on the wrong
    output, two sways, zero/two wayland sockets), paired with the one layout that resolves;
  * a PINNED display is verified, not trusted (check_display): the desktop's own display (bound,
    but not a sway), a stale name, a sway without HEADLESS-1, and the WORKER's headless sway (the
    camera has no window there) all refuse, as does every way swaymsg itself can fail;
  * shoot.py `shoot` refuses (exit 2) and stages NOTHING without a recorder or ffprobe, or with a
    display that is unset or fails check_display — paired with the environment that passes;
  * shoot.sh refuses without ids and outside the capture shell (the missing tool is named).

Nothing boots a compositor or a game: the /proc tables are literal text, the window list is
built by hand, and the tools are stand-in executables.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -t scripts/tests -v
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "rig"))   # sway_windows
sys.path.insert(0, str(REPO / "scripts" / "demo"))  # shoot

import shoot  # noqa: E402  — import is side-effect free (constants + defs only)
import sway_windows as sw  # noqa: E402

PORT = 55546                        # 0xD8FA
ALT_PORT = 55599                    # 0xD92F — a camera booted with SHOOT_CAM_PORT
BASH = shutil.which("bash") or "bash"   # absolute: the cases below run with a stripped PATH
CAM_SOCK = "/run/user/1000/sway-ipc.1000.4242.sock"
BOT_SOCK = "/run/user/1000/sway-ipc.1000.5151.sock"

TCP = """\
  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0100007F:D8FA 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 700 1 0
   1: 0100007F:D8F9 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 800 1 0
   2: 0100007F:D8FA 0100007F:A0A0 01 00000000:00000000 00:00000000 00000000  1000        0 900 1 0
"""

# The ALT_PORT listener lives ONLY here: bridge.js binds with ServerSocketChannel.open(), which on
# a dual-stack JVM is an AF_INET6 socket, so its 127.0.0.1 listener is the v4-mapped address.
TCP6 = """\
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 0000000000000000FFFF00000100007F:D92F 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 600 1 0000000000000000 100 0 0 10 0
   1: 0000000000000000FFFF00000100007F:D92F 0000000000000000FFFF00000100007F:B0B0 01 00000000:00000000 00:00000000 00000000  1000        0 610 1 0000000000000000 20 4 30 10 -1
"""

UNIX = """\
Num       RefCount Protocol Flags    Type St Inode Path
0000000000000000: 00000002 00000000 00010000 0001 01 11 /run/user/1000/wayland-1
0000000000000000: 00000003 00000000 00000000 0001 03 12 /run/user/1000/wayland-1
0000000000000000: 00000002 00000000 00010000 0001 01 21 /run/user/1000/wayland-2
0000000000000000: 00000003 00000000 00000000 0001 03 22 /run/user/1000/wayland-2
0000000000000000: 00000002 00000000 00010000 0001 01 31 /run/user/1000/wayland-3
0000000000000000: 00000002 00000000 00010000 0001 01 41 /run/user/1000/sway-ipc.1000.4242.sock
0000000000000000: 00000003 00000000 00000000 0001 03 99
"""


def win(sock: str, pid: int, inst: str, output: str = "HEADLESS-1") -> sw.Window:
    return sw.Window(sock, pid * 10, inst, output, True, pid)


CAMERA = win(CAM_SOCK, 1001, "Monifactory_cam_shader")
WORKER = win(BOT_SOCK, 2002, "Monifactory_bot_1")


class KernelTableParsingTests(unittest.TestCase):
    def test_only_the_LISTENING_socket_on_the_port_counts(self) -> None:
        # 800 listens on the neighbour port, 900 is an ESTABLISHED connection on ours.
        self.assertEqual(sw.parse_tcp_listen_inodes(TCP, PORT), {700})

    def test_a_port_nobody_listens_on_is_empty(self) -> None:  # NEG-CONTROL
        self.assertEqual(sw.parse_tcp_listen_inodes(TCP, 55547), set())

    def test_a_v4_MAPPED_tcp6_listener_is_parsed(self) -> None:
        # 610 is an ESTABLISHED connection on the same port. The ALT listener is in tcp6 ONLY, so
        # every ALT_PORT case below goes through camera_window()'s tcp6 read.
        self.assertEqual(sw.parse_tcp_listen_inodes(TCP6, ALT_PORT), {600})
        self.assertEqual(sw.parse_tcp_listen_inodes(TCP, ALT_PORT), set())

    def test_unnamed_unix_sockets_are_skipped(self) -> None:
        parsed = sw.parse_unix_sockets(UNIX)
        self.assertIn((21, "/run/user/1000/wayland-2"), parsed)
        self.assertNotIn(99, [inode for inode, _ in parsed])


class PickCameraTests(unittest.TestCase):
    INODES = {1001: {700, 5}, 2002: {6}}

    def test_the_camera_is_the_window_holding_the_port(self) -> None:
        self.assertEqual(sw.pick_camera([WORKER, CAMERA], {700}, self.INODES, PORT), CAMERA)

    def test_NOTHING_listening_is_named(self) -> None:  # NEG-CONTROL
        with self.assertRaisesRegex(sw.ResolveError, "nothing is LISTENING on port 55546"):
            sw.pick_camera([WORKER, CAMERA], set(), self.INODES, PORT)

    def test_NO_windows_is_named(self) -> None:  # NEG-CONTROL
        with self.assertRaisesRegex(sw.ResolveError, "no Minecraft client window"):
            sw.pick_camera([], {700}, self.INODES, PORT)

    def test_a_listener_OUTSIDE_every_sway_is_refused_not_guessed(self) -> None:  # NEG-CONTROL
        # The port is up (a camera on the desktop, say) but no headless window owns it — the
        # worker's sway must NOT be picked just because it is the only one there.
        with self.assertRaisesRegex(sw.ResolveError, "not from any Minecraft window"):
            sw.pick_camera([WORKER], {700}, self.INODES, PORT)

    def test_a_camera_on_the_WRONG_output_is_refused(self) -> None:  # NEG-CONTROL
        cam = win(CAM_SOCK, 1001, "Monifactory_cam_shader", output="DP-1")
        with self.assertRaisesRegex(sw.ResolveError, "record.sh records HEADLESS-1"):
            sw.pick_camera([cam], {700}, self.INODES, PORT)

    def test_a_camera_in_TWO_sways_is_ambiguous(self) -> None:  # NEG-CONTROL
        twin = win(BOT_SOCK, 1001, "Monifactory_cam_shader")
        with self.assertRaisesRegex(sw.ResolveError, "windows in 2 sways"):
            sw.pick_camera([CAMERA, twin], {700}, self.INODES, PORT)

    def test_a_PIN_on_the_cameras_sway_resolves_even_the_ambiguous_case(self) -> None:
        # The refusal above says "pin one with CAM_WAYLAND" — so the pin must settle it.
        twin = win(BOT_SOCK, 1001, "Monifactory_cam_shader")
        self.assertEqual(sw.pick_camera([twin, CAMERA], {700}, self.INODES, PORT, CAM_SOCK),
                         CAMERA)

    def test_a_PIN_on_ANOTHER_clients_sway_is_refused(self) -> None:  # NEG-CONTROL (H3)
        # The worker's sway is a perfectly recordable headless one — but the camera is not in it.
        with self.assertRaisesRegex(sw.ResolveError, "has no window in the sway serving the "
                                                     "pinned display"):
            sw.pick_camera([WORKER, CAMERA], {700}, self.INODES, PORT, BOT_SOCK)


class WaylandDisplayTests(unittest.TestCase):
    UNIX = sw.parse_unix_sockets(UNIX)

    def test_the_display_is_the_socket_the_sway_HOLDS(self) -> None:
        # Listener + an accepted connection of wayland-2: one name, however many inodes.
        self.assertEqual(sw.wayland_display_of(CAM_SOCK, self.UNIX, {21, 22, 41}), "wayland-2")

    def test_a_sway_holding_NO_wayland_socket_is_refused(self) -> None:  # NEG-CONTROL
        with self.assertRaisesRegex(sw.ResolveError, "holds 0 wayland sockets"):
            sw.wayland_display_of(CAM_SOCK, self.UNIX, {41})

    def test_a_sway_holding_TWO_is_refused_not_picked(self) -> None:  # NEG-CONTROL
        with self.assertRaisesRegex(sw.ResolveError, "holds 2 wayland sockets"):
            sw.wayland_display_of(CAM_SOCK, self.UNIX, {21, 31})

    def test_an_IPC_path_without_a_pid_is_refused(self) -> None:  # NEG-CONTROL
        with self.assertRaisesRegex(sw.ResolveError, "compositor pid"):
            sw.wayland_display_of("/tmp/some.sock", self.UNIX, {21})

    def test_held_NON_wayland_sockets_are_skipped_not_dereferenced(self) -> None:  # D3
        # Every held socket here but one is not `wayland-N`: the IPC socket, a lock-style name,
        # a wayland-N with a suffix. A filter that stops guarding the match hits a None.group.
        unix = [(51, "/run/user/1000/sway-ipc.1000.4242.sock"),
                (52, "/run/user/1000/wayland-7.lock"),
                (53, "/run/user/1000/wayland-7x"),
                (54, "/run/user/1000/wayland-7")]
        self.assertEqual(sw.wayland_display_of(CAM_SOCK, unix, {51, 52, 53, 54}), "wayland-7")
        with self.assertRaisesRegex(sw.ResolveError, "holds 0 wayland sockets"):
            sw.wayland_display_of(CAM_SOCK, unix, {51, 52, 53})


class PinnedDisplayTests(unittest.TestCase):
    UNIX = sw.parse_unix_sockets(UNIX)
    HELD = {CAM_SOCK: {21, 22}, BOT_SOCK: {31}}

    def test_a_pin_served_by_a_live_sway_resolves_to_it(self) -> None:
        self.assertEqual(sw.sway_serving("wayland-2", [CAM_SOCK, BOT_SOCK], self.UNIX, self.HELD),
                         CAM_SOCK)

    def test_the_DESKTOP_display_is_refused(self) -> None:  # NEG-CONTROL
        # wayland-1 is bound (the operator's compositor) but no sway holds it.
        with self.assertRaisesRegex(sw.ResolveError, "served by 0 live sway"):
            sw.sway_serving("wayland-1", [CAM_SOCK, BOT_SOCK], self.UNIX, self.HELD)

    def test_a_STALE_name_is_refused(self) -> None:  # NEG-CONTROL
        with self.assertRaisesRegex(sw.ResolveError, "not a bound socket"):
            sw.sway_serving("wayland-9", [CAM_SOCK, BOT_SOCK], self.UNIX, self.HELD)


# The live system check_display() reads, as literal tables: the camera's sway (pid 4242) holds
# wayland-2, the worker's (pid 5151) holds wayland-3, wayland-1 is the desktop's (no sway holds
# it), the camera client (pid 1001) holds the port-55546 listener (inode 700), and the client
# in wayland-3 (pid 2002) holds the port-55599 one (inode 600, in tcp6) — so the port decides.
HELD_BY_PID = {4242: {21, 22}, 5151: {31}, 1001: {700, 5}, 2002: {6, 600}}
TABLES = {"/proc/net/unix": UNIX, "/proc/net/tcp": TCP, "/proc/net/tcp6": TCP6}


def outputs_run(*names: str, rc: int = 0, stdout: str | None = None):
    """A stand-in subprocess.run answering `swaymsg -t get_outputs` with these output names."""
    body = json.dumps([{"name": n, "active": True} for n in names]) if stdout is None else stdout

    def run(argv, **_kw):
        assert argv[-2:] == ["-t", "get_outputs"], argv
        return subprocess.CompletedProcess(argv, rc, body, "IPC socket gone" if rc else "")
    return run


def raising(exc: BaseException):
    """A stand-in subprocess.run that fails the way the real one can: it raises."""
    def run(argv, **_kw):
        raise exc
    return run


@contextlib.contextmanager
def live_system(run=None):
    """check_display()'s readers pinned to the tables above; `run` answers swaymsg."""
    with mock.patch.object(sw, "sockets", return_value=[CAM_SOCK, BOT_SOCK]), \
            mock.patch.object(sw, "_read", side_effect=lambda p: TABLES.get(p, "")), \
            mock.patch.object(sw, "socket_inodes_of",
                              side_effect=lambda pid: HELD_BY_PID.get(pid, set())), \
            mock.patch.object(sw, "windows", return_value=[WORKER, CAMERA]), \
            mock.patch.object(sw.subprocess, "run", side_effect=run or outputs_run("HEADLESS-1")), \
            contextlib.redirect_stderr(io.StringIO()):
        yield


class CheckDisplayTests(unittest.TestCase):
    """check_display(): the pinned display must be a live sway, with HEADLESS-1, holding the camera.

    Fixtures vary on the axes the live values do: the display name (the camera's wayland-2, the
    worker's wayland-3, the desktop's wayland-1), the output list (HEADLESS-1 alone or beside a
    second headless output; a real monitor, two monitors, another headless name, none), and the
    way swaymsg itself can fail (timeout, not runnable, non-zero, garbage).
    """

    def test_the_cameras_display_PASSES(self) -> None:
        for outs in (["HEADLESS-1"], ["HEADLESS-2", "HEADLESS-1"]):
            with self.subTest(outputs=outs), live_system(outputs_run(*outs)):
                self.assertEqual(sw.check_display("wayland-2", PORT), "wayland-2")

    def test_a_sway_WITHOUT_HEADLESS_1_is_refused(self) -> None:  # NEG-CONTROL (S2)
        for outs in (["DP-1"], ["DP-1", "HDMI-A-1"], ["HEADLESS-2"], []):
            with self.subTest(outputs=outs), live_system(outputs_run(*outs)), \
                    self.assertRaisesRegex(sw.ResolveError, "not HEADLESS-1 — record.sh would "
                                                            "have nothing to record"):
                sw.check_display("wayland-2", PORT)

    def test_the_WORKERS_headless_display_is_refused(self) -> None:  # NEG-CONTROL (H3)
        # wayland-3 IS a live sway with HEADLESS-1 — the old check passed it — but the client on
        # the camera port has no window there: recording it would film the worker's screen.
        with live_system(), self.assertRaisesRegex(sw.ResolveError, "has no window in the sway "
                                                                    "serving the pinned display"):
            sw.check_display("wayland-3", PORT)

    def test_the_DESKTOP_display_is_refused(self) -> None:  # NEG-CONTROL
        with live_system(), self.assertRaisesRegex(sw.ResolveError, "served by 0 live sway"):
            sw.check_display("wayland-1", PORT)

    def test_the_camera_is_found_on_the_PASSED_port(self) -> None:  # NEG-CONTROL
        # On 55599 the camera is the client in wayland-3: the verdicts of the default port flip.
        # A check_display that looked on 55546 regardless would pass wayland-2 and refuse wayland-3.
        with live_system():
            self.assertEqual(sw.check_display("wayland-3", ALT_PORT), "wayland-3")
        with live_system(), self.assertRaisesRegex(sw.ResolveError, "has no window in the sway "
                                                                    "serving the pinned display"):
            sw.check_display("wayland-2", ALT_PORT)

    def test_every_swaymsg_FAILURE_is_a_named_refusal(self) -> None:  # NEG-CONTROL (H5)
        cases = (
            (raising(subprocess.TimeoutExpired(["swaymsg"], sw.SWAYMSG_TIMEOUT_S)),
             f"did not answer within {sw.SWAYMSG_TIMEOUT_S}s"),
            (raising(FileNotFoundError(2, "No such file or directory", "swaymsg")),
             "cannot run swaymsg"),
            (raising(PermissionError(13, "Permission denied", "swaymsg")), "cannot run swaymsg"),
            (outputs_run(rc=1), "exited 1: IPC socket gone"),
            (outputs_run(stdout="not json"), "printed no output list"),
            (outputs_run(stdout='{"name": "HEADLESS-1"}'), "printed no output list"),
        )
        for run, needle in cases:
            with self.subTest(needle=needle), live_system(run), \
                    self.assertRaisesRegex(sw.ResolveError, needle):
                sw.check_display("wayland-2", PORT)

    def test_the_CLI_turns_a_refusal_into_exit_1_not_a_traceback(self) -> None:  # NEG-CONTROL
        err = io.StringIO()
        with live_system(raising(subprocess.TimeoutExpired(["swaymsg"], sw.SWAYMSG_TIMEOUT_S))), \
                mock.patch.object(sw.shutil, "which", return_value="/x/swaymsg"), \
                contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(err):
            rc = sw.main(["display", "--check", "wayland-2", "--port", str(PORT)])
        self.assertEqual(rc, 1)
        self.assertIn("did not answer within", err.getvalue())


class ResolveDisplayTests(unittest.TestCase):
    """resolve_display() and the `display` CLI find the camera on the port they are GIVEN.

    Each case is paired across the two ports. A resolver hardcoded to DEFAULT_CAM_PORT passes
    every default-port case and fails every ALT_PORT one.
    """

    def cli(self, *argv: str, env: dict | None = None) -> tuple[int, str]:
        out = io.StringIO()
        base = {k: v for k, v in os.environ.items() if k != "SHOOT_CAM_PORT"}
        with live_system(), mock.patch.dict(os.environ, {**base, **(env or {})}, clear=True), \
                mock.patch.object(sw.shutil, "which", return_value="/x/swaymsg"), \
                contextlib.redirect_stdout(out):
            rc = sw.main(list(argv))
        return rc, out.getvalue().strip()

    def test_the_display_follows_the_port(self) -> None:
        with live_system():
            self.assertEqual(sw.resolve_display(PORT), "wayland-2")
            self.assertEqual(sw.resolve_display(ALT_PORT), "wayland-3")

    def test_the_CLI_resolves_on_its_port(self) -> None:
        self.assertEqual(self.cli("display"), (0, "wayland-2"))
        self.assertEqual(self.cli("display", "--port", str(ALT_PORT)), (0, "wayland-3"))

    def test_the_CLI_checks_a_pin_on_its_port(self) -> None:  # NEG-CONTROL
        self.assertEqual(self.cli("display", "--check", "wayland-3", "--port", str(ALT_PORT)),
                         (0, "wayland-3"))
        self.assertEqual(self.cli("display", "--check", "wayland-3")[0], 1)
        self.assertEqual(self.cli("display", "--check", "wayland-2", "--port", str(ALT_PORT))[0],
                         1)

    def test_SHOOT_CAM_PORT_is_the_CLI_default(self) -> None:  # NEG-CONTROL
        env = {"SHOOT_CAM_PORT": str(ALT_PORT)}
        self.assertEqual(self.cli("display", env=env), (0, "wayland-3"))
        self.assertEqual(self.cli("display", "--check", "wayland-3", env=env), (0, "wayland-3"))
        self.assertEqual(self.cli("display", "--check", "wayland-2", env=env)[0], 1)


class CamPortEnvTests(unittest.TestCase):
    """SHOOT_CAM_PORT reaches every consumer, and the default has ONE home."""

    def module_port(self, module: str, env: dict) -> int:
        # A fresh interpreter: CAM_PORT is bound at import, so reloading here would leak.
        code = (f"import sys; sys.path[:0] = [{str(REPO / 'scripts/demo')!r}]; "
                f"import {module}; print({module}.CAM_PORT)")
        base = {k: v for k, v in os.environ.items() if k != "SHOOT_CAM_PORT"}
        r = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                           env={**base, **env}, check=False)
        self.assertEqual(r.returncode, 0, r.stderr)
        return int(r.stdout.strip())

    def test_the_default_lives_in_sway_windows(self) -> None:
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(sw.cam_port(), sw.DEFAULT_CAM_PORT)
        with mock.patch.dict(os.environ, {"SHOOT_CAM_PORT": str(ALT_PORT)}):
            self.assertEqual(sw.cam_port(), ALT_PORT)

    def test_an_EMPTY_SHOOT_CAM_PORT_falls_back_to_the_one_home(self) -> None:  # NEG-CONTROL (D2)
        # The home is moved OFF the real default: a cam_port() that hardcodes 55546 for the
        # empty case (instead of reading DEFAULT_CAM_PORT) returns the wrong port here.
        for raw in ("", "  "):
            with self.subTest(raw=raw), mock.patch.object(sw, "DEFAULT_CAM_PORT", ALT_PORT), \
                    mock.patch.dict(os.environ, {"SHOOT_CAM_PORT": raw}):
                self.assertEqual(sw.cam_port(), ALT_PORT)
        # ...and a set value still wins over the (moved) home.
        with mock.patch.object(sw, "DEFAULT_CAM_PORT", ALT_PORT), \
                mock.patch.dict(os.environ, {"SHOOT_CAM_PORT": "55601"}):
            self.assertEqual(sw.cam_port(), 55601)

    def test_a_non_port_SHOOT_CAM_PORT_is_refused_by_name(self) -> None:  # NEG-CONTROL (D2)
        for raw in ("cam", "-1", "0", "65536", "555 46", "²", "5554６", "\t55546\x0b1"):
            with self.subTest(raw=raw), mock.patch.dict(os.environ, {"SHOOT_CAM_PORT": raw}), \
                    self.assertRaisesRegex(SystemExit, "SHOOT_CAM_PORT=.* is not a TCP port"):
                sw.cam_port()

    def test_shoot_and_sustain_live_survive_an_EMPTY_SHOOT_CAM_PORT(self) -> None:  # D2
        # Both bind CAM_PORT at import: an int('') there was an import-time crash.
        for module in ("shoot", "sustain_live"):
            with self.subTest(module=module):
                self.assertEqual(self.module_port(module, {"SHOOT_CAM_PORT": ""}),
                                 sw.DEFAULT_CAM_PORT)

    def test_shoot_and_sustain_live_honour_SHOOT_CAM_PORT(self) -> None:  # NEG-CONTROL
        for module in ("shoot", "sustain_live"):
            with self.subTest(module=module):
                self.assertEqual(self.module_port(module, {"SHOOT_CAM_PORT": str(ALT_PORT)}),
                                 ALT_PORT)
                self.assertEqual(self.module_port(module, {}), sw.DEFAULT_CAM_PORT)


def write_exe(path: Path, body: str = "#!/bin/sh\nexit 0\n") -> Path:
    path.write_text(body)
    path.chmod(0o755)
    return path


class ShootPreflightTests(unittest.TestCase):
    """shoot.py refuses before staging — the lost take, pinned."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.bin = Path(tmp.name)
        self.wfrec = write_exe(self.bin / "wf-recorder")
        write_exe(self.bin / "ffprobe")

    def env(self, **over: str) -> dict:
        # wayland-2 is the camera's display in the live_system() tables.
        env = {"PATH": str(self.bin), "WAYLAND_DISPLAY": "wayland-2", **over}
        return {k: v for k, v in env.items() if v}

    def preflight(self, **over: str) -> list[str]:
        # The REAL check_display() runs, against the literal system tables.
        with mock.patch.dict(os.environ, self.env(**over), clear=True), live_system():
            return shoot.recording_preflight()

    def run_main(self, **over: str) -> tuple[int, mock.MagicMock, mock.MagicMock, str]:
        """shoot.py `shoot 01_clutch` with staging and rolling stubbed: (rc, stage, roll, stdout)."""
        with mock.patch.dict(os.environ, self.env(**over), clear=True), live_system(), \
                mock.patch.object(shoot, "stage") as stage, \
                mock.patch.object(shoot, "roll") as roll, \
                mock.patch.object(sys, "argv", ["shoot.py", "shoot",
                                                str(REPO / "scenarios/shots/teaser.json"),
                                                "01_clutch"]), \
                contextlib.redirect_stdout(io.StringIO()) as out:
            rc = shoot.main()
        return rc, stage, roll, out.getvalue()

    def test_a_capture_environment_passes(self) -> None:
        self.assertEqual(self.preflight(), [])

    def test_a_SET_but_WRONG_display_is_refused(self) -> None:  # NEG-CONTROL (H4)
        # The old preflight only asked "is WAYLAND_DISPLAY non-empty" and passed all three.
        for display, why in (("wayland-1", "served by 0 live sway"),          # the desktop's
                             ("wayland-3", "has no window in the sway"),       # the worker's
                             ("wayland-9", "not a bound socket")):            # stale
            with self.subTest(display=display):
                problems = self.preflight(WAYLAND_DISPLAY=display)
                self.assertEqual(len(problems), 1, problems)
                self.assertIn(f"WAYLAND_DISPLAY={display} is not the camera's recordable sway",
                              problems[0])
                self.assertIn(why, problems[0])

    def test_the_display_is_checked_against_the_CAMERA_port(self) -> None:
        # A non-default CAM_PORT: the default one would equal a hardcoded 55546 and prove nothing.
        with mock.patch.dict(os.environ, self.env(), clear=True), \
                mock.patch.object(shoot, "CAM_PORT", ALT_PORT), \
                mock.patch.object(sw, "check_display", return_value="wayland-2") as check:
            self.assertEqual(shoot.recording_preflight(), [])
        check.assert_called_once_with("wayland-2", ALT_PORT)

    def test_a_NON_DEFAULT_camera_port_moves_the_recordable_display(self) -> None:  # NEG-CONTROL
        # The REAL check at CAM_PORT=55599, whose client sits in wayland-3 (see HELD_BY_PID).
        with mock.patch.object(shoot, "CAM_PORT", ALT_PORT):
            self.assertEqual(self.preflight(WAYLAND_DISPLAY="wayland-3"), [])
            problems = self.preflight()
        self.assertEqual(len(problems), 1, problems)
        self.assertIn("has no window in the sway", problems[0])

    def test_shoot_REFUSES_and_stages_NOTHING_on_the_WORKERS_display(self) -> None:  # NEG-CONTROL
        rc, stage, roll, out = self.run_main(WAYLAND_DISPLAY="wayland-3")
        self.assertEqual(rc, 2)
        stage.assert_not_called()
        roll.assert_not_called()
        self.assertIn("WAYLAND_DISPLAY=wayland-3 is not the camera's recordable sway", out)

    def test_no_display_is_named(self) -> None:  # NEG-CONTROL
        self.assertEqual(len(self.preflight(WAYLAND_DISPLAY="")), 1)
        self.assertIn("WAYLAND_DISPLAY", self.preflight(WAYLAND_DISPLAY="")[0])

    def test_no_recorder_is_named(self) -> None:  # NEG-CONTROL — the lost-take case
        self.wfrec.unlink()
        self.assertEqual(self.preflight(), ["no wf-recorder (not on PATH)"])

    def test_a_WFREC_that_is_not_executable_is_named(self) -> None:  # NEG-CONTROL
        self.assertIn("no wf-recorder (WFREC=/nonexistent/wf-recorder)",
                      self.preflight(WFREC="/nonexistent/wf-recorder"))

    def test_no_ffprobe_is_named(self) -> None:  # NEG-CONTROL
        (self.bin / "ffprobe").unlink()
        self.assertIn("ffprobe", " ".join(self.preflight()))

    def test_shoot_REFUSES_and_stages_NOTHING_without_a_recorder(self) -> None:  # NEG-CONTROL
        self.wfrec.unlink()
        rc, stage, roll, out = self.run_main()
        self.assertEqual(rc, 2)
        stage.assert_not_called()
        roll.assert_not_called()
        self.assertIn("REFUSING before staging anything", out)

    def test_shoot_PROCEEDS_to_staging_when_it_can_record(self) -> None:
        # The pair: same call, recorder present, the camera's display — it gets as far as
        # staging (stubbed here).
        with mock.patch.dict(os.environ, self.env(), clear=True), live_system(), \
                mock.patch.object(shoot, "shoot_one", return_value="ok") as one, \
                mock.patch.object(sys, "argv", ["shoot.py", "shoot",
                                                str(REPO / "scenarios/shots/teaser.json"),
                                                "01_clutch"]), \
                contextlib.redirect_stdout(io.StringIO()):
            rc = shoot.main()
        self.assertEqual(rc, 0)
        one.assert_called_once()


@unittest.skipUnless(shutil.which("bash"), "bash not on PATH")
class ShootShTests(unittest.TestCase):
    """scripts/rig/shoot.sh's own refusals — the parts that run before any resolution."""

    SCRIPT = REPO / "scripts" / "rig" / "shoot.sh"

    def run_sh(self, *args: str, path: str) -> subprocess.CompletedProcess:
        return subprocess.run([BASH, str(self.SCRIPT), *args], capture_output=True, text=True,
                              env={"PATH": path, "HOME": os.environ.get("HOME", "/tmp")},
                              check=False)

    def minimal_path(self, tools: list[str]) -> str:
        """A PATH holding the coreutils the script needs plus ONLY the named capture tools."""
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        d = Path(tmp.name)
        for tool in ("dirname", "python3"):
            real = shutil.which(tool)
            if real:
                (d / tool).symlink_to(real)
        for tool in tools:
            write_exe(d / tool)
        return str(d)

    def test_no_ids_is_refused(self) -> None:  # NEG-CONTROL
        r = self.run_sh(path=self.minimal_path(["wf-recorder", "swaymsg", "ffprobe"]))
        self.assertEqual(r.returncode, 1)
        self.assertIn("name the shot id(s)", r.stderr)

    def test_outside_the_capture_shell_the_missing_tool_is_NAMED(self) -> None:  # NEG-CONTROL
        r = self.run_sh("01_clutch", path=self.minimal_path(["swaymsg", "ffprobe"]))
        self.assertEqual(r.returncode, 1)
        self.assertIn("'wf-recorder' is not on PATH", r.stderr)

    def test_an_unknown_shot_list_is_refused(self) -> None:  # NEG-CONTROL
        r = subprocess.run([BASH, str(self.SCRIPT), "01_clutch"], capture_output=True,
                           text=True, check=False,
                           env={"PATH": self.minimal_path(["wf-recorder", "swaymsg", "ffprobe"]),
                                "SHOTLIST": "scenarios/shots/nope.json"})
        self.assertEqual(r.returncode, 1)
        self.assertIn("no shot list at scenarios/shots/nope.json", r.stderr)

    def python3_calls(self, **env: str) -> tuple[list[str], list[str]]:
        """shoot.sh's python3 invocations with python3 a recording stand-in: (argv lines, the
        SHOOT_CAM_PORT each call saw in its environment)."""
        tools = self.minimal_path(["wf-recorder", "swaymsg", "ffprobe"])
        log = Path(tools) / "argv.log"
        seen = Path(tools) / "env.log"
        (Path(tools) / "python3").unlink(missing_ok=True)
        write_exe(Path(tools) / "python3",
                  f'#!/bin/sh\nprintf \'%s\\n\' "$*" >> {log}\n'
                  f'printf \'[%s]\\n\' "${{SHOOT_CAM_PORT-unset}}" >> {seen}\necho wayland-2\n')
        r = subprocess.run([BASH, str(self.SCRIPT), "01_clutch"], capture_output=True,
                           text=True, check=False, env={"PATH": tools, **env})
        self.assertEqual(r.returncode, 0, r.stderr)
        return log.read_text().splitlines(), seen.read_text().splitlines()

    def argv_of_python3(self, **env: str) -> list[str]:
        return self.python3_calls(**env)[0]

    def test_SHOOT_CAM_PORT_reaches_both_display_arms_through_the_environment(self) -> None:  # NEG-CONTROL
        # shoot.sh forwards no --port: sway_windows.py's --port default (cam_port()) reads the
        # variable itself, so a blank value can never become a bad `--port "  "` argument.
        for raw in (str(ALT_PORT), "  "):
            for arm, first in (({}, "scripts/rig/sway_windows.py display"),
                               ({"CAM_WAYLAND": "wayland-3"},
                                "scripts/rig/sway_windows.py display --check wayland-3")):
                with self.subTest(raw=raw, arm=first):
                    argv, seen = self.python3_calls(SHOOT_CAM_PORT=raw, **arm)
                    self.assertEqual(argv[0], first)
                    self.assertEqual(seen[0], f"[{raw}]")

    def test_WITHOUT_SHOOT_CAM_PORT_no_port_is_passed(self) -> None:  # NEG-CONTROL
        # sway_windows.DEFAULT_CAM_PORT is the only default; shoot.sh must not keep a second one.
        self.assertEqual(self.argv_of_python3(),
                         ["scripts/rig/sway_windows.py display",
                          "scripts/demo/shoot.py shoot scenarios/shots/teaser.json 01_clutch"])
        self.assertEqual(self.argv_of_python3(CAM_WAYLAND="wayland-3")[0],
                         "scripts/rig/sway_windows.py display --check wayland-3")

    def test_with_every_tool_present_it_gets_PAST_the_tool_check(self) -> None:
        # The pair for the missing-tool case: with the tools there it proceeds to resolving the
        # display — and a stand-in swaymsg finds no camera, so it must stop THERE, loudly.
        r = self.run_sh("01_clutch", path=self.minimal_path(["wf-recorder", "swaymsg", "ffprobe"]))
        self.assertEqual(r.returncode, 1)
        self.assertNotIn("is not on PATH", r.stderr)
        self.assertIn("could not resolve the camera's headless display", r.stderr)


if __name__ == "__main__":
    unittest.main()
