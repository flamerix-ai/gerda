"""The showcase pair — scenarios/shots/showcase.json (shoot) + showcase_cut.json (edit) — and its
console cards (scenarios/shots/cards/*.json), held to the tools that consume them.

Each lane runs the TRACKED file through the consumer's own validator (assemble.build with the
takes probed by a mock, console_card.validate/check_cut, shoot.load) and pairs it with a mutation
of that same file that must fail, so a lane cannot pass by validating nothing.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -t scripts/tests -v
"""
from __future__ import annotations

import contextlib
import copy
import io
import json
import re
import shlex
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "rig"))
sys.path.insert(0, str(REPO / "scripts" / "demo"))
sys.path.insert(0, str(REPO / "scripts" / "dev"))
import assemble  # noqa: E402
import console_card  # noqa: E402
import gate_live  # noqa: E402
import shoot  # noqa: E402

SHOTS_PATH = REPO / "scenarios" / "shots" / "showcase.json"
CUT_PATH = REPO / "scenarios" / "shots" / "showcase_cut.json"
CARD_PATHS = sorted((REPO / "scenarios" / "shots" / "cards").glob("*.json"))
GATE_CARD = REPO / "scenarios" / "shots" / "cards" / "5b_gate.json"
PROSPECT_CARD = REPO / "scenarios" / "shots" / "cards" / "1b_prospect.json"
MISSIONS_DOC = REPO / "docs" / "MISSIONS.md"
TRIGGER = "scripts/demo/trigger_bot.sh"
PASS = " · PASS"
# Bridge commands that ARE the filmed action: from a shot's `bot` key they fire before the
# recorder starts (shoot.py stage()), so they belong in `during` + trigger_bot.sh.
ACTIONS = {"prospect", "mission_start", "greedy_drive", "plan_start", "chat", "goto"}


def load(path: Path) -> dict:
    return json.loads(path.read_text("utf-8"))


def dies_with(test: unittest.TestCase, needle: str, fn, *args) -> None:
    err = io.StringIO()
    with contextlib.redirect_stderr(err), test.assertRaises(SystemExit):
        fn(*args)
    test.assertIn(needle, err.getvalue())


def unmapped_srcs(cut: dict, shots: dict, cards: list[dict]) -> set[str]:
    """Segment srcs that are neither a shot's take (<id>.mp4) nor a card's rendered out."""
    known = {f"{s['id']}.mp4" for s in shots["shots"]} | {Path(c["out"]).name for c in cards}
    return {s["src"] for s in cut["segments"]} - known


def orphan_shots(cut: dict, shots: dict) -> set[str]:
    """Shots no segment cuts from — a take shot for nothing."""
    used = {s["src"] for s in cut["segments"]}
    return {s["id"] for s in shots["shots"]} - {Path(u).stem for u in used}


def gated_arenas() -> list[str]:
    return gate_live._asserting_names()


def false_pass_labels(cut: dict, shots: dict) -> list[str]:
    """`<arena> · PASS` labels that the shot under them cannot back: the arena is not one the gate
    runs, or the take's driver is not the gate run of THAT arena (whose log carries the verdict)."""
    shot_by_take = {f"{s['id']}.mp4": s for s in shots["shots"]}
    src_by_seg = {s["id"]: s["src"] for s in cut["segments"]}
    bad = []
    for c in cut["captions"]["cues"]:
        if c["layer"] != "label" or not c["text"].endswith(PASS):
            continue
        arena = c["text"][: -len(PASS)]
        shot = shot_by_take.get(src_by_seg.get(c["seg"], ""), {})
        if arena not in gated_arenas() or shot.get("during") != [
                f"./gerda gate {arena} --port 55545"]:
            bad.append(c["text"])
    return bad


def trigger_args(shots: dict) -> list[tuple[str, list[str]]]:
    """(shot id, the positional args after trigger_bot.sh) of every such call in `during`."""
    calls = []
    for s in shots["shots"]:
        for cmd in s.get("during", []):
            argv = shlex.split(cmd)
            if TRIGGER in argv:
                calls.append((s["id"], argv[argv.index(TRIGGER) + 1:]))
    return calls


