#!/usr/bin/env python3
"""assemble.py — DECLARATIVE editor: turn a cut-list JSON into one cut mp4.

scripts/demo/shoot.py is the SHOOT half of the rig (a shot list → a folder of takes);
this is the EDIT half (a cut list → the deliverable). A cut list names, per segment,
which take to use and the in/out that were verified frame-by-frame against that take —
so the edit is data under review in git, not a shell history nobody can reproduce.

  python3 scripts/rig/assemble.py scenarios/shots/teaser_cut.json --dry-run
  python3 scripts/rig/assemble.py scenarios/shots/teaser_cut.json
  python3 scripts/rig/assemble.py scenarios/shots/teaser_cut.json --only vein,finale

CUT SCHEMA (scenarios/shots/*_cut.json)
  {
    "name": "teaser", "fps": 60, "width": 1920, "height": 1080,
    "takes_dir": "release/takes/teaser",          # relative → repo root
    "out": "release/gerda_teaser_draft.mp4",    # relative → repo root
    "fade_in": 0.5, "fade_out": 0.8,             # 0 / absent → no fade
    "segments": [{
      "id":      "vein",            # unique; what --only selects on
      "src":     "03_vein.mp4",     # a file inside takes_dir; may be reused by segments
      "in":      6.0,               # seconds into the take
      "out":     60.0,              # seconds into the take (exclusive), > in, <= duration
      "speed":   3.0,               # optional time-stretch, default 1.0 (3.0 = 3x faster)
      "filters": ["drawbox=..."],   # optional extra per-segment ffmpeg video filters
      "note":    "why this in/out"  # editorial intent — the reason the numbers are these
    }],
    "captions": {                     # optional — burned in; absent → no captions
      "font": "Inter", "label_font": "JetBrains Mono",   # optional; must be INSTALLED (fc-match)
      "cues": [{                      # non-empty; every key below is required, no others allowed
        "seg":   "prospect",          # the segment the cue rides — re-timing it carries the cue
        "at":    0.2,                 # seconds into that segment's OUTPUT (after speed)
        "dur":   4.0,                 # on-screen hold, OUTPUT seconds
        "layer": "line",              # "line" = narrative, bottom third; "label" = state tag, top-left
        "text":  "Standing still on purpose —\nthe prospector scans for veins"
      }]                              # "{speed}" in text = the segment's speed ("3×")
    }
  }

CAPTIONS are anchored to segments, not to the film clock: each cue's absolute time is its
segment's output start + `at`, so changing a segment's in/out/speed (or --only) moves its
captions with it. They render to an ASS sidecar next to the output (`<out>.en.ass`, handy for
review) and are burned in by libass (`ass=`) AFTER the fades. Readability limits are enforced,
not suggested: every cue sits inside its segment, holds >= MIN_HOLD_S, has lines <= MAX_LINE
chars and reads at <= MAX_CPS characters per second — measured on the text AS RENDERED (labels
upper-cased, `{speed}` filled in). A speed is not typed into a caption: `{speed}` is filled from
the segment, and a hand-typed rate in digit form ("3×", "×3", "1.5x") is refused. A rate glued
to a word ("3×speed", "3xspeed") or spelled out ("three times") is NOT caught — that one is on
the author. Sizes must be written unspaced ("3×3"): "3 × 3" reads as a rate and is refused, and
so is a coordinate like "X 120". The caption fonts are checked with fc-match first — libass
would otherwise burn a fallback silently.

ONE ffmpeg INVOCATION, not a pile of intermediates: every take is an `-i` (deduplicated
by path — a take used by two segments is still opened once), each segment is a
trim/setpts/scale chain in a single `-filter_complex`, and the chains are `concat`ed and
faded in place. No temp files, so a re-cut after a number changes is one command and the
generation loss of a re-encode per segment never happens.

FAIL-LOUD (repo convention): a missing take, an out <= in, an out past the real end of the
source (each source is ffprobe'd), an unknown --only id, a speed that is not a positive number
(on ANY segment of the cut list, --only or not), or a
non-zero ffmpeg (which also takes back the caption sidecar), a caption that breaks the schema
or a readability limit or spills past its segment, a caption font that is not installed — each
is a message on stderr and a non-zero exit. Nothing is clamped and
nothing is skipped: a cut list that silently shortens itself would ship a wrong film that
looks fine in the log.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import shutil
import subprocess
import sys
from pathlib import Path
from typing import NoReturn

REPO = Path(__file__).resolve().parents[2]

# The proven delivery settings — same as scripts/rig/encode.sh. Keep them in step.
ENCODE = ["-c:v", "libx264", "-preset", "slow", "-pix_fmt", "yuv420p",
          "-movflags", "+faststart", "-an"]
DEFAULT_CRF = 20
DEFAULT_SPEED = 1.0

# Caption readability limits (burned-in social-video norms: two short lines, time to read them).
MIN_HOLD_S = 1.5
MAX_LINE = 42
MAX_CPS = 20.0
CAPTION_LAYERS = ("line", "label")
DEFAULT_FONT = "Inter"
DEFAULT_LABEL_FONT = "JetBrains Mono"
# Closed schema: a misspelt key ("durr") would otherwise be a silently ignored caption setting.
CAPTION_KEYS = frozenset({"font", "label_font", "cues"})
CUE_KEYS = frozenset({"seg", "at", "dur", "layer", "text"})
# The segment's speed, filled into caption text — the speed is stated once, on the segment.
SPEED_TOKEN = "{speed}"
# A hand-typed rate ("3×", "1.5x", "×2") is that same fact typed twice — refused; write {speed}.
# Both orders: a digit then the sign, or a standalone sign then a digit — the sign's far side must
# not be a word character, so "3xl", "box2" and the dimension "3×3" pass (and so does "3×speed").
HARDCODED_RATE = re.compile(r"\d\s*[×xX](?!\w)|(?<!\w)[×xX]\s*\d")
ASS_CONTROL = "{}\\"
# Characters that would need filtergraph escaping in `ass=<path>` — refused instead of escaped.
FILTER_UNSAFE = set("'\\:,;[]=")


def die(msg: str) -> NoReturn:
    print(f"assemble.py: {msg}", file=sys.stderr)
    raise SystemExit(1)


# ── probing ─────────────────────────────────────────────────────────────────────────────

def need(tool: str) -> str:
    path = shutil.which(tool)
    if not path:
        die(f"{tool} not on PATH — run under the dev shell ('nix develop -c ...')")
    return path


def probe_duration(path: Path) -> float:
    """Real duration of a take, in seconds — the ceiling every `out` is checked against."""
    r = subprocess.run([need("ffprobe"), "-v", "error", "-select_streams", "v:0",
                        "-show_entries", "format=duration",
                        "-of", "default=noprint_wrappers=1:nokey=1", str(path)],
                       capture_output=True, text=True, check=False)
    if r.returncode != 0:
        die(f"ffprobe failed on {path}:\n{r.stderr.strip()}")
    try:
        return float(r.stdout.strip())
    except ValueError:
        die(f"ffprobe reported no duration for {path} (truncated or not a video?)")


def probe_summary(path: Path) -> str:
    r = subprocess.run([need("ffprobe"), "-v", "error", "-select_streams", "v:0",
                        "-show_entries",
                        "stream=codec_name,width,height,r_frame_rate:format=duration,size",
                        "-of", "default=noprint_wrappers=1", str(path)],
                       capture_output=True, text=True, check=False)
    return r.stdout.strip() if r.returncode == 0 else f"(ffprobe failed: {r.stderr.strip()})"


# ── the cut list ────────────────────────────────────────────────────────────────────────

def load(path: Path) -> dict:
    if not path.is_file():
        die(f"no such cut list: {path}")
    doc = json.loads(path.read_text())
    segs = doc.get("segments")
    if not segs:
        die(f"{path}: no segments")
    ids = [s["id"] for s in segs]
    if len(set(ids)) != len(ids):
        die(f"{path}: duplicate segment ids — --only could not address them")
    return doc


def under_repo(value: str, override: str | None) -> Path:
    """Resolve a JSON path against the repo root; an override flag wins, absolute wins."""
    p = Path(override) if override else Path(value)
    return p if p.is_absolute() else (REPO / p)


def select(segments: list[dict], only: str | None) -> list[dict]:
    if not only:
        return segments
    wanted = [i.strip() for i in only.split(",") if i.strip()]
    by_id = {s["id"]: s for s in segments}
    missing = [i for i in wanted if i not in by_id]
    if missing:
        die(f"unknown segment id(s) in --only: {', '.join(missing)} "
            f"(have: {', '.join(by_id)})")
    return [by_id[i] for i in wanted]


def seg_speed(seg: dict) -> float:
    """A segment's speed, or die naming the segment — `cue_number`'s rule (a finite JSON number,
    never a bool or a string), and positive."""
    where, raw = f"segment '{seg['id']}'", seg.get("speed", DEFAULT_SPEED)
    speed = cue_number(where, "speed", raw)
    if speed <= 0:
        die(f"{where}: speed={raw!r} must be positive")
    return speed


def validate(seg: dict, src: Path, source_len: float) -> tuple[float, float, float]:
    """Return (in, out, speed) for a segment, or die telling exactly what is wrong."""
    sid = seg["id"]
    t_in, t_out = float(seg["in"]), float(seg["out"])
    speed = seg_speed(seg)
    if t_in < 0:
        die(f"segment '{sid}': in={t_in} is negative")
    if t_out <= t_in:
        die(f"segment '{sid}': out={t_out} is not after in={t_in}")
    if t_out > source_len:
        die(f"segment '{sid}': out={t_out}s is past the end of {src.name} "
            f"({source_len:.2f}s) — the take is shorter than the cut list thinks")
    return t_in, t_out, speed


# ── the filter graph ────────────────────────────────────────────────────────────────────

Cue = tuple[float, float, str, str]   # (start, end, layer, text) on the OUTPUT timeline


def fmt_speed(speed: float) -> str:
    """A segment speed as a caption shows it: 3.0 → "3×", 1.5 → "1.5×"."""
    return f"{speed:g}×"


def displayed(layer: str, text: str) -> str:
    """Caption text as it lands on screen — labels are caps. The ONE place that says so: the
    readability limits and the ASS renderer both read it, so they measure what is burned in."""
    return text.upper() if layer == "label" else text


def caption_fonts(doc: dict) -> dict[str, str]:
    """layer → font family the ASS style asks libass for."""
    spec = doc.get("captions") or {}
    return {"line": spec.get("font", DEFAULT_FONT),
            "label": spec.get("label_font", DEFAULT_LABEL_FONT)}


def caption_spec(spec: object) -> list:
    """The validated `captions` block's cue list — closed schema, or die naming the stray key."""
    if not isinstance(spec, dict):
        die(f"captions must be an object, got {type(spec).__name__}")
    stray = sorted(set(spec) - CAPTION_KEYS)
    if stray:
        die(f"captions: unknown key(s) {stray} (allowed: {sorted(CAPTION_KEYS)})")
    for key in ("font", "label_font"):
        if key in spec:
            v = spec[key]
            # A comma would split the ASS Style line; a newline would end it.
            if not isinstance(v, str) or not v.strip() or any(ch in v for ch in ",\r\n"):
                die(f"captions.{key}={v!r} must be a non-empty font family name without , or "
                    f"line breaks")
    cues = spec.get("cues")
    if not isinstance(cues, list) or not cues:
        die("captions.cues must be a non-empty list — drop the whole captions block for a "
            "captionless cut")
    return cues


