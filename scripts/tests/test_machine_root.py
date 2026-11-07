"""Unit tests for `scripts/machine_root` — ONE set of machine-local files per repo.

Why (measured twice): `mc-bots.json` is gitignored + machine-local (per-instance
bridge PORT registry), so it exists only in the MAIN checkout. The old
`Path(__file__).resolve().parent.parent` root meant a `just sync` run from a git WORKTREE found no
registry there, `assign()` built a fresh one in the worktree, and the pinned camera instance
`Monifactory_cam_shader` was renumbered 55546 → 55549 (written on into its `bridge_port.txt`) —
after which every cinema tool (`sustain_live.py` CAM_PORT, `shoot.py`) hit `Connection refused`.

Neg-control-first: every positive lane is paired with the SAME fixture under the condition the
lane guards against — the OLD tree-local expression, git unavailable, the raw (unstripped) hook
env, the raw git answer for a vendored copy / submodule — so a resolver that is right by accident
fails here instead of reading as a pass.

Hook hygiene: this suite runs inside `.githooks/pre-push`, and a git hook exports `GIT_DIR` /
`GIT_INDEX_FILE`. Every fixture git call goes through `machine_root.clean_git_env()`, so the
scratch repos below can never write the real index or config (a hook-inherited GIT_DIR once
redirected a fixture's writes into the enclosing repository).

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -t scripts/tests -v
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
import fleet_registry  # noqa: E402
import local_config  # noqa: E402
import machine_root  # noqa: E402

GIT = shutil.which("git")

# Fixture identity + no developer ~/.gitconfig / system config, hooks or templates.
_FIXTURE_GIT_VARS = {
    "GIT_CONFIG_GLOBAL": os.devnull,
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_AUTHOR_NAME": "t",
    "GIT_AUTHOR_EMAIL": "t@example.invalid",
    "GIT_COMMITTER_NAME": "t",
    "GIT_COMMITTER_EMAIL": "t@example.invalid",
}


def fixture_env() -> dict[str, str]:
    """Built per call (so `mock.patch.dict(os.environ, …)` is honoured) and ALWAYS stripped."""
    return {**machine_root.clean_git_env(), **_FIXTURE_GIT_VARS}


def raw_env() -> dict[str, str]:
    """The pre-fix fixture env: inherits whatever git exported. Neg-controls only."""
    return {**os.environ, **_FIXTURE_GIT_VARS}


def git(cwd: Path, *args: str, env: dict[str, str] | None = None) -> str:
    return subprocess.run(
        [GIT or "git", *args], cwd=str(cwd), env=fixture_env() if env is None else env,
        check=True, capture_output=True, text=True,
    ).stdout.strip()


def seed_repo(path: Path, *, scripts: bool = True) -> Path:
    if scripts:
        (path / "scripts").mkdir(parents=True)
        (path / "scripts" / "fleet_registry.py").write_text("# fixture\n", "utf-8")
    else:
        path.mkdir(parents=True)
        (path / "f").write_text("x\n", "utf-8")
    git(path, "init", "-q", "-b", "main")
    git(path, "add", "-A")
    git(path, "commit", "-qm", "seed")
    return path


def raw_common_dir(cwd: Path, env: dict[str, str]) -> Path:
    """What an UNGUARDED probe (no env strip, no toplevel check) would have used."""
    return Path(git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir", env=env)).resolve()


@unittest.skipUnless(GIT, "git is required to build the worktree fixture")
class RepoRootTests(unittest.TestCase):
    """A real `git init` + `git worktree add` fixture — the exact shape that bit us."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name).resolve()

        self.main = seed_repo(self.base / "main")
        # A plain linked worktree, and one under the agent `.claude/worktrees/` convention.
        self.wt = self.base / "wt"
        git(self.main, "worktree", "add", "-q", "-b", "wt1", str(self.wt))
        self.agent_wt = self.base / ".claude" / "worktrees" / "reshoot"
        git(self.main, "worktree", "add", "-q", "-b", "wt2", str(self.agent_wt))

        self.wt_anchor = self.wt / "scripts"
        self.agent_anchor = self.agent_wt / "scripts"

    def hostile_hook_env(self, victim: Path) -> dict[str, str]:
        """What git exports into a hook of `victim` (pre-commit sets exactly these)."""
        return {
            "GIT_DIR": str(victim / ".git"),
            "GIT_INDEX_FILE": str(victim / ".git" / "index"),
        }

    # ── POSITIVE ──────────────────────────────────────────────────────────────────
    def test_resolver_called_from_a_worktree_returns_the_MAIN_repo_root(self) -> None:
        self.assertEqual(machine_root.repo_root(self.wt_anchor), self.main)
        self.assertEqual(machine_root.repo_root(self.agent_anchor), self.main)
        self.assertEqual(machine_root.repo_root(self.main / "scripts"), self.main)

    def test_registry_path_built_on_that_root_is_the_main_checkouts_file(self) -> None:
        got = machine_root.repo_root(self.wt_anchor) / "mc-bots.json"
        self.assertEqual(got, self.main / "mc-bots.json")
        self.assertNotEqual(got, self.wt / "mc-bots.json")

    def test_result_is_independent_of_the_callers_cwd(self) -> None:
        # The probe runs with cwd = the anchor, so a caller sitting anywhere gets the same root.
        cwd = os.getcwd()
        self.addCleanup(os.chdir, cwd)
        os.chdir(self.base)
        self.assertEqual(machine_root.repo_root(self.wt_anchor), self.main)

    # ── NEG-CONTROL: prove the git probe is what changed the outcome ───────────────
    def test_OLD_file_based_root_would_have_returned_the_worktree_local_path(self) -> None:
        # The pre-fix expression, applied to the same fixture. If this equalled the main root the
        # positive lane above would be vacuous.
        old_root = self.wt_anchor.parent
        self.assertEqual(old_root, self.wt)
        self.assertNotEqual(old_root, machine_root.repo_root(self.wt_anchor))

    def test_without_git_on_PATH_a_plain_worktree_falls_back_to_the_tree_local_root(self) -> None:
        # Same fixture, same call — only `git` is taken away, and the answer flips back to the
        # buggy tree-local root. That is the fallback the docstring promises, and it is also the
        # control proving the resolver (not the fixture) produces the positive result above.
        with mock.patch.dict(os.environ, {"PATH": ""}, clear=False):
            self.assertEqual(machine_root.repo_root(self.wt_anchor), self.wt)

    def test_outside_any_repo_the_tree_local_root_is_returned(self) -> None:
        plain = self.base / "plain" / "scripts"
        plain.mkdir(parents=True)
        # GIT_CEILING_DIRECTORIES stops git's upward search, so this is deterministically a
        # non-repo even when the temp dir happens to live inside one.
        with mock.patch.dict(os.environ, {"GIT_CEILING_DIRECTORIES": str(self.base)}, clear=False):
            self.assertEqual(machine_root.repo_root(plain), plain.parent)

    # ── HOOK ENV: an inherited GIT_DIR must not redirect anything ──────────────────
    def test_an_inherited_GIT_DIR_cannot_redirect_the_probe_to_another_repo(self) -> None:
        other = seed_repo(self.base / "other")
        hostile = self.hostile_hook_env(other)
        with mock.patch.dict(os.environ, hostile, clear=False):
            # Neg-control: the env IS hostile — an unstripped probe from the worktree answers
            # for `other` (measured pre-fix: GIT_DIR=<other>/.git → REGISTRY_PATH under <other>/).
            self.assertEqual(raw_common_dir(self.wt_anchor, raw_env()), other / ".git")
            self.assertEqual(machine_root.repo_root(self.wt_anchor), self.main)

    def test_fixture_git_under_a_hook_env_leaves_the_hooks_repo_untouched(self) -> None:
        # A git hook runs this very suite with GIT_DIR/GIT_INDEX_FILE exported. Build a
        # scratch repo under that env through the fixture helper and check the "hook's" repo.
        victim = seed_repo(self.base / "victim", scripts=False)
        head = git(victim, "rev-parse", "HEAD")
        index = (victim / ".git" / "index").read_bytes()
        with mock.patch.dict(os.environ, self.hostile_hook_env(victim), clear=False):
            fresh = seed_repo(self.base / "fresh", scripts=False)
        self.assertEqual(git(victim, "rev-parse", "HEAD"), head)
        self.assertEqual((victim / ".git" / "index").read_bytes(), index)
        self.assertTrue((fresh / ".git").is_dir())
        self.assertEqual(git(fresh, "rev-list", "--count", "HEAD"), "1")

    def test_NEG_the_same_fixture_steps_with_the_raw_env_DO_write_into_the_hooks_repo(self) -> None:
        # Control for the lane above: without the strip, `git add`/`commit` run from the scratch
        # dir land in the victim — so "untouched" above is the strip's doing, not the fixture's.
        victim = seed_repo(self.base / "victim2", scripts=False)
        head = git(victim, "rev-parse", "HEAD")
        scratch = self.base / "scratch"
        scratch.mkdir()
        (scratch / "leak").write_text("x\n", "utf-8")
        with mock.patch.dict(os.environ, self.hostile_hook_env(victim), clear=False):
            env = raw_env()
            git(scratch, "add", "-A", env=env)
            git(scratch, "commit", "-qm", "leak", env=env)
        self.assertNotEqual(git(victim, "rev-parse", "HEAD"), head)

    def test_the_stripped_var_list_is_exactly_gits_own_local_env_vars(self) -> None:
        # Drift guard: a git release that adds a repo-local var must fail here, not leak.
        live = git(self.base, "rev-parse", "--local-env-vars").split()
        self.assertEqual(set(machine_root.GIT_LOCAL_ENV_VARS), set(live))

    # ── ACCEPT ONLY OUR OWN CHECKOUT: vendored copy, submodule ─────────────────────
    def test_a_vendored_copy_inside_another_repo_resolves_to_its_OWN_tree(self) -> None:
        outer = seed_repo(self.base / "outer", scripts=False)
        vendored = outer / "vendor" / "mc" / "scripts"
        vendored.mkdir(parents=True)
        # Neg-control: git answers for the ENCLOSING repo — an unguarded probe would put the
        # registry at outer/mc-bots.json, shared with a stranger's tree.
        self.assertEqual(raw_common_dir(vendored, fixture_env()), outer / ".git")
        self.assertEqual(machine_root.repo_root(vendored), vendored.parent)

    def test_a_submodule_resolves_to_its_OWN_tree_not_super_git_modules(self) -> None:
        sub_src = seed_repo(self.base / "sub_src")
        sup = seed_repo(self.base / "super", scripts=False)
        git(sup, "-c", "protocol.file.allow=always", "submodule", "add", "-q", str(sub_src), "sub")
        anchor = sup / "sub" / "scripts"
        # Neg-control: the common dir is `<super>/.git/modules/sub` — its parent is not a checkout.
        self.assertEqual(raw_common_dir(anchor, fixture_env()), sup / ".git" / "modules" / "sub")
        self.assertEqual(machine_root.repo_root(anchor), sup / "sub")

    # ── FAIL-LOUD carve-out ───────────────────────────────────────────────────────
    def test_probe_failure_INSIDE_claude_worktrees_refuses_instead_of_falling_back(self) -> None:
        # There the fallback is provably wrong and its only symptom is a silently renumbered
        # pinned port hours later, so refuse.
        with mock.patch.dict(os.environ, {"PATH": ""}, clear=False):
            with self.assertRaises(machine_root.MachineRootError) as cm:
                machine_root.repo_root(self.agent_anchor)
        msg = str(cm.exception)
        self.assertIn(str(self.agent_anchor), msg)
        self.assertIn("split machine state", msg)

    def test_the_refusal_is_keyed_on_the_FAILED_probe_not_on_the_path_shape(self) -> None:
        # Neg-control for the lane above: same `.claude/worktrees/` anchor, git available → a
        # root, no exception. A guard that refused on the path alone would break every agent
        # worktree.
        self.assertEqual(machine_root.repo_root(self.agent_anchor), self.main)

    def test_a_non_worktree_path_never_refuses(self) -> None:
        plain = self.base / "plain2" / "scripts"
        plain.mkdir(parents=True)
        with mock.patch.dict(os.environ, {"PATH": ""}, clear=False):
            self.assertEqual(machine_root.repo_root(plain), plain.parent)


