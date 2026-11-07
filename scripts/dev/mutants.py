#!/usr/bin/env python3
"""mutants.py — prove each tagged guard in the host tools by breaking it, and lint that every
line in a known failure shape is tagged.

A guard is proven only by a test that goes red when the guard is gone. This tool keeps that proof
as data: a MUTANT is one literal edit to one guarded line (`anchor` -> `replace`) plus the tests
that must fail on it, with the message they must print and the number of failing tests. The edit
is made in a throw-away copy of the tree; the checkout is never touched.

    python3 scripts/dev/mutants.py list [area]
    python3 scripts/dev/mutants.py run [area [mutant ...]] [-j N]   # `just mutants`
    python3 scripts/dev/mutants.py lint                              # `just gate-tags`

MUTANT FILES: scripts/dev/mutants/<area>.toml, one per area of guarded code.
    command         argv that runs tests, cwd = the copy; a mutant's `test` ids are appended
    ran_line        regex of the line the test runner prints when it ran at all
    skip_marker     substring that marks a skipped test (a skip proves nothing)
    failure_marker  substring once per failing test; `expect_failures` counts it
    failure_exit    exit status of a red run
    timeout         seconds per run (default 300)
    [scope]         what the lint reads: `files` (shell / Containerfile, every line) and
                    `python` (file -> function names)
    [gates]         gate id -> what the guard protects; every `# gate:<id>` tag names one
    mutant          one table per mutant: name, gate (an id of [gates]), file, anchor (must
                    occur exactly once in file), replace, test (test ids), expect_message
                    (substrings of the output), expect_failures (the exact number of failing
                    tests)

RESULT of a mutant: killed (red, with every expected message and the exact failure count) ·
survived (the tests stayed green) · wrong_failure (red, but not as expected) · anchor_missing /
anchor_ambiguous (the anchor occurs 0 / 2+ times) · unparsable (the edited file does not parse)
· run_failed (no `ran_line`: the tests never ran) · skipped. Only killed is green.

Before any mutant, each area runs the tests of the mutants about to run on an UNEDITED copy: the
CONTROL row. A mutant's red run means something only if the same tests are green without the edit
and the runner printed its `ran_line`; a CONTROL that is not green stops the run with exit 2.

Exit: 0 all killed; 1 a guard is not proven (survived / wrong_failure); 2 a broken file, mutant
or CONTROL.
"""
from __future__ import annotations

import argparse
import ast
import os
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

REPO = Path(__file__).resolve().parents[2]
MUTANTS_DIR = REPO / "scripts" / "dev" / "mutants"

GREEN = {"killed"}
NOT_PROVEN = {"survived", "wrong_failure"}


class SpecError(Exception):
    """A malformed mutant file (exit 2)."""


@dataclass(frozen=True)
class Mutant:
    name: str
    gate: str
    file: str
    anchor: str
    replace: str
    test: tuple[str, ...]
    expect_message: tuple[str, ...]
    expect_failures: int


@dataclass
class Area:
    name: str
    path: Path
    command: tuple[str, ...]
    ran_line: str
    skip_marker: str
    failure_marker: str
    failure_exit: int
    timeout: int
    scope_files: tuple[str, ...]
    scope_python: dict[str, tuple[str, ...]]
    gates: dict[str, str]
    mutants: list[Mutant] = field(default_factory=list)


# ── loading ───────────────────────────────────────────────────────────────────────────────────
def _str(raw: object, where: str) -> str:
    if not isinstance(raw, str) or not raw:
        raise SpecError(f"{where} must be a non-empty string, got {raw!r}")
    return raw


def _str_list(raw: object, where: str, *, empty_ok: bool = False) -> tuple[str, ...]:
    if not isinstance(raw, list) or (not empty_ok and not raw):
        raise SpecError(f"{where} must be a non-empty list of strings, got {raw!r}")
    return tuple(_str(x, f"{where}[{i}]") for i, x in enumerate(raw))


