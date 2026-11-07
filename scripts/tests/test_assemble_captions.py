"""Unit tests for the caption layer of `scripts/rig/assemble.py` (burned-in EN teaser captions).

Cues are anchored to SEGMENTS (absolute time = segment output start + `at`), so the lanes pin
the placement arithmetic THROUGH build() (the code that owns the timeline), every schema rule and
readability limit (each positive lane paired with the known-bad that must die, and each refusal
checked for ITS message so a different validator cannot pass for it), the ASS rendering, the
real-run / dry-run file effects, the font precheck, and that the TRACKED teaser cut list passes
its own limits when built.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -t scripts/tests -v
"""
from __future__ import annotations

import contextlib
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "rig"))
import assemble  # noqa: E402

TEASER = REPO / "scenarios" / "shots" / "teaser_cut.json"
# Captured before any test patches it: MainTests mocks check_fonts, one lane needs the real one.
REAL_CHECK_FONTS = assemble.check_fonts


def doc_with(cues: list[dict]) -> dict:
    return {
        "segments": [{"id": "a", "src": "a.mp4", "in": 0, "out": 4},
                     {"id": "b", "src": "b.mp4", "in": 0, "out": 9, "speed": 3.0}],
        "captions": {"cues": cues},
    }


# a: 0–4 s, b: 4–7 s (9 s of source at 3x) — the output timeline the cues ride.
TIMELINE = {"a": (0.0, 4.0), "b": (4.0, 3.0)}


def cue(seg: str = "b", at: float = 0.5, dur: float = 2.0, layer: str = "line",
        text: str = "Mines the vein") -> dict:
    return {"seg": seg, "at": at, "dur": dur, "layer": layer, "text": text}


def dies_with(test: unittest.TestCase, needle: str, fn, *args) -> None:
    """`fn(*args)` must die (SystemExit) AND say `needle` — the refusal is the named one."""
    err = io.StringIO()
    with contextlib.redirect_stderr(err), test.assertRaises(SystemExit):
        fn(*args)
    test.assertIn(needle, err.getvalue())


class PlacementTests(unittest.TestCase):
    def test_cue_lands_at_its_segments_output_start_plus_at(self) -> None:
        got = assemble.caption_cues(doc_with([cue()]), TIMELINE)
        self.assertEqual(got, [(4.5, 6.5, "line", "Mines the vein")])

    def test_cues_of_segments_left_out_by_only_are_dropped_not_misplaced(self) -> None:
        # --only b → b starts at 0; the cue on `a` has nowhere to sit.
        got = assemble.caption_cues(doc_with([cue("a", 0.2), cue("b", 0.5)]), {"b": (0.0, 3.0)})
        self.assertEqual(got, [(0.5, 2.5, "line", "Mines the vein")])

    def test_no_captions_key_means_no_cues(self) -> None:
        d = doc_with([])
        del d["captions"]
        self.assertEqual(assemble.caption_cues(d, TIMELINE), [])

    def test_different_layers_may_overlap(self) -> None:
        # Neg-control for the overlap refusal below: a label and a line together is the design.
        got = assemble.caption_cues(
            doc_with([cue(layer="label", text="Mine"), cue(layer="line")]), TIMELINE)
        self.assertEqual(len(got), 2)

    def test_speed_token_is_filled_from_the_segment(self) -> None:
        d = doc_with([cue("a", 0.2, 2.0, "label", "Walk · {speed}"),
                      cue("b", 0.2, 2.0, "label", "Mine · {speed} speed")])
        d["segments"].append({"id": "c", "src": "c.mp4", "in": 0, "out": 6, "speed": 1.5})
        d["captions"]["cues"].append(cue("c", 0.2, 2.0, "label", "Loop · {speed}"))
        got = assemble.caption_cues(d, {**TIMELINE, "c": (7.0, 4.0)})
        self.assertEqual([c[3] for c in got],
                         ["Walk · 1×", "Mine · 3× speed", "Loop · 1.5×"])


