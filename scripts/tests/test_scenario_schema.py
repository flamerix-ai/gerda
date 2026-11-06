"""The scenario schema (scenarios/scenario.schema.json) against the files, the parsers and the doc.

The parsers (scripts/dev/arena.py, navbench.py, gate_live.py) read spec keys with plain dict
access and ignore a key they do not know, so a typo such as `"expcet"` drops an arena out of the
full gate without a word. The schema states the shape, and this suite holds it in four places:

- every tracked file in scenarios/arenas, scenarios/bench and scenarios/sets matches its `$defs`
  entry, and every arena and set also passes the real loader (`arena._load`);
- every key a parser reads is a property of the schema, and every property is read by a parser
  for its own family (`ParserKeysTests`, an AST scan — the receiver table is `RECEIVERS`, the
  families each parser loads `PARSER_FAMILIES`);
- every property and op kind is named in docs/SCENARIOS.md, and the doc's examples validate;
- every event, mission and plan name a file uses exists in the source or in docs/MISSIONS.md.

Each check is paired with a known-bad that must fail it. Stdlib only: the validator below
implements the JSON Schema keywords the schema uses and refuses any other keyword — and any value
form of a supported keyword it does not apply (`FORMS`; the table: `ValidatorFormTests`) — so the
schema cannot rely on a keyword or form that is silently ignored here. A `pattern` is ECMA-262
and is translated to Python (`ecma_pattern`), refusing any token outside the translated subset.

    python3 -m unittest discover -s scripts/tests -t scripts/tests -p test_scenario_schema.py
"""
from __future__ import annotations

import ast
import copy
import json
import re
import shutil
import sys
import tempfile
import unittest
import warnings
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts"))
sys.path.insert(0, str(REPO / "scripts" / "dev"))
sys.path.insert(0, str(REPO / "mcp"))
import arena  # noqa: E402

SCHEMA_PATH = REPO / "scenarios" / "scenario.schema.json"
DOC_PATH = REPO / "docs" / "SCENARIOS.md"
FAMILIES = {"arenas": "arena", "bench": "bench", "sets": "set"}  # scenarios/<dir> → $defs entry

# ── a stdlib validator for the subset of JSON Schema the schema uses ─────────────────────────
ANNOTATIONS = {"$schema", "$id", "title", "description", "$defs"}
KEYWORDS = {
    "$ref", "type", "const", "enum", "required", "properties", "additionalProperties", "items",
    "minItems", "maxItems", "minLength", "pattern", "minimum", "maximum", "exclusiveMinimum",
    "oneOf", "anyOf", "allOf", "not", "if", "then",
}


DIALECT = "https://json-schema.org/draft/2020-12/schema"


class SchemaKeywordError(ValueError):
    """The schema uses a keyword, or a value form of one, this validator does not implement."""


# Per keyword, the value forms of JSON Schema 2020-12 this validator applies; any other form —
# legal in the spec or not — raises SchemaKeywordError, so no form is accepted and then ignored.
# The full keyword → forms table, with what is refused: ValidatorFormTests.
def _is_schema(v: object) -> bool:
    return isinstance(v, (dict, bool))


def _is_count(v: object) -> bool:  # a non-negative integer, `1.0` and `true` excluded
    return isinstance(v, int) and not isinstance(v, bool) and v >= 0


def _is_bound(v: object) -> bool:  # a number; `true` (draft-4 exclusiveMinimum) excluded
    return isinstance(v, (int, float)) and not isinstance(v, bool)


# `pattern` is ECMA-262 with the "u" flag (JSON Schema 2020-12 core § 6.4); Python `re` differs:
# `$` also matches before a trailing "\n", `\d`/`\w`/`\b` are Unicode, `\s` is another set, `.`
# stops only at "\n", and it accepts syntax the u-mode refuses (`\:`, `\Z`, `a{`, `a*+`). So a
# pattern is TRANSLATED token by token, under re.ASCII, and every token outside the subset below
# is refused (the APPLIED / REFUSED rows of `pattern`).
ECMA_SPACE = ("\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000"
              "\\ufeff")
ECMA_DOT = "[^\\n\\r\\u2028\\u2029]"
SYNTAX = set("^$\\.*+?()[]{}|/")  # the u-mode identity escapes; `-` too inside a class
QUANT = re.compile(r"\{\d+(?:,\d*)?\}")


def ecma_pattern(p: str) -> str:
    """`p` (ECMA-262, u flag) as a Python pattern for re.ASCII; ValueError for any other token."""
    out: list[str] = []
    i, in_class, after_quant, can_repeat = 0, False, False, False
    while i < len(p):
        c, nxt = p[i], p[i + 1:i + 2]
        if c == "\\":
            if in_class and nxt in set("dDwW") or not in_class and nxt in set("dDwWbB"):
                out.append(c + nxt)
            elif nxt == "s":
                out.append(ECMA_SPACE if in_class else f"[{ECMA_SPACE}]")
            elif nxt == "S" and not in_class:
                out.append(f"[^{ECMA_SPACE}]")
            elif nxt in SYNTAX or (in_class and nxt == "-"):
                out.append(c + nxt)
            else:
                raise ValueError(f"escape \\{nxt} in {p!r}")
            i += 2
            after_quant, can_repeat = False, not in_class  # `\b*`: Python refuses it too
            continue
        if in_class:
            if c == "]":
                in_class, can_repeat = False, True
            # literal in ECMA; Python reserves them for set operations (a FutureWarning today)
            out.append("\\" + c if c in "[&~|" else c)
            i += 1
            continue
        quant = QUANT.match(p, i) if c == "{" else None
        if c in "*+?" or quant:
            if c == "?" and after_quant:  # the lazy marker
                out.append(c)
                i, after_quant = i + 1, False
                continue
            if not can_repeat:
                raise ValueError(f"nothing to repeat at {i} in {p!r}")
            out.append(quant.group(0) if quant else c)
            i = quant.end() if quant else i + 1
            after_quant, can_repeat = True, False
            continue
        after_quant, can_repeat = False, True
        if c == "[":
            neg = p[i + 1:i + 2] == "^"
            if p[i + 1 + neg:i + 2 + neg] == "]":
                raise ValueError(f"empty class (`[]`/`[^]`) in {p!r}")
            in_class = True
            out.append("[^" if neg else "[")
            i += 1 + neg
            continue
        if c == "(" and nxt == "?":
            if p[i + 2:i + 3] not in (":", "=", "!"):
                raise ValueError(f"group syntax (?{p[i + 2:i + 3]} in {p!r}")
            out.append(p[i:i + 3])
            i, can_repeat = i + 3, False
            continue
        if c in "{}]":
            raise ValueError(f"lone {c!r} in {p!r}")
        out.append({"$": "\\Z", ".": ECMA_DOT}.get(c, c))
        if c in "(|^$":
            can_repeat = False
        i += 1
    return "".join(out)  # an unclosed class is left to re.compile, which refuses it


def _is_regex(v: object) -> bool:
    if not isinstance(v, str):
        return False
    try:
        re.compile(ecma_pattern(v), re.ASCII)
    except (ValueError, re.error):  # re.error is a ValueError
        return False
    return True