def _int(raw: object, where: str) -> int:
    if not isinstance(raw, int) or isinstance(raw, bool) or raw < 0:
        raise SpecError(f"{where} must be a non-negative integer, got {raw!r}")
    return raw


def _keys(raw: dict, allowed: set[str], where: str) -> None:
    extra = sorted(set(raw) - allowed)
    if extra:
        raise SpecError(f"{where}: unknown key(s) {extra} (allowed: {sorted(allowed)})")


def _rel_path(raw: object, where: str) -> str:
    p = _str(raw, where)
    pp = PurePosixPath(p)
    if pp.is_absolute() or ".." in pp.parts:
        raise SpecError(f"{where} must be a path inside the tree, got {p!r}")
    return p


def _mutant(raw: object, i: int, gates: dict[str, str]) -> Mutant:
    where = f"mutant[{i}]"
    if not isinstance(raw, dict):
        raise SpecError(f"{where} must be a table")
    _keys(raw, {"name", "gate", "file", "anchor", "replace", "test", "expect_message",
                "expect_failures"}, where)
    name = _str(raw.get("name"), f"{where}.name")
    where = f"mutant '{name}'"
    gate = _str(raw.get("gate"), f"{where}.gate")
    if gate not in gates:
        raise SpecError(f"{where}.gate '{gate}' is not declared in [gates]")
    anchor = _str(raw.get("anchor"), f"{where}.anchor")
    replace = raw.get("replace")
    if not isinstance(replace, str):
        raise SpecError(f"{where}.replace must be a string")
    if replace == anchor:
        raise SpecError(f"{where}: replace equals anchor — the edit changes nothing")
    if "expect_failures" not in raw:
        raise SpecError(f"{where}.expect_failures is missing")
    return Mutant(
        name=name, gate=gate, file=_rel_path(raw.get("file"), f"{where}.file"),
        anchor=anchor, replace=replace,
        test=_str_list(raw.get("test"), f"{where}.test"),
        expect_message=_str_list(raw.get("expect_message", []), f"{where}.expect_message", empty_ok=True),
        expect_failures=_int(raw["expect_failures"], f"{where}.expect_failures"),
    )


def load_area(path: Path) -> Area:
    """Parse and validate one mutant file; SpecError on anything malformed."""
    try:
        raw = tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as e:
        raise SpecError(f"{path}: {e}") from None
    _keys(raw, {"command", "ran_line", "skip_marker", "failure_marker", "failure_exit", "timeout",
                "scope", "gates", "mutant"}, path.name)
    scope = raw.get("scope", {})
    if not isinstance(scope, dict):
        raise SpecError(f"{path.name}: [scope] must be a table")
    _keys(scope, {"files", "python"}, f"{path.name} [scope]")
    python = scope.get("python", {})
    if not isinstance(python, dict):
        raise SpecError(f"{path.name}: [scope.python] must map a file to function names")
    gates = raw.get("gates")
    if not isinstance(gates, dict) or not gates:
        raise SpecError(f"{path.name}: [gates] must declare at least one gate id")
    for k, v in gates.items():
        if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", k):
            raise SpecError(f"{path.name}: gate id '{k}' must be lowercase [a-z0-9-]")
        _str(v, f"{path.name} gates.{k}")
    failure_exit = _int(raw.get("failure_exit"), f"{path.name}.failure_exit")
    if failure_exit == 0:
        raise SpecError(f"{path.name}.failure_exit is 0 — a red run cannot exit 0")
    a = Area(
        name=path.stem, path=path,
        command=_str_list(raw.get("command"), f"{path.name}.command"),
        ran_line=_str(raw.get("ran_line"), f"{path.name}.ran_line"),
        skip_marker=_str(raw.get("skip_marker"), f"{path.name}.skip_marker"),
        failure_marker=_str(raw.get("failure_marker"), f"{path.name}.failure_marker"),
        failure_exit=failure_exit,
        timeout=_int(raw.get("timeout", 300), f"{path.name}.timeout"),
        scope_files=tuple(_rel_path(f, f"{path.name} scope.files")
                          for f in _str_list(scope.get("files", []), f"{path.name} scope.files", empty_ok=True)),
        scope_python={_rel_path(f, "scope.python key"): _str_list(fns, f"scope.python.{f}")
                      for f, fns in python.items()},
        gates=dict(gates),
    )
    try:
        re.compile(a.ran_line, re.M)
    except re.error as e:
        raise SpecError(f"{path.name}.ran_line is not a regex: {e}") from None
    raw_mutants = raw.get("mutant")
    if not isinstance(raw_mutants, list) or not raw_mutants:
        raise SpecError(f"{path.name}: no mutant table")
    seen: set[str] = set()
    for i, rm in enumerate(raw_mutants):
        mu = _mutant(rm, i, a.gates)
        if mu.name in seen:
            raise SpecError(f"{path.name}: mutant name '{mu.name}' is taken twice")
        seen.add(mu.name)
        a.mutants.append(mu)
    orphan = sorted(set(a.gates) - {mu.gate for mu in a.mutants})
    if orphan:
        raise SpecError(f"{path.name}: gate id(s) with no mutant: {orphan}")
    return a