class RefusalTests(unittest.TestCase):
    """Every limit dies loudly — a cut list that silently drops a caption ships a wrong film."""

    def dies(self, needle: str, c: dict, timeline: dict | None = None) -> None:
        dies_with(self, needle, assemble.caption_cues, doc_with([c]), timeline or TIMELINE)

    def passes(self, c: dict, timeline: dict | None = None) -> None:
        self.assertEqual(len(assemble.caption_cues(doc_with([c]), timeline or TIMELINE)), 1)

    def test_unknown_segment_id(self) -> None:
        self.dies("no segment 'nope'", cue(seg="nope"))

    def test_unknown_layer(self) -> None:
        self.dies("layer='hud'", cue(layer="hud"))

    def test_negative_at(self) -> None:
        self.dies("is negative", cue(at=-0.1))
        self.passes(cue(at=0.0))

    def test_spill_past_the_segment_end(self) -> None:
        self.dies("spills past", cue(at=1.5, dur=1.6))   # b is 3.0 s of output; 3.1 spills
        self.passes(cue(at=1.4, dur=1.6))                # 3.0 fits

    def test_hold_under_the_minimum_dies_and_exactly_the_minimum_passes(self) -> None:
        self.dies("minimum hold", cue(dur=assemble.MIN_HOLD_S - 0.1))
        self.passes(cue(at=0.0, dur=assemble.MIN_HOLD_S, text="Mine"))

    def test_line_over_max_chars(self) -> None:
        # Same hold, same slot — only the length differs, so the line limit is what decides.
        self.dies("chars as rendered", cue(at=0.0, dur=2.9, text="x" * (assemble.MAX_LINE + 1)))
        self.passes(cue(at=0.0, dur=2.9, text="x" * assemble.MAX_LINE))

    def test_max_line_is_measured_on_the_upper_cased_label(self) -> None:
        # 'ß'.upper() == 'SS': MAX_LINE chars as typed, 2×MAX_LINE as burned in on a label. A
        # 10 s segment and a long hold keep the reading-speed limit out of it.
        wide = {"b": (4.0, 10.0)}
        text = "ß" * assemble.MAX_LINE
        self.dies("chars as rendered", cue(at=0.0, dur=9.0, layer="label", text=text), wide)
        self.passes(cue(at=0.0, dur=9.0, layer="line", text=text), wide)

    def test_reading_speed_over_max_cps(self) -> None:
        # 2 lines × 30 chars over 2.0 s = 30 cps > 20; the same text over 2.9 s = 20.7 still dies,
        # and 3.0 s (20.0 cps) is exactly at the limit and passes.
        text = "a" * 30 + "\n" + "b" * 30
        self.dies("chars/s", cue(at=0.0, dur=2.0, text=text))
        self.dies("chars/s", cue(at=0.0, dur=2.9, text=text))
        self.passes(cue(at=0.0, dur=3.0, text=text))

    def test_ass_control_characters(self) -> None:
        for bad in ("{\\b1}bold", "back\\slash", "brace}", "{spead}"):
            self.dies("ASS control", cue(text=bad))

    def test_blank_or_whitespace_text(self) -> None:
        for bad in ("", "   ", "\t", "\n", "a\n \nb", "a\n"):
            self.dies("blank", cue(text=bad))
        self.passes(cue(text="a\nb"))

    def test_text_must_be_a_string_without_carriage_returns(self) -> None:
        for bad in (5, None, ["Mine"]):
            self.dies("is not a string", cue(text=bad))
        self.dies("carriage return", cue(text="Mines\r\nthe vein"))

    def test_at_and_dur_must_be_finite_numbers(self) -> None:
        for key in ("at", "dur"):
            for bad in (float("nan"), float("inf"), float("-inf")):
                self.dies("is not finite", {**cue(), key: bad})
            for bad in ("1.0", True, None):
                self.dies("is not a number", {**cue(), key: bad})
        self.passes({**cue(), "at": 1, "dur": 2})       # ints are numbers

    def test_a_hand_typed_rate_is_refused_whether_or_not_it_agrees(self) -> None:
        # b runs at 3x: "3×" agrees, "2×" disagrees — both are the speed typed twice.
        for bad in ("Mine · 3× speed", "Mine · 2× speed", "Loop · 1.5x", "Base · 20 × lapse",
                    "Mine · ×2 speed", "Mine · x3", "Loop · X 1.5", "Mine · 3X speed",
                    "Mines a 3 × 3 tunnel"):
            self.dies("types a rate by hand", cue(layer="label", text=bad))
        self.passes(cue(layer="label", text="Mine · {speed} speed"))
        # Known-good: a sign whose far side touches a word character (3xl, Box2, the unspaced
        # sizes 3×3 / 3x3 / 16×16 / 1920x1080) is no rate.
        for fine in ("Box2 stays", "3xl crate", "Max 2 bots", "Mines a 3×3 tunnel",
                     "16×16 textures", "3x3 hammer", "1920x1080 capture"):
            self.passes(cue(text=fine))
        # Documented escape, pinned so a widened regex cannot silently change it.
        self.passes(cue(text="3×speed"))

    def test_same_layer_overlap(self) -> None:
        dies_with(self, "overlap on layer 'line'", assemble.caption_cues,
                  doc_with([cue(at=0.0, dur=1.6), cue(at=1.0, dur=1.6)]), TIMELINE)


