"""Both git hooks re-enter the flake devShell when the gate's tools are missing — and only then.

git started outside the devShell (a plain shell, an IDE, an agent) runs `.githooks/pre-commit` and
`.githooks/pre-push` without `just` / `gitleaks` on PATH; the private snapshot guard then failed
~99 tests on a missing gitleaks, not on the commit. Each hook now execs itself once through
`nix develop` — but only where the gate cannot pass as is: no `just`, or the private repo
(`scripts/private/`) without gitleaks, and only with a `flake.nix` and a `nix` to enter it. The
first cut re-entered on a missing gitleaks in ANY tree: a fork (no gitleaks needed) paid for nix
on every commit, and a scratch repo with no flake failed every run with `… is not part of a
flake` (test_pre_push_log.py, 54 failures outside the devShell).

The hooks run for real in a scratch repo on a HERMETIC PATH — the caller's own just / gitleaks /
nix never leak in, so the suite answers the same inside and outside the devShell. `nix` is a stub
that logs its argv and stdin, then runs the `-c` command with a "devShell" bin dir in front of
PATH, the way `nix develop` hands over. Pinned: the re-entry on both trigger axes (with
pre-push's ref lines on the re-entered hook's stdin), and every state that must NOT re-enter:
marker set, no nix, fork without gitleaks, no flake, tools present, a devShell that still lacks
the tool (re-enters once, not forever), and pre-push's delete-only fast path.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -t scripts/tests -p 'test_hook_devshell.py' -v
"""
from __future__ import annotations

import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
import machine_root  # noqa: E402

HOOK_DIR = REPO / ".githooks"  # a known-bad run points this at mutated copies
HOOKS = ("pre-commit", "pre-push")
# Each hook's first gate stage: pre-commit runs only the TS half, pre-push the full check.
GATE = {"pre-commit": "check-ts", "pre-push": "check"}
ZERO = "0" * 40
# What the hooks and the stubs need from the system, linked into the hermetic PATH. Stubs are
# `#!/bin/sh` scripts, so `sh` itself is not on this list.
SYSTEM_TOOLS = ("bash", "git", "cat", "tail")
NOTICE = "just/gitleaks not on PATH — re-entering the flake devShell"