def load_all(mutants_dir: Path = MUTANTS_DIR) -> list[Area]:
    paths = sorted(mutants_dir.glob("*.toml"))
    if not paths:
        raise SpecError(f"no mutant files in {mutants_dir}")
    areas = [load_area(p) for p in paths]
    owner: dict[str, str] = {}
    for a in areas:
        for g in a.gates:
            if g in owner:
                raise SpecError(f"gate id '{g}' declared by both {owner[g]} and {a.name}")
            owner[g] = a.name
    return areas


# ── running ───────────────────────────────────────────────────────────────────────────────────
@dataclass
class Row:
    area: str
    mutant: str
    result: str
    rc: int | None
    ran: str
    detail: str = ""


def tree_files(root: Path) -> list[str]:
    """Tracked + untracked-not-ignored files of the checkout (what a copy holds)."""
    r = subprocess.run(["git", "-C", str(root), "ls-files", "-z", "-co", "--exclude-standard"],
                       capture_output=True, check=True)
    return sorted({p for p in r.stdout.decode().split("\0") if p and (root / p).is_file()})


def make_copy(root: Path, dest: Path, files: list[str]) -> None:
    """Copy `files` of `root` into `dest`, and make the copy a git repo whose index lists them
    (a test that reads `git ls-files` sees the same file set as in the checkout)."""
    for rel in files:
        target = dest / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / rel, target, follow_symlinks=False)
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
    for argv in (["git", "init", "-q"], ["git", "add", "-A"]):
        subprocess.run(argv, cwd=dest, env=env, capture_output=True, check=True)


def _env() -> dict[str, str]:
    """The test environment: no git variables of a hook, no bytecode cache, and NO COLOUR — an
    escape sequence inside `FAIL: test_x` would make every expected message miss."""
    env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_") and k != "FORCE_COLOR"}
    env.update(PYTHONDONTWRITEBYTECODE="1", NO_COLOR="1", PYTHON_COLORS="0", TERM="dumb")
    env.pop("PYTHONPYCACHEPREFIX", None)
    return env


ANSI = re.compile(r"\x1b\[[0-9;]*[A-Za-z]")


def _parses(path: Path) -> str | None:
    """None when `path` parses in its language, else the error. bash -n / Python compile()."""
    if path.suffix == ".py":
        try:
            compile(path.read_text(encoding="utf-8"), str(path), "exec", dont_inherit=True)
        except SyntaxError as e:
            return f"SyntaxError: {e}"
        return None
    if path.suffix == ".sh":
        r = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True)
        return None if r.returncode == 0 else r.stderr.strip()
    return None


