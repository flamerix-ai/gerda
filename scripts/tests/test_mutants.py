"""scripts/dev/mutants.py — the mutant runner and the gate-tag lint are guards themselves, so each
result they can give has a known-bad here: a fixture mutant that MUST come out survived /
wrong_failure / anchor_missing / anchor_ambiguous / unparsable / run_failed / skipped, a CONTROL
that must stop the table, and a lint finding per rule.

Stdlib-only (unittest); needs git and python3:
    python3 -m unittest discover -s scripts/tests -v
"""
from __future__ import annotations

import contextlib
import io
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "dev"))
import mutants  # noqa: E402

PROG = '''\
def check(x):
    if x < 0:  # gate:neg
        raise ValueError("negative")  # gate:neg
    return x  # not-a-gate: the value of a good x
'''

TESTS = '''\
import unittest
import prog


class T(unittest.TestCase):
    def test_negative_refused(self):
        with self.assertRaisesRegex(ValueError, "negative"):
            prog.check(-1)

    def test_positive(self):
        self.assertEqual(prog.check(2), 2)

    @unittest.skip("not here")
    def test_skipped(self):
        pass
'''

HEAD = '''\
command = ["python3", "-m", "unittest"]
ran_line = '^Ran \\d+ tests? in \\d+\\.\\d+s$'
skip_marker = "skipped="
failure_marker = " (t_prog."
failure_exit = 1

[scope.python]
"prog.py" = ["check"]

[gates]
neg = "a negative x is refused"
'''

KILL = '''
[[ mutant ]]
name = "neg-unchecked"
gate = "neg"
file = "prog.py"
anchor = "    if x < 0:"
replace = "    if False:"
test = ["t_prog.T.test_negative_refused"]
expect_message = ["FAIL: test_negative_refused (", "ValueError not raised"]
expect_failures = 1
'''


class _Repo(unittest.TestCase):
    """A tiny git repo: prog.py (one tagged guard) and its tests."""

    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        (self.root / "prog.py").write_text(PROG)
        (self.root / "t_prog.py").write_text(TESTS)
        env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
        for argv in (["git", "init", "-q"], ["git", "add", "-A"]):
            subprocess.run(argv, cwd=self.root, env=env, check=True, capture_output=True)

    def area(self, body: str, head: str = HEAD) -> mutants.Area:
        path = self.root / "area.toml"
        path.write_text(head + body)
        return mutants.load_area(path)

    def run_one(self, body: str, head: str = HEAD) -> mutants.Row:
        a = self.area(body, head)
        with tempfile.TemporaryDirectory() as work:
            return mutants.run_mutant(a, a.mutants[0], mutants.tree_files(self.root), Path(work), self.root)