class SchemaTests(unittest.TestCase):
    """The captions block and every cue are CLOSED — a misspelt key is an ignored setting."""

    def dies(self, needle: str, doc: dict) -> None:
        dies_with(self, needle, assemble.caption_cues, doc, TIMELINE)

    def test_unknown_cue_key(self) -> None:
        self.dies("unknown key(s) ['durr']", doc_with([{**cue(), "durr": 3.0}]))

    def test_every_cue_key_is_required(self) -> None:
        for key in assemble.CUE_KEYS:
            c = cue()
            del c[key]
            self.dies(f"missing key(s) ['{key}']", doc_with([c]))

    def test_a_cue_must_be_an_object(self) -> None:
        self.dies("must be an object", doc_with(["Mines the vein"]))

    def test_unknown_captions_key(self) -> None:
        d = doc_with([cue()])
        d["captions"]["fnt"] = "Inter"
        self.dies("unknown key(s) ['fnt']", d)
        d["captions"]["font"] = d["captions"].pop("fnt")     # the spelt-right key passes
        self.assertEqual(len(assemble.caption_cues(d, TIMELINE)), 1)

    def test_cues_must_be_a_non_empty_list(self) -> None:
        for bad in ({"cues": []}, {"cues": {}}, {"cues": cue()}, {}, {"font": "Inter"}):
            d = doc_with([])
            d["captions"] = bad
            self.dies("non-empty list", d)

    def test_captions_must_be_an_object(self) -> None:
        d = doc_with([])
        d["captions"] = [cue()]
        self.dies("captions must be an object", d)

    def test_font_names_must_fit_an_ass_style_line(self) -> None:
        for key in ("font", "label_font"):
            for bad in ("Inter,Bold", "", "  ", 5, "In\nter"):
                d = doc_with([cue()])
                d["captions"][key] = bad
                self.dies(f"captions.{key}=", d)


class RenderTests(unittest.TestCase):
    def test_ass_events_carry_times_styles_breaks_and_caps_labels(self) -> None:
        cues = [(4.5, 6.5, "line", "Standing still —\non purpose"), (0.25, 2.0, "label", "Goto")]
        ass = assemble.render_ass(cues, {"width": 1920, "height": 1080})
        self.assertIn("PlayResX: 1920", ass)
        self.assertIn("Dialogue: 0,0:00:04.50,0:00:06.50,line,,0,0,0,,{\\fad(150,150)}"
                      "Standing still —\\Non purpose", ass)
        self.assertIn(",label,,0,0,0,,{\\fad(150,150)}GOTO", ass)
        self.assertNotIn("\n\non purpose", ass)

    def test_styles_name_the_configured_fonts(self) -> None:
        doc = {"captions": {"font": "Noto Sans", "label_font": "Iosevka", "cues": []}}
        ass = assemble.render_ass([], doc)
        self.assertIn("Style: line,Noto Sans,", ass)
        self.assertIn("Style: label,Iosevka,", ass)

    def test_ass_time_rolls_over_minutes_and_hours(self) -> None:
        self.assertEqual(assemble.ass_time(61.234), "0:01:01.23")
        self.assertEqual(assemble.ass_time(3600.0), "1:00:00.00")


