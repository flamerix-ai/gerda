"""Unit tests for `scripts/rig/console_card.py` (stylized console cards for a cut list).

Every refusal class of the card spec is a lane with its known-bad, and each known-bad is checked
for ITS message, so a different validator cannot pass for it; each limit is paired with the
nearest input that must still pass. Fonts are mocked except in the one real render, which skips
when ffmpeg or the font is not installed.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -t scripts/tests -v
"""
from __future__ import annotations

import contextlib
import copy
import io
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "rig"))
import console_card  # noqa: E402

BASE = {
    "out": "release/takes/t/card.mp4",
    "fps": 60, "width": 1920, "height": 1080, "duration": 3.0,
    "prompt": "$",
    "command": "./gerda ctl send prospect '{\"want\":\"iron\"}'",
    "response": ["  \"dist\": <FILL:dist>,", ""],
}


def spec(**over) -> dict:
    s = copy.deepcopy(BASE)
    for k, v in over.items():
        if v is DROP:
            s.pop(k, None)
        else:
            s[k] = v
    return s


DROP = object()


def dies_with(test: unittest.TestCase, needle: str, fn, *args, **kw) -> None:
    """`fn(...)` must die (SystemExit) AND say `needle` — the refusal is the named one."""
    err = io.StringIO()
    with contextlib.redirect_stderr(err), test.assertRaises(SystemExit):
        fn(*args, **kw)
    test.assertIn(needle, err.getvalue())


class SchemaTests(unittest.TestCase):
    def dies(self, needle: str, s: object) -> None:
        dies_with(self, needle, console_card.validate, s)

    def test_the_base_spec_passes(self) -> None:
        s = spec()
        self.assertIs(console_card.validate(s), s)

    def test_not_an_object(self) -> None:
        self.dies("must be a JSON object", ["out"])

    def test_missing_and_unknown_keys(self) -> None:
        self.dies("missing key(s) ['duration']", spec(duration=DROP))
        self.dies("unknown key(s) ['durr']", spec(durr=3))
        console_card.validate(spec(title="t", font="JetBrains Mono", font_size=30,
                                   values={"dist": 4}, _doc=["why"]))

    def test_out_must_be_a_relative_mp4_and_never_a_draft(self) -> None:
        self.dies("repo-relative .mp4", spec(out="/abs/card.mp4"))
        self.dies("repo-relative .mp4", spec(out="release/card.png"))
        self.dies("not a .draft.mp4", spec(out="release/card.draft.mp4"))

    def test_out_cannot_climb_out_of_the_repo(self) -> None:
        self.dies("climbs out with '..'", spec(out="../elsewhere/card.mp4"))
        self.dies("climbs out with '..'", spec(out="release/takes/../../../card.mp4"))
        console_card.validate(spec(out="release/takes/t/card..v2.mp4"))

    def test_the_prompt_cannot_hold_a_token(self) -> None:
        self.dies("the prompt is fixed text", spec(prompt="<FILL:host>$"))
        self.dies("the prompt is fixed text", spec(prompt="<FILL host>$"))

    def test_fps_and_size_are_positive_even_integers(self) -> None:
        self.dies("fps=0 is not a positive integer", spec(fps=0))
        self.dies("fps=True is not a positive integer", spec(fps=True))
        self.dies("fps=60.0 is not a positive integer", spec(fps=60.0))
        self.dies("width=1921 is odd", spec(width=1921))
        self.dies("height=-2 is not a positive integer", spec(height=-2))

    def test_duration_is_a_positive_finite_number(self) -> None:
        for bad in (0, -1, float("inf"), "3", True):
            self.dies("is not a positive finite number", spec(duration=bad))
        console_card.validate(spec(duration=1))

    def test_text_fields_are_single_line_strings(self) -> None:
        self.dies("command is blank", spec(command="  "))
        self.dies("prompt=5 is not a string", spec(prompt=5))
        self.dies("control character '\\n'", spec(command="a\nb"))
        self.dies("control character '\\t'", spec(response=["a\tb"]))

    def test_response_is_a_non_empty_list_of_strings(self) -> None:
        self.dies("non-empty list", spec(response=[]))
        self.dies("non-empty list", spec(response="one line"))
        self.dies("response[0]=3 is not a string", spec(response=[3]))

    def test_font_must_be_a_plain_family_name(self) -> None:
        self.dies("plain family name", spec(font="JetBrains Mono:style=Bold"))

    def test_doc_is_a_list_of_strings(self) -> None:
        self.dies("_doc must be a list of strings", spec(_doc="why"))