class LazinessTests(unittest.TestCase):
    """Importing must spawn no git and cannot raise — `sync.py --validate-only` (the pre-push
    gate), `local_config` ("the loader is lazy") and `sustain_live.py` all promise that."""

    PROBE = (
        "import subprocess, sys\n"
        "def trap(*a, **k): raise SystemExit(f'subprocess at import: {a[0]!r}')\n"
        "subprocess.run = subprocess.Popen = trap\n"
        f"sys.path[:0] = [{str(REPO / 'scripts')!r}, {str(REPO / 'scripts' / 'ops')!r}]\n"
        "import machine_root, fleet_registry, local_config, sync\n"
        "{extra}\n"
        "print('imported')\n"
    )

    # Overrides that answer `registry_path()` without asking the machine root. Exported in the
    # caller's shell (a fleet operator's MC_BOTS_REGISTRY), they kept the trap below from ever
    # firing and turned the NEG lane red for reasons unrelated to the code.
    ROOT_BYPASS_ENV = ("MC_BOTS_REGISTRY",)

    def run_probe(self, extra: str = "") -> subprocess.CompletedProcess:
        env = {k: v for k, v in machine_root.clean_git_env().items() if k not in self.ROOT_BYPASS_ENV}
        return subprocess.run(
            [sys.executable, "-c", self.PROBE.replace("{extra}", extra)],
            capture_output=True, text=True, env=env,
        )

    def test_the_probe_ignores_a_registry_override_in_the_callers_shell(self) -> None:
        # NEG-lane hermeticity: with MC_BOTS_REGISTRY exported, the control lane must still see
        # the git probe (it did not: `just check` went red in an operator's shell).
        with mock.patch.dict(os.environ, {"MC_BOTS_REGISTRY": "/tmp/elsewhere/mc-bots.json"}):
            r = self.run_probe("fleet_registry.registry_path()")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertIn("rev-parse", r.stderr)

    def test_importing_every_consumer_runs_no_subprocess(self) -> None:
        r = self.run_probe()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("imported", r.stdout)

    def test_NEG_the_trap_fires_once_the_root_is_actually_asked_for(self) -> None:
        # Control: same process, one call to `root()` → the trap reports the git probe. Without
        # this, a trap that never fired would make the lane above pass vacuously.
        r = self.run_probe("fleet_registry.registry_path()")
        self.assertNotEqual(r.returncode, 0, r.stdout)
        self.assertIn("subprocess at import", r.stderr)
        self.assertIn("rev-parse", r.stderr)