class MutantResultTests(_Repo):
    def test_a_mutant_whose_test_reds_as_expected_is_killed(self) -> None:  # known-good
        r = self.run_one(KILL)
        self.assertEqual(r.result, "killed", r.detail)
        self.assertEqual(r.rc, 1)
        self.assertRegex(r.ran, r"^Ran 1 test in ")
        self.assertEqual((self.root / "prog.py").read_text(), PROG)   # the checkout is untouched

    def test_a_mutant_the_tests_do_not_see_survives(self) -> None:
        r = self.run_one(KILL.replace("test_negative_refused\"]", "test_positive\"]"))
        self.assertEqual(r.result, "survived")

    def test_a_red_with_another_message_is_wrong_failure(self) -> None:
        r = self.run_one(KILL.replace('"ValueError not raised"', '"some other finding"'))
        self.assertEqual(r.result, "wrong_failure")
        self.assertIn("missing: 'some other finding'", r.detail)

    def test_a_failure_count_one_off_is_wrong_failure(self) -> None:
        for count in ("expect_failures = 0", "expect_failures = 2"):
            with self.subTest(count=count):
                r = self.run_one(KILL.replace("expect_failures = 1", count))
                self.assertEqual(r.result, "wrong_failure")

    def test_another_exit_status_is_wrong_failure(self) -> None:
        r = self.run_one(KILL, HEAD.replace("failure_exit = 1", "failure_exit = 3"))
        self.assertEqual(r.result, "wrong_failure")
        self.assertIn("exit 1, expected 3", r.detail)

    def test_a_rotted_anchor_is_anchor_missing(self) -> None:
        r = self.run_one(KILL.replace('"    if x < 0:"', '"    if x <= 0:"'))
        self.assertEqual(r.result, "anchor_missing")
        self.assertIn("occurs 0 times", r.detail)

    def test_an_anchor_found_twice_is_anchor_ambiguous(self) -> None:
        r = self.run_one(KILL.replace('anchor = "    if x < 0:"', 'anchor = "x"'))
        self.assertEqual(r.result, "anchor_ambiguous")

    def test_a_mutant_that_does_not_parse_is_unparsable(self) -> None:
        self.assertEqual(self.run_one(KILL.replace('"    if False:"', '"    if False"')).result, "unparsable")

    def test_tests_without_their_ran_line_are_run_failed(self) -> None:
        head = HEAD.replace('command = ["python3", "-m", "unittest"]', 'command = ["python3", "-c", "import sys; sys.exit(1)"]')
        self.assertEqual(self.run_one(KILL, head).result, "run_failed")

    def test_a_skipped_test_is_no_kill(self) -> None:
        body = KILL.replace('test = ["t_prog.T.test_negative_refused"]',
                            'test = ["t_prog.T.test_negative_refused", "t_prog.T.test_skipped"]')
        self.assertEqual(self.run_one(body).result, "skipped")

    def test_a_file_that_resolves_outside_the_copy_is_refused(self) -> None:
        (self.root / "link.py").symlink_to(self.root / "prog.py")
        subprocess.run(["git", "add", "link.py"], cwd=self.root, check=True, capture_output=True)
        with self.assertRaisesRegex(RuntimeError, "outside the copy"):
            self.run_one(KILL.replace('file = "prog.py"', 'file = "link.py"'))
        self.assertEqual((self.root / "prog.py").read_text(), PROG)


class ControlTests(_Repo):
    def table(self, body: str) -> tuple[int, str]:
        a = self.area(body)
        out = io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            rc = mutants.run_table([(a, a.mutants)], self.root, 2)
        return rc, out.getvalue()

    def test_the_control_row_comes_first_with_its_rc(self) -> None:  # known-good
        rc, out = self.table(KILL)
        self.assertEqual(rc, 0, out)
        self.assertRegex(out.splitlines()[0], r"^GREEN +area/CONTROL  rc=0  Ran 1 test in ")
        self.assertRegex(out, r"(?m)^killed +area/neg-unchecked  rc=1")

    def test_a_red_control_stops_the_table(self) -> None:
        (self.root / "prog.py").write_text(PROG.replace('raise ValueError("negative")', "pass"))
        rc, out = self.table(KILL.replace('"    if x < 0:"', '"    return x"').replace('"    if False:"', '"    return -x"'))
        self.assertEqual(rc, 2)
        self.assertRegex(out, r"(?m)^RED +area/CONTROL")
        self.assertNotIn("neg-unchecked", out)

    def test_a_survivor_fails_the_table(self) -> None:
        rc, _ = self.table(KILL.replace("test_negative_refused\"]", "test_positive\"]"))
        self.assertEqual(rc, 1)

    def test_a_broken_mutant_fails_the_table_as_broken(self) -> None:
        rc, _ = self.table(KILL.replace('"    if x < 0:"', '"    if x <= 0:"'))
        self.assertEqual(rc, 2)