def _is_schema_list(v: object) -> bool:  # allOf/anyOf/oneOf: a NON-empty array of schemas
    return isinstance(v, list) and bool(v) and all(_is_schema(s) for s in v)


FORMS = {
    "type": lambda v: (isinstance(v, str) or (isinstance(v, list) and bool(v)
                                              and all(isinstance(n, str) for n in v))),
    "const": lambda v: True,
    "enum": lambda v: isinstance(v, list),
    "required": lambda v: isinstance(v, list) and all(isinstance(k, str) for k in v),
    "properties": lambda v: isinstance(v, dict) and all(_is_schema(s) for s in v.values()),
    "additionalProperties": _is_schema,
    "items": _is_schema,  # the array (tuple) form is draft 2019-09; 2020-12 spells it prefixItems
    "minItems": _is_count, "maxItems": _is_count, "minLength": _is_count,
    "pattern": _is_regex,
    "minimum": _is_bound, "maximum": _is_bound, "exclusiveMinimum": _is_bound,
    "oneOf": _is_schema_list, "anyOf": _is_schema_list, "allOf": _is_schema_list,
    "not": _is_schema, "if": _is_schema, "then": _is_schema,
    "$ref": lambda v: isinstance(v, str),
    "$defs": lambda v: isinstance(v, dict) and all(_is_schema(s) for s in v.values()),
    "$schema": lambda v: v == DIALECT,
    "$id": lambda v: isinstance(v, str),
    "title": lambda v: isinstance(v, str), "description": lambda v: isinstance(v, str),
}
# A nested $id rebases every $ref below it, a nested $schema switches dialect, and a nested $defs
# is reachable only by a pointer `_deref` refuses — none is applied, so each is refused below root.
ROOT_ONLY = {"$schema", "$id", "$defs"}


def _check_forms(schema: dict, root: dict, where: str) -> None:
    for key, v in schema.items():
        if key in FORMS and not FORMS[key](v):
            raise SchemaKeywordError(f"{where}: unsupported form of {key!r}: {json.dumps(v)}")
        if key in ROOT_ONLY and schema is not root:
            raise SchemaKeywordError(f"{where}: {key!r} below the schema root")
    if ("if" in schema) != ("then" in schema):  # alone, either one is a no-op
        raise SchemaKeywordError(f"{where}: 'if' and 'then' come as a pair ('else' is unsupported)")
    if "type" in schema:
        for name in schema["type"] if isinstance(schema["type"], list) else [schema["type"]]:
            _is_type(None, name)  # an unknown name raises


def _json_eq(a: object, b: object) -> bool:
    """JSON equality: `true` is no number, `1` equals `1.0`, objects compare key-order-free."""
    if isinstance(a, bool) or isinstance(b, bool):
        return isinstance(a, bool) and isinstance(b, bool) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(_json_eq(x, y) for x, y in zip(a, b, strict=True))
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_json_eq(a[k], b[k]) for k in a)
    return type(a) is type(b) and a == b


def _is_type(value: object, name: str) -> bool:
    if name == "object":
        return isinstance(value, dict)
    if name == "array":
        return isinstance(value, list)
    if name == "string":
        return isinstance(value, str)
    if name == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if name == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if name == "boolean":
        return isinstance(value, bool)
    if name == "null":
        return value is None
    raise SchemaKeywordError(f"unknown type {name!r}")


def _deref(ref: str, root: dict, where: str) -> dict | bool:
    name = ref[len("#/$defs/"):]
    if not ref.startswith("#/$defs/") or "/" in name or "~" in name:
        raise SchemaKeywordError(f"{where}: only local #/$defs/<name> refs are supported ({ref})")
    if name not in root.get("$defs", {}):
        raise SchemaKeywordError(f"{where}: $ref to a missing definition ({ref})")
    return root["$defs"][name]


def _check_node(schema: object, root: dict, where: str) -> None:
    """Raise SchemaKeywordError unless every keyword and value form of this ONE node is applied."""
    if isinstance(schema, bool):
        return
    if not isinstance(schema, dict):
        raise SchemaKeywordError(f"{where}: a schema is an object or a boolean, got {json.dumps(schema)}")
    unknown = set(schema) - KEYWORDS - ANNOTATIONS
    if unknown:
        raise SchemaKeywordError(f"{where}: unsupported keyword(s) {sorted(unknown)}")
    _check_forms(schema, root, where)
    if "$ref" in schema:
        beside = set(schema) - {"$ref"} - ANNOTATIONS
        if beside:  # validate returns the target's verdict, so a sibling would go unchecked
            raise SchemaKeywordError(f"{where}: keyword(s) {sorted(beside)} beside $ref")
        _deref(schema["$ref"], root, where)


def check_schema(schema: object, root: dict, where: str = "/") -> None:
    """`_check_node` over EVERY subschema, reached by a value or not (an unreferenced $defs entry)."""
    _check_node(schema, root, where)
    if not isinstance(schema, dict):
        return
    for key in ("properties", "$defs"):
        for name, sub in schema.get(key, {}).items():
            check_schema(sub, root, f"{where.rstrip('/')}/{key}/{name}")
    for key in ("additionalProperties", "items", "not", "if", "then"):
        if key in schema:
            check_schema(schema[key], root, f"{where.rstrip('/')}/{key}")
    for key in ("allOf", "anyOf", "oneOf"):
        for i, sub in enumerate(schema.get(key, [])):
            check_schema(sub, root, f"{where.rstrip('/')}/{key}/{i}")


