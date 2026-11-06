"""The pre-push hook sends the gate's output to a log file and prints one summary line.

The gate (`just check` + build + bundle validation) prints thousands of lines; before this, all
of them landed in the pushing terminal (and in an agent's context). The hook now writes them to
`<git-dir>/pre-push.log` and prints one `pre-push: OK …` line — or, on failure, the failing
command plus the log's tail.

The hook runs for real in a scratch repo, with `just` / `bun` / `python3` replaced by stubs on
PATH that write marker lines to stdout, then stderr, then stdout again, and exit with a chosen
code. Neg-controls, each swept over every stage: a failing stage must still fail the push, put
both of its streams (in order) IN FRONT of the user under the FAILED header, and stop the later
stages; bash's own report of a stage killed by a signal must come through the log too; a signal
to the hook (SIGINT/SIGTERM trapped, HUP/USR1/ALRM untrapped) must never print OK. Also pinned:
the 40-line tail, the per-worktree log path, a rerun replacing the previous log, the private
repo's extra snapshot leak scan stage (`just pubsim`, run only when `scripts/private/` exists),
and the refs git feeds on stdin: a delete-only push skips the gate, and a pushed commit that is
not HEAD but shares history with it is refused before any stage runs.

Hook hygiene: this suite runs inside `.githooks/pre-push`; every fixture git call and the hook
itself get `machine_root.clean_git_env()`, so nothing here can touch the real index.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -t scripts/tests -v
"""
from __future__ import annotations

import itertools
import os
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
import machine_root  # noqa: E402

GIT = shutil.which("git")
BASH = shutil.which("bash")
STAGES = ("just", "bun", "python3")
STAGE_CMDS = {"just": "just check", "bun": "bun run build",
              "python3": "python3 scripts/ops/sync.py --validate-only"}
ZERO = "0" * 40  # the sha git feeds the hook for the missing side of a ref update
OK_FORK = "pre-push: OK — check, build and bundle validation passed"
OK_PRIVATE = "pre-push: OK — check, build, bundle validation and the snapshot leak scan passed"