def cue_where(n: int, c: object) -> str:
    if not isinstance(c, dict):
        return f"caption #{n}"
    return f"caption #{n} ({c.get('seg')!r}: {str(c.get('text', ''))[:24]!r})"


def cue_number(where: str, key: str, v: object) -> float:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        die(f"{where}: {key}={v!r} is not a number")
    if not math.isfinite(v):
        die(f"{where}: {key}={v!r} is not finite")
    return float(v)


def one_cue(n: int, c: object, speeds: dict[str, float]) -> tuple[str, float, float, str, str]:
    """(seg, at, dur, layer, text-with-{speed}-filled) for cue #n, or die naming what is wrong.
    Everything that does not depend on where the segment lands is checked here — so a cue of a
    segment left out by --only is still held to the schema and the readability limits."""
    where = cue_where(n, c)
    if not isinstance(c, dict):
        die(f"{where}: must be an object, got {type(c).__name__}")
    missing, stray = sorted(CUE_KEYS - set(c)), sorted(set(c) - CUE_KEYS)
    if missing or stray:
        die(f"{where}: missing key(s) {missing}, unknown key(s) {stray} "
            f"(a cue is exactly {sorted(CUE_KEYS)})")
    seg, layer, text = c["seg"], c["layer"], c["text"]
    if seg not in speeds:
        die(f"{where}: no segment {seg!r} in the cut list")
    if layer not in CAPTION_LAYERS:
        die(f"{where}: layer={layer!r} is not one of {CAPTION_LAYERS}")
    at, dur = cue_number(where, "at", c["at"]), cue_number(where, "dur", c["dur"])
    if not isinstance(text, str):
        die(f"{where}: text={text!r} is not a string")
    if "\r" in text:
        die(f"{where}: text holds a carriage return — break lines with \\n only")
    if any(not ln.strip() for ln in text.split("\n")):
        die(f"{where}: text is blank or has a blank line")
    if rate := HARDCODED_RATE.search(text):
        die(f"{where}: text types a rate by hand ({rate.group(0)!r}) — "
            f"write {SPEED_TOKEN} so it is filled from the segment's speed "
            f"({fmt_speed(speeds[seg])})")
    text = text.replace(SPEED_TOKEN, fmt_speed(speeds[seg]))
    if any(ch in text for ch in ASS_CONTROL):
        die(f"{where}: text holds ASS control characters {{ }} \\ (only {SPEED_TOKEN} is "
            f"allowed)")
    if at < 0:
        die(f"{where}: at={at} is negative")
    if dur < MIN_HOLD_S:
        die(f"{where}: dur={dur}s is under the {MIN_HOLD_S}s minimum hold")
    lines = displayed(layer, text).split("\n")
    long = [ln for ln in lines if len(ln) > MAX_LINE]
    if long:
        die(f"{where}: line {long[0]!r} is {len(long[0])} chars as rendered (max {MAX_LINE})")
    cps = sum(len(ln) for ln in lines) / dur
    if cps > MAX_CPS:
        die(f"{where}: reads at {cps:.1f} chars/s (max {MAX_CPS:g}) — hold it longer "
            f"or say less")
    return seg, at, dur, layer, text


