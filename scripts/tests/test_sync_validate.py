"""Unit tests for the deploy-time bundle gate — scripts/ops/sync.py validate_bundle +
the `--validate-only` entrypoint the pre-push hook runs after `bun run build`.

Neg-control-first: every rule the validator enforces is paired with a known-bad bundle
that must trip it, so a validator that returned [] for everything (or a CLI that always
exited 0) fails here instead of quietly waving a broken bundle through to `just sync`.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "ops"))
import sync  # noqa: E402

SYNC_PY = REPO / "scripts" / "ops" / "sync.py"

# The minimal shape worker.js accepts: a global Module with the lifecycle hooks.
GOOD_BUNDLE = 'var Module = { init: function(){}, tick: function(){}, stop: function(){} };\n'


def write(tmp: Path, text: str, name: str = "bundle.js") -> Path:
    p = tmp / name
    p.write_text(text, "utf-8")
    return p


class ValidateBundleTests(unittest.TestCase):
    def test_minimal_good_bundle_passes(self) -> None:
        self.assertEqual(sync.validate_bundle(GOOD_BUNDLE), [])

    def test_assignment_form_of_the_export_also_passes(self) -> None:
        self.assertEqual(sync.validate_bundle("globalThis.Module = {tick: function(){}};"), [])

    def test_shipped_bot_template_passes(self) -> None:
        # The plain-JS template is deployed AS the bundle (docs/BUILD_YOUR_OWN_BOT.md).
        text = (REPO / "harness" / "bot_template.js").read_text("utf-8")
        self.assertEqual(sync.validate_bundle(text), [])

    # ── NEG-CONTROLS: one per rule ────────────────────────────────────────────────
    def test_strict_mode_var_module_is_rejected(self) -> None:
        # The earlier bot_template.js shape: strict mode + `var Module` — the var stays
        # inside worker.js's eval, so the worker loads no module at all.
        errors = sync.validate_bundle('"use strict";\n' + GOOD_BUNDLE)
        self.assertTrue(any("globalThis.Module" in e for e in errors), errors)

    def test_oversize_is_rejected(self) -> None:
        text = GOOD_BUNDLE + "/*" + ("x" * sync.MAX_CODE_LEN) + "*/"
        errors = sync.validate_bundle(text)
        self.assertTrue(any("bundle size" in e for e in errors), errors)

    def test_exactly_at_the_cap_is_accepted(self) -> None:
        # POSITIVE control for the boundary: the cap is inclusive, so a bundle of exactly
        # MAX_CODE_LEN chars must NOT be rejected (an off-by-one here blocks every deploy).
        pad = sync.MAX_CODE_LEN - len(GOOD_BUNDLE) - len("/**/")
        text = GOOD_BUNDLE + "/*" + ("x" * pad) + "*/"
        self.assertEqual(len(text), sync.MAX_CODE_LEN)
        self.assertEqual(sync.validate_bundle(text), [])

    def test_for_ever_header_is_rejected(self) -> None:
        # The exact shape that landed green last session and then blocked `just sync`.
        errors = sync.validate_bundle(GOOD_BUNDLE + "for(;;){ drain(); }")
        self.assertTrue(any("infinite loop" in e for e in errors), errors)

    def test_for_ever_header_with_spaces_is_rejected(self) -> None:
        errors = sync.validate_bundle(GOOD_BUNDLE + "for ( ; ; ) { drain(); }")
        self.assertTrue(any("infinite loop" in e for e in errors), errors)

    def test_while_true_is_rejected(self) -> None:
        errors = sync.validate_bundle(GOOD_BUNDLE + "while (true) { drain(); }")
        self.assertTrue(any("infinite loop" in e for e in errors), errors)

    def test_bounded_while_header_is_NOT_rejected(self) -> None:
        # POSITIVE control pairing the two above: the chat-command drain header must stay legal,
        # or the rule would simply ban every while-loop.
        self.assertEqual(sync.validate_bundle(GOOD_BUNDLE + "while (queue.length > 0) { s(); }"), [])

    def test_missing_module_export_is_rejected(self) -> None:
        errors = sync.validate_bundle("function tick(){}\n")
        self.assertTrue(any("Module" in e for e in errors), errors)

    def test_java_reflection_is_rejected(self) -> None:
        errors = sync.validate_bundle(GOOD_BUNDLE + "java.lang.reflect.Field;")
        self.assertTrue(any("dangerous Java interop" in e for e in errors), errors)

    def test_process_builder_is_rejected(self) -> None:
        errors = sync.validate_bundle(GOOD_BUNDLE + "new ProcessBuilder('sh');")
        self.assertTrue(any("dangerous Java interop" in e for e in errors), errors)

    def test_runtime_exec_is_rejected(self) -> None:
        # The third alternative of the interop rule; without its own known-bad, deleting it
        # from the regex left every test green.
        errors = sync.validate_bundle(GOOD_BUNDLE + "Runtime.getRuntime().exec('sh');")
        self.assertTrue(any("dangerous Java interop" in e for e in errors), errors)

    def test_runtime_facade_lookalikes_are_NOT_rejected(self) -> None:
        # POSITIVE control pairing the one above: the bot's own `Runtime` facade and a member
        # that merely starts with `getRuntime` must stay legal (the rule is word-anchored).
        for text in ("Runtime.getRuntimeStats();", "rt.getRuntime();", "myRuntime.getRuntime();"):
            with self.subTest(text=text):
                self.assertEqual(sync.validate_bundle(GOOD_BUNDLE + text), [])

    def test_every_violation_is_reported_at_once(self) -> None:
        # Not fail-on-first: a caller must see the whole list to fix it in one pass.
        errors = sync.validate_bundle("for(;;){ java.lang.reflect.Field; }")
        self.assertEqual(len(errors), 3, errors)


class ValidateOnlyFunctionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tmpdir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def test_good_bundle_returns_zero(self) -> None:
        self.assertEqual(sync.validate_only(write(self.tmpdir, GOOD_BUNDLE)), 0)

    def test_bad_bundle_returns_one(self) -> None:
        self.assertEqual(sync.validate_only(write(self.tmpdir, "for(;;){}")), 1)

    def test_missing_file_returns_one(self) -> None:
        # A gate that "passes" because it never read anything is the worst failure mode.
        self.assertEqual(sync.validate_only(self.tmpdir / "absent.js"), 1)

    def test_a_directory_returns_one_instead_of_exploding(self) -> None:
        # exists() is true for a dir; read_text() would then raise IsADirectoryError out of a
        # gate, which reads like the gate is broken rather than the argument being wrong.
        self.assertEqual(sync.validate_only(self.tmpdir), 1)


class GateWiringTests(unittest.TestCase):
    """The gate is only a gate if it is actually INVOKED. Nothing else in the suite fails if
    the hook line is deleted — validate_only would keep passing its own unit tests while no
    push ever ran it again. Same drift-guard idea as test-ts/docs-drift.test.ts."""

    def test_pre_push_runs_the_validator_after_the_build(self) -> None:
        hook = (REPO / ".githooks" / "pre-push").read_text("utf-8")
        self.assertIn("sync.py --validate-only", hook)
        lines = [ln.strip() for ln in hook.splitlines()]
        self.assertLess(
            lines.index("bun run build"),
            next(i for i, ln in enumerate(lines) if "--validate-only" in ln and not ln.startswith("#")),
            "the validator must run AFTER the build, or there is no fresh bundle to validate",
        )

    def test_pre_commit_does_NOT_run_it(self) -> None:
        # NEG-CONTROL for the placement: pre-commit builds nothing, so validating there would
        # either gate on a stale dist/ or force a build into every commit.
        hook = (REPO / ".githooks" / "pre-commit").read_text("utf-8")
        self.assertNotIn("--validate-only", hook)

    def test_justfile_exposes_the_recipe(self) -> None:
        justfile = (REPO / "justfile").read_text("utf-8")
        self.assertIn("\nvalidate-bundle ", justfile)
        self.assertIn("--validate-only", justfile)


class ValidateOnlyCliTests(unittest.TestCase):
    """The pre-push path end-to-end: `python3 scripts/ops/sync.py --validate-only [PATH]`."""

    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.tmpdir = Path(self.tmp.name)
        self.addCleanup(self.tmp.cleanup)

    def run_cli(self, *args: str, instances: str | None = None) -> subprocess.CompletedProcess:
        env = dict(os.environ)
        # No game installed: point the instance resolver at a path that does not exist. Deploy
        # would SystemExit on it — validate-only must never look, so this doubles as the
        # "works with no instances present" assertion.
        env["MC_INSTANCES_ROOT"] = instances if instances is not None else str(self.tmpdir / "nope")
        return subprocess.run(
            [sys.executable, str(SYNC_PY), *args],
            capture_output=True, text=True, cwd=str(REPO), env=env,
        )

    def test_good_bundle_exits_zero_without_touching_instances(self) -> None:
        r = self.run_cli("--validate-only", str(write(self.tmpdir, GOOD_BUNDLE)))
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("Bundle OK", r.stdout)
        self.assertNotIn("Deployed", r.stdout)

    def test_bad_bundle_exits_one_and_names_the_rule(self) -> None:
        r = self.run_cli("--validate-only", str(write(self.tmpdir, "for(;;){}")))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("BUNDLE VALIDATION FAILED", r.stdout)
        self.assertIn("infinite loop", r.stdout)
        self.assertIn("missing 'Module' export", r.stdout)

    def test_missing_bundle_exits_one(self) -> None:
        r = self.run_cli("--validate-only", str(self.tmpdir / "absent.js"))
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("bundle not found", r.stdout)

    def test_name_option_is_REFUSED_not_ignored(self) -> None:
        # -n names a deploy output file and means nothing here; silently ignoring it would let
        # `--validate-only -n other.js` read as "validate other.js" while it validated the default.
        r = self.run_cli("--validate-only", "-n", "other.js")
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("-n/--name has no meaning here", r.stderr)

    def test_bare_flag_falls_back_to_the_source_option(self) -> None:
        p = write(self.tmpdir, GOOD_BUNDLE)
        r = self.run_cli("-s", str(p), "--validate-only")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn(str(p), r.stdout)


if __name__ == "__main__":
    unittest.main()
