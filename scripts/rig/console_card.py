#!/usr/bin/env python3
"""console_card.py — render a STYLIZED console card (a full-frame terminal still) as an mp4.

assemble.py cuts takes; it has no picture-in-picture and no blank card. A film that shows what
was typed at the bridge and what came back therefore needs that console as a take of its own:
this script draws one — a dark terminal frame with a prompt, the command and its response
lines — and encodes it at the cut list's size and fps, so it drops into a cut as a plain
segment `src`.

  python3 scripts/rig/console_card.py scenarios/shots/cards/1b_prospect.json --check
  python3 scripts/rig/console_card.py scenarios/shots/cards/1b_prospect.json \\
      --cut scenarios/shots/showcase_cut.json --set iron_dist=41
  python3 scripts/rig/console_card.py <spec> --draft      # layout preview, tokens shown as <name>

CARD SPEC (scenarios/shots/cards/*.json) — closed schema, a stray key dies
  {
    "out":       "release/takes/showcase/card_1b_prospect.mp4",   # relative → repo root, no '..'
    "fps": 60, "width": 1920, "height": 1080,   # must equal the cut list's (--cut checks it)
    "duration":  3.0,                           # seconds on screen
    "prompt":    "$",                           # fixed text: no <FILL:…> token
    "command":   "./gerda ctl send prospect ...",
    "response":  ["  \\"veins\\": {", "..."],    # 1+ lines under the command, verbatim
    "title":     "gerda — bridge",              # optional: the window title bar text
    "font":      "JetBrains Mono NL",           # optional; INSTALLED and MONOSPACED (fc-match)
    "font_size": 40,                            # optional, px
    "values":    {"iron_dist": 41},             # optional: fills the <FILL:iron_dist> tokens
    "from_log":  true,                          # optional: the response is a run's output
    "_doc":      ["why the card says what it says"]   # optional, never rendered
  }

A `from_log` card (the live-gate summary) renders only with `--log <that run's log>`, and only
when its response lines stand in the log verbatim and in a row: a card whose last line says
`20/20 passed` is refused against a run that printed `19/20 passed`, or against no run at all.

THE TEXT IS COPIED, NOT WRITTEN. A card stands for a real command and its real answer, so the
numbers in it come from a real run: a value the spec cannot know yet is a `<FILL:name>` token,
filled from `values` or `--set name=value` (the flag wins). A token left unfilled REFUSES the
render — a card with a guessed number reads exactly like one with the measured number. `--draft`
renders the tokens as `<name>` for a layout check and writes `<out stem>.draft.mp4`, never `out`
itself, so a preview cannot pass for the final card.

FAIL-LOUD: a spec that breaks the schema, a malformed or unfilled token, a value nobody uses, a
line that does not fit the frame at the font size, a font that is not installed, not monospaced
or lacks a glyph the text uses, a size or fps that differs from the cut list, or a non-zero
ffmpeg — each is a message on stderr and a non-zero exit.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import NoReturn

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
import assemble  # noqa: E402  — ENCODE / DEFAULT_CRF / FILTER_UNSAFE: one copy of the delivery settings

REQUIRED_KEYS = frozenset({"out", "fps", "width", "height", "duration", "prompt", "command",
                           "response"})
OPTIONAL_KEYS = frozenset({"title", "font", "font_size", "values", "from_log", "_doc"})
# The ligature-free cut: the card text is a verbatim copy, and the ligature face draws `===` as one
# long bar and `--` as a dash — a different string on screen than in the run.
DEFAULT_FONT = "JetBrains Mono NL"
DEFAULT_FONT_SIZE = 40
# fontconfig's `spacing` for a monospaced face — the layout places the command after the prompt
# by character count, which only holds when every glyph has the same advance.
FC_MONO = "100"
# A monospaced advance is ~0.6 em (JetBrains Mono: 600/1000 units); the fit check measures with it.
ADVANCE_EM = 0.6
LINE_EM = 1.5
MARGIN_FRAC = 0.05
TITLE_BAR_EM = 1.6

BG = "0x0d1117"
BAR = "0x161b22"
PROMPT_COLOR = "0x3fb950"
COMMAND_COLOR = "0xe6edf3"
RESPONSE_COLOR = "0xc9d1d9"
TITLE_COLOR = "0x8b949e"

TOKEN = re.compile(r"<FILL:([^<>]*)>")
TOKEN_NAME = re.compile(r"[a-z][a-z0-9_]*")


def die(msg: str) -> NoReturn:
    print(f"console_card.py: {msg}", file=sys.stderr)
    raise SystemExit(1)


# ── the spec ────────────────────────────────────────────────────────────────────────────

def text_field(where: str, v: object, *, allow_empty: bool = False) -> str:
    """A single-line string, or die: a newline or tab would break the one-line-per-drawtext layout."""
    if not isinstance(v, str):
        die(f"{where}={v!r} is not a string")
    if not allow_empty and not v.strip():
        die(f"{where} is blank")
    bad = [ch for ch in v if ord(ch) < 0x20 or ord(ch) == 0x7f]
    if bad:
        die(f"{where} holds a control character {bad[0]!r} — one card line per string, no tabs")
    return v


def positive_int(where: str, v: object, *, even: bool = False) -> int:
    if isinstance(v, bool) or not isinstance(v, int) or v <= 0:
        die(f"{where}={v!r} is not a positive integer")
    if even and v % 2:
        die(f"{where}={v} is odd — yuv420p needs even frame dimensions")
    return v


def positive_number(where: str, v: object) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) or v <= 0:
        die(f"{where}={v!r} is not a positive finite number")
    return float(v)


def tokens_in(where: str, text: str) -> list[str]:
    """The token names in `text`; die on a malformed one (a typo must not render as literal text)."""
    names = []
    for m in TOKEN.finditer(text):
        if not TOKEN_NAME.fullmatch(m.group(1)):
            die(f"{where}: malformed token {m.group(0)!r} — write <FILL:name>, name = [a-z][a-z0-9_]*")
        names.append(m.group(1))
    if text.count("<FILL") != len(names):
        die(f"{where}: a '<FILL' that is not a whole <FILL:name> token")
    return names


def card_lines(spec: dict) -> list[str]:
    """Every text line the card draws, in order (title first when present) — what is checked."""
    lines = [spec["title"]] if "title" in spec else []
    return [*lines, f"{spec['prompt']} {spec['command']}", *spec["response"]]


def validate(spec: object) -> dict:
    """The spec, checked against the closed schema — or die naming the first thing wrong."""
    if not isinstance(spec, dict):
        die(f"a card spec must be a JSON object, got {type(spec).__name__}")
    missing = sorted(REQUIRED_KEYS - set(spec))
    stray = sorted(set(spec) - REQUIRED_KEYS - OPTIONAL_KEYS)
    if missing or stray:
        die(f"missing key(s) {missing}, unknown key(s) {stray} "
            f"(required {sorted(REQUIRED_KEYS)}, optional {sorted(OPTIONAL_KEYS)})")
    out = text_field("out", spec["out"])
    if Path(out).is_absolute() or not out.endswith(".mp4") or out.endswith(".draft.mp4"):
        die(f"out={out!r} must be a repo-relative .mp4 path (and not a .draft.mp4)")
    # Lexical, not resolve(): a takes dir symlinked to another checkout is a legitimate home.
    if ".." in Path(out).parts:
        die(f"out={out!r} climbs out with '..' — the card must land inside the repo")
    positive_int("fps", spec["fps"])
    positive_int("width", spec["width"], even=True)
    positive_int("height", spec["height"], even=True)
    positive_number("duration", spec["duration"])
    prompt = text_field("prompt", spec["prompt"])
    if "<FILL" in prompt:
        # filter_graph indents the command by the SPEC prompt's length and draws the closing
        # prompt from the spec unfilled, so a filled prompt would misplace both.
        die(f"prompt={prompt!r} holds a <FILL:…> token — the prompt is fixed text")
    text_field("command", spec["command"])
    resp = spec["response"]
    if not isinstance(resp, list) or not resp:
        die("response must be a non-empty list of lines")
    for i, ln in enumerate(resp):
        text_field(f"response[{i}]", ln, allow_empty=True)
    if "title" in spec:
        text_field("title", spec["title"])
    if "font" in spec:
        font = text_field("font", spec["font"])
        if any(ch in font for ch in ",:'\\"):
            die(f"font={font!r} must be a plain family name")
    if "font_size" in spec:
        positive_int("font_size", spec["font_size"])
    values = spec.get("values", {})
    if not isinstance(values, dict):
        die("values must be an object of token name → value")
    for k, v in values.items():
        if not TOKEN_NAME.fullmatch(k):
            die(f"values: {k!r} is not a token name")
        if isinstance(v, bool) or not isinstance(v, (str, int, float)):
            die(f"values.{k}={v!r} must be a string or a number")
        if isinstance(v, str):
            text_field(f"values.{k}", v)
    if "from_log" in spec and spec["from_log"] is not True:
        die(f"from_log={spec['from_log']!r} must be true (or absent)")
    if "_doc" in spec and not (isinstance(spec["_doc"], list)
                               and all(isinstance(d, str) for d in spec["_doc"])):
        die("_doc must be a list of strings")
    used = {n for i, ln in enumerate(card_lines(spec)) for n in tokens_in(f"line {i}", ln)}
    unused = sorted(set(values) - used)
    if unused:
        die(f"values {unused} fill no token — a misspelt name would leave its token unfilled")
    check_fit(spec, card_lines(spec))
    return spec


def load(path: Path) -> dict:
    if not path.is_file():
        die(f"no such card spec: {path}")
    try:
        doc = json.loads(path.read_text("utf-8"))
    except json.JSONDecodeError as e:
        die(f"{path}: not JSON ({e})")
    return validate(doc)


def fill(spec: dict, overrides: dict[str, str], draft: bool) -> list[str]:
    """The card's lines with every token filled — or die listing the unfilled ones (unless draft)."""
    values = {k: str(v) for k, v in spec.get("values", {}).items()}
    used = {n for i, ln in enumerate(card_lines(spec)) for n in tokens_in(f"line {i}", ln)}
    stray = sorted(set(overrides) - used)
    if stray:
        die(f"--set {stray} fills no token in this card")
    values.update(overrides)
    for k, v in overrides.items():
        text_field(f"--set {k}", v)
    unfilled = sorted(used - set(values))
    if unfilled and not draft:
        die(f"unfilled token(s) {unfilled} — copy them from the real run (--set name=value or the "
            f"spec's values); --draft previews the layout without them")
    lines = [TOKEN.sub(lambda m: values.get(m.group(1), f"<{m.group(1)}>"), ln)
             for ln in card_lines(spec)]
    check_fit(spec, lines)
    return lines