def validate(value: object, schema: dict | bool, root: dict, path: str = "") -> list[str]:
    """Every violation of `schema` by `value`, as `<json pointer>: <message>` lines."""
    where = path or "/"
    _check_node(schema, root, where)
    if isinstance(schema, bool):  # the boolean schemas: `true` accepts all, `false` nothing
        return [] if schema else [f"{where}: the false schema accepts no value"]
    if "$ref" in schema:
        return validate(value, _deref(schema["$ref"], root, where), root, path)
    errors: list[str] = []
    if "type" in schema:
        names = schema["type"] if isinstance(schema["type"], list) else [schema["type"]]
        if not any(_is_type(value, n) for n in names):
            return [f"{where}: expected {'/'.join(names)}, got {json.dumps(value)}"]
    if "const" in schema and not _json_eq(value, schema["const"]):
        errors.append(f"{where}: must be {json.dumps(schema['const'])}, got {json.dumps(value)}")
    if "enum" in schema and not any(_json_eq(value, e) for e in schema["enum"]):
        errors.append(f"{where}: must be one of {schema['enum']}, got {json.dumps(value)}")
    if isinstance(value, str):
        if len(value) < schema.get("minLength", 0):
            errors.append(f"{where}: shorter than {schema['minLength']}")
        if "pattern" in schema and not re.search(ecma_pattern(schema["pattern"]), value, re.ASCII):
            errors.append(f"{where}: does not match {schema['pattern']!r}")
    if _is_type(value, "number"):
        if "minimum" in schema and value < schema["minimum"]:
            errors.append(f"{where}: below the minimum {schema['minimum']}")
        if "maximum" in schema and value > schema["maximum"]:
            errors.append(f"{where}: above the maximum {schema['maximum']}")
        if "exclusiveMinimum" in schema and value <= schema["exclusiveMinimum"]:
            errors.append(f"{where}: must be greater than {schema['exclusiveMinimum']}")
    if isinstance(value, list):
        if len(value) < schema.get("minItems", 0):
            errors.append(f"{where}: fewer than {schema['minItems']} items")
        if "maxItems" in schema and len(value) > schema["maxItems"]:
            errors.append(f"{where}: more than {schema['maxItems']} items")
        if "items" in schema:
            for i, item in enumerate(value):
                errors += validate(item, schema["items"], root, f"{path}/{i}")
    if isinstance(value, dict):
        props = schema.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append(f"{where}: missing required key {key!r}")
        for key, item in value.items():
            if key in props:
                errors += validate(item, props[key], root, f"{path}/{key}")
            elif schema.get("additionalProperties", True) is False:
                errors.append(f"{where}: unknown key {key!r}")
            else:
                errors += validate(item, schema.get("additionalProperties", True), root, f"{path}/{key}")
    for sub in schema.get("allOf", []):
        errors += validate(value, sub, root, path)
    if "anyOf" in schema and not any(not validate(value, s, root, path) for s in schema["anyOf"]):
        errors.append(f"{where}: matches none of {_branch_names(schema['anyOf'])}")
    if "oneOf" in schema:
        results = [validate(value, s, root, path) for s in schema["oneOf"]]
        passing = sum(1 for r in results if not r)
        if passing == 0:
            keyed = [r for s, r in zip(schema["oneOf"], results, strict=True) if _const_match(value, s, root)]
            errors += keyed[0] if len(keyed) == 1 else min(results, key=len)
        elif passing > 1:
            errors.append(f"{where}: matches {passing} branches of oneOf, want exactly 1")
    if "not" in schema and not validate(value, schema["not"], root, path):
        errors.append(f"{where}: must not match {json.dumps(schema['not'])}")
    if "if" in schema and not validate(value, schema["if"], root, path) and "then" in schema:
        errors += validate(value, schema["then"], root, path)
    return errors


def _const_match(value: object, branch: dict, root: dict) -> bool:
    """True when `value` carries the branch's const-valued keys (`"op": "fill"` picks op_fill),
    so a broken op reports its own branch's error, not the first branch's `must be "clear"`."""
    while isinstance(branch, dict) and "$ref" in branch:
        branch = _deref(branch["$ref"], root, "/")
    if not isinstance(branch, dict):
        return False
    consts = {k: p["const"] for k, p in branch.get("properties", {}).items()
              if isinstance(p, dict) and "const" in p}
    return bool(consts) and isinstance(value, dict) and all(
        k in value and _json_eq(value[k], c) for k, c in consts.items())


def _branch_names(branches: list[dict]) -> str:
    return " | ".join(json.dumps(b, sort_keys=True) for b in branches)


def load_schema(path: Path = SCHEMA_PATH) -> dict:
    schema = json.loads(path.read_text("utf-8"))
    check_schema(schema, schema)  # every node in an applied form, used by a file or not
    return schema


def check_spec(spec: object, family: str, schema: dict | None = None) -> list[str]:
    schema = schema or load_schema()
    return validate(spec, schema["$defs"][family], schema)


def tracked_files() -> list[tuple[Path, str]]:
    return [(p, fam) for d, fam in FAMILIES.items() for p in sorted((REPO / "scenarios" / d).glob("*.json"))]


# ── the fixtures ─────────────────────────────────────────────────────────────────────────────
ARENA = {
    "desc": "a minimal mission arena",
    "ops": [
        {"op": "clear", "from": [-2, 100, -2], "to": [2, 104, 2]},
        {"op": "fill", "from": [-2, 100, -2], "to": [2, 100, 2], "block": "minecraft:stone"},
        {"op": "give", "item": "minecraft:diamond_pickaxe"},
        {"op": "player", "pos": [0, 101, 0]},
    ],
    "mission": {"name": "goto", "params": {"x": 1, "y": 101, "z": 1}},
    "expect": {"events": ["GOTO_ARRIVED"], "timeout": 30},
}
CHECK = {"desc": "a check", "jeval": "World.getBlock(0, 100, 0).getId()", "expect": "minecraft:stone"}
BENCH = {"ops": [{"op": "clearinv"}], "start": [0, 101, 0], "legs": [{"name": "l", "to": [5, 101, 0]}]}
SET = {"snapshot": {"boxes": [{"from": [0, 0, 0], "to": [1, 1, 1]}], "dimension": "minecraft:overworld"}}


def with_(base: dict, **changes: object) -> dict:
    out = copy.deepcopy(base)
    for k, v in changes.items():
        if v is DROP:
            out.pop(k, None)
        else:
            out[k] = v
    return out


DROP = object()


class TrackedFilesTests(unittest.TestCase):
    def test_every_tracked_scenario_matches_its_schema(self) -> None:
        files = tracked_files()
        self.assertGreaterEqual(len(files), 30, "the glob found too few files to mean anything")
        schema = load_schema()
        for path, family in files:
            with self.subTest(file=path.relative_to(REPO).as_posix()):
                self.assertEqual(check_spec(json.loads(path.read_text("utf-8")), family, schema), [])

    def test_every_tracked_arena_and_set_passes_the_loader(self) -> None:
        names = arena._all_names() + arena._all_set_names()
        self.assertTrue(any(n.startswith(arena.SET_PREFIX) for n in names))
        for name in names:
            with self.subTest(name=name):
                arena._load(name)  # validate_arena_spec / validate_set_spec, the cross-field rules