def _run_tests(a: Area, test: tuple[str, ...], cwd: Path) -> tuple[int | None, str]:
    try:
        r = subprocess.run([*a.command, *test], cwd=cwd, env=_env(), capture_output=True,
                           text=True, timeout=a.timeout)
    except subprocess.TimeoutExpired as e:
        out = (e.stdout or b"").decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
        return None, ANSI.sub("", out) + f"\n[mutants] tests timed out after {a.timeout}s"
    return r.returncode, ANSI.sub("", r.stdout + r.stderr)


def _ran(a: Area, out: str) -> str | None:
    hit = re.search(a.ran_line, out, re.M)
    return hit.group(0) if hit else None


def control(a: Area, mutants: list[Mutant], files: list[str], work: Path, root: Path = REPO) -> Row:
    """The unedited CONTROL: the union of the tests of the mutants about to run, on a fresh copy,
    must be green — else no mutant's red run says anything."""
    test: list[str] = []
    for mu in mutants:
        test += [t for t in mu.test if t not in test]
    tree = work / f"{a.name}-control"
    make_copy(root, tree, files)
    try:
        rc, out = _run_tests(a, tuple(test), tree)
    finally:
        shutil.rmtree(tree, ignore_errors=True)
    ran = _ran(a, out)
    if ran is None:
        return Row(a.name, "CONTROL", "run_failed", rc, "", out[-3000:])
    if a.skip_marker in out:
        return Row(a.name, "CONTROL", "skipped", rc, ran, out[-3000:])
    if rc != 0:
        return Row(a.name, "CONTROL", "red", rc, ran, out[-3000:])
    return Row(a.name, "CONTROL", "green", rc, ran)


def run_mutant(a: Area, mu: Mutant, files: list[str], work: Path, root: Path = REPO) -> Row:
    """Make the mutant's edit in a fresh copy, run its tests, say what came out."""
    tree = work / f"{a.name}-{mu.name}"
    make_copy(root, tree, files)
    try:
        return _classify(a, mu, tree)
    finally:
        shutil.rmtree(tree, ignore_errors=True)


def _classify(a: Area, mu: Mutant, tree: Path) -> Row:
    def row(result: str, rc: int | None = None, ran: str = "", detail: str = "") -> Row:
        return Row(a.name, mu.name, result, rc, ran, detail)

    target = tree / mu.file
    if not target.resolve().is_relative_to(tree.resolve()):
        raise RuntimeError(f"mutant {mu.name}: {mu.file} resolves outside the copy")
    if not target.is_file():
        return row("anchor_missing", detail=f"no file {mu.file}")
    text = target.read_text(encoding="utf-8")
    n = text.count(mu.anchor)
    if n != 1:
        return row("anchor_missing" if n == 0 else "anchor_ambiguous",
                   detail=f"anchor occurs {n} times in {mu.file}: {mu.anchor[:80]!r}")
    target.write_text(text.replace(mu.anchor, mu.replace), encoding="utf-8")
    err = _parses(target)
    if err:
        return row("unparsable", detail=err)
    rc, out = _run_tests(a, mu.test, tree)
    ran = _ran(a, out)
    if ran is None:
        return row("run_failed", rc, detail=out[-3000:])
    if a.skip_marker in out:
        return row("skipped", rc, ran, out[-3000:])
    if rc == 0:
        return row("survived", rc, ran, out[-1500:])
    why: list[str] = []
    if rc != a.failure_exit:
        why.append(f"exit {rc}, expected {a.failure_exit}")
    why += [f"missing: {m!r}" for m in mu.expect_message if m not in out]
    n = out.count(a.failure_marker)
    if n != mu.expect_failures:
        why.append(f"{n} failing test(s), expected {mu.expect_failures}")
    if why:
        return row("wrong_failure", rc, ran, "; ".join(why) + "\n" + out[-3000:])
    return row("killed", rc, ran)