def check_fonts(doc: dict, cues: list[Cue]) -> None:
    """Die unless every font a cue uses is installed. libass asks fontconfig and burns in
    whatever comes back — a missing family is a SILENT fallback in the delivered film."""
    fc = shutil.which("fc-match")
    if not fc:
        die("fc-match not on PATH — cannot verify the caption fonts, and libass would burn in a "
            "fallback silently (it ships with fontconfig; `nix develop .#capture` has it)")
    fonts = caption_fonts(doc)
    for family in sorted({fonts[layer] for _, _, layer, _ in cues}):
        r = subprocess.run([fc, "-f", "%{family}", family],
                           capture_output=True, text=True, check=False)
        if r.returncode != 0:
            die(f"fc-match failed on caption font {family!r}:\n{r.stderr.strip()}")
        got = [f.strip() for f in r.stdout.split(",")]
        if family.casefold() not in {f.casefold() for f in got}:
            die(f"caption font {family!r} is not installed — fontconfig resolves it to "
                f"{r.stdout.strip()!r}, which libass would burn in instead")


def caption_cues(doc: dict, timeline: dict[str, tuple[float, float]]) -> list[Cue]:
    """Place every cue whose segment is in the cut on the film clock, or die naming the cue.

    `timeline` maps segment id → (output start, output length). Cues of segments left out by
    --only are dropped (they have nowhere to sit); a cue naming an id that is not in the cut
    list at all is a typo and dies.
    """
    spec = doc.get("captions")
    if spec is None:
        return []
    speeds = {s["id"]: seg_speed(s) for s in doc["segments"]}
    cues: list[Cue] = []
    for n, c in enumerate(caption_spec(spec)):
        seg, at, dur, layer, text = one_cue(n, c, speeds)
        if seg not in timeline:
            continue
        start, length = timeline[seg]
        if at + dur > length + 1e-6:
            die(f"{cue_where(n, c)}: at+dur={at + dur:g}s spills past its segment "
                f"({length:.2f}s output)")
        cues.append((start + at, start + at + dur, layer, text))
    cues.sort()
    for layer in CAPTION_LAYERS:
        mine = [c for c in cues if c[2] == layer]
        for a, b in zip(mine, mine[1:]):
            if b[0] < a[1] - 1e-6:
                die(f"captions overlap on layer {layer!r}: {a[3]!r} (to {a[1]:.2f}s) and "
                    f"{b[3]!r} (from {b[0]:.2f}s)")
    return cues