def trigger_calls(shots: dict) -> list[tuple[str, str, str]]:
    """(shot id, bridge command type, raw JSON payload) of every trigger_bot.sh call in `during`."""
    return [(sid, args[1], args[2]) for sid, args in trigger_args(shots)]


def bridge_call(port: str, timeout: str | None, typ: str, payload: str) -> dict:
    return {"port": port, "timeout": timeout, "type": typ, "payload": json.loads(payload)}


def trigger_bridge_call(shots: dict, sid: str) -> dict:
    """The bridge call shot `sid`'s one trigger_bot.sh sends, with the script's defaults applied
    (port 55545; timeout absent = bridge_ctl's own default)."""
    (args,) = [a for s, a in trigger_args(shots) if s == sid]
    return bridge_call(args[3] if len(args) > 3 else "55545", args[4] if len(args) > 4 else None,
                       args[1], args[2])


def card_bridge_call(card: dict) -> dict:
    """The bridge call a card's `./gerda ctl [--port P] [--timeout T] send <type> <json>` shows."""
    argv = shlex.split(card["command"])
    assert argv[:2] == ["./gerda", "ctl"], card["command"]
    opts, i = {"--port": "55545", "--timeout": None}, 2
    while argv[i] in opts:
        opts[argv[i]], i = argv[i + 1], i + 2
    assert argv[i] == "send" and len(argv) == i + 3, card["command"]
    return bridge_call(opts["--port"], opts["--timeout"], argv[i + 1], argv[i + 2])


def bad_trigger_payloads(shots: dict) -> list[str]:
    """trigger_bot.sh calls whose JSON payload would not parse as an object on the bridge."""
    bad = []
    for sid, _type, payload in trigger_calls(shots):
        try:
            ok = isinstance(json.loads(payload), dict)
        except json.JSONDecodeError:
            ok = False
        if not ok:
            bad.append(f"{sid}: {payload[:40]}")
    return bad


def mission_params(doc: str) -> dict[str, set[str]]:
    """Each `### <mission>` of docs/MISSIONS.md -> the names in its `| name | type | ...` table."""
    out: dict[str, set[str]] = {}
    cur, in_table = None, False
    for ln in doc.splitlines():
        m = re.fullmatch(r"### (\S+)", ln)
        if m:
            cur, in_table = m.group(1), False
            out[cur] = set()
        elif ln.startswith("## "):
            cur = None
        elif cur is not None and ln.startswith("| name | type |"):
            in_table = True
        elif cur is not None and in_table:
            m = re.match(r"\| `([^`]+)` \|", ln)
            if m:
                out[cur].add(m.group(1))
            elif not ln.startswith("|"):
                in_table = False
    return out


def bad_mission_starts(shots: dict, params: dict[str, set[str]]) -> list[str]:
    """mission_start payloads the worker would misread: a key besides name/params (an `args` is
    silently dropped), a mission docs/MISSIONS.md does not list, or a param outside its table."""
    bad = []
    for sid, typ, payload in trigger_calls(shots):
        if typ != "mission_start":
            continue
        body = json.loads(payload)
        stray = set(body) - {"name", "params"}
        if stray:
            bad.append(f"{sid}: keys {sorted(stray)}")
        name = body.get("name")
        if name not in params:
            bad.append(f"{sid}: mission {name!r}")
            continue
        unknown = set(body.get("params", {})) - params[name]
        if unknown:
            bad.append(f"{sid}: {name} params {sorted(unknown)}")
    return bad