def three_segment_doc() -> dict:
    """Every axis the live cut list varies on: non-zero `in`, speed ≠ 1 (two different ones), an
    absent speed, a reused take, several segments, cues with `at` > 0 on each."""
    return {
        "segments": [
            {"id": "a", "src": "a.mp4", "in": 2.0, "out": 6.0, "speed": 2.0},   # 2.0 s out
            {"id": "b", "src": "b.mp4", "in": 1.0, "out": 10.0, "speed": 3.0},  # 3.0 s out
            {"id": "c", "src": "a.mp4", "in": 5.0, "out": 8.5},                 # 3.5 s out
        ],
        "captions": {"cues": [
            cue("a", 0.3, 1.6, "line", "Falls"),
            cue("b", 0.2, 2.5, "label", "Mine · {speed}"),
            cue("b", 0.5, 2.0, "line", "Mines the vein"),
            cue("c", 1.0, 2.5, "line", "Climbs out"),
        ]},
    }


class BuildTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        for name in ("a.mp4", "b.mp4"):
            (self.dir / name).write_bytes(b"")
        patcher = mock.patch.object(assemble, "probe_duration", return_value=100.0)
        patcher.start()
        self.addCleanup(patcher.stop)

    def build(self, doc: dict, segments: list[dict] | None = None,
              ass: Path | None = None) -> tuple[list[str], list[list], list]:
        return assemble.build(doc, doc["segments"] if segments is None else segments, self.dir,
                              ass if ass is not None else self.dir / "out.en.ass")

    def graph(self, doc: dict, ass: Path | None) -> str:
        args, _, _ = assemble.build(doc, doc["segments"], self.dir, ass)
        return args[args.index("-filter_complex") + 1]

    def assertCues(self, got: list, want: list) -> None:
        self.assertEqual([(round(s, 6), round(e, 6), la, t) for s, e, la, t in got], want)

    def test_build_places_cues_on_the_film_clock_across_speeds_and_offsets(self) -> None:
        # a = 0–2 (4 s at 2x), b = 2–5 (9 s at 3x), c = 5–8.5 (3.5 s at 1x).
        _, rows, cues = self.build(three_segment_doc())
        self.assertCues(cues, [(0.3, 1.9, "line", "Falls"),
                                (2.2, 4.7, "label", "Mine · 3×"),
                                (2.5, 4.5, "line", "Mines the vein"),
                                (6.0, 8.5, "line", "Climbs out")])
        self.assertEqual(rows[-1][-1], "8.50s")

    def test_build_with_only_re_anchors_kept_cues_and_drops_the_rest(self) -> None:
        # --only c,a → c = 0–3.5, a = 3.5–5.5; b's cues have nowhere to sit.
        doc = three_segment_doc()
        _, _, cues = self.build(doc, assemble.select(doc["segments"], "c,a"))
        self.assertCues(cues, [(1.0, 3.5, "line", "Climbs out"),
                                (3.8, 5.4, "line", "Falls")])

    def test_spill_is_measured_on_the_output_length_not_the_source(self) -> None:
        # b is 9 s of source at 3x = 3.0 s of output: 0.5 + 2.6 = 3.1 spills the OUTPUT, while
        # it would sit comfortably inside the 9 s of source a speed-blind length would measure.
        doc = three_segment_doc()
        doc["captions"]["cues"] = [cue("b", 0.5, 2.6, "line", "Mines the vein")]
        dies_with(self, "spills past", self.build, doc)
        doc["captions"]["cues"] = [cue("b", 0.5, 2.5, "line", "Mines the vein")]   # 3.0 fits
        self.assertCues(self.build(doc)[2], [(2.5, 5.0, "line", "Mines the vein")])

    def test_a_bad_speed_dies_naming_its_segment_even_when_left_out_by_only(self) -> None:
        # The rule is cue_number's: "3" and True are what float() would have waved through.
        for bad, needle in (("fast", "speed='fast' is not a number"),
                            ("3", "speed='3' is not a number"),
                            (True, "speed=True is not a number"),
                            (None, "speed=None is not a number"),
                            (0, "speed=0 must be positive"),
                            (-2, "speed=-2 must be positive"),
                            (float("nan"), "speed=nan is not finite"),
                            (float("inf"), "speed=inf is not finite"),
                            (float("-inf"), "speed=-inf is not finite")):
            for captioned in (True, False):
                with self.subTest(speed=bad, captioned=captioned):
                    doc = three_segment_doc()
                    if not captioned:
                        # Without captions nothing reads b's speed for {speed}: only the
                        # every-segment check in build() stands between it and a clean exit.
                        del doc["captions"]
                    doc["segments"][1]["speed"] = bad
                    # --only a,c leaves b out — it must still die, with b's name.
                    dies_with(self, f"segment 'b': {needle}", self.build, doc,
                              assemble.select(doc["segments"], "a,c"))
                    dies_with(self, f"segment 'b': {needle}", self.build, doc)

    def test_captions_burn_after_the_fades(self) -> None:
        d = doc_with([cue()])
        d["fade_in"] = 0.5
        g = self.graph(d, self.dir / "out.en.ass")
        self.assertTrue(g.endswith(f"fade=t=in:st=0:d=0.5,ass=filename={self.dir}/out.en.ass[v]"), g)

    def test_without_captions_the_graph_has_no_ass_pass(self) -> None:
        # Neg-control for the lane above: the ass= pass comes from the cues, not from the path.
        d = doc_with([])
        del d["captions"]
        g = self.graph(d, self.dir / "out.en.ass")
        self.assertNotIn("ass=", g)
        self.assertNotIn("ass=", self.graph(d, None))   # ... and needs no sidecar path at all

    def test_captions_without_a_sidecar_path_die(self) -> None:
        dies_with(self, "no ASS sidecar path", self.graph, doc_with([cue()]), None)

    def test_every_filtergraph_unsafe_character_in_the_sidecar_path_is_refused(self) -> None:
        self.assertTrue(assemble.FILTER_UNSAFE)
        for ch in sorted(assemble.FILTER_UNSAFE):
            with self.subTest(ch=ch):
                dies_with(self, "filtergraph metacharacters", self.graph, doc_with([cue()]),
                          self.dir / f"we{ch}ird.en.ass")
        self.assertIn("ass=", self.graph(doc_with([cue()]), self.dir / "weird.en.ass"))