def print_row(r: Row) -> None:
    rc = "-" if r.rc is None else str(r.rc)
    print(f"{r.result.upper() if r.mutant == 'CONTROL' else r.result:<17} {r.area}/{r.mutant}  rc={rc}  {r.ran}")
    if r.detail and r.result not in GREEN and r.result != "green":
        lines = r.detail.rstrip().splitlines()
        # the first line says WHY (the expectation that failed); the tail is the test output
        for line in (lines if len(lines) <= 25 else [lines[0], "…", *lines[-24:]]):
            print(f"    | {line}")


def cmd_run(args: argparse.Namespace) -> int:
    areas = load_all()
    if args.area:
        areas = [a for a in areas if a.name == args.area]
        if not areas:
            raise SpecError(f"no mutant file '{args.area}'")
    chosen: list[tuple[Area, list[Mutant]]] = []
    for a in areas:
        mutants = a.mutants
        if args.mutants:
            mutants = [mu for mu in a.mutants if mu.name in args.mutants]
            unknown = set(args.mutants) - {mu.name for mu in a.mutants}
            if unknown:
                raise SpecError(f"{a.name}: no mutant(s) {sorted(unknown)}")
        chosen.append((a, mutants))
    return run_table(chosen, REPO, args.jobs)


def run_table(chosen: list[tuple[Area, list[Mutant]]], root: Path, jobs: int) -> int:
    """The CONTROL rows, then (only when every CONTROL is green) one row per mutant; the exit code."""
    files = tree_files(root)
    rows: list[Row] = []
    with tempfile.TemporaryDirectory(prefix="mutants-") as tmp:
        work = Path(tmp)
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            controls = list(pool.map(lambda c: control(c[0], c[1], files, work, root), chosen))
        for c in controls:
            print_row(c)
        if any(c.result != "green" for c in controls):
            print("mutants: a CONTROL is not green, so a red mutant run would prove nothing — stopped",
                  file=sys.stderr)
            return 2
        todo = [(a, mu) for a, mutants in chosen for mu in mutants]
        with ThreadPoolExecutor(max_workers=jobs) as pool:
            rows = list(pool.map(lambda j: run_mutant(j[0], j[1], files, work, root), todo))
    for r in rows:
        print_row(r)
    tally: dict[str, int] = {}
    for r in rows:
        tally[r.result] = tally.get(r.result, 0) + 1
    print(f"mutants: {len(rows)} mutant(s): " + ", ".join(f"{k} {v}" for k, v in sorted(tally.items())))
    if any(r.result not in GREEN | NOT_PROVEN for r in rows):
        return 2
    return 1 if any(r.result in NOT_PROVEN for r in rows) else 0


def cmd_list(args: argparse.Namespace) -> int:
    for a in load_all():
        if args.area and a.name != args.area:
            continue
        print(f"{a.name} ({a.path.relative_to(REPO)}): {len(a.mutants)} mutant(s), {len(a.gates)} gate id(s)")
        for mu in a.mutants:
            print(f"  {mu.name:<44} {mu.gate:<34} {mu.file}")
    return 0


# ── the gate-tag lint ─────────────────────────────────────────────────────────────────────────
# Die-shaped is a fixed list of known failure shapes, not every way a line can fail. A guard in
# another shape (a bare `grep -q` / `cmp` / `diff` under `set -e`, `(( … ))`, `${1:?}`,
# `trap … ERR`, Python `+=` / `.extend` / `ok = False`, Python inside a shell heredoc) is not
# flagged: it is tested only if its author tags it and review checks that.
# Shell, any of: a `return` or `exit` not followed by a literal 0 (a bare one passes on the last
# status); `false` as a command; a `||` whose right side is not `true` or `:`; a call of `die`
# or of a `*_fail` helper; a `test` / `[` / `[[` that is not the condition of `if` / `elif` /
# `while` / `until` (its status becomes the function's, or ends the script under `set -e`); a
# `*sum -c` / `--check`.
# Containerfile: every `RUN` instruction (any command in it can fail the build).
# Python, inside the listed functions: every `return`, `raise` and `assert`, every call of
# `exit` / `sys.exit` / `die` / `SystemExit`, and every `.append(...)` (a recorded failure).
# A file in [scope] with no die-shaped line at all is itself a finding: the rule cannot read it.
DIE_SH = re.compile(
    r"\breturn\b(?!\s+0\b)|\bexit\b(?!\s+0\b)|(?:^|[\s;&|({])false\b(?![\w.:=-])"
    r"|\|\|(?!\s*(?:true|:)\s*(?:$|[;)}#]|&&|\|\|))"
    r"|\bdie\b|\b\w+_fail\b"
    r"|\b\w*sum\b[^|;&]*\s(?:-c|--check)\b")