class KnownBadSpecTests(unittest.TestCase):
    """Each fixture breaks one rule; the assert names the message that rule must print."""

    CASES = [
        # (family, spec, a substring of the expected error)
        ("arena", with_(ARENA, expcet={"events": ["X"]}), "unknown key 'expcet'"),
        ("arena", with_(ARENA, name="mine-vein"), "unknown key 'name'"),
        ("arena", with_(ARENA, ops=DROP), "missing required key 'ops'"),
        ("arena", with_(ARENA, ops=[]), "fewer than 1 items"),
        ("arena", with_(ARENA, expect={"event": ["GOTO_ARRIVED"]}), "unknown key 'event'"),
        ("arena", with_(ARENA, expect={"timeout": 30}), "missing required key 'events'"),
        ("arena", with_(ARENA, expect={"events": ["GOTO_ARRIVED"], "timeout": "30"}), "expected number"),
        ("arena", with_(ARENA, mission=DROP), "matches none of"),  # expect with nothing to run
        ("arena", with_(ARENA, plan="sustain-cycle"), "must not match"),  # mission AND plan
        ("arena", with_(ARENA, mission=DROP, expect=DROP, marker={"ore": "iron", "x": 0, "z": 0}),
         "matches none of"),  # a marker nothing reads
        ("arena", with_(ARENA, mission={"params": {}}), "missing required key 'name'"),
        ("arena", with_(ARENA, ops=[{"op": "teleport", "pos": [0, 0, 0]}]), "must be"),
        ("arena", with_(ARENA, ops=[{"op": "fill", "from": [0, 0, 0], "to": [1, 1, 1]}]),
         "missing required key 'block'"),
        ("arena", with_(ARENA, ops=[{"op": "set", "pos": [0, 0], "block": "minecraft:stone"}]),
         "fewer than 3 items"),
        ("arena", with_(ARENA, ops=[{"op": "set", "pos": [0, 0.5, 0], "block": "minecraft:stone"}]),
         "expected integer"),
        ("arena", with_(ARENA, ops=[{"op": "select", "slot": 9}]), "above the maximum 8"),
        ("arena", with_(ARENA, ops=[{"op": "wait", "ticks": -1}]), "below the minimum 0"),
        ("arena", with_(ARENA, ops=[{"op": "player", "pos": [0, 1, 2, 3]}]), "more than 3 items"),
        ("arena", with_(ARENA, expect={"events": ["GOTO_ARRIVED"], "timeout": 0}), "greater than 0"),
        ("arena", with_(ARENA, mission=DROP, plan=""), "shorter than 1"),
        ("arena", with_(ARENA, ops=[{"op": "give", "item": "minecraft:stone", "count": True}]),
         "expected integer"),
        ("arena", with_(ARENA, checks=[with_(CHECK, expect=DROP)]), "missing required key 'expect'"),
        ("arena", with_(ARENA, checks=[with_(CHECK, jeval="  ")]), "does not match"),
        ("arena", with_(ARENA, checks=[with_(CHECK, wrong="yes")]), "must be true"),
        ("arena", with_(ARENA, checks=[with_(CHECK, expected=1)]), "unknown key 'expected'"),
        ("arena", with_(ARENA, snapshot=SET["snapshot"]), "unknown key 'snapshot'"),
        ("bench", with_(BENCH, start=DROP), "missing required key 'start'"),
        ("bench", with_(BENCH, legs=DROP), "matches none of"),
        ("bench", with_(BENCH, mission={"name": "mine"}), "must not match"),  # legs AND mission
        ("bench", with_(BENCH, impls=["baritone"]), "must be one of"),
        ("bench", with_(BENCH, ops=[{"op": "player", "pos": [0, 0, 0]}]), "must be"),
        ("bench", with_(BENCH, legs=[{"name": "l"}]), "missing required key 'to'"),
        # keys only the mission runner reads (navbench.py#race_mission), on a leg bench
        ("bench", with_(BENCH, marker={"ore": "iron", "x": 0, "z": 0}), "missing required key 'mission'"),
        ("bench", with_(BENCH, collect="minecraft:raw_iron"), "missing required key 'mission'"),
        ("bench", with_(BENCH, done_event="VEINS_DEPLETED"), "missing required key 'mission'"),
        ("set", with_(SET, mission={"name": "mine"}), "unknown key 'mission'"),
        ("set", with_(SET, snapshot=DROP), "missing required key 'snapshot'"),
        ("set", with_(SET, snapshot={"boxes": []}), "fewer than 1 items"),
        ("set", with_(SET, snapshot={"boxes": [{"from": [0, 0, 0]}]}), "missing required key 'to'"),
        ("set", with_(SET, snapshot={**SET["snapshot"], "dimension": "null"}), "does not match"),
        # ECMA `$` is the end of the input: Python's would accept the trailing newline
        ("set", with_(SET, snapshot={**SET["snapshot"], "dimension": "minecraft:overworld\n"}),
         "does not match"),
        ("set", with_(SET, snapshot={**SET["snapshot"], "dimension": "minecraft:over﻿world"}),
         "does not match"),
        ("set", with_(SET, ops_generated=[{"op": "give", "item": "minecraft:stone"}]), "must be"),
        ("set", with_(SET, marker={"ore": "iron", "x": 0, "z": 0}), "unknown key 'marker'"),
    ]

    def test_the_fixtures_are_valid_before_the_break(self) -> None:  # positive controls
        for family, spec in (("arena", ARENA), ("arena", with_(ARENA, checks=[CHECK])),
                             ("arena", with_(ARENA, mission=DROP, expect=DROP, checks=[CHECK])),
                             ("arena", with_(ARENA, mission=DROP, plan="sustain-cycle")),
                             ("bench", BENCH), ("bench", with_(BENCH, legs=DROP, mission={"name": "mine"})),
                             ("bench", with_(BENCH, legs=DROP, mission={"name": "drill"}, collect="x",
                                             done_event="E", marker={"ore": "iron", "x": 0, "z": 0})),
                             ("set", SET)):
            with self.subTest(family=family, spec=spec):
                self.assertEqual(check_spec(spec, family), [])

    def test_every_known_bad_is_refused_with_its_message(self) -> None:
        for family, spec, message in self.CASES:
            with self.subTest(family=family, message=message, spec=spec):
                errors = check_spec(spec, family)
                self.assertTrue(any(message in e for e in errors), f"no {message!r} in {errors}")


class ValidatorTests(unittest.TestCase):
    def test_an_unsupported_keyword_is_refused(self) -> None:
        with self.assertRaises(SchemaKeywordError):
            validate([1, 1], {"type": "array", "uniqueItems": True}, {})

    def test_a_keyword_beside_ref_is_refused(self) -> None:
        root = {"$defs": {"list": {"type": "array"}}}
        with self.assertRaises(SchemaKeywordError):
            validate([], {"$ref": "#/$defs/list", "minItems": 1}, root)
        # neg-control: an annotation beside $ref is no keyword, and the target still applies
        self.assertEqual(validate([], {"$ref": "#/$defs/list", "description": "d"}, root), [])
        self.assertTrue(validate({}, {"$ref": "#/$defs/list", "description": "d"}, root))

    def test_a_non_local_ref_is_refused(self) -> None:
        with self.assertRaises(SchemaKeywordError):
            validate([], {"$ref": "other.json#/$defs/list"}, {"$defs": {"list": {}}})

    def test_one_of_refuses_a_value_two_branches_accept(self) -> None:
        errors = validate(1, {"oneOf": [{"type": "integer"}, {"type": "number"}]}, {})
        self.assertIn("matches 2 branches", errors[0])

    def test_bool_is_neither_integer_nor_number(self) -> None:
        self.assertTrue(validate(True, {"type": "integer"}, {}))
        self.assertTrue(validate(False, {"type": "number"}, {}))
        self.assertEqual(validate(3, {"type": ["number", "null"]}, {}), [])


# "a/b" and "a~1b" are definition NAMES, so a naive lookup would resolve the two pointer rows of
# REFUSED (`#/$defs/a/b` and `#/$defs/a~1b`, which RFC 6901 reads as a path and as "a/b").
ROOT = {"$schema": DIALECT, "$id": "x", "type": "string",
        "$defs": {"s": {"type": "string"}, "t": True, "a/b": {}, "a~1b": {}}}