class SpecTests(_Repo):
    def refused(self, body: str, why: str, head: str = HEAD) -> None:
        with self.assertRaisesRegex(mutants.SpecError, why):
            self.area(body, head)

    def test_a_mutant_name_taken_twice_is_refused(self) -> None:
        self.refused(KILL + KILL, "taken twice")

    def test_an_undeclared_gate_is_refused(self) -> None:
        self.refused(KILL.replace('gate = "neg"', 'gate = "other"'), "not declared in")

    def test_a_gate_without_a_mutant_is_refused(self) -> None:
        self.refused(KILL, "with no mutant", HEAD + 'spare = "nothing kills it"\n')

    def test_a_missing_failure_count_is_refused(self) -> None:
        self.refused(KILL.replace("expect_failures = 1\n", ""), "expect_failures is missing")

    def test_a_no_op_edit_is_refused(self) -> None:
        self.refused(KILL.replace('"    if False:"', '"    if x < 0:"'), "changes nothing")

    def test_a_failure_exit_of_zero_is_refused(self) -> None:
        self.refused(KILL, "cannot exit 0", HEAD.replace("failure_exit = 1", "failure_exit = 0"))

    def test_a_file_outside_the_tree_is_refused(self) -> None:
        for path in ("/etc/passwd", "../prog.py"):
            with self.subTest(path=path):
                self.refused(KILL.replace('file = "prog.py"', f'file = "{path}"'), "inside the tree")

    def test_an_unknown_key_is_refused(self) -> None:
        self.refused(KILL.replace("expect_failures = 1", "expect_failures = 1\nexpect_mesage = []"), "unknown key")

    def test_the_shipped_files_load(self) -> None:  # known-good
        areas = mutants.load_all()
        self.assertEqual({a.name for a in areas}, {"sandbox", "arena", "motion-probe"})
        self.assertGreater(sum(len(a.mutants) for a in areas), 100)


SHELL = '''\
#!/usr/bin/env bash
die() { echo "$*" >&2; exit 1; }   # not-a-gate: definition of the fail helper
# a comment that says die is not a fail path
[ -f x ] || die "no x"   # gate:x-present
# gate:y-present
[ -f y ] \\
  || die "no y"
'''


class LintTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.root)
        (self.root / "t_s.py").write_text("import unittest\nclass T(unittest.TestCase):\n    def test_x(self):\n        pass\n")

    def lint(self, shell: str = SHELL, body: str | None = None, prog: str = PROG, gates: str = "") -> list[str]:
        (self.root / "s.sh").write_text(shell)
        (self.root / "prog.py").write_text(prog)
        body = body if body is not None else self.MUTANTS
        (self.root / "m.toml").write_text(textwrap.dedent(f'''\
            command = ["python3", "-m", "unittest"]
            ran_line = "^Ran"
            skip_marker = "skipped="
            failure_marker = " (t_s."
            failure_exit = 1
            [scope]
            files = ["s.sh"]
            [scope.python]
            "prog.py" = ["check"]
            [gates]
            x-present = "x"
            y-present = "y"
            neg = "n"
            {gates}''') + body)
        return mutants.lint([mutants.load_area(self.root / "m.toml")], self.root)

    MUTANTS = ''.join(f'''
[[ mutant ]]
name = "{n}"
gate = "{g}"
file = "{f}"
anchor = {o}
replace = {w}
test = ["t_s.T.test_x"]
expect_failures = 1
''' for n, g, f, o, w in (("x", "x-present", "s.sh", '''"[ -f x ] || die"''', '"true || die"'),
                          ("y", "y-present", "s.sh", '''"[ -f y ] \\\\"''', '"true \\\\"'),
                          ("n", "neg", "prog.py", '"    if x < 0:"', '"    if False:"')))

    def test_a_clean_tree_has_no_finding(self) -> None:  # known-good
        self.assertEqual(self.lint(), [])

    def test_an_untagged_die_line_is_a_finding(self) -> None:
        for line in ('[ -f z ] || die "no z"', "exit 2", "return 1", 'import_fail r l "why"',
                     '[ -f z ] || die "z"   # a trailing comment is no tag',
                     # the shapes a list of fail helpers missed: a bare or computed return, a
                     # `false`, a block that kills the script, a test whose status is the
                     # function's, a checksum check under `set -e`
                     "cp a b || return", "cp a b || return $rc", "cp a b || false",
                     'cp a b || { echo "no"; kill $$; }', "test -f z", "[ -f z ]",
                     "sha256sum -c sums.txt", "exit", "false"):
            with self.subTest(line=line):
                found = self.lint(SHELL + line + "\n")
                self.assertEqual(len(found), 1, found)
                self.assertIn("die-shaped line with no", found[0])

    def test_a_comment_only_line_is_no_fail_path(self) -> None:  # the one carve-out
        self.assertEqual(self.lint(SHELL + "#   die exit 1 return 1\n"), [])

    def test_exit_0_and_return_0_are_not_die_shaped(self) -> None:
        self.assertEqual(self.lint(SHELL + "exit 0\nreturn 0\n"), [])

    def test_lines_that_cannot_fail_the_step_are_not_die_shaped(self) -> None:  # known-good twins
        for line in ("if [ -f z ]; then echo y; fi", "while [ -f z ]; do sleep 1; done",
                     "cp a b || true", "cp a b || :", "echo enableVsync:false > o.txt",
                     "x=1"):
            with self.subTest(line=line):
                self.assertEqual(self.lint(SHELL + line + "\n"), [])

    def test_a_reasonless_not_a_gate_is_a_finding(self) -> None:
        found = self.lint(SHELL + 'false || die "q"   # not-a-gate: why\n')
        self.assertTrue(any("at least three words" in f for f in found), found)

    def test_a_line_cannot_be_both(self) -> None:
        found = self.lint(SHELL + 'false || die "q"   # not-a-gate: a b c gate:x-present\n')
        self.assertTrue(any("never both" in f for f in found), found)

    def test_a_malformed_tag_is_a_finding(self) -> None:
        found = self.lint(SHELL + 'false || die "q"   # gate: x-present\n')
        self.assertTrue(any("malformed gate tag" in f for f in found), found)

    def test_a_tag_without_a_mutant_is_a_finding(self) -> None:
        found = self.lint(SHELL + 'false || die "q"   # gate:nobody\n')
        self.assertTrue(any("gate:nobody has no mutant" in f for f in found), found)

    def test_a_gate_tagged_nowhere_is_a_finding(self) -> None:
        found = self.lint(SHELL.replace("   # gate:x-present", "   # not-a-gate: moved to another place"))
        self.assertTrue(any("gate id 'x-present' is tagged nowhere" in f for f in found), found)

    def test_a_rotted_anchor_is_a_finding(self) -> None:
        found = self.lint(SHELL.replace("[ -f x ] || die", "[ -e x ] || die"))
        self.assertTrue(any("x: anchor occurs 0 times" in f for f in found), found)

    def test_a_doubled_anchor_is_a_finding(self) -> None:
        found = self.lint(SHELL + '[ -f x ] || die "again"   # gate:x-present\n')
        self.assertTrue(any("x: anchor occurs 2 times" in f for f in found), found)

    def test_an_anchor_away_from_its_gate_is_a_finding(self) -> None:
        found = self.lint(SHELL.replace("# gate:x-present", "# gate:y-present"))
        self.assertTrue(any("touches no line tagged gate:x-present" in f for f in found), found)

    def test_a_comment_tag_covers_the_continued_line(self) -> None:
        # the clean tree (above) shows the comment tag covers `[ -f y ] \` AND `|| die "no y"`;
        # without the comment the continued die line is untagged
        found = self.lint(SHELL.replace("# gate:y-present\n", ""))
        self.assertTrue(any('die-shaped line with no' in f and 'die "no y"' in f for f in found), found)

    def test_a_test_id_that_names_no_test_is_a_finding(self) -> None:
        found = self.lint(body=self.MUTANTS.replace("t_s.T.test_x", "t_s.T.test_gone", 1))
        self.assertTrue(any("no test test_gone" in f for f in found), found)

    def test_an_untagged_raise_in_a_scoped_function_is_a_finding(self) -> None:
        found = self.lint(prog=PROG.replace('  # gate:neg\n    return', '\n    return'))
        self.assertTrue(any("die-shaped raise" in f for f in found), found)

    def test_every_python_exit_of_a_scoped_function_is_die_shaped(self) -> None:
        for stmt, what in (('return False, "too big"', "return"), ("return 1", "return"),
                           ("return None", "return"), ("return", "return"),
                           ("assert x < 9", "assert"), ("errors.append(x)", ".append()"),
                           ("sys.exit(2)", ".exit()"), ("raise ValueError(x)", "raise")):
            with self.subTest(stmt=stmt):
                prog = PROG.replace("    return x  #", f"    if x > 9:\n        {stmt}\n    return x  #")
                found = self.lint(prog=prog)
                self.assertEqual(len(found), 1, found)
                self.assertIn(f"die-shaped {what} with no", found[0])

    def test_a_scope_file_with_no_die_shaped_line_is_a_finding(self) -> None:  # the floor
        found = self.lint(shell="#!/usr/bin/env bash\necho hello\n")
        self.assertTrue(any("s.sh: in the [scope]" in f and "no line of it is die-shaped" in f
                            for f in found), found)
        found = self.lint(prog="def check(x):\n    print(x)\n")
        self.assertTrue(any("prog.py: in the [scope]" in f and "no node" in f for f in found), found)

    def containerfile_lint(self, text: str) -> list[str]:
        (self.root / "Containerfile").write_text(text)
        (self.root / "c.toml").write_text(textwrap.dedent('''\
            command = ["python3", "-m", "unittest"]
            ran_line = "^Ran"
            skip_marker = "skipped="
            failure_marker = " (t_s."
            failure_exit = 1
            [scope]
            files = ["Containerfile"]
            [gates]
            sums = "s"
            [[ mutant ]]
            name = "sums"
            gate = "sums"
            file = "Containerfile"
            anchor = "sha256sum -c -"
            replace = "true"
            test = ["t_s.T.test_x"]
            expect_failures = 1
            '''))
        return mutants.lint([mutants.load_area(self.root / "c.toml")], self.root)

    def test_an_untagged_run_in_a_containerfile_is_a_finding(self) -> None:
        tagged = ('FROM x\n# gate:sums\nRUN curl -o a.zip https://x/a.zip \\\n'
                  '    && echo "$SHA  a.zip" | sha256sum -c -\n'
                  "# not-a-gate: creates the user, nothing checked\nRUN useradd u\n")
        self.assertEqual(self.containerfile_lint(tagged), [])   # known-good
        found = self.containerfile_lint(tagged.replace("# gate:sums\n", ""))
        self.assertTrue(any("Containerfile:2: die-shaped line" in f for f in found), found)

    def test_a_tag_in_a_file_only_a_mutant_edits_counts(self) -> None:
        (self.root / "pins.env").write_text('A_SHA256="aa"   # gate:pin\n')
        body = self.MUTANTS + '''
[[ mutant ]]
name = "blank-pin"
gate = "pin"
file = "pins.env"
anchor = 'A_SHA256="aa"'
replace = 'A_SHA256=""'
test = ["t_s.T.test_x"]
expect_failures = 1
'''
        self.assertEqual(self.lint(body=body, gates='pin = "p"\n'), [])
        (self.root / "pins.env").write_text('A_SHA256="aa"\n')   # known-bad: the tag is gone
        found = self.lint(body=body, gates='pin = "p"\n')
        self.assertTrue(any("touches no line tagged gate:pin" in f for f in found), found)
        self.assertTrue(any("gate id 'pin' is tagged nowhere" in f for f in found), found)

    def test_a_raise_outside_the_scoped_functions_is_out_of_scope(self) -> None:
        self.assertEqual(self.lint(prog=PROG + "\n\ndef other():\n    raise ValueError('x')\n"), [])

    def test_a_scoped_function_that_is_gone_is_a_finding(self) -> None:
        found = self.lint(prog=PROG.replace("def check", "def checked"))
        self.assertTrue(any("names function 'check'" in f for f in found), found)

    def test_the_shipped_tree_is_clean(self) -> None:  # the lint over this repo, as `just gate-tags`
        self.assertEqual(mutants.lint(mutants.load_all()), [])


if __name__ == "__main__":
    unittest.main()