def check_log(spec: dict, lines: list[str], log: Path) -> None:
    """A from_log card shows a run's output: its response lines must stand in that run's log,
    verbatim and in a row — or die. A summary line the run did not print (19/20 where the card
    says 20/20) is the first thing named."""
    if not log.is_file():
        die(f"no such log: {log}")
    want = [ln.rstrip() for ln in lines[-len(spec["response"]):]]
    have = [ln.rstrip() for ln in log.read_text("utf-8", "replace").splitlines()]
    if want[-1] not in have:
        die(f"{log} has no line {want[-1]!r}: the card's last line is not what this run printed")
    if not any(have[i:i + len(want)] == want for i in range(len(have) - len(want) + 1)):
        die(f"{log}: the card's response lines are not the log's lines verbatim and in a row")


# ── layout ──────────────────────────────────────────────────────────────────────────────

def geometry(spec: dict) -> dict[str, int]:
    fs = spec.get("font_size", DEFAULT_FONT_SIZE)
    margin = round(spec["width"] * MARGIN_FRAC)
    bar = round(fs * TITLE_BAR_EM) if "title" in spec else 0
    return {"fs": fs, "margin": margin, "bar": bar, "line": round(fs * LINE_EM),
            "advance": math.ceil(fs * ADVANCE_EM), "top": bar + margin}