TEST_CMD = re.compile(r"(?:^|(?<=[\s;&|({]))(?:test|\[\[?)(?=\s)")
CONDITION = re.compile(r"(?:^|[\s;&|({])(?:if|elif|while|until)$")
DIE_CONTAINERFILE = re.compile(r"^\s*RUN\b")
TAG = re.compile(r"(?:^|\s)#\s*(gate:|not-a-gate:)(.*)$")
GATE_ID = re.compile(r"gate:([a-z0-9][a-z0-9-]*)")
MALFORMED = re.compile(r"(?:^|\s)#.*(?<![a-z-])gate:(?![a-z0-9])")


def die_shaped_line(line: str, containerfile: bool = False) -> bool:
    """Whether a shell (or Containerfile) line is die-shaped; its own tag comment is not read."""
    if _is_comment(line):
        return False
    hit = TAG.search(line)
    code = line[: hit.start()] if hit else line
    if containerfile:
        return bool(DIE_CONTAINERFILE.search(code))
    if DIE_SH.search(code):
        return True
    return any(not CONDITION.search(code[: m.start()].rstrip()) for m in TEST_CMD.finditer(code))


@dataclass
class Tagged:
    gates: set[str]
    not_gate: str | None   # the reason, when the line is tagged not-a-gate


def parse_tag(line: str) -> Tagged | None:
    """The tag a line carries, or None. Raises ValueError on a malformed tag."""
    hit = TAG.search(line)
    if not hit:
        if MALFORMED.search(line):
            raise ValueError("malformed gate tag (write `# gate:<id>`)")
        return None
    comment = line[hit.start():]
    if hit.group(1) == "not-a-gate:":
        if GATE_ID.search(comment.replace("not-a-gate:", "")):
            raise ValueError("a line is either `gate:<id>` or `not-a-gate:`, never both")
        reason = hit.group(2).strip()
        if len(reason.split()) < 3:
            raise ValueError("`not-a-gate:` needs a reason of at least three words")
        return Tagged(set(), reason)
    gates = set(GATE_ID.findall(comment))
    if not gates:
        raise ValueError("malformed gate tag (write `# gate:<id>`)")
    return Tagged(gates, None)


def _is_comment(line: str) -> bool:
    return line.lstrip().startswith("#")


def coverage(lines: list[str], shell: bool) -> dict[int, Tagged]:
    """line number (1-based) -> the tag that covers it. A tag on a code line covers that line; a
    tag on a comment-only line covers the next code line and, in a shell file, its backslash
    continuations (a line ending in `\\` cannot carry a comment of its own)."""
    cov: dict[int, Tagged] = {}
    for i, line in enumerate(lines, 1):
        tag = parse_tag(line)
        if tag is None:
            continue
        if not _is_comment(line):
            cov[i] = tag
            continue
        j = i + 1
        while j <= len(lines) and (_is_comment(lines[j - 1]) or not lines[j - 1].strip()):
            j += 1
        while j <= len(lines):
            cov[j] = tag
            if not (shell and lines[j - 1].rstrip().endswith("\\")):
                break
            j += 1
    return cov