class TokenTests(unittest.TestCase):
    def test_malformed_tokens_die_instead_of_rendering_literally(self) -> None:
        for bad in ("<FILL:Dist>", "<FILL:>", "<FILL:a b>"):
            dies_with(self, "malformed token", console_card.validate, spec(response=[bad]))
        dies_with(self, "not a whole <FILL:name> token", console_card.validate,
                  spec(response=["<FILL dist>"]))

    def test_values_are_named_scalars_that_fill_a_token(self) -> None:
        dies_with(self, "is not a token name", console_card.validate, spec(values={"Dist": 4}))
        dies_with(self, "must be a string or a number", console_card.validate,
                  spec(values={"dist": True}))
        dies_with(self, "must be a string or a number", console_card.validate,
                  spec(values={"dist": [4]}))
        dies_with(self, "values ['dsit'] fill no token", console_card.validate,
                  spec(values={"dsit": 4}))

    def test_an_unfilled_token_refuses_the_render(self) -> None:
        dies_with(self, "unfilled token(s) ['dist']", console_card.fill, spec(), {}, False)

    def test_values_fill_and_set_wins_over_values(self) -> None:
        lines = console_card.fill(spec(values={"dist": 41}), {}, False)
        self.assertIn('  "dist": 41,', lines)
        lines = console_card.fill(spec(values={"dist": 41}), {"dist": "40"}, False)
        self.assertIn('  "dist": 40,', lines)

    def test_a_set_that_fills_nothing_dies(self) -> None:
        dies_with(self, "--set ['dsit'] fills no token", console_card.fill, spec(),
                  {"dsit": "4"}, False)

    def test_draft_shows_the_token_name_and_never_a_value(self) -> None:
        self.assertIn('  "dist": <dist>,', console_card.fill(spec(), {}, True))

    def test_parse_set(self) -> None:
        self.assertEqual(console_card.parse_set(["dist=41", "x=a=b"]), {"dist": "41", "x": "a=b"})
        dies_with(self, "must be name=value", console_card.parse_set, ["dist"])
        dies_with(self, "must be name=value", console_card.parse_set, ["Dist=4"])


class FitTests(unittest.TestCase):
    """Width: (2 x 5 % margin) + chars x ceil(0.6 em). 1920 px at 40 px → 1728 px / 24 px = 72."""

    def test_the_longest_line_that_fits_passes_and_one_more_char_dies(self) -> None:
        console_card.validate(spec(response=["x" * 72]))
        dies_with(self, "does not fit the 1728px text width", console_card.validate,
                  spec(response=["x" * 73]))

    def test_the_title_is_measured_against_the_full_frame_width(self) -> None:
        # Centred over the whole frame: 1920 px / 24 px = 80 chars, past the 72 of a body line.
        console_card.validate(spec(title="t" * 80))
        dies_with(self, "does not fit the 1920px frame width", console_card.validate,
                  spec(title="t" * 81))

    def test_too_many_rows_die(self) -> None:
        # 96 top + rows x 60 + 96 bottom <= 1080 → 14 rows: command + 12 lines + closing prompt.
        console_card.validate(spec(response=["x"] * 12))
        dies_with(self, "15 rows need 1092px", console_card.validate, spec(response=["x"] * 13))

    def test_a_filled_value_is_measured_too(self) -> None:
        s = spec(response=["x" * 60 + "<FILL:dist>"])
        console_card.fill(s, {"dist": "y" * 12}, False)
        dies_with(self, "does not fit", console_card.fill, s, {"dist": "y" * 13}, False)