def check_fit(spec: dict, lines: list[str]) -> None:
    """Die unless every line fits the frame width and all rows (plus the closing prompt) its height.
    The title is centred across the whole frame (filter_graph), so it gets the full width."""
    g = geometry(spec)
    body = lines[1:] if "title" in spec else lines
    if "title" in spec and len(lines[0]) * g["advance"] > spec["width"]:
        die(f"title {lines[0][:40]!r}… is {len(lines[0])} chars — {len(lines[0]) * g['advance']}px "
            f"at font_size {g['fs']} does not fit the {spec['width']}px frame width; shorten it")
    room = spec["width"] - 2 * g["margin"]
    for i, ln in enumerate(body):
        if len(ln) * g["advance"] > room:
            die(f"line {ln[:40]!r}… is {len(ln)} chars — {len(ln) * g['advance']}px at font_size "
                f"{g['fs']} does not fit the {room}px text width; shorten it or lower font_size")
    rows = len(body) + 1   # + the closing prompt with its cursor
    need = g["top"] + rows * g["line"] + g["margin"]
    if need > spec["height"]:
        die(f"{rows} rows need {need}px at font_size {g['fs']}, the frame is {spec['height']}px — "
            f"drop lines or lower font_size")


# ── fonts ───────────────────────────────────────────────────────────────────────────────