@unittest.skipUnless(all(shutil.which(t) for t in SYSTEM_TOOLS), "bash, git, cat, tail required")
class HookDevShellTests(unittest.TestCase):
    def fresh(self) -> None:
        # One scratch repo per subTest: a case must not see the last one's logs or markers.
        self.root = Path(tempfile.mkdtemp(prefix="hook-devshell-")).resolve()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.repo = self.root / "repo"
        self.logs = self.root / "logs"
        self.sys = self.root / "sys"
        for d in (self.repo, self.logs, self.sys):
            d.mkdir()
        for tool in SYSTEM_TOOLS:
            (self.sys / tool).symlink_to(shutil.which(tool))
        # The marker is DROPPED, not inherited: this suite itself runs inside a re-entered
        # pre-push, where the caller's env carries GERDA_HOOK_DEVSHELL=1.
        self.env = {k: v for k, v in machine_root.clean_git_env().items()
                    if k != "GERDA_HOOK_DEVSHELL"}
        self.env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1",
                        GIT_AUTHOR_NAME="t", GIT_AUTHOR_EMAIL="t@example.invalid",
                        GIT_COMMITTER_NAME="t", GIT_COMMITTER_EMAIL="t@example.invalid")
        self.env.pop("NIX_STUB_DEPTH", None)
        subprocess.run(["git", "init", "-q"], cwd=self.repo, env=self.env, check=True)
        subprocess.run(["git", "commit", "-q", "--allow-empty", "-m", "x"], cwd=self.repo,
                       env=self.env, check=True)
        self.head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=self.repo, env=self.env,
                                   check=True, capture_output=True, text=True).stdout.strip()
        (self.repo / ".githooks").mkdir()
        for hook in HOOKS:
            shutil.copy(HOOK_DIR / hook, self.repo / ".githooks" / hook)

    def write_exe(self, path: Path, body: str) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"#!/bin/sh\n{body}", "utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def tools(self, where: str, names: tuple[str, ...], fail: tuple[str, ...] = ()) -> Path:
        # A stage stub records WHICH bin dir answered, so the gate is seen running with the
        # devShell's tools after a re-entry and with the caller's own without one. A stub in
        # `fail` then exits 3 — a gate stage failing.
        bindir = self.root / where
        bindir.mkdir(exist_ok=True)
        for name in names:
            tail = "exit 3\n" if name in fail else ""
            self.write_exe(bindir / name,
                           f"echo \"{name}@{where} $*\" >> '{self.logs}/stages'\n{tail}")
        return bindir

    def nix_stub(self, devbin: Path) -> Path:
        # `nix develop <flake> -c <cmd…>`: log argv (one per line, `--` after each call) and stdin
        # (per call), then run <cmd> the way the devShell would — its bin dir first on PATH, the
        # logged stdin on its stdin. A depth cap turns a re-entry loop into a countable failure
        # instead of a hang.
        nixbin = self.root / "nixbin"
        self.write_exe(nixbin / "nix", (
            "depth=$((${NIX_STUB_DEPTH:-0} + 1)); export NIX_STUB_DEPTH=$depth\n"
            f"for a in \"$@\"; do echo \"$a\"; done >> '{self.logs}/nix.argv'\n"
            f"echo -- >> '{self.logs}/nix.argv'\n"
            "[ \"$depth\" -le 3 ] || exit 98\n"
            "[ \"$1\" = develop ] && [ \"$3\" = -c ] || exit 97\n"
            f"cat > '{self.logs}/nix.stdin.'$depth\n"
            "shift 3\n"
            f"PATH='{devbin}':\"$PATH\" exec \"$@\" < '{self.logs}/nix.stdin.'$depth\n"))
        return nixbin

    def run_hook(self, hook: str, *, outer: tuple[str, ...],
                 dev: tuple[str, ...] = ("just", "gitleaks"), nix: bool = True, private: bool = True, flake: bool = True,
                 refs: str | None = None, marker: bool = False,
                 dev_fail: tuple[str, ...] = ()) -> subprocess.CompletedProcess[str]:
        if private:
            (self.repo / "scripts" / "private").mkdir(parents=True, exist_ok=True)
        if flake:
            (self.repo / "flake.nix").write_text("{}\n", "utf-8")
        # bun / python3 are pre-push stages the devShell question never touches: always present.
        path = [self.tools("outer", (*outer, "bun", "python3"))]
        if nix:
            path.insert(0, self.nix_stub(self.tools("devshell", dev, fail=dev_fail)))
        path.append(self.sys)
        env = {**self.env, "PATH": os.pathsep.join(map(str, path))}
        if marker:
            env["GERDA_HOOK_DEVSHELL"] = "1"
        if refs is None:
            refs = f"refs/heads/dev {self.head} refs/heads/dev {ZERO}\n" \
                   f"refs/heads/dev {self.head} refs/heads/main {ZERO}\n"
        stdin = {"input": refs} if hook == "pre-push" else {"stdin": subprocess.DEVNULL}
        return subprocess.run(["bash", str(self.repo / ".githooks" / hook),
                               "origin", "https://example.invalid/r.git"],
                              cwd=self.repo, env=env, capture_output=True, text=True,
                              timeout=60, **stdin)

    def nix_calls(self) -> list[list[str]]:
        log = self.logs / "nix.argv"
        if not log.exists():
            return []
        calls, cur = [], []
        for line in log.read_text("utf-8").splitlines():
            if line == "--":
                calls.append(cur)
                cur = []
            else:
                cur.append(line)
        return calls

    def stages(self) -> list[str]:
        log = self.logs / "stages"
        return log.read_text("utf-8").splitlines() if log.exists() else []

    def test_a_missing_tool_reenters_the_devshell_once(self) -> None:
        # The two trigger axes: no `just` at all (a fork too — the gate cannot run without it),
        # and the private repo without gitleaks. The gate must then run with the devShell's
        # `just`, the hook's own args must reach the re-entry, and pre-push's ref lines — read
        # by the fast path BEFORE the re-entry — must arrive on the re-entered hook's stdin.
        cases = {"no just, fork": dict(outer=(), private=False),
                 "no gitleaks, private repo": dict(outer=("just",), private=True)}
        for hook in HOOKS:
            for case, kw in cases.items():
                with self.subTest(hook=hook, case=case):
                    self.fresh()
                    refs = (f"refs/heads/dev {self.head} refs/heads/dev {ZERO}\n"
                            f"refs/heads/x {self.head} refs/heads/main {ZERO}\n")
                    res = self.run_hook(hook, refs=refs, **kw)
                    self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
                    hook_path = str(self.repo / ".githooks" / hook)
                    self.assertEqual(self.nix_calls(), [[
                        "develop", str(self.repo), "-c", "bash", hook_path,
                        "origin", "https://example.invalid/r.git"]])
                    self.assertIn(f"{hook}: {NOTICE}", res.stderr)
                    self.assertEqual(self.stages()[0], f"just@devshell {GATE[hook]}")
                    if hook == "pre-push":
                        self.assertEqual((self.logs / "nix.stdin.1").read_text("utf-8"), refs)

    def test_states_that_must_not_reenter(self) -> None:
        # NEG-CONTROLS, each its own axis of the trigger: the gate runs with the caller's own
        # tools and nix is never called. "no flake" and "fork without gitleaks" are the two
        # first-cut defects (the scratch repo of test_pre_push_log.py, a fork paying for nix).
        cases = {
            "marker already set": dict(outer=("just",), marker=True),
            "no nix on PATH": dict(outer=("just",), nix=False),
            "fork without gitleaks": dict(outer=("just",), private=False),
            "private repo without flake.nix": dict(outer=("just",), flake=False),
            "tools present": dict(outer=("just", "gitleaks")),
        }
        for hook in HOOKS:
            for case, kw in cases.items():
                with self.subTest(hook=hook, case=case):
                    self.fresh()
                    res = self.run_hook(hook, **kw)
                    self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
                    self.assertEqual(self.nix_calls(), [])
                    self.assertNotIn(NOTICE, res.stderr)
                    self.assertEqual(self.stages()[0], f"just@outer {GATE[hook]}")

    def test_a_devshell_still_lacking_the_tool_reenters_only_once(self) -> None:
        # NEG-CONTROL for the loop guard: the marker must be EXPORTED, or the re-entered hook —
        # still without gitleaks — re-enters again (the stub caps it at 3 and exits 98).
        for hook in HOOKS:
            with self.subTest(hook=hook):
                self.fresh()
                res = self.run_hook(hook, outer=("just",), dev=("just",))
                self.assertEqual(len(self.nix_calls()), 1, res.stdout + res.stderr)
                self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
                self.assertEqual(self.stages()[0], f"just@devshell {GATE[hook]}")

    def test_a_gate_failing_inside_the_devshell_fails_the_hook(self) -> None:
        # NEG-CONTROL for the exit status: every other re-entry case passes, so a re-entry that
        # swallowed the gate's rc (`nix develop … || :; exit 0` in place of `exec`) would leave
        # them all green while turning every failing gate green for exactly these callers.
        for hook in HOOKS:
            with self.subTest(hook=hook):
                self.fresh()
                res = self.run_hook(hook, outer=(), private=False, dev_fail=("just",))
                self.assertEqual(len(self.nix_calls()), 1, res.stdout + res.stderr)
                self.assertEqual(res.returncode, 3, res.stdout + res.stderr)

    def test_a_delete_only_push_never_pays_for_nix(self) -> None:
        # NEG-CONTROL for the placement: the re-entry sits BELOW pre-push's fast path, so
        # `git push origin --delete <branch>` skips the gate without entering the devShell.
        self.fresh()
        res = self.run_hook("pre-push", outer=(),
                            refs=f"(delete) {ZERO} refs/heads/gone {self.head}\n")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("branch deletion only", res.stdout)
        self.assertEqual(self.nix_calls(), [])
        self.assertEqual(self.stages(), [])


if __name__ == "__main__":
    unittest.main()