class CutTests(unittest.TestCase):
    CUT = {"fps": 60, "width": 1920, "height": 1080, "takes_dir": "release/takes/t",
           "segments": [{"id": "c", "src": "card.mp4", "in": 0, "out": 3}]}

    def test_a_matching_card_passes(self) -> None:
        console_card.check_cut(spec(), self.CUT, "card.json")

    def test_fps_and_size_must_equal_the_cut(self) -> None:
        dies_with(self, "fps=30 but the cut list's is 60", console_card.check_cut, spec(fps=30),
                  self.CUT, "card.json")
        dies_with(self, "width=1280 but the cut list's is 1920", console_card.check_cut,
                  spec(width=1280), self.CUT, "card.json")
        dies_with(self, "height=720 but the cut list's is 1080", console_card.check_cut,
                  spec(height=720), self.CUT, "card.json")

    def test_out_must_be_a_src_of_the_cuts_takes_dir(self) -> None:
        dies_with(self, "is not in the cut's takes_dir", console_card.check_cut,
                  spec(out="release/takes/other/card.mp4"), self.CUT, "card.json")
        dies_with(self, "no segment of the cut list has src 'card2.mp4'", console_card.check_cut,
                  spec(out="release/takes/t/card2.mp4"), self.CUT, "card.json")


class FontTests(unittest.TestCase):
    def fc(self, match: str, charsets: dict[str, str] | None = None,
           which: dict[str, str | None] | None = None):
        def run(cmd, **_):
            if cmd[0].endswith("fc-match"):
                return subprocess.CompletedProcess(cmd, 0, match, "")
            return subprocess.CompletedProcess(cmd, 0, (charsets or {}).get(cmd[1], ""), "")
        paths = which if which is not None else {"fc-match": "/bin/fc-match", "fc-list": "/bin/fc-list"}
        return (mock.patch.object(console_card.shutil, "which", side_effect=paths.get),
                mock.patch.object(console_card.subprocess, "run", side_effect=run))

    def resolve(self, match: str, text: str = "ascii", **kw) -> str:
        a, b = self.fc(match, **kw)
        with a, b:
            return console_card.resolve_font("JetBrains Mono NL", text)

    def test_an_installed_monospaced_font_resolves_to_its_file(self) -> None:
        self.assertEqual(self.resolve("JetBrains Mono NL,JetBrains Mono NL Light|100|/f/JB.otf"),
                         "/f/JB.otf")

    def test_a_fallback_family_dies(self) -> None:
        dies_with(self, "is not installed", self.resolve, "DejaVu Sans Mono|100|/f/D.ttf")

    def test_a_proportional_font_dies(self) -> None:
        dies_with(self, "is not monospaced", self.resolve, "JetBrains Mono NL||/f/JB.otf")

    def test_a_missing_glyph_dies_and_a_covered_one_passes(self) -> None:
        ok = {"JetBrains Mono NL:charset=2014": "JetBrains Mono NL\n"}
        self.resolve("JetBrains Mono NL|100|/f/JB.otf", "a — b", charsets=ok)
        dies_with(self, "has no glyph for '✓'", self.resolve, "JetBrains Mono NL|100|/f/JB.otf",
                  "a ✓", charsets=ok)

    def test_no_fc_match_dies(self) -> None:
        dies_with(self, "fc-match not on PATH", self.resolve, "", which={})

    def test_no_fc_list_dies_once_a_non_ascii_glyph_needs_checking(self) -> None:
        which = {"fc-match": "/bin/fc-match"}
        self.assertEqual(self.resolve("JetBrains Mono NL|100|/f/JB.otf", "ascii", which=which),
                         "/f/JB.otf")
        dies_with(self, "fc-list not on PATH", self.resolve, "JetBrains Mono NL|100|/f/JB.otf",
                  "a — b", which=which)

    def test_a_filtergraph_unsafe_font_path_dies(self) -> None:
        dies_with(self, "filtergraph metacharacters", self.resolve,
                  "JetBrains Mono NL|100|/f/a:b.otf")