def ass_time(t: float) -> str:
    cs = round(t * 100)
    h, rem = divmod(cs, 360000)
    m, rem = divmod(rem, 6000)
    s, cs = divmod(rem, 100)
    return f"{h}:{m:02d}:{s:02d}.{cs:02d}"


def render_ass(cues: list[Cue], doc: dict) -> str:
    """The ASS script for `cues`: a bottom-centre narrative style and a top-left boxed label."""
    fonts = caption_fonts(doc)
    font, label_font = fonts["line"], fonts["label"]
    width, height = doc.get("width", 1920), doc.get("height", 1080)
    fields = ("Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, "
              "BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, "
              "BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding")
    out = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {width}", f"PlayResY: {height}",
        "WrapStyle: 2", "ScaledBorderAndShadow: yes", "",
        "[V4+ Styles]", f"Format: {fields}",
        # line: white, 3px black outline + soft shadow, bottom centre (alignment 2).
        f"Style: line,{font},54,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,"
        "-1,0,0,0,100,100,0,0,1,3,1,2,120,120,72,1",
        # label: caps mono on a translucent box (BorderStyle 3 = OutlineColour box), top-left (7).
        f"Style: label,{label_font},38,&H00FFFFFF,&H000000FF,&H60000000,&H00000000,"
        "-1,0,0,0,100,100,2,0,3,10,0,7,56,56,48,1",
        "",
        "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
        "Effect, Text",
    ]
    for start, end, layer, text in cues:
        body = displayed(layer, text)
        out.append(f"Dialogue: 0,{ass_time(start)},{ass_time(end)},{layer},,0,0,0,,"
                   "{\\fad(150,150)}" + body.replace("\n", "\\N"))
    return "\n".join(out) + "\n"