# keyword → (form, schema, a value it accepts, a value it refuses); each row is the positive
# control of one IMPLEMENTED form: the keyword in that form is applied, both ways. NOTHING = no
# value of that verdict exists for the form. Validated against ROOT (for $ref and the root-only
# annotations).
NOTHING = object()
APPLIED = [
    ("type", "string", {"type": "string"}, "a", 1),
    ("type", "array of names", {"type": ["string", "null"]}, None, 1),
    ("const", "scalar, 1 == 1.0, true is no number", {"const": 1}, 1.0, True),
    ("const", "object/array, key order free", {"const": {"a": [1], "b": 0}}, {"b": 0, "a": [1.0]},
     {"a": [True], "b": 0}),
    ("enum", "array", {"enum": [1, "x"]}, "x", True),
    ("enum", "empty array", {"enum": []}, NOTHING, "x"),
    ("required", "array of names", {"required": ["a"]}, {"a": 1}, {}),
    ("properties", "object of object schemas", {"properties": {"a": {"type": "integer"}}}, {"a": 1},
     {"a": "x"}),
    ("properties", "object of boolean schemas", {"properties": {"a": False}}, {}, {"a": 1}),
    ("additionalProperties", "false", {"additionalProperties": False}, {}, {"x": 1}),
    ("additionalProperties", "true", {"additionalProperties": True}, {"x": 1}, NOTHING),
    ("additionalProperties", "schema", {"properties": {"a": {}}, "additionalProperties": {"type": "integer"}},
     {"a": "s", "x": 1}, {"a": "s", "x": "s"}),
    ("items", "schema", {"items": {"type": "integer"}}, [1], ["x"]),
    ("items", "boolean", {"items": False}, [], [1]),
    ("minItems", "count", {"minItems": 1}, [1], []),
    ("maxItems", "count", {"maxItems": 0}, [], [1]),
    ("minLength", "count, in code points", {"minLength": 2}, "éé", "é"),
    ("pattern", "regex", {"pattern": "^a"}, "ab", "ba"),
    # ECMA-262 (u flag) semantics, each where Python `re` alone differs
    ("pattern", "`$` = the end of the input, not before a final \\n", {"pattern": "^a$"}, "a", "a\n"),
    ("pattern", "`$` inside an alternative", {"pattern": "(?:a$|b)"}, "xa", "a\n"),
    ("pattern", "`\\d` ASCII only", {"pattern": "^\\d$"}, "7", "٣"),
    ("pattern", "`\\w` ASCII only", {"pattern": "^\\w+$"}, "a_1", "é"),
    ("pattern", "`\\b` ASCII only", {"pattern": "a\\b"}, "aé", "ab"),
    ("pattern", "`\\s` = the ECMA set (has U+FEFF)", {"pattern": "^\\s$"}, "﻿", "\x1c"),
    ("pattern", "`\\S` = its complement", {"pattern": "\\S"}, "\x85", " "),
    ("pattern", "`\\s` inside a class", {"pattern": "^[^:\\s]+$"}, "a\x1f", "a﻿"),
    ("pattern", "`.` = any code point but a line terminator", {"pattern": "^.$"}, "\U0001F600", " "),
    ("pattern", "a class keeps `[&~|` literal", {"pattern": "^[&~|]$"}, "~", "a"),
    ("pattern", "quantifiers, lazy, groups, lookahead", {"pattern": "^(?:ab){1,2}?c*(?=d)(?!e)"},
     "abd", "abe"),
    ("minimum", "number", {"minimum": 0.5}, 0.5, 0),
    ("maximum", "number", {"maximum": 1}, 1, 1.5),
    ("exclusiveMinimum", "number", {"exclusiveMinimum": 0.5}, 1, 0.5),
    ("allOf", "array of schemas", {"allOf": [True, {"type": "string"}]}, "a", 1),
    ("anyOf", "array of schemas", {"anyOf": [False, {"type": "string"}]}, "a", 1),
    ("oneOf", "array of schemas", {"oneOf": [True, {"type": "string"}]}, 1, "a"),
    ("not", "schema", {"not": {"type": "string"}}, 1, "a"),
    ("not", "boolean", {"not": True}, NOTHING, 1),
    ("if", "schema, with then", {"if": {"type": "string"}, "then": {"minLength": 2}}, "ab", "a"),
    ("then", "boolean, with if", {"if": True, "then": False}, NOTHING, 1),
    ("$ref", "#/$defs/<name>", {"$ref": "#/$defs/s"}, "a", 1),
    ("$ref", "to a boolean definition", {"$ref": "#/$defs/t"}, 1, NOTHING),
    ("$schema/$id/$defs", "at the root (the 2020-12 dialect)", ROOT, "a", 1),
    ("(schema)", "boolean false", False, NOTHING, 1),
    ("(schema)", "boolean true", True, 1, NOTHING),
]
# keyword → (form, schema) of every form refused: legal-in-2020-12 forms the validator does not
# apply, and illegal forms it would otherwise misread. Each row is a known-bad.
REFUSED = [
    ("type", "empty array", {"type": []}),
    ("type", "array with a non-name", {"type": ["string", 1]}),
    ("type", "non-string", {"type": 5}),
    ("type", "unknown name", {"type": "date"}),
    ("type", "unknown name in an array", {"type": ["string", "date"]}),
    ("enum", "non-array", {"enum": "a"}),
    ("required", "non-array (a string would iterate as chars)", {"required": "ab"}),
    ("required", "array with a non-name", {"required": [1]}),
    ("properties", "non-object", {"properties": []}),
    ("properties", "member not a schema", {"properties": {"a": 1}}),
    ("additionalProperties", "neither boolean nor schema", {"additionalProperties": 1}),
    ("additionalProperties", "null", {"additionalProperties": None}),
    ("items", "array (2019-09 tuple form)", {"items": [{"type": "string"}]}),
    ("items", "neither boolean nor schema", {"items": 1}),
    ("prefixItems", "any (keyword unsupported)", {"prefixItems": [{"type": "string"}]}),
    ("minItems", "negative", {"minItems": -1}),
    ("minItems", "float", {"minItems": 1.0}),
    ("maxItems", "boolean", {"maxItems": True}),
    ("minLength", "string", {"minLength": "1"}),
    ("pattern", "non-string", {"pattern": 1}),
    ("pattern", "uncompilable", {"pattern": "("}),
    # syntax Python `re` reads but ECMA-262 (u flag) refuses or reads otherwise
    ("pattern", "Python-only escape `\\Z`", {"pattern": "a\\Z"}),
    ("pattern", "Python-only escape `\\A`", {"pattern": "\\Aa"}),
    ("pattern", "identity escape outside the syntax characters", {"pattern": "a\\:b"}),
    ("pattern", "`\\-` outside a class", {"pattern": "a\\-b"}),
    ("pattern", "backreference", {"pattern": "(a)\\1"}),
    ("pattern", "unicode escape (not translated)", {"pattern": "\\u0041"}),
    ("pattern", "`\\b` inside a class (backspace)", {"pattern": "[\\b]"}),
    ("pattern", "`\\S` inside a class", {"pattern": "[\\S]"}),
    ("pattern", "named group", {"pattern": "(?<n>a)"}),
    ("pattern", "lookbehind", {"pattern": "(?<=a)b"}),
    ("pattern", "inline flag", {"pattern": "(?i)a"}),
    ("pattern", "atomic group", {"pattern": "(?>a)"}),
    ("pattern", "empty class `[]`", {"pattern": "[]a]"}),
    ("pattern", "empty class `[]` Python reads as `]`", {"pattern": "[][a]"}),
    ("pattern", "any-char class `[^]`", {"pattern": "[^]a]"}),
    ("pattern", "lone `{`", {"pattern": "a{"}),
    ("pattern", "`{,n}`", {"pattern": "a{,2}"}),
    ("pattern", "lone `}`", {"pattern": "a}"}),
    ("pattern", "lone `]`", {"pattern": "a]"}),
    ("pattern", "possessive quantifier", {"pattern": "a*+"}),
    ("pattern", "quantified anchor", {"pattern": "^*a"}),
    ("pattern", "quantified `\\b`", {"pattern": "a\\b+"}),
    ("pattern", "trailing backslash", {"pattern": "a\\"}),
    ("pattern", "unclosed class", {"pattern": "[a"}),
    ("minimum", "string", {"minimum": "1"}),
    ("maximum", "null", {"maximum": None}),
    ("exclusiveMinimum", "boolean (draft-4 form)", {"exclusiveMinimum": True}),
    ("allOf", "empty array", {"allOf": []}),
    ("anyOf", "object", {"anyOf": {"a": {}}}),
    ("oneOf", "member not a schema", {"oneOf": [1]}),
    ("not", "neither boolean nor schema", {"not": 1}),
    ("if", "without then (a no-op)", {"if": {"type": "string"}}),
    ("then", "without if (a no-op)", {"then": {"type": "string"}}),
    ("if", "neither boolean nor schema", {"if": 1, "then": {}}),
    ("else", "any (keyword unsupported)", {"if": True, "then": True, "else": False}),
    ("$ref", "non-local", {"$ref": "other.json#/$defs/s"}),
    ("$ref", "nested pointer", {"$ref": "#/$defs/a/b"}),
    ("$ref", "escaped pointer", {"$ref": "#/$defs/a~1b"}),
    ("$ref", "missing definition", {"$ref": "#/$defs/nope"}),
    ("$ref", "non-string", {"$ref": 5}),
    ("$schema", "another dialect at the root", "draft-07"),
    ("$schema", "below the root", {"$schema": DIALECT}),
    ("$id", "below the root", {"$id": "y"}),
    ("$defs", "below the root", {"$defs": {}}),
    ("title", "non-string", {"title": 1}),
    ("description", "non-string", {"description": []}),
    ("(schema)", "neither object nor boolean", 5),
]