class GraphTests(unittest.TestCase):
    def test_text_goes_through_textfiles_verbatim_with_expansion_off(self) -> None:
        s = spec(title="t", values={"dist": "41%{n}"})
        lines = console_card.fill(s, {}, False)
        with tempfile.TemporaryDirectory() as td:
            g = console_card.filter_graph(s, lines, "/f/JB.otf", Path(td))
            texts = sorted(p.read_text("utf-8") for p in Path(td).glob("line*.txt"))
        self.assertIn('  "dist": 41%{n},', texts)
        self.assertIn("./gerda ctl send prospect '{\"want\":\"iron\"}'", texts)
        self.assertNotIn("41%{n}", g, "card text must never be inlined into the filtergraph")
        self.assertEqual(g.count("expansion=none"), g.count("drawtext="))
        self.assertIn("enable='lt(mod(t,1),0.5)'", g, "the cursor's commas must be quoted")


class RenderFailureTests(unittest.TestCase):
    def test_a_failed_ffmpeg_leaves_no_partial_out(self) -> None:
        s = spec(values={"dist": 41})
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "card.mp4"

            def ffmpeg(cmd, **_):
                out.write_bytes(b"half a file")   # what a crashed encode leaves behind
                return subprocess.CompletedProcess(cmd, 1)

            with mock.patch.object(console_card, "resolve_font", return_value="/f/JB.otf"), \
                    mock.patch.object(console_card.assemble, "need", return_value="/bin/ffmpeg"), \
                    mock.patch.object(console_card.subprocess, "run", side_effect=ffmpeg) as run, \
                    contextlib.redirect_stdout(io.StringIO()):
                dies_with(self, "ffmpeg exited 1", console_card.render, s,
                          console_card.fill(s, {}, False), out, 18, False)
            self.assertTrue(run.called)
            self.assertFalse(out.exists(), "a partial encode must not survive as the card")


class MainTests(unittest.TestCase):
    def run_main(self, argv: list[str], s: dict) -> mock.Mock:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "card.json"
            p.write_text(json.dumps(s), "utf-8")
            render = mock.Mock()
            with mock.patch.object(console_card, "render", render), \
                    mock.patch.object(sys, "argv", ["console_card.py", str(p), *argv]), \
                    contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(console_card.main(), 0)
        return render

    def test_draft_renders_to_the_draft_path_never_to_out(self) -> None:
        render = self.run_main(["--draft"], spec())
        out = render.call_args.args[2]
        self.assertEqual(out.name, "card.draft.mp4")

    def test_a_filled_card_renders_to_out(self) -> None:
        render = self.run_main(["--set", "dist=41"], spec())
        self.assertEqual(render.call_args.args[2], REPO / "release/takes/t/card.mp4")

    def test_check_renders_nothing_even_with_tokens_unfilled(self) -> None:
        self.assertFalse(self.run_main(["--check"], spec()).called)

    def test_an_unfilled_render_dies_before_ffmpeg(self) -> None:
        dies_with(self, "unfilled token(s) ['dist']", self.run_main, [], spec())


