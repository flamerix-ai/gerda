"""Shared fixture of the sandbox suites (test_sandbox_scripts.py, test_sandbox_steps.py).

No container, no network and no display: `curl`, `podman`, `unzip`, `xdotool`, `xprop` and the
launcher are stubs that log their argv and answer from environment variables, and sbx.sh is
sourced for its functions (it does not dispatch when sourced), so a test can redefine a function
the step calls before it calls the step.

The scripts run on a CLOSED PATH: the stub dir, then a dir of links to DEVSHELL_TOOLS only — the
tools the flake devShell itself provides. Nothing else on the host is reachable, so a test that
passes here does not lean on a host tool the CI runner lacks (procps' `pgrep` did, once). A
command the scripts call that is neither a stub nor such a tool fails the test that reached it,
even where the script hides the miss (`… 2>/dev/null || true`).
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SBX = REPO / "scripts" / "sandbox"

# curl stub: writes STUB_BODY to the -o file, prints STUB_EFFECTIVE for -w, logs the url.
CURL = r'''#!/usr/bin/env python3
import os, sys
a = sys.argv[1:]
url = [x for x in a if x.startswith("http")][-1]
open(os.environ["STUB_LOG"], "a").write("curl " + url + "\n")
if os.environ.get("STUB_CURL_RC", "0") != "0":
    sys.exit(int(os.environ["STUB_CURL_RC"]))
open(a[a.index("-o") + 1], "wb").write(os.environ.get("STUB_BODY", "body").encode())
if "-w" in a:
    sys.stdout.write(os.environ.get("STUB_EFFECTIVE", url))
'''

# podman stub: logs argv; existence, labels, rm results and `exec cat` answers come from the
# environment.
PODMAN = r'''#!/usr/bin/env python3
import os, sys
a = sys.argv[1:]
open(os.environ["STUB_LOG"], "a").write("podman " + " ".join(a) + "\n")
e = os.environ.get
if a[:2] == ["container", "exists"]: sys.exit(0 if e("STUB_EXISTS") == "1" else 1)
if a[:2] == ["volume", "exists"]: sys.exit(0 if e("STUB_VEXISTS") == "1" else 1)
if a[:2] == ["image", "exists"]: sys.exit(0)
if a[:1] == ["inspect"]: print(e("STUB_RUNNING", "false")); sys.exit(0)
if a[:2] == ["container", "inspect"]: print(e("STUB_CLABEL", "")); sys.exit(0)
if a[:2] == ["volume", "inspect"]: print(e("STUB_VLABEL", "")); sys.exit(0)
if a[:1] == ["rm"]: sys.exit(int(e("STUB_RM_RC", "0")))
if a[:2] == ["volume", "rm"]: sys.exit(int(e("STUB_VRM_RC", "0")))
if a[:1] == ["exec"] and "cat" in a:
    if e("STUB_STEP_RC") is None: sys.exit(1)
    print(e("STUB_STEP_RC")); sys.exit(0)
if a[:1] == ["exec"] and "tail" in a: print("(step log tail)"); sys.exit(0)
sys.exit(0)
'''

# unzip stub: only the `unzip -p <zip> <member>` form sbx.sh uses to read manifest.json.
UNZIP = r'''#!/usr/bin/env python3
import sys, zipfile
a = sys.argv[1:]
if a[0] != "-p":
    sys.exit("unzip stub: only -p")
try:
    sys.stdout.buffer.write(zipfile.ZipFile(a[1]).read(a[2]))
except Exception as e:
    sys.exit(f"unzip stub: {e}")
'''

# Fake launcher for the import (-d <root> -I <zip>). The windows it shows live in STUB_STATE, one
# "<id>\t<normal|dialog>\t<title>" line each: the main window plus the New Instance dialog. What
# happens once xdotool "pressed" Return (STUB_STATE.key) depends on STUB_IMPORT:
#   ok / notflame / othername   commit the instance (ManagedPackType=flame / without it / under
#                               another name) from STUB_FIXTURE
#   blocked      log the blocked files AND show the "Blocked mods found" dialog
#   blockedwin   show that dialog, log nothing
#   unknown      show an "Update available" dialog;  untitled  a dialog titled as the app
#   normalother  show a second NON-dialog window with another title
#   optional     show "Select Optional Mods"; two clicks in it commit the instance
#   optstuck     show "Select Optional Mods"; clicks change nothing
#   stuck        Return changes nothing;  hang  the dialog closes, nothing is ever committed
# and before any window: logfail = log "Instance creation failed", show only the main window;
# crash = exit at once.
LAUNCHER = r'''#!/usr/bin/env bash
echo "launcher DISPLAY=$DISPLAY $*" >> "$STUB_LOG"
root=$2 name=$(basename "$4" .zip)
MAIN=$'1\tnormal\tFreesm Launcher Maple 2.3.1'
NEWI=$'42\tdialog\tNew Instance — Freesm Launcher Maple 2.3.1'
OPT=$'46\tdialog\tSelect Optional Mods — Freesm Launcher Maple 2.3.1'
win() { printf '%s\n' "$@" > "$STUB_STATE.tmp"; mv "$STUB_STATE.tmp" "$STUB_STATE"; }
commit() {
  local n=${1:-$name}
  mkdir -p "$root/instances/$n"; cp -a "$STUB_FIXTURE/." "$root/instances/$n/minecraft"
  if [ "$STUB_IMPORT" = notflame ]; then printf '[General]\nname=%s\n' "$n"
  else printf '[General]\nManagedPackType=flame\nname=%s\n' "$n"; fi > "$root/instances/$n/instance.cfg"
}
trap 'exit 0' TERM
case "$STUB_IMPORT" in
  crash) exit 3 ;;
  logfail) echo '    1.0 Critical: Instance creation failed: no network'; win "$MAIN" ;;
  *) win "$MAIN" "$NEWI" ;;
esac
for i in $(seq 1 1200); do
  if [ -f "$STUB_STATE.key" ]; then
    rm -f "$STUB_STATE.key"
    case "$STUB_IMPORT" in
      ok|notflame) commit; win "$MAIN" ;;
      othername) commit "$name-1"; win "$MAIN" ;;
      blocked)
        echo '    1.0 Warning: Blocked mods found, displaying mod list (unknown:0)'
        echo '    1.0 Debug: [Blocked Mods Dialog] Mods List: QList({ name: "x.jar", websiteUrl: "https://example.invalid/x", hash: "0"})'
        win "$MAIN" $'45\tdialog\tBlocked mods found — Freesm Launcher Maple 2.3.1' ;;
      blockedwin) win "$MAIN" $'45\tdialog\tBlocked mods found — Freesm Launcher Maple 2.3.1' ;;
      unknown) win "$MAIN" $'43\tdialog\tUpdate available — Freesm Launcher Maple 2.3.1' ;;
      normalother) win "$MAIN" $'47\tnormal\tSome Window' ;;
      untitled) win "$MAIN" $'44\tdialog\tFreesm Launcher Maple 2.3.1' ;;
      optional|optstuck) win "$MAIN" "$OPT" ;;
      hang) win "$MAIN" ;;
    esac
  fi
  if [ "$STUB_IMPORT" = optional ] && [ -f "$STUB_STATE.clicks" ] && [ "$(wc -l < "$STUB_STATE.clicks")" -ge 2 ]; then
    rm -f "$STUB_STATE.clicks"; commit; win "$MAIN"
  fi
  sleep 0.05 & wait $!
done
'''

# xdotool stub: windows (and their titles) from STUB_STATE; a window not in it does not exist.
# STUB_XDO_FAIL=windowfocus fails that verb; STUB_GEOM=none|partial breaks getwindowgeometry.
XDOTOOL = r'''#!/usr/bin/env bash
echo "xdotool DISPLAY=$DISPLAY $*" >> "$STUB_LOG"
title() { awk -F'\t' -v id="$1" '$1 == id { print $3; f = 1 } END { exit !f }' "$STUB_STATE" 2>/dev/null; }
case "$1" in
  search) cut -f1 "$STUB_STATE" 2>/dev/null ;;
  getwindowname) title "$2" ;;
  getwindowgeometry)
    case "$STUB_GEOM" in
      none) exit 1 ;;
      partial) printf 'WINDOW=%s\nX=10\nY=20\n' "$3" ;;
      *) printf 'WINDOW=%s\nX=10\nY=20\nWIDTH=550\nHEIGHT=310\nSCREEN=0\n' "$3" ;;
    esac ;;
  windowfocus) [ "$STUB_XDO_FAIL" = windowfocus ] && exit 1 ;;
  key) [ "$2" = Return ] && touch "$STUB_STATE.key" ;;
  mousemove) echo click >> "$STUB_STATE.clicks" ;;
esac
exit 0
'''

# xprop stub: a window's type from STUB_STATE, in the form `xprop -id <w> <props>` prints. A
# dialog carries both marks Qt sets (STUB_XPROP=both, the default), or only its window type
# (type), or only WM_TRANSIENT_FOR (transient).
XPROP = r'''#!/usr/bin/env bash
echo "xprop DISPLAY=$DISPLAY $*" >> "$STUB_LOG"
t=$(awk -F'\t' -v id="$2" '$1 == id { print $2 }' "$STUB_STATE" 2>/dev/null)
[ -n "$t" ] || { echo "X Error: BadWindow" >&2; exit 1; }
style=${STUB_XPROP:-both}
if [ "$t" = dialog ] && [ "$style" != transient ]; then echo "_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_DIALOG"
else echo "_NET_WM_WINDOW_TYPE(ATOM) = _NET_WM_WINDOW_TYPE_NORMAL"; fi
if [ "$t" = dialog ] && [ "$style" != type ]; then echo "WM_TRANSIENT_FOR(WINDOW): window id # 0x1"
else echo "WM_TRANSIENT_FOR:  not found."; fi
'''


# pgrep / pkill stub (one body, the verb is the file name): the forms sbx.sh and the tests use —
# `pgrep -f [-a] [--] <regex>`, `pkill -f [--] <regex>` — matched against the full command line of
# every process in /proc (Linux), as procps does; the stub's own process never matches. Any other
# form exits 2 AND is recorded as a miss (see MISSING_HANDLER), so a new use fails its test even
# behind `|| true`.
PGREP = r'''#!/usr/bin/env python3
import os, re, signal, sys
verb = os.path.basename(sys.argv[0])
a = sys.argv[1:]
flags = ""
while a and a[0].startswith("-") and a[0] != "--":
    flags += a.pop(0)[1:]
if a[:1] == ["--"]:
    a.pop(0)
if "f" not in flags or set(flags) - set("fa" if verb == "pgrep" else "f") or len(a) != 1:
    miss = f"{verb} (stub has no form {sys.argv[1:]})"
    if os.environ.get("SBX_TEST_MISSING"):
        open(os.environ["SBX_TEST_MISSING"], "a").write(miss + "\n")
    print(miss, file=sys.stderr)
    sys.exit(2)
pat, me, hits = re.compile(a[0]), os.getpid(), []
for d in sorted(os.listdir("/proc"), key=lambda d: int(d) if d.isdigit() else 0):
    if not d.isdigit() or int(d) == me:
        continue
    try:
        cmd = open(f"/proc/{d}/cmdline", "rb").read().rstrip(b"\0").replace(b"\0", b" ").decode(errors="replace")
    except OSError:
        continue   # it exited meanwhile
    if cmd and pat.search(cmd):
        hits.append((int(d), cmd))
for pid, cmd in hits:
    if verb == "pkill":
        try: os.kill(pid, signal.SIGTERM)
        except ProcessLookupError: pass
    else:
        print(f"{pid} {cmd}" if "a" in flags else pid)
sys.exit(0 if hits else 1)
'''

# setsid stub (util-linux is not in the devShell): run the command in a new session, forking
# first when the caller leads its process group, as setsid(1) does without -w.
SETSID = r'''#!/usr/bin/env python3
import os, sys
if os.getpgrp() == os.getpid() and os.fork():
    sys.exit(0)
os.setsid()
os.execvp(sys.argv[1], sys.argv[1:])
'''

# What the flake devShell (`nix develop`) provides besides the stubs: bash, python3 and the
# stdenv's coreutils, findutils, diffutils, grep, sed, gawk, tar, gzip. Exactly these are linked
# onto a test's PATH. Add a name here only when the devShell has it — not because this host does.
DEVSHELL_TOOLS = (
    "bash", "sh", "env", "python3", "git",
    # coreutils
    "basename", "cat", "chmod", "chown", "comm", "cp", "cut", "date", "dirname", "du", "echo",
    "false", "head", "id", "install", "join", "ln", "ls", "mkdir", "mkfifo", "mktemp", "mv",
    "nohup", "printf", "pwd", "readlink", "realpath", "rm", "rmdir", "seq", "sha1sum", "sha256sum",
    "sleep", "sort", "stat", "sync", "tail", "tee", "test", "timeout", "touch", "tr", "true",
    "uname", "uniq", "wc", "yes",
    # findutils, diffutils, grep, sed, gawk, tar, gzip
    "find", "xargs", "cmp", "diff", "grep", "sed", "awk", "tar", "gzip",
)

# Every miss of a bash run under the fixture lands in $SBX_TEST_MISSING, besides bash's own message;
# exported, so sbx.sh, provision.sh and the bash stubs all inherit it.
MISSING_HANDLER = '() { echo "$1" >> "$SBX_TEST_MISSING"; echo "bash: $1: command not found" >&2; return 127; }'


def sha(body: str) -> str:
    return hashlib.sha256(body.encode()).hexdigest()


def tracked_files() -> list[Path]:
    """Every file git tracks in this checkout (a scan over it cannot miss a new file)."""
    out = subprocess.run(["git", "-C", str(REPO), "ls-files", "-z"], capture_output=True, check=True).stdout
    return [REPO / p for p in out.decode().split("\0") if p and (REPO / p).is_file()]


def _have_tools() -> bool:
    return all(shutil.which(t) for t in ("bash", "sha256sum", "xargs"))


@unittest.skipUnless(_have_tools(), "needs bash, sha256sum and xargs")
class Sandbox(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.tmp)
        self.home, self.cache, self.bin = self.tmp / "home", self.tmp / "cache", self.tmp / "bin"
        self.tools = self.tmp / "tools"
        for d in (self.home, self.cache, self.bin, self.tools):
            d.mkdir()
        for name, body in (("curl", CURL), ("podman", PODMAN), ("unzip", UNZIP), ("pgrep", PGREP),
                           ("pkill", PGREP), ("setsid", SETSID)):
            self.stub(name, body)
        for name in DEVSHELL_TOOLS:
            self.tool(name)
        self.log = self.tmp / "stub.log"
        self.log.touch()
        self.missing = self.tmp / "missing.log"
        self.missing.touch()
        self.addCleanup(self.assert_nothing_missing)
        self.env = {
            **os.environ, "PATH": f"{self.bin}:{self.tools}", "HOME": str(self.home),
            "SBX_CACHE": str(self.cache), "STUB_LOG": str(self.log),
            "SBX_TEST_MISSING": str(self.missing), "BASH_FUNC_command_not_found_handle%%": MISSING_HANDLER,
        }

    def tool(self, name: str) -> None:
        """Link the host's `name` onto the closed PATH (DEVSHELL_TOOLS, or a test's own real binary)."""
        real = shutil.which(name)
        if real is None:
            raise AssertionError(f"{name} is not on PATH — run the suite in the flake devShell (nix develop)")
        (self.tools / name).symlink_to(real)

    def assert_nothing_missing(self) -> None:
        missing = sorted(set(self.missing.read_text().splitlines()))
        self.assertEqual(missing, [], "the scripts called commands that are neither a stub nor in "
                         "DEVSHELL_TOOLS (sandbox_fixture.py) — stub them, or the run depends on this host")

    def stub(self, name: str, body: str, where: Path | None = None) -> Path:
        path = (where or self.bin) / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(body)
        path.chmod(0o755)
        return path

    def sbx(self, snippet: str, timeout: int = 60, **env: str) -> subprocess.CompletedProcess[str]:
        """Source sbx.sh, then run `snippet` (bash) with its functions."""
        return subprocess.run(
            ["bash", "-c", f'source "$SBX_SH"\n{snippet}'], env={**self.env, "SBX_SH": str(SBX / "sbx.sh"), **env},
            capture_output=True, text=True, timeout=timeout,
        )

    def provision(self, *args: str, **env: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["bash", str(SBX / "provision.sh"), *args],
                              env={**self.env, "SBX_NAME": "t", **env},
                              capture_output=True, text=True, timeout=60)

    def calls(self) -> list[str]:
        return self.log.read_text().splitlines()

    def mark(self, *names: str) -> None:
        """Create ~/.sbx/<name>.done marks, as finished sub-steps leave them."""
        state = self.home / ".sbx"
        state.mkdir(exist_ok=True)
        for n in names:
            (state / f"{n}.done").touch()


class Pack(Sandbox):
    """A two-file modpack: one jar, one resource pack; the pins list both, with their dir."""

    FILES = {"mods/a.jar": "jar a", "resourcepacks/r p.zip": "pack r"}
    IDS = [(11, 21), (12, 22)]

    def setUp(self) -> None:
        super().setUp()
        self.zip = self.tmp / "pack.zip"
        with zipfile.ZipFile(self.zip, "w") as z:
            files = ",".join(f'{{"projectID": {p}, "fileID": {f}}}' for p, f in self.IDS)
            z.writestr("manifest.json", '{"minecraft": {"version": "1.19.4", "modLoaders": [{"id": "fabric-0.14.21", '
                       f'"primary": true}}]}}, "files": [{files}]}}')
        self.pins = self.tmp / "pins.tsv"
        self.pins.write_text(self.pin_rows(self.FILES))
        self.game = self.tmp / "game"

    def pin_rows(self, files: dict[str, str]) -> str:
        return "".join(f"{p}\t{f}\t{Path(n).parent}\t{Path(n).name}\t{sha(b)}\n"
                       for (p, f), (n, b) in zip(self.IDS, files.items(), strict=True))

    def write_files(self, root: Path, files: dict[str, str]) -> None:
        for rel, body in files.items():
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_text(body)