def build(doc: dict, segments: list[dict], takes_dir: Path,
          ass_path: Path | None = None) -> tuple[list[str], list[list], list[Cue]]:
    """Build the ffmpeg args (minus output/encode), the per-segment report rows and the placed
    caption cues. With cues present the graph burns `ass_path` — the caller writes that file."""
    fps = doc.get("fps", 60)
    width, height = doc.get("width", 1920), doc.get("height", 1080)
    # EVERY segment's speed, --only or not, captions or not: a bad one is a broken cut list even
    # when this cut leaves its segment out.
    for seg in doc["segments"]:
        seg_speed(seg)

    inputs: list[Path] = []          # unique sources, in first-use order → -i order
    index: dict[Path, int] = {}
    chains: list[str] = []
    rows: list[list] = []
    timeline: dict[str, tuple[float, float]] = {}
    total = 0.0

    for seg in segments:
        src = takes_dir / seg["src"]
        if not src.is_file():
            die(f"segment '{seg['id']}': no such take: {src}")
        if src not in index:
            index[src] = len(inputs)
            inputs.append(src)
        t_in, t_out, speed = validate(seg, src, probe_duration(src))

        extra = "".join(f",{f}" for f in seg.get("filters", []))
        label = f"s{len(chains)}"
        chains.append(
            f"[{index[src]}:v]trim=start={t_in}:end={t_out},"
            f"setpts=(PTS-STARTPTS)/{speed}{extra},"
            f"scale={width}:{height},setsar=1,fps={fps}[{label}]"
        )
        out_len = (t_out - t_in) / speed
        timeline[seg["id"]] = (total, out_len)
        total += out_len
        rows.append([seg["id"], seg["src"], f"{t_in:g}→{t_out:g}", f"{speed:g}x",
                     f"{out_len:.2f}s"])

    joined = "".join(f"[s{i}]" for i in range(len(chains)))
    chains.append(f"{joined}concat=n={len(chains)}:v=1:a=0[cat]")

    # Fades ride the CONCATENATED stream, so the film opens and closes — not each segment.
    fades = []
    fade_in, fade_out = float(doc.get("fade_in", 0)), float(doc.get("fade_out", 0))
    if fade_in > 0:
        fades.append(f"fade=t=in:st=0:d={fade_in}")
    if fade_out > 0:
        if fade_out >= total:
            die(f"fade_out={fade_out}s does not fit in a {total:.2f}s cut")
        fades.append(f"fade=t=out:st={total - fade_out:.3f}:d={fade_out}")
    # Captions burn AFTER the fades, so text is never dimmed by the film's own fade.
    cues = caption_cues(doc, timeline)
    post = list(fades)
    if cues:
        if ass_path is None:
            die("captions present but no ASS sidecar path to burn them from")
        if FILTER_UNSAFE & set(str(ass_path)):
            die(f"ASS sidecar path {ass_path} holds filtergraph metacharacters "
                f"({''.join(sorted(FILTER_UNSAFE))}) — pick an --out without them")
        post.append(f"ass=filename={ass_path}")
    if post:
        chains.append(f"[cat]{','.join(post)}[v]")
        vmap = "[v]"
    else:
        vmap = "[cat]"

    args: list[str] = []
    for p in inputs:
        args += ["-i", str(p)]
    args += ["-filter_complex", ";".join(chains), "-map", vmap]
    rows.append(["TOTAL", f"{len(inputs)} source(s)", "", "", f"{total:.2f}s"])
    return args, rows, cues