@unittest.skipUnless(GIT and BASH, "git and bash are required")
class PrePushLogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="prepush-"))
        self.addCleanup(shutil.rmtree, self.root, True)
        self.repo = self.root / "repo"
        self.bin = self.root / "bin"
        self.repo.mkdir()
        self.bin.mkdir()
        # GERDA_HOOK_DEVSHELL: the stage stubs ARE the gate's tools here. The scratch repo has no
        # flake.nix, so the hook would not re-enter anyway; the marker keeps this suite about the
        # log even if that condition changes. The re-entry itself is pinned in
        # test_hook_devshell.py.
        self.env = {**machine_root.clean_git_env(), "GIT_CONFIG_GLOBAL": os.devnull,
                    "GIT_CONFIG_NOSYSTEM": "1", "GERDA_HOOK_DEVSHELL": "1"}
        subprocess.run(["git", "init", "-q"], cwd=self.repo, env=self.env, check=True)
        hooks = self.repo / ".githooks"
        hooks.mkdir()
        shutil.copy(REPO / ".githooks" / "pre-push", hooks / "pre-push")
        self.log = Path(subprocess.run(
            ["git", "rev-parse", "--path-format=absolute", "--git-path", "pre-push.log"],
            cwd=self.repo, env=self.env, check=True, capture_output=True, text=True,
        ).stdout.strip())

    def stub(self, name: str, rc: int = 0, only: str | None = None) -> None:
        path = self.bin / name
        # Real stages write to BOTH streams (just echoes recipes and unittest reports on stderr):
        # a stdout-only stub cannot see a hook that logs stdout but leaks stderr. Both orders
        # occur, so stdout also comes AFTER stderr: with `>"$log" 2>>"$log"` the streams keep
        # separate offsets and the later stdout write overwrites the stderr line.
        # `only`: exit `rc` for that first argument alone (one `just` recipe), 0 for the rest.
        end = f"exit {rc}\n" if only is None else f"[ \"$1\" = '{only}' ] && exit {rc}\nexit 0\n"
        path.write_text(f"#!/bin/sh\necho 'STAGE-{name}' \"$@\"\necho 'STAGE-{name}-err' >&2\n"
                        f"echo 'STAGE-{name}-after'\n{end}", "utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def run_hook(self, refs: str | None = None) -> subprocess.CompletedProcess[str]:
        # `refs`: the "<local_ref> <local_sha> <remote_ref> <remote_sha>" lines git feeds on
        # stdin; None = an empty, non-tty stdin.
        env = {**self.env, "PATH": f"{self.bin}{os.pathsep}{self.env['PATH']}"}
        stdin = {"stdin": subprocess.DEVNULL} if refs is None else {"input": refs}
        return subprocess.run(["bash", str(self.repo / ".githooks" / "pre-push")], cwd=self.repo,
                              env=env, capture_output=True, text=True, **stdin)

    def git(self, *args: str, stdin: str | None = None) -> str:
        env = {**self.env, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"}
        return subprocess.run(["git", *args], cwd=self.repo, env=env, check=True, input=stdin,
                              capture_output=True, text=True).stdout.strip()

    def commit(self, msg: str) -> str:
        self.git("commit", "-q", "--allow-empty", "-m", msg)
        return self.git("rev-parse", "HEAD")

    def test_success_prints_one_line_and_logs_every_stage(self) -> None:
        for name in STAGES:
            self.stub(name)
        res = self.run_hook()
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(res.stdout.splitlines(), [f"{OK_FORK} (log: {self.log})"])
        self.assertEqual(res.stderr, "")
        logged = self.log.read_text("utf-8")
        for name in STAGES:
            self.assertIn(f"STAGE-{name}-err\nSTAGE-{name}-after\n", logged)  # both streams, in order
            self.assertNotIn(f"STAGE-{name}", res.stdout + res.stderr)

    def test_each_failing_stage_fails_the_push_and_shows_its_tail(self) -> None:
        # NEG-CONTROL, swept over EVERY stage: the redirect must not swallow a failure — rc, the
        # failing command and its output reach the terminal, and the stages after it never run.
        # One case per stage: a `|| true` on any one line, or a hard-coded stage name in the
        # message, fails that stage's case. Distinct codes catch a hard-coded rc.
        for i, (name, rc) in enumerate(zip(STAGES, (1, 3, 4))):
            with self.subTest(stage=name):
                for other in STAGES:
                    self.stub(other, rc=rc if other == name else 0)
                res = self.run_hook()
                self.assertEqual(res.returncode, rc)
                self.assertEqual(res.stdout, "")
                self.assertIn(f"pre-push: FAILED (rc={rc}) at: {STAGE_CMDS[name]}", res.stderr)
                self.assertIn(f"STAGE-{STAGE_CMDS[name]}", res.stderr)
                # The stage's stderr comes through the LOG: once, inside the tail printed under
                # the FAILED header, in order with its stdout. A stderr leaking straight to the
                # terminal shows up ABOVE the header.
                lines = res.stderr.splitlines()
                self.assertEqual(lines.count(f"STAGE-{name}-err"), 1)
                self.assertLess(next(hdr for hdr, s in enumerate(lines)
                                     if s.startswith("pre-push: FAILED")),
                                lines.index(f"STAGE-{name}-err"))
                self.assertIn(f"STAGE-{name}-err\nSTAGE-{name}-after\n", res.stderr)
                logged = self.log.read_text("utf-8")
                for later in STAGES[i + 1:]:
                    self.assertNotIn(f"STAGE-{later}", logged)

    def test_bash_reporting_a_killed_stage_lands_in_the_tail(self) -> None:
        # NEG-CONTROL: a stage's own output is not all that reaches the hook's stderr — bash
        # itself reports a stage that dies by a signal ("… Killed  just check"). A hook that
        # redirects each stage with `2>&1` instead of its own stderr in `exec` logs every stub
        # stream above, and leaks only bash's diagnostics. A stage that SIGKILLs itself makes
        # bash print one; it must come through the log, below the FAILED header. Swept over
        # every stage so a kill in any of them is shown to reach the log; bash's own stderr is
        # one stream for the whole hook, so that mutant fails the case of every stage at once.
        self.env["LC_ALL"] = "C"  # "Killed" is strsignal() text; pin the locale
        for name in STAGES:
            with self.subTest(stage=name):
                for other in STAGES:
                    self.stub(other)
                path = self.bin / name
                path.write_text(f"#!/bin/sh\necho 'STAGE-{name}'\nkill -9 $$\n", "utf-8")
                path.chmod(path.stat().st_mode | stat.S_IXUSR)
                res = self.run_hook()
                rc = 128 + signal.SIGKILL
                self.assertEqual(res.returncode, rc)
                self.assertIn(f"pre-push: FAILED (rc={rc}) at: {STAGE_CMDS[name]}", res.stderr)
                lines = res.stderr.splitlines()
                killed = [n for n, s in enumerate(lines) if "Killed" in s]
                self.assertEqual(len(killed), 1, res.stderr)
                self.assertLess(next(hdr for hdr, s in enumerate(lines)
                                     if s.startswith("pre-push: FAILED")), killed[0])

    def test_failure_shows_exactly_the_last_40_lines(self) -> None:
        # Real logs run to thousands of lines; a one-line stub cannot tell `tail -n 40` from
        # `tail -n 1`. The failing stage prints 60 numbered lines, so the tail is LINE-21..60.
        path = self.bin / "just"
        path.write_text("#!/bin/sh\ni=1\nwhile [ $i -le 60 ]; do echo \"LINE-$i\"; i=$((i+1)); done\n"
                        "exit 1\n", "utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        self.stub("bun")
        self.stub("python3")
        lines = self.run_hook().stderr.splitlines()
        self.assertIn("LINE-21", lines)
        self.assertIn("LINE-60", lines)
        self.assertNotIn("LINE-20", lines)

    def test_log_is_per_worktree_not_shared(self) -> None:
        # Two worktree sessions pushing at once must not overwrite each other's log. In a plain
        # checkout `--git-path` and the common dir are the same file, so only a linked worktree
        # tells them apart.
        env = {**self.env, "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@example.invalid",
               "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@example.invalid"}
        subprocess.run(["git", "commit", "-q", "--allow-empty", "-m", "x"], cwd=self.repo,
                       env=env, check=True)
        wt = self.root / "wt"
        subprocess.run(["git", "worktree", "add", "-q", str(wt)], cwd=self.repo, env=env,
                       check=True)
        for name in STAGES:
            self.stub(name)
        res = subprocess.run(["bash", str(self.repo / ".githooks" / "pre-push")], cwd=wt,
                             env={**env, "PATH": f"{self.bin}{os.pathsep}{env['PATH']}"},
                             stdin=subprocess.DEVNULL, capture_output=True, text=True)
        self.assertEqual(res.returncode, 0, res.stderr)
        per_wt = self.repo / ".git" / "worktrees" / "wt" / "pre-push.log"
        self.assertIn("STAGE-just", per_wt.read_text("utf-8"))
        self.assertFalse((self.repo / ".git" / "pre-push.log").exists())

    def test_a_signal_never_prints_ok(self) -> None:
        # NEG-CONTROL: bash runs the EXIT trap with $? = 0 after ANY fatal signal, so a hook that
        # keys "OK" on $? printed "pre-push: OK … passed" on Ctrl-C, a closed terminal (HUP), a
        # supervisor's kill. Two delivery axes: the whole group (Ctrl-C) kills the stage too; the
        # hook's pid alone (`kill <pid>`) lets the stage finish, so only the trap's `exit` makes
        # the hook fail — without it the hook exits 0 and git pushes. The three untrapped signals
        # kill the hook by re-raise; the gate_done sentinel only keeps "OK" off the terminal.
        # Third axis — the stage the signal lands in: a sentinel set before the LAST stage
        # passes a lane that only ever interrupts the first one.
        cases = [(signal.SIGINT, 130, "interrupted (SIGINT)"),
                 (signal.SIGTERM, 143, "terminated (SIGTERM)"),
                 (signal.SIGHUP, None, "at: before the gate finished"),
                 (signal.SIGUSR1, None, "at: before the gate finished"),
                 (signal.SIGALRM, None, "at: before the gate finished")]
        for stage, (sig, code, why), group in itertools.product(STAGES, cases, (True, False)):
            with self.subTest(stage=stage, sig=sig.name, group=group):
                out, err, rc = self.run_hook_killed(sig, group, stage)
                self.assertNotIn("pre-push: OK", out + err)
                self.assertNotEqual(rc, 0)
                if code is not None:
                    self.assertEqual(rc, code)
                    self.assertIn(f"pre-push: FAILED (rc={code})", err)
                else:
                    self.assertLess(rc, 0)  # died BY the signal, not a made-up exit code
                    self.assertIn("pre-push: FAILED (killed by a signal)", err)
                self.assertIn(why, err)

    def run_hook_killed(self, sig: signal.Signals, group: bool,
                        stage: str) -> tuple[str, str, int]:
        # `stage` blocks until released AFTER the signal: no fixed sleep to pay for on the
        # pid-only axis, and no window where the gate finishes before the signal lands.
        release = self.root / "release"
        release.unlink(missing_ok=True)
        for name in STAGES:
            self.stub(name)
        path = self.bin / stage
        path.write_text(f"#!/bin/sh\necho STAGE-{stage}\n"
                        f"while [ ! -e '{release}' ]; do sleep 0.05; done\n", "utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)
        env = {**self.env, "PATH": f"{self.bin}{os.pathsep}{self.env['PATH']}"}
        self.log.unlink(missing_ok=True)  # the wait below must see THIS run's stage
        proc = subprocess.Popen(["bash", str(self.repo / ".githooks" / "pre-push")],
                                cwd=self.repo, env=env, stdin=subprocess.DEVNULL,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                text=True, start_new_session=True)
        self.addCleanup(self.reap, proc)
        deadline = time.monotonic() + 10
        while not (self.log.exists() and f"STAGE-{stage}" in self.log.read_text("utf-8")):
            self.assertLess(time.monotonic(), deadline, "stub stage never started")
            time.sleep(0.05)
        if group:
            os.killpg(proc.pid, sig)
        else:
            os.kill(proc.pid, sig)
        release.touch()
        out, err = proc.communicate(timeout=20)
        return out, err, proc.returncode

    @staticmethod
    def reap(proc: subprocess.Popen[str]) -> None:
        # A failed wait or a timeout above must not orphan the hook's group (bash, stub, sleep).
        # A reaped hook's pgid may already be reused: signal only a hook still unreaped.
        if proc.returncode is not None:
            return
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.communicate()

    def test_a_rerun_replaces_the_previous_log(self) -> None:
        # A stale FAILED log from the last push must not read as this push's output.
        self.stub("just", rc=1)
        self.stub("bun")
        self.stub("python3")
        self.run_hook()
        self.stub("just")
        self.assertEqual(self.run_hook().returncode, 0)
        self.assertEqual(self.log.read_text("utf-8").count("STAGE-just check"), 1)

    # ---- the private repo's snapshot leak scan (marker: scripts/private/ exists) -------------

    def test_private_repo_runs_the_leak_scan_last_and_names_it(self) -> None:
        (self.repo / "scripts" / "private").mkdir(parents=True)
        for name in STAGES:
            self.stub(name)
        res = self.run_hook()
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(res.stdout.splitlines(), [f"{OK_PRIVATE} (log: {self.log})"])
        logged = self.log.read_text("utf-8")
        self.assertEqual(logged.count("STAGE-just pubsim"), 1)
        self.assertLess(logged.index("STAGE-python3"), logged.index("STAGE-just pubsim"))

    def test_private_repo_failing_leak_scan_fails_the_push(self) -> None:
        # NEG-CONTROL: a dropped block, a mistyped marker test or `just pubsim || true` would let
        # a leak the scan finds through the push. Only `pubsim` fails, so the earlier stages run.
        (self.repo / "scripts" / "private").mkdir(parents=True)
        self.stub("just", rc=5, only="pubsim")
        self.stub("bun")
        self.stub("python3")
        res = self.run_hook()
        self.assertEqual(res.returncode, 5)
        self.assertEqual(res.stdout, "")
        self.assertIn("pre-push: FAILED (rc=5) at: just pubsim", res.stderr)
        self.assertIn("STAGE-just pubsim", res.stderr)
        self.assertIn("STAGE-just check", self.log.read_text("utf-8"))

    def test_fork_never_runs_the_leak_scan(self) -> None:
        # NEG-CONTROL for the marker: a fork has no scripts/private/ and no snapshot tooling. The
        # `pubsim` stub fails, so a hook that runs it anyway fails this push.
        self.stub("just", rc=5, only="pubsim")
        self.stub("bun")
        self.stub("python3")
        res = self.run_hook()
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(res.stdout.splitlines(), [f"{OK_FORK} (log: {self.log})"])
        self.assertNotIn("STAGE-just pubsim", self.log.read_text("utf-8"))

    # ---- the refs git feeds on stdin ---------------------------------------------------------

    def test_a_delete_only_push_skips_the_gate(self) -> None:
        for name in STAGES:
            self.stub(name, rc=1)  # any stage that runs fails the push
        sha = self.commit("x")
        res = self.run_hook(f"(delete) {ZERO} refs/heads/gone {sha}\n")
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertIn("branch deletion only, nothing to check — skipping gate", res.stdout)
        self.assertFalse(self.log.exists(), "a stage ran")

    def test_a_pushed_commit_other_than_head_is_refused_before_the_gate(self) -> None:
        # NEG-CONTROL: every stage reads the checkout, so `git push origin <sha>:dev` with a sha
        # other than HEAD passed on HEAD's gate. Axes: where the commit sits relative to HEAD,
        # a tag object (peeled before the compare), a refused line beside an accepted one, an
        # object that is no commit at all, and a commit whose history cannot be walked (its
        # parent is missing, so merge-base errors out instead of answering "unrelated").
        for name in STAGES:
            self.stub(name)
        old = self.commit("old")
        head = self.commit("head")
        descendant = self.git("commit-tree", f"{head}^{{tree}}", "-p", head, "-m", "next")
        self.git("tag", "-a", "-m", "t", "old-tag", old)
        old_tag = self.git("rev-parse", "old-tag")
        tree = self.git("rev-parse", f"{head}^{{tree}}")
        sig = "t <t@example.invalid> 0 +0000"
        broken = self.git("hash-object", "-t", "commit", "-w", "--stdin", stdin=(
            f"tree {tree}\nparent {'1' * 40}\nauthor {sig}\ncommitter {sig}\n\nbroken\n"))
        cases = {
            "ancestor": f"refs/heads/x {old} refs/heads/dev {ZERO}\n",
            "descendant": f"refs/heads/x {descendant} refs/heads/dev {ZERO}\n",
            "annotated tag of an ancestor": f"refs/tags/old-tag {old_tag} refs/tags/old-tag {ZERO}\n",
            "after a HEAD update": (f"refs/heads/main {head} refs/heads/main {ZERO}\n"
                                    f"refs/heads/x {old} refs/heads/dev {ZERO}\n"),
            "after a delete": (f"(delete) {ZERO} refs/heads/gone {old}\n"
                               f"refs/heads/x {old} refs/heads/dev {ZERO}\n"),
            "not a commit": f"refs/heads/x {tree} refs/heads/dev {ZERO}\n",
            "unwalkable history": f"refs/heads/x {broken} refs/heads/dev {ZERO}\n",
        }
        for case, refs in cases.items():
            with self.subTest(case=case):
                self.log.unlink(missing_ok=True)
                res = self.run_hook(refs)
                self.assertEqual(res.returncode, 1)
                self.assertEqual(res.stdout, "")
                self.assertRegex(res.stderr, r"^pre-push: refusing — refs/\S+ would get [0-9a-f]{40}")
                self.assertIn(f"(HEAD {head})", res.stderr)
                self.assertIn("check out the commit you push", res.stderr)
                self.assertFalse(self.log.exists(), "a stage ran")

    def git_shim(self, merge_base_error_rc: int) -> None:
        # A `git` on PATH that reports a merge-base ERROR (any exit but 0 and 1) with the given
        # code: 1 is what git 2.43 (Ubuntu 24.04) returns for a missing parent, 255 is git 2.53.
        # Every other subcommand, and a real 0/1 answer, passes through untouched.
        path = self.bin / "git"
        path.write_text(
            "#!/bin/sh\n"
            f"if [ \"$1\" = merge-base ]; then\n  '{GIT}' \"$@\"; rc=$?\n"
            f"  case $rc in 0|1) exit $rc ;; *) exit {merge_base_error_rc} ;; esac\nfi\n"
            f"exec '{GIT}' \"$@\"\n", "utf-8")
        path.chmod(path.stat().st_mode | stat.S_IXUSR)

    def test_unwalkable_history_is_refused_whatever_merge_base_exits(self) -> None:
        # NEG-CONTROL for the git-version split: a hook that reads merge-base's exit 1 as
        # "unrelated" lets the unwalkable commit through on git 2.43, which exits 1 for a missing
        # parent. Swept over both exit-code shapes; the truly unrelated snapshot must still pass
        # under each (the known-good side, so a hook that refuses everything fails too).
        for name in STAGES:
            self.stub(name)
        head = self.commit("head")
        tree = self.git("rev-parse", f"{head}^{{tree}}")
        sig = "t <t@example.invalid> 0 +0000"
        broken = self.git("hash-object", "-t", "commit", "-w", "--stdin", stdin=(
            f"tree {tree}\nparent {'1' * 40}\nauthor {sig}\ncommitter {sig}\n\nbroken\n"))
        snapshot = self.git("commit-tree", tree, "-m", "snapshot")
        for rc in (1, 255):
            self.git_shim(rc)
            with self.subTest(merge_base_error_rc=rc, case="unwalkable"):
                self.log.unlink(missing_ok=True)
                res = self.run_hook(f"refs/heads/x {broken} refs/heads/dev {ZERO}\n")
                self.assertEqual(res.returncode, 1, res.stderr)
                self.assertIn("pre-push: refusing", res.stderr)
                self.assertFalse(self.log.exists(), "a stage ran")
            with self.subTest(merge_base_error_rc=rc, case="unrelated"):
                res = self.run_hook(f"{snapshot} {snapshot} refs/heads/main {ZERO}\n")
                self.assertEqual(res.returncode, 0, res.stderr)
                self.assertIn("STAGE-just check", self.log.read_text("utf-8"))

    def test_an_unwalkable_HEAD_is_refused_too(self) -> None:
        # The other side of the walk: the PUSHED commit is fine (an unrelated snapshot, which
        # goes through when HEAD is sound), but HEAD's own parent is missing. Under git 2.43
        # merge-base exits 1 here as well, so a hook that walks only the pushed commit reads
        # "unrelated" and lets it through — the shim reproduces that exit code on any git.
        for name in STAGES:
            self.stub(name)
        head = self.commit("head")
        tree = self.git("rev-parse", f"{head}^{{tree}}")
        sig = "t <t@example.invalid> 0 +0000"
        broken = self.git("hash-object", "-t", "commit", "-w", "--stdin", stdin=(
            f"tree {tree}\nparent {'1' * 40}\nauthor {sig}\ncommitter {sig}\n\nbroken\n"))
        snapshot = self.git("commit-tree", tree, "-m", "snapshot")
        self.git("update-ref", "HEAD", broken)
        self.git_shim(1)
        res = self.run_hook(f"{snapshot} {snapshot} refs/heads/main {ZERO}\n")
        self.assertEqual(res.returncode, 1, res.stderr)
        self.assertIn("pre-push: refusing", res.stderr)
        self.assertFalse(self.log.exists(), "a stage ran")

    def test_head_and_unrelated_history_go_through_to_the_gate(self) -> None:
        # The known-good side: HEAD itself (by branch or by an annotated tag), and a commit with
        # no history in common with HEAD — what the snapshot publish and the docs deploy cut from
        # HEAD and push through this hook. Each must reach the gate and pass.
        for name in STAGES:
            self.stub(name)
        self.commit("old")
        head = self.commit("head")
        self.git("tag", "-a", "-m", "t", "head-tag", head)
        head_tag = self.git("rev-parse", "head-tag")
        snapshot = self.git("commit-tree", f"{head}^{{tree}}", "-m", "snapshot")
        cases = {
            "HEAD": f"refs/heads/main {head} refs/heads/dev {ZERO}\n",
            "annotated tag of HEAD": f"refs/tags/head-tag {head_tag} refs/tags/head-tag {ZERO}\n",
            "unrelated history": f"{snapshot} {snapshot} refs/heads/main {ZERO}\n",
        }
        for case, refs in cases.items():
            with self.subTest(case=case):
                res = self.run_hook(refs)
                self.assertEqual(res.returncode, 0, res.stderr)
                self.assertEqual(res.stdout.splitlines(), [f"{OK_FORK} (log: {self.log})"])
                self.assertIn("STAGE-just check", self.log.read_text("utf-8"))


if __name__ == "__main__":
    unittest.main()