class ValidatorFormTests(unittest.TestCase):
    """The keyword → value-form table: every form is APPLIED (both verdicts shown) or REFUSED."""

    def test_every_applied_form_is_applied_both_ways(self) -> None:  # positive controls
        for kw, form, schema, good, bad in APPLIED:
            with self.subTest(keyword=kw, form=form):
                if good is not NOTHING:
                    self.assertEqual(validate(good, schema, ROOT), [])
                if bad is not NOTHING:
                    self.assertTrue(validate(bad, schema, ROOT))

    def test_every_refused_form_raises(self) -> None:  # known-bads
        for kw, form, schema in REFUSED:
            with self.subTest(keyword=kw, form=form):
                if schema == "draft-07":
                    root = {**ROOT, "$schema": "http://json-schema.org/draft-07/schema#"}
                    with self.assertRaises(SchemaKeywordError):
                        validate("a", root, root)
                    continue
                with self.assertRaises(SchemaKeywordError):  # null: no keyword applies to it,
                    validate(None, schema, ROOT)  # so only the form check can refuse
                with self.assertRaises(SchemaKeywordError):  # unreached by any value, still refused
                    check_schema({"properties": {"p": schema}}, ROOT)
        # neg-control: the same wrapper around an applied form passes the whole-schema check
        check_schema({"properties": {"p": {"additionalProperties": {"type": "integer"}}}}, ROOT)

    def test_a_class_never_reaches_python_set_syntax(self) -> None:
        # `[&&]` `[~~]` `[||]` `[[` are literal in ECMA; Python warns it may read them as set
        # operations, so they are escaped — a warning here is that drift arriving
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            self.assertEqual(validate("&", {"pattern": "^[&&~~||[]$"}, ROOT), [])
            self.assertTrue(validate("a", {"pattern": "^[&&~~||[]$"}, ROOT))

    def test_the_table_covers_every_keyword(self) -> None:
        named = {k for row in APPLIED + REFUSED for k in row[0].split("/")}
        self.assertLessEqual(KEYWORDS | ANNOTATIONS, named | {"(schema)"})
        self.assertEqual(set(FORMS), KEYWORDS | ANNOTATIONS)

    def test_the_real_schema_is_checked_whole(self) -> None:
        # known-bad: a refused form in a definition no file uses is still caught at load
        schema = json.loads(SCHEMA_PATH.read_text("utf-8"))
        schema["$defs"]["zz_unused"] = {"type": "object", "additionalProperties": 1}
        bad = Path(tempfile.mkdtemp(prefix="schema-")) / "s.json"
        self.addCleanup(shutil.rmtree, bad.parent, True)
        bad.write_text(json.dumps(schema), "utf-8")
        with self.assertRaises(SchemaKeywordError):
            load_schema(bad)
        real = load_schema()  # the real one passes
        self.assertIn("arena", real["$defs"])

    def test_check_schema_reaches_every_subschema_position(self) -> None:
        bad = {"minItems": -1}
        positions = {
            "properties": {"properties": {"p": bad}}, "additionalProperties": {"additionalProperties": bad},
            "items": {"items": bad}, "not": {"not": bad}, "if": {"if": bad, "then": True},
            "then": {"if": True, "then": bad}, "allOf": {"allOf": [True, bad]},
            "anyOf": {"anyOf": [True, bad]}, "oneOf": {"oneOf": [True, bad]},
        }
        for key, schema in positions.items():
            with self.subTest(position=key):
                with self.assertRaises(SchemaKeywordError):
                    check_schema(schema, ROOT)
                good = json.loads(json.dumps(schema).replace('{"minItems": -1}', '{"minItems": 1}'))
                check_schema(good, ROOT)  # neg-control: the same position, an applied form
        root = {**ROOT, "$defs": {"d": bad}}  # $defs: from the root
        with self.assertRaises(SchemaKeywordError):
            check_schema(root, root)
        root = {**ROOT, "$defs": {"d": {"minItems": 1}}}
        check_schema(root, root)

    def test_a_boolean_property_beside_a_const_key_does_not_break_the_error_pick(self) -> None:
        branches = {"oneOf": [{"properties": {"op": {"const": "a"}, "x": False}, "required": ["op"]},
                              {"properties": {"op": {"const": "b"}, "n": {"type": "integer"}}}]}
        errors = validate({"op": "b", "n": "s"}, branches, ROOT)
        self.assertEqual(errors, ["/n: expected integer, got \"s\""])


# ── the parsers ↔ the schema ──────────────────────────────────────────────────────────────────
PARSERS = {
    "scripts/dev/arena.py": "arena",
    "scripts/dev/navbench.py": "bench",
    "scripts/dev/gate_live.py": "gate",
}
OP_DEFS = ("op_clear", "op_fill", "op_set", "op_clearinv", "op_give", "op_select", "op_player",
           "op_marker", "op_wait")