def table(rows: list[list]) -> None:
    head = ["id", "src", "in→out", "speed", "duration"]
    widths = [max(len(str(r[i])) for r in [head, *rows]) for i in range(len(head))]
    line = "  ".join(h.ljust(w) for h, w in zip(head, widths))
    print(f"  {line}\n  {'-' * len(line)}")
    for r in rows:
        print("  " + "  ".join(str(c).ljust(w) for c, w in zip(r, widths)))


# ── main ────────────────────────────────────────────────────────────────────────────────

def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cutlist", type=Path)
    ap.add_argument("--takes-dir", help="override the cut list's takes_dir")
    ap.add_argument("--out", help="override the cut list's out file")
    ap.add_argument("--only", help="comma-separated segment ids (default: all, in order)")
    ap.add_argument("--crf", type=int, default=DEFAULT_CRF,
                    help=f"x264 quality (default {DEFAULT_CRF}, same as encode.sh)")
    ap.add_argument("--dry-run", action="store_true",
                    help="print the command and the segment table, encode nothing")
    args = ap.parse_args()

    doc = load(args.cutlist)
    takes_dir = under_repo(doc.get("takes_dir", "release/takes"), args.takes_dir)
    if not takes_dir.is_dir():
        die(f"no such takes dir: {takes_dir}")
    out = under_repo(doc.get("out", "release/cut.mp4"), args.out)
    segments = select(doc["segments"], args.only)

    print(f"assemble: {doc.get('name', args.cutlist.stem)} — {len(segments)} segment(s) "
          f"from {takes_dir} → {out}")
    ass_path = out.with_suffix(".en.ass")
    graph, rows, cues = build(doc, segments, takes_dir, ass_path)
    cmd = [need("ffmpeg"), "-y", *graph, *ENCODE, "-crf", str(args.crf), str(out)]

    table(rows)
    for start, end, layer, text in cues:
        shown = displayed(layer, text).replace("\n", " / ")
        print(f"  {start:6.2f}→{end:6.2f}  {layer:<5}  {shown}")
    if cues:
        check_fonts(doc, cues)
    print("\n  " + " ".join(cmd) + "\n")
    if args.dry_run:
        if cues:
            print(f"assemble: --dry-run — the ass= sidecar the command names ({ass_path}) is "
                  f"NOT written; only a real run writes it")
        print("assemble: --dry-run — nothing encoded, nothing written")
        return 0

    out.parent.mkdir(parents=True, exist_ok=True)
    if cues:
        ass_path.write_text(render_ass(cues, doc), "utf-8")
        print(f"assemble: {len(cues)} caption cue(s) → {ass_path}")
    ok = False
    try:
        r = subprocess.run(cmd, check=False)
        ok = r.returncode == 0
    finally:
        if cues and not ok:
            # A sidecar beside a failed cut reads as a finished edit's companion — take it back.
            ass_path.unlink(missing_ok=True)
    if not ok:
        die(f"ffmpeg exited {r.returncode} — see its output above; nothing usable at {out}"
            + (f" (caption sidecar {ass_path} removed)" if cues else ""))
    print(f"\nassemble: done → {out}")
    print(probe_summary(out))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