class CutBuildTests(unittest.TestCase):
    """The tracked cut list through assemble.build itself — schema, readability, placement."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.doc = load(CUT_PATH)
        patcher = mock.patch.object(assemble, "probe_duration", return_value=1000.0)
        patcher.start()
        self.addCleanup(patcher.stop)

    def build(self, doc: dict) -> tuple[list[list], list]:
        for s in doc["segments"]:
            (self.dir / s["src"]).write_bytes(b"")
        _, rows, cues = assemble.build(doc, doc["segments"], self.dir, self.dir / "s.en.ass")
        return rows, cues

    def test_the_tracked_cut_builds_with_every_cue_placed(self) -> None:
        rows, cues = self.build(self.doc)
        self.assertEqual(len(cues), len(self.doc["captions"]["cues"]), "no cue may be dropped")
        total = float(rows[-1][-1].removesuffix("s"))
        self.assertTrue(60 <= total <= 150, f"a {total} s cut is no longer a short showcase")

    def test_a_hand_typed_rate_fails_the_same_build(self) -> None:
        doc = copy.deepcopy(self.doc)
        cue = next(c for c in doc["captions"]["cues"] if "{speed}" in c["text"])
        cue["text"] = cue["text"].replace("{speed}", "3×")
        dies_with(self, "types a rate by hand", self.build, doc)

    def test_a_cue_spilling_past_a_shortened_segment_fails(self) -> None:
        doc = copy.deepcopy(self.doc)
        next(s for s in doc["segments"] if s["id"] == "home")["out"] = 2.0
        dies_with(self, "spills past its segment", self.build, doc)

    def test_an_overlong_line_fails(self) -> None:
        doc = copy.deepcopy(self.doc)
        next(c for c in doc["captions"]["cues"] if c["layer"] == "line")["text"] = "x" * 43
        dies_with(self, "chars as rendered", self.build, doc)

    def test_the_finale_credit_is_the_teasers_verbatim(self) -> None:
        teaser = load(REPO / "scenarios" / "shots" / "teaser_cut.json")
        credit = next(c["text"] for c in teaser["captions"]["cues"] if c["seg"] == "finale"
                      and c["layer"] == "line")
        mine = [c["text"] for c in self.doc["captions"]["cues"] if c["seg"] == "finale"]
        self.assertEqual(mine, [credit])


@unittest.skipUnless(shutil.which("fc-list") and shutil.which("fc-match"), "needs fontconfig")
class GlyphTests(unittest.TestCase):
    """assemble.py checks the caption FAMILY is installed, not that it has every glyph — the
    non-ASCII marks the captions use (· ✓ —) are checked here against the same fonts."""

    def setUp(self) -> None:
        self.doc = load(CUT_PATH)
        self.fonts = assemble.caption_fonts(self.doc)
        for family in set(self.fonts.values()):
            r = subprocess.run(["fc-match", "-f", "%{family}", family],
                               capture_output=True, text=True, check=False)
            if family.casefold() not in {f.strip().casefold() for f in r.stdout.split(",")}:
                self.skipTest(f"caption font {family!r} is not installed here")

    def missing(self, layer: str, text: str) -> list[str]:
        return console_card.missing_glyphs(self.fonts[layer], assemble.displayed(layer, text))

    def test_every_caption_glyph_is_in_its_font(self) -> None:
        for c in self.doc["captions"]["cues"]:
            self.assertEqual(self.missing(c["layer"], c["text"]), [], c["text"])

    def test_a_glyph_the_font_lacks_is_reported(self) -> None:
        # U+E000 is Private Use: no text face carries it.
        self.assertEqual(self.missing("label", "6/6 · Craft ✓ "), [""])


class MappingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.cut, self.shots = load(CUT_PATH), load(SHOTS_PATH)
        self.cards = [load(p) for p in CARD_PATHS]

    def test_every_segment_src_is_a_shot_or_a_card(self) -> None:
        self.assertEqual(unmapped_srcs(self.cut, self.shots, self.cards), set())

    def test_an_unknown_src_is_caught(self) -> None:
        cut = copy.deepcopy(self.cut)
        cut["segments"][0]["src"] = "99_nope.mp4"
        self.assertEqual(unmapped_srcs(cut, self.shots, self.cards), {"99_nope.mp4"})

    def test_every_shot_is_cut_from(self) -> None:
        self.assertEqual(orphan_shots(self.cut, self.shots), set())
        shots = copy.deepcopy(self.shots)
        shots["shots"].append({"id": "99_spare", "seconds": 5})
        self.assertEqual(orphan_shots(self.cut, shots), {"99_spare"})

    def test_shoot_py_loads_the_shot_list(self) -> None:
        self.assertEqual(len(shoot.load(SHOTS_PATH)["shots"]), len(self.shots["shots"]))


class CardTests(unittest.TestCase):
    def test_every_card_is_valid_and_cut_ready(self) -> None:
        self.assertTrue(CARD_PATHS)
        cut = load(CUT_PATH)
        for p in CARD_PATHS:
            console_card.check_cut(console_card.load(p), cut, p.name)

    def test_a_card_at_another_fps_is_not_cut_ready(self) -> None:
        card = load(CARD_PATHS[0])
        card["fps"] = 30
        dies_with(self, "fps=30 but the cut list's is 60", console_card.check_cut, card,
                  load(CUT_PATH), CARD_PATHS[0].name)

    def test_the_tracked_cards_carry_no_guessed_value(self) -> None:
        # A run's numbers are tokens the run fills, never a value in the tracked spec. The gate
        # card has none: its every line is the fixed all-PASS summary (held below).
        tokened = []
        for p in CARD_PATHS:
            spec = console_card.load(p)
            self.assertFalse(spec.get("values"), f"{p.name}: values belong to a filled render")
            if any("<FILL:" in ln for ln in console_card.card_lines(spec)):
                tokened.append(p.name)
                dies_with(self, "unfilled token(s)", console_card.fill, spec, {}, False)
        self.assertEqual(tokened, ["1b_prospect.json"])

    @staticmethod
    def gate_rows(card: dict) -> list[str]:
        return [ln for ln in card["response"] if ln.startswith("  PASS  ")]

    @staticmethod
    def expected_gate_rows() -> list[str]:
        names = gated_arenas() + [f"bench:{b}" for b in gate_live._bench_names()]
        return [f"  PASS  {n}" for n in names]

    def gate_card_problems(self, card: dict) -> list[str]:
        """What keeps `card` from being the summary of a full all-PASS default-set gate run."""
        expected = self.expected_gate_rows()
        k = len(expected)
        probs = []
        if card["response"][0] != "=== gate summary ===":
            probs.append("first line")
        if self.gate_rows(card) != expected:
            probs.append("rows")
        if card["response"][-1] != f"[gate] {k}/{k} passed":
            probs.append("count")
        if len(card["response"]) != k + 2:
            probs.append("extra lines")
        return probs

    def test_the_gate_card_is_the_full_all_pass_summary_in_order(self) -> None:
        self.assertEqual(self.gate_card_problems(load(GATE_CARD)), [])

    def test_the_gate_card_renders_only_against_a_run_log(self) -> None:
        # its text is what a full pass prints, not a measurement: from_log makes the render
        # check it against the log of a real run (console_card FromLogTests hold the refusal)
        self.assertIs(load(GATE_CARD).get("from_log"), True)

    def test_a_partial_count_on_the_gate_card_is_caught(self) -> None:
        card = load(GATE_CARD)
        k = len(self.expected_gate_rows())
        card["response"][-1] = f"[gate] {k - 1}/{k} passed"
        self.assertEqual(self.gate_card_problems(card), ["count"])

    def test_a_dropped_or_failed_row_on_the_gate_card_is_caught(self) -> None:
        card = load(GATE_CARD)
        del card["response"][1]
        self.assertIn("rows", self.gate_card_problems(card))
        card = load(GATE_CARD)
        card["response"][1] = card["response"][1].replace("PASS", "FAIL")
        self.assertIn("rows", self.gate_card_problems(card))

    def test_a_build_only_arena_on_the_gate_card_is_caught(self) -> None:
        card = load(GATE_CARD)
        card["response"].insert(1, "  PASS  water-dive")
        self.assertIn("rows", self.gate_card_problems(card))

    def test_another_first_line_on_the_gate_card_is_caught(self) -> None:
        card = load(GATE_CARD)
        card["response"][0] = "=== gate run ==="
        self.assertEqual(self.gate_card_problems(card), ["first line"])

    def test_an_extra_non_pass_line_on_the_gate_card_is_caught(self) -> None:
        card = load(GATE_CARD)
        card["response"].insert(2, "  ----  x (not run)")
        self.assertEqual(self.gate_card_problems(card), ["extra lines"])

    def test_the_prospect_card_shows_the_call_its_shot_sends(self) -> None:
        shots = load(SHOTS_PATH)
        card = load(PROSPECT_CARD)
        sent = trigger_bridge_call(shots, "01a_prospect_gui")
        self.assertEqual(card_bridge_call(card), sent)
        self.assertEqual((sent["port"], sent["timeout"]), ("55545", "30"), "trigger parse")
        card["command"] = card["command"].replace("--timeout 30", "--timeout 60")
        self.assertNotEqual(card_bridge_call(card), sent)


class ShotTests(unittest.TestCase):
    def setUp(self) -> None:
        self.cut, self.shots = load(CUT_PATH), load(SHOTS_PATH)

    def test_every_pass_label_is_backed_by_that_arenas_gate_run(self) -> None:
        labels = [c for c in self.cut["captions"]["cues"] if c["text"].endswith(PASS)]
        self.assertTrue(labels)
        self.assertEqual(false_pass_labels(self.cut, self.shots), [])

    def test_a_pass_label_on_a_build_only_arena_is_caught(self) -> None:
        cut = copy.deepcopy(self.cut)
        cue = next(c for c in cut["captions"]["cues"] if c["text"].endswith(PASS))
        cue["text"] = "water-dive" + PASS
        self.assertEqual(false_pass_labels(cut, self.shots), ["water-dive" + PASS])

    def test_a_gated_arenas_label_on_another_gated_arenas_take_is_caught(self) -> None:
        cut = copy.deepcopy(self.cut)
        cue = next(c for c in cut["captions"]["cues"] if c["seg"] == "arena_mine_vein"
                   and c["layer"] == "label")
        cue["text"] = "goto-travel" + PASS
        self.assertIn("goto-travel", gated_arenas())
        self.assertEqual(false_pass_labels(cut, self.shots), ["goto-travel" + PASS])

    def test_trigger_payloads_parse(self) -> None:
        self.assertEqual(bad_trigger_payloads(self.shots), [])
        shots = copy.deepcopy(self.shots)
        shots["shots"][0]["during"] = ["bash scripts/demo/trigger_bot.sh 2 prospect '{\"want\":}'"]
        self.assertEqual(len(bad_trigger_payloads(shots)), 1)

    def test_mission_start_payloads_match_the_mission_docs(self) -> None:
        params = mission_params(MISSIONS_DOC.read_text("utf-8"))
        self.assertTrue({"chain", "want", "min", "table"} <= params["craft"], "doc parse")
        self.assertTrue(any(t == "mission_start" for _, t, _ in trigger_calls(self.shots)))
        self.assertEqual(bad_mission_starts(self.shots, params), [])

    def test_an_args_key_or_an_unknown_param_is_caught(self) -> None:
        params = mission_params(MISSIONS_DOC.read_text("utf-8"))
        shots = {"shots": [{"id": "x", "during": [
            f"bash {TRIGGER} 2 mission_start '{{\"name\":\"drill\",\"args\":{{\"ore\":\"iron\"}}}}'",
            f"bash {TRIGGER} 2 mission_start '{{\"name\":\"drill\",\"params\":{{\"target\":1}}}}'",
            f"bash {TRIGGER} 2 mission_start '{{\"name\":\"dril\"}}'",
        ]}]}
        self.assertEqual(bad_mission_starts(shots, params),
                         ["x: keys ['args']", "x: drill params ['target']", "x: mission 'dril'"])

    def test_no_filmed_action_rides_the_pre_record_bot_key(self) -> None:
        early = [s["id"] for s in self.shots["shots"] if s.get("bot", {}).get("cmd") in ACTIONS]
        self.assertEqual(early, [])
        shots = copy.deepcopy(self.shots)
        shots["shots"][0]["bot"] = {"cmd": "prospect", "params": {"keep_open": True}}
        self.assertEqual([s["id"] for s in shots["shots"]
                          if s.get("bot", {}).get("cmd") in ACTIONS], [shots["shots"][0]["id"]])


if __name__ == "__main__":
    unittest.main()