def resolve_font(family: str, text: str) -> str:
    """The font FILE drawtext gets — or die unless `family` is installed, monospaced and covers
    every non-ASCII character of `text`. drawtext, like libass, would draw a fallback silently."""
    fc = shutil.which("fc-match")
    if not fc:
        die("fc-match not on PATH — cannot resolve the card font (`nix develop .#capture` has it)")
    r = subprocess.run([fc, "-f", "%{family}|%{spacing}|%{file}", family],
                       capture_output=True, text=True, check=False)
    if r.returncode != 0 or r.stdout.count("|") != 2:
        die(f"fc-match failed on card font {family!r}: {r.stderr.strip() or r.stdout!r}")
    fams, spacing, path = r.stdout.split("|")
    if family.casefold() not in {f.strip().casefold() for f in fams.split(",")}:
        die(f"card font {family!r} is not installed — fontconfig resolves it to {fams!r}")
    if spacing != FC_MONO:
        die(f"card font {family!r} is not monospaced (fontconfig spacing={spacing!r}) — the "
            f"command is placed after the prompt by character count")
    if assemble.FILTER_UNSAFE & set(path):
        die(f"font file {path} holds filtergraph metacharacters — cannot pass it to drawtext")
    missing = missing_glyphs(family, text)
    if missing:
        ch = missing[0]
        die(f"card font {family!r} has no glyph for {ch!r} (U+{ord(ch):04X}) — drawtext would "
            f"draw a box; use plain ASCII")
    return path


def missing_glyphs(family: str, text: str) -> list[str]:
    """The non-ASCII characters of `text` that installed `family` has no glyph for (fontconfig's
    charset), sorted. ASCII is taken as covered: every face the rig uses has it."""
    wanted = sorted({c for c in text if ord(c) > 0x7e})
    if not wanted:
        return []
    fl = shutil.which("fc-list")
    if not fl:
        die(f"fc-list not on PATH — cannot check that {family!r} has the glyphs {wanted}")
    out = []
    for ch in wanted:
        r = subprocess.run([fl, f"{family}:charset={ord(ch):x}", "family"],
                           capture_output=True, text=True, check=False)
        got = {f.strip().casefold() for ln in r.stdout.splitlines() for f in ln.split(",")}
        if family.casefold() not in got:
            out.append(ch)
    return out


# ── render ──────────────────────────────────────────────────────────────────────────────

def drawtext(fontfile: str, textfile: Path, fs: int, color: str, x: int, y: int) -> str:
    # textfile + expansion=none: the card text never passes through filtergraph escaping or
    # drawtext's %{…} expansion, so a quote, colon or percent sign in a real response is drawn as-is.
    return (f"drawtext=fontfile={fontfile}:textfile={textfile}:expansion=none:fontsize={fs}:"
            f"fontcolor={color}:x={x}:y={y}")


