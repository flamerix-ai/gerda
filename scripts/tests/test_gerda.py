"""gerda dispatcher: every table entry must point at an existing script.

Guards the CLI against silent drift when scripts move — the dispatcher itself
fails loud at runtime, but this catches it at commit time.
"""
from __future__ import annotations

import importlib.util
import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from importlib.machinery import SourceFileLoader
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]

# The CLI is an extensionless script — spec_from_file_location needs an explicit
# source loader for it.
_loader = SourceFileLoader("_gerda_cli", str(REPO / "gerda"))
spec = importlib.util.spec_from_loader("_gerda_cli", _loader)
assert spec is not None
gerda = importlib.util.module_from_spec(spec)
_loader.exec_module(gerda)


def _driver(body: str) -> str:
    """`python -c` source that loads the real gerda as `g` (its WINDOWS from the real os.name),
    then runs `body`."""
    return ("import sys, importlib.util as u; from importlib.machinery import SourceFileLoader; "
            f"l = SourceFileLoader('g', {str(REPO / 'gerda')!r}); "
            "g = u.module_from_spec(u.spec_from_loader('g', l)); l.exec_module(g); " + body)


_SKIP_DIRS = {".git", ".direnv", "node_modules", "__pycache__"}  # .direnv: direnv rewrites it


def _tree_state() -> set[tuple[str, int, int]]:
    """(path, size, mtime_ns) of every file in the checkout, minus VCS, deps and bytecode."""
    state = set()
    for dirpath, dirnames, filenames in os.walk(REPO):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS]
        for f in filenames:
            st = os.stat(os.path.join(dirpath, f))
            state.add((os.path.relpath(os.path.join(dirpath, f), REPO), st.st_size, st.st_mtime_ns))
    return state