# The scenario families each parser loads itself: a row of RECEIVERS[parser] may name only defs
# reachable from these (`own_defs`), so a key one parser reads for its family never counts as read
# for another family (gate_live.py loads the leg benches; arenas and sets it hands to arena.py).
PARSER_FAMILIES = {"arena": ("arena", "set"), "bench": ("bench",), "gate": ("bench",)}
# Receiver expression (as `_path` spells it) → the $defs entries whose properties it reads, per
# parser. A receiver missing from this table is not a spec value (a bridge reply, a log entry) —
# unless its root (`spec` of `spec.mission`) is a row: such a chained read must be a row itself.
RECEIVERS = {
    "arena": {
        "spec": ("arena", "set"), "spec.snapshot": ("snapshot",), "snap": ("snapshot",),
        "spec.expect": ("expect",), "expect": ("expect",), "mission": ("mission",),
        "marker": ("marker",), "op": OP_DEFS, "box": ("box",), "ch": ("check",),
        "check": ("check",), "twin": ("check",), "checks[]": ("check",),
    },
    "bench": {
        "spec": ("bench",), "m": ("mission",), "marker": ("marker",), "leg": ("leg",),
    },
    "gate": {"spec": ("bench",), "leg": ("leg",)},
}
INJECTED = {("arena", "spec", "name"), ("gate", "spec", "name")}  # set by the loader, never in a file


def _path(node: ast.AST) -> str | None:
    """`spec` · `spec.snapshot` (for spec["snapshot"] or spec.get("snapshot")) · `checks[]`."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Subscript):
        base = _path(node.value)
        if base is None:
            return None
        if isinstance(node.slice, ast.Constant) and isinstance(node.slice.value, str):
            return f"{base}.{node.slice.value}"
        return f"{base}[]"
    if (isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "get"
            and node.args and isinstance(node.args[0], ast.Constant)):
        base = _path(node.func.value)
        return None if base is None else f"{base}.{node.args[0].value}"
    if isinstance(node, ast.BoolOp) and isinstance(node.op, ast.Or):
        return _path(node.values[0])  # `(spec.get("expect") or {})`
    return None


def reads(source: str) -> set[tuple[str, str]]:
    """Every (receiver, key) a source reads: x["k"], x.get("k", …) and "k" in x / not in x."""
    out: set[tuple[str, str]] = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Subscript) and isinstance(node.slice, ast.Constant) \
                and isinstance(node.slice.value, str):
            recv = _path(node.value)
            if recv:
                out.add((recv, node.slice.value))
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) \
                and node.func.attr == "get" and node.args and isinstance(node.args[0], ast.Constant) \
                and isinstance(node.args[0].value, str):
            recv = _path(node.func.value)
            if recv:
                out.add((recv, node.args[0].value))
        elif isinstance(node, ast.Compare) and isinstance(node.left, ast.Constant) \
                and isinstance(node.left.value, str) and len(node.ops) == 1 \
                and isinstance(node.ops[0], (ast.In, ast.NotIn)):
            recv = _path(node.comparators[0])
            if recv:
                out.add((recv, node.left.value))
    return out


def props(schema: dict, defs: tuple[str, ...]) -> set[str]:
    return {k for d in defs for k in schema["$defs"][d].get("properties", {})}


def _refs(node: object) -> set[str]:
    """The $defs names a schema node points at, at any depth."""
    if isinstance(node, dict):
        out = {node["$ref"][len("#/$defs/"):]} if isinstance(node.get("$ref"), str) else set()
        return out.union(*(_refs(v) for v in node.values()))
    if isinstance(node, list):
        return set().union(*(_refs(v) for v in node))
    return set()


def own_defs(schema: dict, families: tuple[str, ...]) -> set[str]:
    """The families' $defs entries and every entry they reach through $ref."""
    out, todo = set(), list(families)
    while todo:
        d = todo.pop()
        if d not in out:
            out.add(d)
            todo += sorted(_refs(schema["$defs"][d]) - out)
    return out


def _root(recv: str) -> str:
    return re.split(r"[.\[]", recv, maxsplit=1)[0]


def unread_or_undeclared(sources: dict[str, str], schema: dict) -> tuple[list[str], list[str], list[str]]:
    """(keys a parser reads that the schema lacks, or reads below a tabled receiver through an
    untabled chain; schema properties no parser reads; RECEIVERS rows no parser uses any more,
    or that name a def outside the parser's own families)."""
    undeclared: list[str] = []
    seen_recv: set[tuple[str, str]] = set()
    read_by_def: dict[str, set[str]] = {}
    for rel, parser in PARSERS.items():
        table = RECEIVERS[parser]
        for recv, key in sorted(reads(sources[rel])):
            if recv not in table:
                if _root(recv) in table:
                    undeclared.append(f"{rel}: {recv}[{key!r}] is a chained read below the "
                                      f"receiver {_root(recv)!r} with no RECEIVERS row")
                continue
            seen_recv.add((parser, recv))
            if (parser, recv, key) in INJECTED:
                continue
            defs = table[recv]
            if key not in props(schema, defs):
                undeclared.append(f"{rel}: {recv}[{key!r}] is read but no schema entry {defs} declares it")
            for d in defs:
                read_by_def.setdefault(d, set()).add(key)
    unread = [
        f"$defs/{d}/properties/{k} is read by no parser"
        for d in sorted(schema["$defs"])
        for k in sorted(schema["$defs"][d].get("properties", {}))
        if k not in read_by_def.get(d, set())
    ]
    stale = [f"RECEIVERS[{p!r}][{r!r}] matches nothing in {rel}"
             for rel, p in PARSERS.items() for r in RECEIVERS[p] if (p, r) not in seen_recv]
    for p, rows in RECEIVERS.items():
        own = own_defs(schema, PARSER_FAMILIES[p])
        stale += [f"RECEIVERS[{p!r}][{r!r}] names {sorted(set(defs) - own)}, outside the "
                  f"families {PARSER_FAMILIES[p]} that parser loads"
                  for r, defs in rows.items() if set(defs) - own]
    return undeclared, unread, stale


def parser_sources() -> dict[str, str]:
    return {rel: (REPO / rel).read_text("utf-8") for rel in PARSERS}