def _py_die_nodes(tree: ast.AST, functions: tuple[str, ...]) -> tuple[list[tuple[int, int, str]], set[str]]:
    """(lineno, end_lineno, what) of every die-shaped node inside the named functions."""
    found: list[tuple[int, int, str]] = []
    seen: set[str] = set()
    for fn in ast.walk(tree):
        if not isinstance(fn, ast.FunctionDef | ast.AsyncFunctionDef) or fn.name not in functions:
            continue
        seen.add(fn.name)
        for node in ast.walk(fn):
            what = _py_die_shape(node)
            if what:
                found.append((node.lineno, node.end_lineno or node.lineno, what))
    return found, seen


def _py_die_shape(node: ast.AST) -> str | None:
    if isinstance(node, ast.Raise):
        return "raise"
    if isinstance(node, ast.Assert):
        return "assert"
    if isinstance(node, ast.Return):
        return "return"
    if isinstance(node, ast.Call):
        f = node.func
        if isinstance(f, ast.Name) and f.id in {"die", "exit", "SystemExit"}:
            return f"{f.id}()"
        if isinstance(f, ast.Attribute) and f.attr in {"exit", "append"}:
            return f".{f.attr}()"
    return None


def lint(areas: list[Area], root: Path = REPO) -> list[str]:
    """Every finding of the gate-tag lint, as `path:line: message`; empty = clean."""
    out: list[str] = []
    owner = {g: a for a in areas for g in a.gates}
    tagged_ids: dict[str, set[str]] = {}
    texts: dict[str, list[str]] = {}
    for a in areas:
        scope = list(a.scope_files) + [f for f in a.scope_python if f not in a.scope_files]
        for rel in scope:
            p = root / rel
            if not p.is_file():
                out.append(f"{rel}: in the [scope] of {a.name}, but there is no such file")
                continue
            lines = p.read_text(encoding="utf-8").splitlines()
            texts[rel] = lines
            shell = rel not in a.scope_python
            try:
                cov = coverage(lines, shell)
            except ValueError:
                cov = {}
            for i, line in enumerate(lines, 1):
                try:
                    tag = parse_tag(line)
                except ValueError as e:
                    out.append(f"{rel}:{i}: {e}")
                    continue
                for g in (tag.gates if tag else set()):
                    tagged_ids.setdefault(g, set()).add(f"{rel}:{i}")
            if shell:
                containerfile = PurePosixPath(rel).name in {"Containerfile", "Dockerfile"}
                die_lines = [i for i, line in enumerate(lines, 1) if die_shaped_line(line, containerfile)]
                if not die_lines:
                    out.append(f"{rel}: in the [scope] of {a.name}, but no line of it is die-shaped "
                               f"— the rule does not read this file")
                for i in die_lines:
                    if i not in cov:
                        out.append(f"{rel}:{i}: die-shaped line with no `# gate:<id>` and no "
                                   f"`# not-a-gate: <reason>`: {lines[i - 1].strip()[:120]}")
            else:
                try:
                    tree = ast.parse("\n".join(lines), rel)
                except SyntaxError as e:
                    out.append(f"{rel}: does not parse: {e}")
                    continue
                nodes, seen = _py_die_nodes(tree, a.scope_python[rel])
                for fn in sorted(set(a.scope_python[rel]) - seen):
                    out.append(f"{rel}: [scope.python] names function '{fn}', which is not in the file")
                if not nodes:
                    out.append(f"{rel}: in the [scope] of {a.name}, but no node of its listed "
                               f"functions is die-shaped — the rule does not read this file")
                for lo, hi, what in nodes:
                    if not any(n in cov for n in range(lo, hi + 1)):
                        out.append(f"{rel}:{lo}: die-shaped {what} with no `# gate:<id>` and no "
                                   f"`# not-a-gate: <reason>`: {lines[lo - 1].strip()[:120]}")
    # a file a mutant edits but the lint does not scan (data such as pins.env) still carries the
    # tag of the gate its mutant breaks
    for rel in sorted({mu.file for a in areas for mu in a.mutants} - set(texts)):
        p = root / rel
        lines = p.read_text(encoding="utf-8").splitlines() if p.is_file() else []
        for i, line in enumerate(lines, 1):
            try:
                tag = parse_tag(line)
            except ValueError as e:
                out.append(f"{rel}:{i}: {e}")
                continue
            for g in (tag.gates if tag else set()):
                tagged_ids.setdefault(g, set()).add(f"{rel}:{i}")
    for g, where in sorted(tagged_ids.items()):
        if g not in owner:
            out.append(f"{sorted(where)[0]}: gate:{g} has no mutant (no mutant file declares it in [gates])")
    for a in areas:
        for g in sorted(a.gates):
            if g not in tagged_ids:
                rel = a.path.relative_to(root) if a.path.is_relative_to(root) else a.path
                out.append(f"{rel}: gate id '{g}' is tagged nowhere")
        for mu in a.mutants:
            out += _lint_mutant(a, mu, root, texts)
    return out