class FromLogTests(unittest.TestCase):
    """A from_log card renders only against the log of the run whose output it shows."""

    run_main = MainTests.run_main

    CARD = spec(command="just gate-live", from_log=True,
                response=["=== gate summary ===", "  PASS  a", "  PASS  b", "[gate] 2/2 passed"])

    def log(self, text: str) -> Path:
        d = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, d)
        (d / "gate.log").write_text(text, "utf-8")
        return d / "gate.log"

    def test_the_card_renders_against_the_run_it_copies(self) -> None:  # known-good
        log = self.log("[gate] running 2 arena(s)\n=== gate summary ===\n  PASS  a\n  PASS  b\n[gate] 2/2 passed\n")
        self.assertTrue(self.run_main(["--log", str(log)], self.CARD).called)

    def test_a_run_with_another_summary_line_is_refused(self) -> None:  # known-bad
        log = self.log("=== gate summary ===\n  PASS  a\n  FAIL  b\n[gate] 1/2 passed\n")
        dies_with(self, "has no line '[gate] 2/2 passed'", self.run_main, ["--log", str(log)], self.CARD)

    def test_rows_that_differ_from_the_log_are_refused(self) -> None:  # known-bad
        log = self.log("=== gate summary ===\n  PASS  a\n  PASS  c\n[gate] 2/2 passed\n")
        dies_with(self, "not the log's lines verbatim", self.run_main, ["--log", str(log)], self.CARD)

    def test_the_right_lines_in_another_order_are_refused(self) -> None:  # known-bad
        log = self.log("=== gate summary ===\n  PASS  b\n  PASS  a\n[gate] 2/2 passed\n")
        dies_with(self, "not the log's lines verbatim", self.run_main, ["--log", str(log)], self.CARD)

    def test_the_right_lines_with_a_foreign_line_between_are_refused(self) -> None:  # known-bad
        log = self.log("=== gate summary ===\n  PASS  a\n[gate] retry b\n  PASS  b\n[gate] 2/2 passed\n")
        dies_with(self, "not the log's lines verbatim", self.run_main, ["--log", str(log)], self.CARD)

    def test_no_log_is_refused_and_draft_needs_none(self) -> None:
        dies_with(self, "pass that run's log with --log", self.run_main, [], self.CARD)
        self.assertTrue(self.run_main(["--draft"], self.CARD).called)
        self.assertFalse(self.run_main(["--check"], self.CARD).called)

    def test_a_log_for_a_card_that_copies_no_run_is_refused(self) -> None:
        log = self.log("x\n")
        dies_with(self, "only for a card with", self.run_main, ["--log", str(log), "--set", "dist=4"], spec())

    def test_from_log_must_be_true(self) -> None:
        dies_with(self, "must be true", console_card.validate, spec(from_log="yes"))


@unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe") and shutil.which("fc-match"),
                     "needs ffmpeg + ffprobe + fontconfig (the capture devShell)")
class RealRenderTests(unittest.TestCase):
    def test_a_card_encodes_at_the_specs_size_fps_and_duration(self) -> None:
        r = subprocess.run(["fc-match", "-f", "%{family}", console_card.DEFAULT_FONT],
                           capture_output=True, text=True, check=False)
        if console_card.DEFAULT_FONT.casefold() not in r.stdout.casefold():
            self.skipTest(f"{console_card.DEFAULT_FONT} is not installed")
        s = spec(width=320, height=180, fps=30, duration=0.5, font_size=8,
                 command="send x", response=['"dist": 41'])
        with tempfile.TemporaryDirectory() as td:
            out = Path(td) / "card.mp4"
            with contextlib.redirect_stdout(io.StringIO()):
                console_card.render(console_card.validate(s), console_card.fill(s, {}, False),
                                    out, 30, dry_run=False)
            p = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                                "-show_entries", "stream=width,height,r_frame_rate:format=duration",
                                "-of", "json", str(out)], capture_output=True, text=True, check=True)
        info = json.loads(p.stdout)
        st = info["streams"][0]
        self.assertEqual((st["width"], st["height"], st["r_frame_rate"]), (320, 180, "30/1"))
        self.assertAlmostEqual(float(info["format"]["duration"]), 0.5, delta=0.05)


if __name__ == "__main__":
    unittest.main()