class ParserKeysTests(unittest.TestCase):
    def test_parsers_and_schema_agree_both_ways(self) -> None:
        undeclared, unread, stale = unread_or_undeclared(parser_sources(), load_schema())
        self.assertEqual(undeclared, [], "a parser reads a key the schema does not declare")
        self.assertEqual(unread, [], "the schema declares a key no parser reads")
        self.assertEqual(stale, [], "a RECEIVERS row no longer matches the parser")

    def test_a_new_key_read_by_a_parser_is_reported(self) -> None:  # known-bad: narrowing schema
        for form in ('spec.get("brand_new")', 'spec["brand_new"]', '"brand_new" in spec',
                     '(spec.get("expect") or {}).get("brand_new")'):
            with self.subTest(form=form):
                sources = parser_sources()
                sources["scripts/dev/arena.py"] += f"\n\ndef _x(spec):\n    return {form}\n"
                undeclared, _, _ = unread_or_undeclared(sources, load_schema())
                self.assertTrue(any("'brand_new'" in u for u in undeclared), undeclared)

    def test_a_key_nobody_reads_is_reported(self) -> None:  # known-bad: widening schema
        schema = load_schema()
        schema["$defs"]["expect"]["properties"]["retries"] = {"type": "integer"}
        _, unread, _ = unread_or_undeclared(parser_sources(), schema)
        self.assertIn("$defs/expect/properties/retries is read by no parser", unread)

    def test_a_chained_read_below_a_receiver_is_reported(self) -> None:  # known-bad: dropped read
        for form in ('spec["mission"]["brand_new"]', 'spec.get("mission", {}).get("brand_new")',
                     '"brand_new" in spec["mission"]', 'spec["ops"][0]["brand_new"]',
                     'spec["snapshot"]["boxes"][0]["brand_new"]'):
            with self.subTest(form=form):
                sources = parser_sources()
                sources["scripts/dev/arena.py"] += f"\n\ndef _x(spec):\n    return {form}\n"
                undeclared, _, _ = unread_or_undeclared(sources, load_schema())
                self.assertTrue(any("'brand_new'" in u and "chained read" in u for u in undeclared),
                                undeclared)
        # neg-control: a chain from a root that is no receiver (a bridge reply) is no spec read
        sources = parser_sources()
        sources["scripts/dev/arena.py"] += '\n\ndef _x(reply):\n    return reply["mission"]["brand_new"]\n'
        self.assertEqual(unread_or_undeclared(sources, load_schema())[0], [])

    def test_a_row_outside_the_parsers_families_is_reported(self) -> None:  # known-bad: shared row
        with mock.patch.dict(RECEIVERS["gate"], {"spec": ("arena", "bench")}):
            _, _, stale = unread_or_undeclared(parser_sources(), load_schema())
        self.assertTrue(any("RECEIVERS['gate']['spec'] names ['arena']" in s for s in stale), stale)

    def test_a_key_only_another_familys_parser_reads_stays_unread(self) -> None:
        # `arrival` is read by navbench.py and gate_live.py, both for benches: declared on the
        # arena, no parser reads it for an arena
        schema = load_schema()
        schema["$defs"]["arena"]["properties"]["arrival"] = {"type": "number"}
        _, unread, _ = unread_or_undeclared(parser_sources(), schema)
        self.assertIn("$defs/arena/properties/arrival is read by no parser", unread)

    def test_a_renamed_receiver_is_reported(self) -> None:  # known-bad: a vacuous table row
        sources = parser_sources()
        sources["scripts/dev/navbench.py"] = sources["scripts/dev/navbench.py"].replace("leg[", "lg[")
        _, _, stale = unread_or_undeclared(sources, load_schema())
        self.assertTrue(any("'leg'" in s and "navbench" in s for s in stale), stale)


# ── the doc ↔ the schema ──────────────────────────────────────────────────────────────────────
EXAMPLE_RE = re.compile(r"<!-- scenario-example: (\w+) -->\s*```json\n(.*?)```", re.S)


def doc_gaps(doc: str, schema: dict) -> list[str]:
    """Schema properties and op kinds the doc never names in backticks."""
    names = {k for d in schema["$defs"].values() for k in d.get("properties", {})}
    names |= {d["properties"]["op"]["const"] for n, d in schema["$defs"].items() if n.startswith("op_")}
    return sorted(n for n in names if f"`{n}`" not in doc)


class DocTests(unittest.TestCase):
    def test_the_doc_names_every_key_and_op(self) -> None:
        self.assertEqual(doc_gaps(DOC_PATH.read_text("utf-8"), load_schema()), [])

    def test_a_key_missing_from_the_doc_is_reported(self) -> None:  # known-bad
        doc = DOC_PATH.read_text("utf-8").replace("`done_event`", "done_event")
        self.assertEqual(doc_gaps(doc, load_schema()), ["done_event"])

    def test_the_doc_examples_validate(self) -> None:
        examples = EXAMPLE_RE.findall(DOC_PATH.read_text("utf-8"))
        self.assertEqual(sorted(f for f, _ in examples), ["arena", "bench", "checks", "set"])
        for family, body in examples:
            with self.subTest(example=family):
                spec = json.loads(body)
                self.assertEqual(check_spec(spec, "arena" if family == "checks" else family), [])


# ── names the files use ↔ the source and docs/MISSIONS.md ────────────────────────────────────
def src_literals() -> str:
    return "\n".join(p.read_text("utf-8") for p in sorted((REPO / "src").rglob("*.ts")))


def missing_names(specs: list[tuple[str, dict]], src: str, missions_doc: str) -> list[str]:
    """Events, missions and plans the files name that the code or docs/MISSIONS.md lacks."""
    plans = set(re.findall(r'^\s*name: "([\w-]+)"', "\n".join(
        p.read_text("utf-8") for p in sorted((REPO / "src" / "bot" / "plans").glob("*.ts"))), re.M))
    headings = set(re.findall(r"^### ([\w-]+)\s*$", missions_doc, re.M))
    out: list[str] = []
    for where, spec in specs:
        events = list((spec.get("expect") or {}).get("events", []))
        events += [spec["done_event"]] if "done_event" in spec else []
        for ev in events:
            if not re.search(rf"[\"'`]{re.escape(ev)}[\"'`]", src):
                out.append(f"{where}: event {ev} is emitted nowhere in src/")
        if "mission" in spec and spec["mission"]["name"] not in headings:
            out.append(f"{where}: mission {spec['mission']['name']} has no heading in docs/MISSIONS.md")
        if "plan" in spec and spec["plan"] not in plans:
            out.append(f"{where}: plan {spec['plan']} is not a plan in src/bot/plans/")
    return out


class NamesTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.src = src_literals()
        cls.missions = (REPO / "docs" / "MISSIONS.md").read_text("utf-8")

    def test_every_event_mission_and_plan_exists(self) -> None:
        specs = [(p.relative_to(REPO).as_posix(), json.loads(p.read_text("utf-8")))
                 for p, fam in tracked_files() if fam != "set"]
        self.assertEqual(missing_names(specs, self.src, self.missions), [])

    def test_a_misspelled_name_is_reported(self) -> None:  # known-bads, one per name kind
        cases = [
            (with_(ARENA, expect={"events": ["GOTO_ARRIVD"]}), "event GOTO_ARRIVD"),
            (with_(BENCH, legs=DROP, mission={"name": "mine"}, done_event="SCAN_EXHAUSTD"),
             "event SCAN_EXHAUSTD"),
            (with_(ARENA, mission={"name": "mien"}), "mission mien"),
            (with_(ARENA, mission=DROP, plan="sustain-cylce"), "plan sustain-cylce"),
        ]
        for spec, message in cases:
            with self.subTest(message=message):
                got = missing_names([("x", spec)], self.src, self.missions)
                self.assertTrue(any(message in g for g in got), got)
        self.assertEqual(missing_names([("x", ARENA)], self.src, self.missions), [])  # control


if __name__ == "__main__":
    unittest.main()