class RegistryDefaultsTests(unittest.TestCase):
    """The accessors every importer relies on (`registry_path`, `load`, `save`, ...)."""

    SENTINEL = Path("/sentinel/machine-root")

    def setUp(self) -> None:
        env = {k: v for k, v in os.environ.items() if k != "MC_BOTS_REGISTRY"}
        for patcher in (
            mock.patch.dict(os.environ, env, clear=True),
            mock.patch.object(machine_root, "root", lambda: self.SENTINEL),
        ):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_every_machine_state_file_hangs_off_machine_root(self) -> None:
        # The same bug lived at every gitignored machine-state path, not just mc-bots.json: a
        # tree-local local.config.json silently fell through to launcher autodetect from a
        # worktree, and fleet_hub's mc-tasks.json queue split per tree. The sentinel root makes a
        # revert to ANY tree-local expression fail from any tree, main checkout included.
        self.assertEqual(fleet_registry.registry_path(), self.SENTINEL / "mc-bots.json")
        self.assertEqual(fleet_registry.tasks_path(), self.SENTINEL / "mc-tasks.json")
        self.assertEqual(local_config.config_path(), self.SENTINEL / "local.config.json")
        hub = (REPO / "scripts" / "ops" / "fleet_hub.py").read_text("utf-8")
        self.assertIn("TaskQueue(fleet_registry.tasks_path())", hub)

    def test_MC_BOTS_REGISTRY_overrides_the_registry_and_moves_its_sibling(self) -> None:
        with mock.patch.dict(os.environ, {"MC_BOTS_REGISTRY": "/scratch/reg.json"}):
            self.assertEqual(fleet_registry.registry_path(), Path("/scratch/reg.json"))
            self.assertEqual(fleet_registry.tasks_path(), Path("/scratch/mc-tasks.json"))

    def test_every_entry_point_defaults_to_the_resolved_registry(self) -> None:
        # An importer calling load()/save()/resolve()/assign() without `path` is what sync.py,
        # bridge_ctl.py and fleet_hub.py do — all four must land on registry_path().
        with tempfile.TemporaryDirectory() as d:
            reg = Path(d) / "mc-bots.json"
            with mock.patch.dict(os.environ, {"MC_BOTS_REGISTRY": str(reg)}):
                ports = fleet_registry.assign([("bot_a", Path("/i/a"))], base_port=60000)
                self.assertEqual(ports, {"/i/a": 60000})
                self.assertTrue(reg.is_file())
                self.assertEqual(fleet_registry.resolve("bot_a"), ("127.0.0.1", 60000))
                fleet_registry.save({"version": 1, "bots": []})
                self.assertEqual(fleet_registry.load(), {"version": 1, "bots": []})

    def test_no_script_rederives_a_tree_local_root_for_machine_files(self) -> None:
        # Source-level guard: a new `Path(__file__)…parent / "local.config.json"` (or the old
        # `REPO_ROOT` constant) would reintroduce the per-tree split without failing any lane above.
        for rel in ("local_config.py", "fleet_registry.py"):
            src = (REPO / "scripts" / rel).read_text("utf-8")
            self.assertNotIn("Path(__file__).resolve().parent.parent", src, rel)
            self.assertIn("machine_root.root()", src, rel)

    def test_live_runners_read_the_registry_through_fleet_registry(self) -> None:
        # gate_live.py used to build `REPO / "mc-bots.json"` from its own file location — the
        # same bug at a second site. Its port → instance lookup now lives in fleet_registry
        # (`game_dir_for_port`, shared with navbench.py --port). Source-level guard so a private
        # path build cannot creep back into either runner.
        for rel in ("scripts/dev/gate_live.py", "scripts/dev/navbench.py"):
            src = (REPO / rel).read_text("utf-8")
            self.assertIn("fleet_registry.game_dir_for_port(", src, rel)
            self.assertNotIn('REPO / "mc-bots.json"', src, rel)