def _lint_mutant(a: Area, mu: Mutant, root: Path, texts: dict[str, list[str]]) -> list[str]:
    where = f"{a.name}/{mu.name}"
    out: list[str] = []
    p = root / mu.file
    if not p.is_file():
        return [f"{where}: file {mu.file} does not exist"]
    text = p.read_text(encoding="utf-8")
    n = text.count(mu.anchor)
    if n != 1:
        return [f"{where}: anchor occurs {n} times in {mu.file} (must be exactly once): {mu.anchor[:80]!r}"]
    first = text[: text.index(mu.anchor)].count("\n") + 1
    last = first + mu.anchor.count("\n")
    lines = texts.get(mu.file) or text.splitlines()
    try:
        cov = coverage(lines, mu.file not in a.scope_python)
    except ValueError:
        cov = {}
    if not any(mu.gate in cov[k].gates for k in range(first, last + 1) if k in cov):
        out.append(f"{where}: the anchor ({mu.file}:{first}-{last}) touches no line tagged gate:{mu.gate}")
    for t in mu.test:
        out += _lint_test_id(where, t, root)
    return out


def _lint_test_id(where: str, test_id: str, root: Path) -> list[str]:
    parts = test_id.split(".")
    for k in range(len(parts), 0, -1):
        f = root.joinpath(*parts[:k]).with_suffix(".py")
        if f.is_file():
            text = f.read_text(encoding="utf-8")
            rest = parts[k:]
            if rest and not re.search(rf"^class {re.escape(rest[0])}\b", text, re.M):
                return [f"{where}: test {test_id}: no class {rest[0]} in {f.relative_to(root)}"]
            if len(rest) > 1 and not re.search(rf"^\s+def {re.escape(rest[1])}\(", text, re.M):
                return [f"{where}: test {test_id}: no test {rest[1]} in {f.relative_to(root)}"]
            return []
    return [f"{where}: test {test_id}: no such test module"]


def cmd_lint(_: argparse.Namespace) -> int:
    areas = load_all()
    findings = lint(areas)
    for f in findings:
        print(f, file=sys.stderr)
    if findings:
        print(f"gate-tags: {len(findings)} finding(s)", file=sys.stderr)
        return 1
    n = sum(len(a.mutants) for a in areas)
    print(f"gate-tags: OK — every die-shaped line in scope is tagged; {n} mutant(s) anchored")
    return 0


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("list")
    p.add_argument("area", nargs="?")
    p.set_defaults(fn=cmd_list)
    p = sub.add_parser("run")
    p.add_argument("area", nargs="?")
    p.add_argument("mutants", nargs="*")
    p.add_argument("-j", "--jobs", type=int, default=max(1, min(8, (os.cpu_count() or 2) // 2)))
    p.set_defaults(fn=cmd_run)
    p = sub.add_parser("lint")
    p.set_defaults(fn=cmd_lint)
    args = ap.parse_args(argv)
    try:
        return args.fn(args)
    except SpecError as e:
        print(f"mutants: {e}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