class GerdaTableTests(unittest.TestCase):
    def test_every_command_targets_an_existing_script(self) -> None:
        for name, (rel, desc) in gerda.FLAT.items():
            with self.subTest(command=name):
                self.assertTrue((REPO / rel).is_file(), f"{name} -> {rel} missing")
                self.assertTrue(desc)

    def test_no_duplicate_names_across_groups(self) -> None:
        total = sum(len(g) for g in gerda.COMMANDS.values())
        self.assertEqual(total, len(gerda.FLAT))

    def test_help_exits_zero_and_lists_ctl(self) -> None:
        out = subprocess.run(
            [sys.executable, str(REPO / "gerda"), "--help"],
            capture_output=True, text=True, check=True,
        )
        self.assertIn("ctl", out.stdout)

    def test_bare_call_lists_the_commands(self) -> None:
        # The docs say "run `./gerda` bare for the full list"; it used to exit 2 with a usage error.
        out = subprocess.run([sys.executable, str(REPO / "gerda")], capture_output=True, text=True)
        self.assertEqual(out.returncode, 0, out.stderr)
        for name in gerda.FLAT:
            self.assertIn(name, out.stdout)

    def test_every_command_prints_help_without_side_effects(self) -> None:
        # A newcomer reads `./gerda <cmd> -h` before they have a launcher, a game or a bridge.
        # Each tool must answer -h with rc 0 and touch nothing: `extract-ores -h` once fetched
        # upstream source and rewrote the tracked config/gtceu_ores.json, the old live-manifest
        # dump dialled the bridge, and shot/srg/tune/bind-accounts/decompile died looking for an instances
        # dir. The empty HOME keeps the launcher autodetect out of reach, and MC_INSTANCES_ROOT
        # pointing at a path that does not exist beats local.config.json's instancesRoot (read
        # from the main checkout, not from HOME): a tool that resolves the instances before it
        # parses -h dies here, on every machine.
        home = Path(tempfile.mkdtemp(prefix="gerda-help-"))
        self.addCleanup(shutil.rmtree, home, True)
        env = {k: v for k, v in os.environ.items()
               if k not in ("MC_INST", "MC_BRIDGE_HOST", "MC_BRIDGE_PORT")}
        env["HOME"] = str(home)
        env["MC_INSTANCES_ROOT"] = str(home / "no-instances-here")
        before = _tree_state()
        for name in gerda.FLAT:
            with self.subTest(command=name):
                out = subprocess.run([sys.executable, str(REPO / "gerda"), name, "-h"],
                                     capture_output=True, text=True, env=env, timeout=30,
                                     stdin=subprocess.DEVNULL)
                self.assertEqual(out.returncode, 0, out.stdout + out.stderr)
                self.assertTrue(out.stdout.strip(), "no help text on stdout")
        self.assertEqual(_tree_state(), before, "a `-h` call changed files in the checkout")

    def test_windows_runs_a_child_with_each_argument_whole(self) -> None:
        # The Windows test VM: `gerda ctl send mission_start '{json}'` reached bridge_ctl split into
        # words, because os.execv there re-joins argv unquoted; and a piped cp1252 stdout died on
        # the help screen's arrows (UnicodeEncodeError). Patched WINDOWS drives that path on Linux.
        payload = '{"name": "goto", "params": {"x": 1}}'
        calls: list[tuple[list[str], dict[str, str]]] = []

        def call(argv: list[str], env: dict[str, str]) -> int:
            calls.append((argv, env))
            return 7

        def no_exec(*_: object) -> None:
            raise AssertionError("exec on Windows")

        out, err = (io.TextIOWrapper(io.BytesIO(), encoding="cp1252") for _ in range(2))
        with mock.patch.object(gerda, "WINDOWS", True), \
                mock.patch.object(gerda.subprocess, "call", call), \
                mock.patch.object(gerda.signal, "signal"), \
                mock.patch.object(gerda.os, "execvp", no_exec), \
                mock.patch.object(gerda.sys, "argv", ["gerda", "ctl", "send", "mission_start", payload]), \
                mock.patch.object(gerda.sys, "stdout", out), mock.patch.object(gerda.sys, "stderr", err):
            rc = gerda.main()
            encodings = (gerda.sys.stdout.encoding, gerda.sys.stderr.encoding)
        self.assertEqual(rc, 7, "the tool's exit code is not passed on")
        self.assertEqual(encodings, ("utf-8", "utf-8"))
        [(argv, env)] = calls
        self.assertEqual(argv, [sys.executable, str(REPO / "scripts/ops/bridge_ctl.py"),
                                "send", "mission_start", payload])
        self.assertEqual(env, {**os.environ, "PYTHONUTF8": "1"})

    def windows_dispatch(self, command: str, exec_path: str | bytes | Exception) -> list[str]:
        """argv of the child that `gerda <command>` starts with WINDOWS patched on, `git
        --exec-path` answering `exec_path` as Git for Windows writes it to a pipe: UTF-8 bytes
        (`bytes` raw), decoded the way check_output would — `text=True` alone means the
        Windows locale's code page (cp1252 here)."""
        calls: list[list[str]] = []

        def git(argv: list[str], *, text: bool = False, encoding: str | None = None) -> str | bytes:
            self.assertEqual(argv, ["git", "--exec-path"])
            if isinstance(exec_path, Exception):
                raise exec_path
            raw = exec_path if isinstance(exec_path, bytes) else (exec_path + "\n").encode("utf-8")
            codec = encoding or ("cp1252" if text else None)
            return raw.decode(codec) if codec else raw

        def call(argv: list[str], env: dict[str, str]) -> int:
            calls.append(argv)
            return 0

        with mock.patch.object(gerda, "WINDOWS", True), \
                mock.patch.object(gerda.subprocess, "check_output", git), \
                mock.patch.object(gerda.subprocess, "call", call), \
                mock.patch.object(gerda.signal, "signal"), \
                mock.patch.object(gerda.sys, "argv", ["gerda", command, "-h"]), \
                mock.patch.object(gerda.sys, "stdout", io.TextIOWrapper(io.BytesIO())), \
                mock.patch.object(gerda.sys, "stderr", io.TextIOWrapper(io.BytesIO())):
            gerda.main()
        [argv] = calls
        return argv

    def git_install(self, *bashes: str, home: str = "Git") -> str:
        """A Git for Windows layout at `<tmp>/<home>` with the given bash.exe paths (relative to
        `home`; `../` reaches above it); returns the `git --exec-path` it answers
        (mingw64/libexec/git-core, as Git for Windows prints it)."""
        root = Path(tempfile.mkdtemp(prefix="gerda-git-"))
        self.addCleanup(shutil.rmtree, root, True)
        exec_path = root / home / "mingw64" / "libexec" / "git-core"
        exec_path.mkdir(parents=True)
        for rel in bashes:
            (root / home / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / home / rel).write_text("")
        return str(exec_path)

    def test_windows_runs_bash_scripts_under_git_bash(self) -> None:
        # The Windows test VM with WSL installed: a bare `bash` resolved System32\bash.exe (WSL)
        # before PATH. The bash comes from git's own install dir; bin/ first, since it puts Git's
        # /usr/bin on PATH and a bare usr/bin/bash.exe from cmd does not.
        both = self.git_install("bin/bash.exe", "usr/bin/bash.exe")
        git_root = Path(both).parents[2]
        self.assertEqual(self.windows_dispatch("decompile", both),
                         [str(git_root / "bin/bash.exe"), str(REPO / "scripts/dev/decompile.sh"), "-h"])
        usr_only = self.git_install("usr/bin/bash.exe")
        self.assertEqual(self.windows_dispatch("decompile", usr_only)[0],
                         str(Path(usr_only).parents[2] / "usr/bin/bash.exe"))
        # A per-user or scoop Git under a non-ASCII profile: a locale (cp1252) decode of git's
        # UTF-8 bytes raised UnicodeDecodeError (cp1251: a mojibake path, "Install Git").
        # (escaped: the tree is English-only; the name's UTF-8 holds 0x9D, undefined in cp1252)
        cyrillic = self.git_install("bin/bash.exe", home="Users/\u041d\u0438\u043a\u0430/Git")
        self.assertEqual(self.windows_dispatch("decompile", cyrillic)[0],
                         str(Path(cyrillic).parents[2] / "bin/bash.exe"))
        # neg-control: a python tool does not ask git at all
        self.assertEqual(self.windows_dispatch("ctl", RuntimeError("git asked for a .py tool"))[0],
                         sys.executable)

    def test_windows_refuses_a_bash_script_without_git_bash(self) -> None:
        # Never a silent fallback to `bash` (WSL's, on that machine): no git, a failing git, an
        # undecodable answer, a git without a bash (MinGit), or a MinGit with an unrelated bash
        # above its install dir each stop with the cure named and no child started.
        mingit = self.git_install()
        decoy = self.git_install("../bin/bash.exe", home="MinGit")
        for exec_path in (FileNotFoundError("git"),
                          subprocess.CalledProcessError(128, ["git", "--exec-path"]),
                          b"C:/\xff/mingw64/libexec/git-core\n",
                          mingit, decoy):
            with self.subTest(exec_path=exec_path):
                with self.assertRaises(SystemExit) as cm:
                    self.windows_dispatch("decompile", exec_path)
                self.assertIn("Git Bash", str(cm.exception.code))
                if isinstance(exec_path, bytes):  # git is there; its answer is the trouble
                    self.assertIn("is not UTF-8", str(cm.exception.code))
                    self.assertNotIn("Install Git", str(cm.exception.code))
                else:
                    self.assertIn("Install Git for Windows", str(cm.exception.code))
                if isinstance(exec_path, str):  # names where it looked
                    self.assertIn(f"install dir {Path(exec_path).parents[2]} (from {exec_path})",
                                  str(cm.exception.code))
        # An exec path with no install dir three levels up, absolute with one or two parents
        # (on POSIX only the depth check refuses; Windows Python sees no drive and refuses it
        # as relative), relative (only the absolute check refuses: its root would be the CWD)
        # or empty, stops before any bash is looked for — a bin/bash.exe in the CWD is never it.
        cwd = Path(tempfile.mkdtemp(prefix="gerda-cwd-"))
        self.addCleanup(shutil.rmtree, cwd, True)
        (cwd / "bin").mkdir()
        (cwd / "bin" / "bash.exe").write_text("")
        self.addCleanup(os.chdir, os.getcwd())
        os.chdir(cwd)
        for exec_path in ("/git-core", "/libexec/git-core", "mingw64/libexec/git-core", ""):
            with self.subTest(exec_path=exec_path):
                with self.assertRaises(SystemExit) as cm:
                    self.windows_dispatch("decompile", exec_path)
                self.assertIn(f"answered {exec_path!r}, not an absolute", str(cm.exception.code))

    def test_windows_ctrl_c_passes_the_child_exit_code_on(self) -> None:
        # Ctrl+C on a console reaches every process on it: the child ran its handler and exited,
        # while subprocess.call in the dispatcher killed it and died with a traceback. Linux
        # stand-in: SIGINT to the process group of a dispatcher patched to WINDOWS.
        tmp = Path(tempfile.mkdtemp(prefix="gerda-ctrlc-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        child = tmp / "child.py"
        child.write_text("import os, signal, time\n"
                         "signal.signal(signal.SIGINT, lambda *_: os._exit(42))\n"
                         "print('ready', flush=True)\n"
                         "time.sleep(30)\n")
        driver = _driver(f"g.WINDOWS = True; g.FLAT = {{'x': ({str(child)!r}, 'd')}}; "
                         "sys.argv = ['gerda', 'x']; sys.exit(g.main())")
        proc = subprocess.Popen([sys.executable, "-c", driver], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, start_new_session=True)
        self.addCleanup(proc.kill)
        assert proc.stdout is not None
        self.assertEqual(proc.stdout.readline().strip(), "ready")
        os.killpg(proc.pid, signal.SIGINT)
        _, err = proc.communicate(timeout=30)
        self.assertNotIn("Traceback", err)
        self.assertEqual(proc.returncode, 42, err)

    def test_posix_runs_the_tool_in_its_own_process(self) -> None:
        # The POSIX path is the old one, end to end through the real WINDOWS value: the tool
        # replaces the dispatcher (same pid), gets its argv untouched, no PYTHONUTF8 of ours and
        # a default SIGINT; a .sh runs under plain `bash`.
        tmp = Path(tempfile.mkdtemp(prefix="gerda-posix-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        (tmp / "tool.py").write_text(
            "import json, os, signal, sys\n"
            "print(json.dumps([os.getpid(), sys.argv[1:], os.environ.get('PYTHONUTF8'),\n"
            "                  signal.getsignal(signal.SIGINT) is signal.default_int_handler]))\n")
        (tmp / "tool.sh").write_text('printf "%s|%s|%s\\n" "$$" "$0" "$*"\n')
        payload = '{"a": 1}'
        env = {k: v for k, v in os.environ.items() if k != "PYTHONUTF8"}
        for name in ("tool.py", "tool.sh"):
            with self.subTest(tool=name):
                driver = _driver(f"g.FLAT = {{'x': ({str(tmp / name)!r}, 'd')}}; "
                                 f"sys.argv = ['gerda', 'x', 'send', {payload!r}]; "
                                 "sys.exit(g.main())")
                proc = subprocess.Popen([sys.executable, "-c", driver], stdout=subprocess.PIPE,
                                        stderr=subprocess.PIPE, text=True, env=env)
                out, err = proc.communicate(timeout=30)
                self.assertEqual(proc.returncode, 0, err)
                if name == "tool.py":
                    self.assertEqual(json.loads(out), [proc.pid, ["send", payload], None, True])
                else:
                    self.assertEqual(out, f"{proc.pid}|{tmp / name}|send {payload}\n")

    def test_posix_execs_the_tool(self) -> None:
        # NEG-CONTROL for the Windows branch: off Windows nothing changed — exec, no child process.
        class Exec(Exception):
            pass

        def execvp(file: str, argv: list[str]) -> None:
            raise Exec(file, argv)

        def no_call(*_: object, **__: object) -> int:
            raise AssertionError("child process on POSIX")

        with mock.patch.object(gerda, "WINDOWS", False), \
                mock.patch.object(gerda.subprocess, "call", no_call), \
                mock.patch.object(gerda.os, "execvp", execvp), \
                mock.patch.object(gerda.sys, "argv", ["gerda", "ctl", "status"]), \
                self.assertRaises(Exec) as cm:
            gerda.main()
        self.assertEqual(cm.exception.args, (sys.executable, [
            sys.executable, str(REPO / "scripts/ops/bridge_ctl.py"), "status"]))

    def test_unknown_command_exits_two(self) -> None:
        out = subprocess.run(
            [sys.executable, str(REPO / "gerda"), "definitely-not-a-command"],
            capture_output=True, text=True,
        )
        self.assertEqual(out.returncode, 2)


if __name__ == "__main__":
    unittest.main()