def completed(rc: int) -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=[], returncode=rc, stdout="", stderr="")


class MainTests(unittest.TestCase):
    """main()'s file effects: what a real run, a failed run and a dry run leave on disk."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        (self.dir / "takes").mkdir()
        for name in ("a.mp4", "b.mp4"):
            (self.dir / "takes" / name).write_bytes(b"")
        self.cut = self.dir / "cut.json"
        self.cut.write_text(json.dumps(doc_with([cue()])), "utf-8")
        self.out = self.dir / "out" / "film.mp4"
        self.ass = self.dir / "out" / "film.en.ass"
        for target, kw in ((assemble, {"probe_duration": mock.Mock(return_value=100.0),
                                       "need": mock.Mock(side_effect=lambda t: t),
                                       "check_fonts": mock.Mock()}),):
            patcher = mock.patch.multiple(target, **kw)
            patcher.start()
            self.addCleanup(patcher.stop)

    def main(self, *extra: str, rc: int = 0) -> mock.Mock:
        argv = ["assemble.py", str(self.cut), "--takes-dir", str(self.dir / "takes"),
                "--out", str(self.out), *extra]
        run = mock.Mock(return_value=completed(rc))
        with mock.patch.object(sys, "argv", argv), \
                mock.patch.object(assemble.subprocess, "run", run), \
                contextlib.redirect_stdout(io.StringIO()) as self.stdout:
            self.assertEqual(assemble.main(), 0)
        return run

    def test_a_real_run_writes_the_sidecar_it_burns(self) -> None:
        # Neg-control for the two lanes below: the sidecar DOES appear when the cut succeeds.
        run = self.main()
        self.assertEqual(self.ass.read_text("utf-8"),
                         assemble.render_ass([(4.5, 6.5, "line", "Mines the vein")],
                                             doc_with([cue()])))
        self.assertIn(f"ass=filename={self.ass}", " ".join(run.call_args_list[0].args[0]))

    def test_dry_run_writes_nothing_and_says_the_sidecar_is_not_written(self) -> None:
        run = self.main("--dry-run")
        run.assert_not_called()
        self.assertFalse((self.dir / "out").exists())
        self.assertIn(f"({self.ass}) is NOT written", self.stdout.getvalue())

    def test_a_failed_ffmpeg_takes_the_sidecar_back(self) -> None:
        with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()) as err:
            self.main(rc=1)
        self.assertFalse(self.ass.exists())
        self.assertIn("caption sidecar", err.getvalue())

    def test_an_interrupted_ffmpeg_takes_the_sidecar_back(self) -> None:
        argv = ["assemble.py", str(self.cut), "--takes-dir", str(self.dir / "takes"),
                "--out", str(self.out)]
        with mock.patch.object(sys, "argv", argv), \
                mock.patch.object(assemble.subprocess, "run", side_effect=KeyboardInterrupt), \
                contextlib.redirect_stdout(io.StringIO()), self.assertRaises(KeyboardInterrupt):
            assemble.main()
        self.assertFalse(self.ass.exists())

    def test_main_checks_the_fonts_of_a_captioned_cut(self) -> None:
        self.main("--dry-run")
        assemble.check_fonts.assert_called_once()

    def test_a_captionless_cut_skips_the_font_check_and_leaves_any_sidecar_alone(self) -> None:
        # Neg-control for the two lanes above, with the REAL font check and no fc-match on PATH:
        # a cut without captions must not probe fonts (it would die on fc-match instead of on
        # ffmpeg) and a failed ffmpeg must not delete a sidecar this run never wrote.
        d = doc_with([])
        del d["captions"]
        self.cut.write_text(json.dumps(d), "utf-8")
        self.ass.parent.mkdir(parents=True)
        self.ass.write_text("an earlier run's sidecar", "utf-8")
        with mock.patch.object(assemble, "check_fonts", REAL_CHECK_FONTS), \
                mock.patch.object(assemble.shutil, "which", return_value=None), \
                self.assertRaises(SystemExit), \
                contextlib.redirect_stderr(io.StringIO()) as err:
            self.main(rc=1)
        self.assertIn("ffmpeg exited 1", err.getvalue())
        self.assertNotIn("fc-match", err.getvalue())
        self.assertNotIn("caption sidecar", err.getvalue())
        self.assertEqual(self.ass.read_text("utf-8"), "an earlier run's sidecar")


class FontCheckTests(unittest.TestCase):
    """libass burns whatever fontconfig hands back — a missing family must die, not fall back."""

    CUES = [(0.0, 2.0, "line", "x"), (0.0, 2.0, "label", "y")]

    def check(self, resolve: dict[str, str], cues: list | None = None,
              which: str | None = "/usr/bin/fc-match") -> mock.Mock:
        run = mock.Mock(side_effect=lambda cmd, **_: subprocess.CompletedProcess(
            cmd, 0, resolve[cmd[-1]], ""))
        with mock.patch.object(assemble.shutil, "which", return_value=which), \
                mock.patch.object(assemble.subprocess, "run", run):
            assemble.check_fonts(doc_with([]), self.CUES if cues is None else cues)
        return run

    def test_installed_fonts_pass(self) -> None:
        run = self.check({"Inter": "Inter", "JetBrains Mono": "JetBrains Mono,JetBrains Mono NL"})
        self.assertEqual(sorted(c.args[0][-1] for c in run.call_args_list),
                         ["Inter", "JetBrains Mono"])

    def test_a_font_resolving_to_a_fallback_dies(self) -> None:
        dies_with(self, "'JetBrains Mono' is not installed", self.check,
                  {"Inter": "Inter", "JetBrains Mono": "DejaVu Sans Mono"})

    def test_only_the_fonts_a_cue_uses_are_checked(self) -> None:
        # No label cue → the (missing) label font is irrelevant and is not probed.
        run = self.check({"Inter": "Inter"}, cues=[(0.0, 2.0, "line", "x")])
        self.assertEqual([c.args[0][-1] for c in run.call_args_list], ["Inter"])

    def test_no_fc_match_dies(self) -> None:
        dies_with(self, "fc-match not on PATH", self.check, {}, None, None)

    def test_a_failing_fc_match_dies(self) -> None:
        run = mock.Mock(side_effect=lambda cmd, **_: subprocess.CompletedProcess(
            cmd, 1, "", "Fontconfig error: cannot load default config"))
        with mock.patch.object(assemble.shutil, "which", return_value="/usr/bin/fc-match"), \
                mock.patch.object(assemble.subprocess, "run", run):
            dies_with(self, "fc-match failed on caption font 'Inter'", assemble.check_fonts,
                      doc_with([]), [(0.0, 2.0, "line", "x")])


class TrackedTeaserTests(unittest.TestCase):
    """The tracked cut list, placed by build() itself — no private copy of the timeline math."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.doc = json.loads(TEASER.read_text("utf-8"))
        for s in self.doc["segments"]:
            (self.dir / s["src"]).write_bytes(b"")
        patcher = mock.patch.object(assemble, "probe_duration", return_value=1000.0)
        patcher.start()
        self.addCleanup(patcher.stop)

    def build(self, only: str | None = None) -> tuple[list[list], list]:
        segs = assemble.select(self.doc["segments"], only)
        _, rows, cues = assemble.build(self.doc, segs, self.dir, self.dir / "t.en.ass")
        return rows, cues

    def test_the_tracked_teaser_builds_with_every_cue_placed(self) -> None:
        rows, cues = self.build()
        self.assertEqual(len(cues), len(self.doc["captions"]["cues"]), "no cue may be dropped")
        self.assertEqual(rows[-1][-1], "54.90s", "the accepted release cut is 54.900 s")

    def test_the_prospect_standstill_is_explained(self) -> None:
        _, cues = self.build("prospect")
        self.assertTrue(any("still" in text.lower() for _, _, layer, text in cues
                            if layer == "line"))

    def test_hook_clutch_label_never_shares_the_screen_with_its_line(self) -> None:
        # Design rule: the hook's label and line sharing the screen read over MAX_CPS.
        _, cues = self.build("hook_clutch")
        lines = [c for c in cues if c[2] == "line"]
        labels = [c for c in cues if c[2] == "label"]
        self.assertTrue(lines, "the hook keeps its narrative line")
        for lab in labels:
            for ln in lines:
                self.assertFalse(lab[0] < ln[1] and ln[0] < lab[1], (lab, ln))

    def test_the_vein_label_names_the_mine_mission_at_the_segments_speed(self) -> None:
        _, cues = self.build("vein")
        labels = [assemble.displayed(layer, text) for _, _, layer, text in cues
                  if layer == "label"]
        self.assertEqual(labels, ["MINE · 3× SPEED"])

    def test_branding_is_flamerix_ai_only(self) -> None:
        _, cues = self.build()
        texts = " ".join(text for *_, text in cues).replace("\n", " ")
        # The full end-card credit, not just its tail: the old "open-source bot by Flamerix AI"
        # also contains "by Flamerix AI" and must fail here.
        self.assertIn("open-source bot framework by Flamerix AI", texts)


if __name__ == "__main__":
    unittest.main()