def filter_graph(spec: dict, lines: list[str], fontfile: str, tmp: Path) -> str:
    g = geometry(spec)
    fs, m, adv = g["fs"], g["margin"], g["advance"]
    if assemble.FILTER_UNSAFE & set(str(tmp)):
        die(f"temp dir {tmp} holds filtergraph metacharacters")
    parts: list[str] = []
    n = 0

    def text(s: str, color: str, x: int, y: int) -> None:
        nonlocal n
        f = tmp / f"line{n}.txt"
        n += 1
        f.write_text(s, "utf-8")
        parts.append(drawtext(fontfile, f, fs, color, x, y))

    body = lines
    if "title" in spec:
        parts.append(f"drawbox=x=0:y=0:w=iw:h={g['bar']}:color={BAR}:t=fill")
        title, body = lines[0], lines[1:]
        text(title, TITLE_COLOR, (spec["width"] - len(title) * adv) // 2, (g["bar"] - fs) // 2)
    prompt = spec["prompt"]
    indent = m + (len(prompt) + 1) * adv
    y = g["top"]
    text(prompt, PROMPT_COLOR, m, y)
    text(body[0][len(prompt) + 1:], COMMAND_COLOR, indent, y)
    for ln in body[1:]:
        y += g["line"]
        if ln.strip():
            text(ln, RESPONSE_COLOR, m, y)
    y += g["line"]
    text(prompt, PROMPT_COLOR, m, y)
    # The closing prompt's cursor: a block that blinks at 1 Hz, so the still reads as a live shell.
    parts.append(f"drawbox=x={indent}:y={y}:w={adv}:h={fs}:color={COMMAND_COLOR}:t=fill:"
                 f"enable='lt(mod(t,1),0.5)'")
    return ",".join(parts)


def render(spec: dict, lines: list[str], out: Path, crf: int, dry_run: bool) -> None:
    font = spec.get("font", DEFAULT_FONT)
    fontfile = resolve_font(font, "".join(lines))
    ffmpeg = assemble.need("ffmpeg")
    with tempfile.TemporaryDirectory(prefix="console_card_") as td:
        graph = filter_graph(spec, lines, fontfile, Path(td))
        src = (f"color=c={BG}:s={spec['width']}x{spec['height']}:r={spec['fps']}:"
               f"d={spec['duration']}")
        cmd = [ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", src,
               "-vf", graph, "-t", str(spec["duration"]), *assemble.ENCODE, "-crf", str(crf),
               str(out)]
        print("\n  " + " ".join(cmd) + "\n")
        if dry_run:
            print("console_card: --dry-run — nothing encoded, nothing written")
            return
        out.parent.mkdir(parents=True, exist_ok=True)
        r = subprocess.run(cmd, check=False)
    if r.returncode != 0:
        out.unlink(missing_ok=True)
        die(f"ffmpeg exited {r.returncode} — see its output above; nothing usable at {out}")
    print(f"console_card: done → {out}")
    print(assemble.probe_summary(out))


# ── the cut it is for ───────────────────────────────────────────────────────────────────

def check_cut(spec: dict, cut: dict, spec_name: str) -> None:
    """Die unless the card is cut-ready: same fps/size as the cut list, and `out` IS the takes_dir
    file some segment names — a card rendered anywhere else is a file the cut never opens."""
    for key, default in (("fps", 60), ("width", 1920), ("height", 1080)):
        if spec[key] != cut.get(key, default):
            die(f"{spec_name}: {key}={spec[key]} but the cut list's is {cut.get(key, default)}")
    out = Path(spec["out"])
    takes = Path(cut.get("takes_dir", "release/takes"))
    if out.parent != takes:
        die(f"{spec_name}: out={spec['out']} is not in the cut's takes_dir {takes}")
    srcs = {s.get("src") for s in cut.get("segments", [])}
    if out.name not in srcs:
        die(f"{spec_name}: no segment of the cut list has src {out.name!r}")


# ── main ────────────────────────────────────────────────────────────────────────────────

def parse_set(items: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for item in items:
        name, sep, value = item.partition("=")
        if not sep or not TOKEN_NAME.fullmatch(name):
            die(f"--set {item!r} must be name=value with name = [a-z][a-z0-9_]*")
        out[name] = value
    return out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("spec", type=Path)
    ap.add_argument("--set", action="append", default=[], metavar="NAME=VALUE",
                    help="fill a <FILL:NAME> token (wins over the spec's values)")
    ap.add_argument("--cut", type=Path, help="the cut list this card is for — fps/size/src must match")
    ap.add_argument("--check", action="store_true", help="validate only (tokens may stay unfilled)")
    ap.add_argument("--draft", action="store_true",
                    help="render with unfilled tokens shown as <name>, to <out stem>.draft.mp4")
    ap.add_argument("--dry-run", action="store_true", help="print the ffmpeg command, encode nothing")
    ap.add_argument("--crf", type=int, default=assemble.DEFAULT_CRF)
    ap.add_argument("--log", type=Path,
                    help="the log of the run a from_log card copies; the render checks the card against it")
    args = ap.parse_args()

    spec = load(args.spec)
    if args.log and not spec.get("from_log"):
        die("--log is read only for a card with \"from_log\": true")
    if args.cut:
        if not args.cut.is_file():
            die(f"no such cut list: {args.cut}")
        check_cut(spec, json.loads(args.cut.read_text("utf-8")), args.spec.name)
    overrides = parse_set(args.set)
    if args.check:
        fill(spec, overrides, draft=True)
        print(f"console_card: {args.spec} — spec ok")
        return 0
    lines = fill(spec, overrides, draft=args.draft)
    if spec.get("from_log") and not args.draft:
        if not args.log:
            die("this card copies a run's output — pass that run's log with --log (or --draft)")
        check_log(spec, lines, args.log)
    out = REPO / spec["out"]
    if args.draft:
        out = out.with_name(out.name[: -len(".mp4")] + ".draft.mp4")
    print(f"console_card: {args.spec.name} → {out}  ({spec['width']}x{spec['height']} "
          f"@{spec['fps']} fps, {spec['duration']:g}s)")
    for ln in lines:
        print(f"  | {ln}")
    render(spec, lines, out, args.crf, args.dry_run)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