class HookEnvScrubTests(unittest.TestCase):
    """The hooks export GIT_DIR/GIT_INDEX_FILE into every test they run; the scrub line is the
    only thing standing between a fixture's `git init` and the real index. Pin it, and pin it
    BEFORE the first test command — a scrub placed after the suites protects nothing."""

    def test_every_hook_scrubs_git_local_env_before_running_the_suites(self) -> None:
        for name in ("pre-commit", "pre-push"):
            lines = [ln.strip() for ln in (REPO / ".githooks" / name).read_text("utf-8").splitlines()]
            self.assertIn("unset $(git rev-parse --local-env-vars)", lines, name)
            scrub = lines.index("unset $(git rev-parse --local-env-vars)")
            first_suite = next(i for i, ln in enumerate(lines)
                               if ln.startswith(("just ", "bun run", "python3")))
            self.assertLess(scrub, first_suite, f"{name}: scrub must precede the first suite")


@unittest.skipUnless(GIT, "git is required")
class ThisRepoTests(unittest.TestCase):
    def test_this_repos_root_is_the_main_worktree_git_lists_first(self) -> None:
        # Independent formula (not the resolver's own `--git-common-dir`): `git worktree list`
        # always prints the MAIN worktree first, from any linked worktree of this repo.
        out = git(REPO, "worktree", "list", "--porcelain")
        main = Path(out.splitlines()[0].removeprefix("worktree ")).resolve()
        self.assertEqual(machine_root.repo_root(), main)


if __name__ == "__main__":
    unittest.main()
