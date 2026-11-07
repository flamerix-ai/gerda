"""Unit tests for sustain_live.py's plan witness (scripts/demo/sustain_live.py).

`plan_start` acks `ok:true` even when the plan does not exist — `cmdPlanStart` logs
ORCH_PLAN_UNKNOWN and returns, and the dispatcher builds its ok:true outcome from "the handler
did not throw" (src/bot/orchestrator/index.ts + src/shared/kernel/capability.ts). So the ack is
not evidence, and `plan_witness` goes to the worker journal for a real answer.

The property worth pinning is the STALE one: the journal is append-only, so a STARTED left over
from the PREVIOUS lap sits in the same file as this lap's failure. Reporting it would be worse
than reporting nothing — it is a confident "the plan is running" over a bot that is standing
still, which is the exact class of mistake the whole change is about. The byte offset taken
before plan_start is what makes the read honest, so the neg-controls here are: an old STARTED
must NOT vouch for this lap, and an unreadable journal must degrade to `no-evidence` rather than
to a verdict.

The read is also BOUNDED, and that is tested as a property rather than trusted: the witness used
to call `get_logs`, which main.js implements as `Files.readAllLines()` + slice — the whole
day-long journal, read on the game's thread, twice per lap. `journal_since` seeks to the
remembered offset instead, so `BoundedReadTests` MEASURES what a read consumes out of a
deliberately huge fixture — both the bytes handed back and how far the handle travelled, the
second because a rewrite to plain `for ln in fh` would be invisible to the first — and every
budget is paired with a case proving the fixture and the spy can see a full read.

The mark is `(inode, offset)`, not an offset alone: after a rotation into a LARGER file the bare
number still passes a size check and the seek lands mid-line, so the reader can hand back a
fragment. Both directions are covered — a rotation re-windows loudly, an ordinary append does not.

Finally, the two branches that can mislead an operator have to NAME THEIR SOURCE: a `no-evidence`
verdict (a readable-but-stale journal errors nowhere and reports nothing all day) and a re-windowed
read (which can produce a confident STARTED out of the previous journal's last lines) both print
the file and its age. Paired with a control that a healthy STARTED stays a one-liner — a diagnosis
printed every lap is one nobody reads.

Everything drives real files under a temp dir (`worker_journal()` is repointed) — no bridge, no
game, no launcher instance.

Stdlib-only (unittest):
    python3 -m unittest discover -s scripts/tests -t scripts/tests -v
"""
from __future__ import annotations

import contextlib
import io
import json
import os
import shutil
import sys
import tempfile
import time
import unittest
from pathlib import Path
from typing import IO
from unittest import mock

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "scripts" / "demo"))  # sustain_live

import sustain_live as sl  # noqa: E402  — import is side-effect free (constants + defs only)


def line(event: str, n: int = 0) -> str:
    return f'{{"tick": {n}, "lvl": "INFO", "event": "{event}"}}'


class JournalTestCase(unittest.TestCase):
    """A real NDJSON journal on disk, with `worker_journal()` pointed at it."""

    def setUp(self) -> None:
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, True)
        self.journal = self.dir / "miner.ndjson"
        # worker_journal() is the accessor everything routes through (it resolves the instances
        # root via scripts/local_config.py), so the fixture replaces THAT rather than a constant.
        patch = mock.patch.object(sl, "worker_journal", lambda: self.journal)
        patch.start()
        self.addCleanup(patch.stop)

    def append(self, *lines: str) -> None:
        with self.journal.open("a", encoding="utf-8") as fh:
            for ln in lines:
                fh.write(ln + "\n")

    def witness(self, mark: tuple[int, int] | None) -> str:
        with contextlib.redirect_stdout(io.StringIO()):
            return sl.plan_witness(mark)


class PlanWitnessTests(JournalTestCase):
    def test_a_fresh_ORCH_PLAN_START_is_the_verdict(self) -> None:
        self.append(line("TICK", 1))
        mark = sl.journal_mark()
        self.append(line("ORCH_PLAN_START", 2))
        self.assertEqual(self.witness(mark), "STARTED")

    def test_a_fresh_ORCH_PLAN_UNKNOWN_is_reported_as_such(self) -> None:
        self.append(line("TICK", 1))
        mark = sl.journal_mark()
        self.append(line("ORCH_PLAN_UNKNOWN", 2))
        self.assertEqual(self.witness(mark), "UNKNOWN_PLAN")

    def test_a_PREVIOUS_lap_s_START_does_not_vouch_for_this_one(self) -> None:  # NEG-CONTROL
        # The killer case: last lap really did start, this one was refused. Everything before
        # the mark is history and must be ignored.
        self.append(line("ORCH_PLAN_START", 1), line("MISSION_DONE", 2))
        mark = sl.journal_mark()
        self.append(line("ORCH_PLAN_UNKNOWN", 3))
        self.assertEqual(self.witness(mark), "UNKNOWN_PLAN")

    def test_an_old_START_with_NOTHING_new_reads_as_no_evidence(self) -> None:  # NEG-CONTROL
        # "The worker logged nothing this lap" is a real outcome. It must not be answered with
        # the previous lap's success.
        self.append(line("ORCH_PLAN_START", 1))
        self.assertEqual(self.witness(sl.journal_mark()), "no-evidence")

    def test_a_no_evidence_verdict_NAMES_the_file_it_read_and_its_age(self) -> None:
        # The nastiest shape is a READABLE but stale journal: nothing errors, so every lap says
        # no-evidence all day while a live worker writes somewhere else entirely. The verdict has
        # to carry its own source — which file, how old — or it is unfalsifiable by the operator.
        self.append(line("ORCH_PLAN_START", 1))
        mark = sl.journal_mark()
        old = time.time() - 3600
        os.utime(self.journal, (old, old))

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(sl.plan_witness(mark), "no-evidence")
        out = buf.getvalue()
        self.assertIn(str(self.journal), out, "the verdict must name the file it read")
        self.assertIn("last written", out)
        self.assertRegex(out, r"last written 3[56]\d\ds ago")  # ~3600s, not "0s"

    def test_a_STARTED_verdict_stays_a_ONE_LINER(self) -> None:
        # The paired control: the diagnosis rides ONLY on the branch that found nothing. A shoot
        # log that prints a path and an mtime on every healthy lap trains the reader to skip it.
        mark = sl.journal_mark()
        self.append(line("ORCH_PLAN_START", 2))
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(sl.plan_witness(mark), "STARTED")
        self.assertEqual(buf.getvalue().strip(), "[lap] plan witness: STARTED")

    def test_a_re_windowed_read_also_names_the_file(self) -> None:
        # A rotation/truncation re-windows to the tail, and that window can hold the PREVIOUS
        # journal's last lines — i.e. it can produce a confident STARTED. The notice must say
        # which file that verdict came out of.
        self.append(line("SHORT", 1))
        stale = sl.journal_mark()
        assert stale is not None
        self.journal.write_text(line("ORCH_PLAN_START", 9) + "\n", encoding="utf-8")

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            self.assertEqual(sl.plan_witness((stale[0], stale[1] + 10_000)), "STARTED")
        out = buf.getvalue()
        self.assertIn("truncated under the mark", out)
        self.assertIn(str(self.journal), out)
        self.assertIn("last written", out)

    def test_the_path_note_survives_an_unresolvable_instance_dir(self) -> None:  # NEG-CONTROL
        # worker_journal() returns None when local_config cannot find an instances root. The note
        # is the last thing that still has to work then — it must say what to set, not crash.
        with mock.patch.object(sl, "worker_journal", lambda: None):
            note = sl.journal_path_note()
        self.assertIn("MC_WORKER_JOURNAL", note)

    def test_the_LAST_of_the_two_codes_wins(self) -> None:
        # A retry within one lap: the failed attempt precedes the good one in the same window.
        mark = sl.journal_mark()
        self.append(line("ORCH_PLAN_UNKNOWN", 2), line("ORCH_PLAN_START", 3))
        self.assertEqual(self.witness(mark), "STARTED")

    def test_a_MISSING_journal_is_no_evidence_not_a_verdict(self) -> None:  # NEG-CONTROL
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertIsNone(sl.journal_mark())      # nothing to mark either
        self.assertEqual(self.witness(None), "no-evidence")

    def test_an_UNREADABLE_journal_is_no_evidence_not_a_crash(self) -> None:  # NEG-CONTROL
        # A lap must survive a permission/IO fault: a probe that sank the take it was added to
        # explain would be a net loss.
        self.append(line("ORCH_PLAN_START", 1))
        with mock.patch.object(Path, "open", side_effect=OSError("boom")):
            self.assertEqual(self.witness((1, 0)), "no-evidence")

    def test_no_mark_at_all_falls_back_to_the_recent_tail(self) -> None:
        # journal_mark() returning None BEFORE plan_start (the file was not there yet) must not
        # crash the lap — it degrades to "look at the recent tail", never to an exception.
        self.append(line("ORCH_PLAN_UNKNOWN", 4))
        self.assertEqual(self.witness(None), "UNKNOWN_PLAN")

    def test_a_TRUNCATED_journal_re_windows_instead_of_reading_nothing(self) -> None:
        # A cleared journal leaves the mark past EOF. Seeking there would read zero bytes for the
        # rest of the shoot — every lap "no-evidence" while the bot works fine.
        self.append(*(line("FILLER", i) for i in range(50)))
        stale = sl.journal_mark()
        assert stale is not None
        self.journal.write_text(line("ORCH_PLAN_START", 9) + "\n", encoding="utf-8")
        self.assertEqual(stale[0], self.journal.stat().st_ino, "write_text must reuse the inode")
        self.assertGreater(stale[1], self.journal.stat().st_size, "fixture must shrink the file")

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            verdict = sl.plan_witness(stale)
        self.assertEqual(verdict, "STARTED")
        self.assertIn("truncated under the mark", buf.getvalue())  # never silent

    def test_a_ROTATED_journal_never_seeks_into_the_middle_of_a_line(self) -> None:
        # Rotation into a BIGGER file is the case an offset alone cannot see: the stale offset
        # is still < size, so the size check passes and the seek lands mid-line, handing back a
        # FRAGMENT — which a substring match can read as evidence about a lap that never ran.
        # The inode is what catches it; the read then starts at a window boundary, whole lines.
        self.append(line("SHORT", 1))
        stale = sl.journal_mark()
        assert stale is not None

        rotated = self.dir / "rotated.ndjson"       # a genuinely different file, then renamed in
        rotated.write_text("".join(line("HISTORY", i) + "\n" for i in range(3)), encoding="utf-8")
        rotated.replace(self.journal)
        st = self.journal.stat()
        self.assertNotEqual(stale[0], st.st_ino, "fixture must change the inode")
        self.assertLess(stale[1], st.st_size, "fixture must rotate into a LARGER file")

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            fresh = sl.journal_since(stale)
        self.assertIsNotNone(fresh)
        assert fresh is not None
        # Checked FIRST because it is the actual defect: seeking to the stale offset cuts the
        # new file's first line in half, so this list would start with a JSON fragment.
        for ln in fresh:
            json.loads(ln)
        self.assertEqual(len(fresh), 3, "the whole (small) rotated file is the window")
        self.assertIn("rotated (inode", buf.getvalue())     # ... and never silent about it

    def test_the_SAME_file_growing_is_not_mistaken_for_a_rotation(self) -> None:
        # The other half of the inode check: an ordinary append must take the exact-offset path,
        # with no notice and no re-window (which would drag in the previous lap's lines).
        self.append(line("ORCH_PLAN_START", 1))
        mark = sl.journal_mark()
        self.append(line("ORCH_PLAN_UNKNOWN", 2))

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            fresh = sl.journal_since(mark)
        self.assertEqual(fresh, [line("ORCH_PLAN_UNKNOWN", 2)])
        self.assertEqual(buf.getvalue(), "", "an ordinary append must print no anomaly")


class BoundedReadTests(JournalTestCase):
    """The read must stay bounded — the whole reason it moved off `get_logs`."""

    BIG = 400_000  # bytes of history: >> JOURNAL_TAIL_BYTES, so a full read is measurable

    def fill(self) -> None:
        pad = line("FILLER")
        with self.journal.open("a", encoding="utf-8") as fh:
            written = 0
            while written < self.BIG:
                fh.write(pad + "\n")
                written += len(pad) + 1

    @staticmethod
    @contextlib.contextmanager
    def counting_reads():  # type: ignore[no-untyped-def]
        """Measure how much of the file a block actually consumed.

        Two independent numbers, because one is not enough:
          `bytes`     — handed back by read/readline/readlines (a rewrite to any of those is
                        still counted);
          `traversed` — final tell() minus the last seek(), which catches the forms the wrappers
                        cannot see (`for ln in fh`, `fh.seek(0)` then iterate) because iterating
                        still advances the handle.

        Patches `io.open`, NOT `builtins.open`: `Path.open` (what journal_since calls) resolves
        the module attribute `io.open`, so a builtins-only patch would count nothing and every
        budget below would pass vacuously. `test_the_FIXTURE_can_tell_a_full_read_apart` is what
        holds that wiring honest.
        """
        seen = {"bytes": 0, "seek": 0, "end": 0}
        real_open = io.open

        def spy(*args, **kwargs):  # type: ignore[no-untyped-def]
            fh: IO = real_open(*args, **kwargs)
            real = {name: getattr(fh, name) for name in ("read", "readline", "readlines",
                                                         "seek", "close")}

            def counted(name):  # type: ignore[no-untyped-def]
                def call(*a, **k):  # type: ignore[no-untyped-def]
                    out = real[name](*a, **k)
                    seen["bytes"] += sum(map(len, out)) if name == "readlines" else len(out)
                    return out
                return call

            def seek(*a, **k):  # type: ignore[no-untyped-def]
                pos = real["seek"](*a, **k)
                seen["seek"] = pos
                return pos

            def close(*a, **k):  # type: ignore[no-untyped-def]
                seen["end"] = real["seek"](0, io.SEEK_CUR)   # where the handle ended up
                return real["close"](*a, **k)

            for name in ("read", "readline", "readlines"):
                setattr(fh, name, counted(name))
            fh.seek = seek      # type: ignore[method-assign]
            fh.close = close    # type: ignore[method-assign]
            return fh

        with mock.patch.object(io, "open", spy):
            yield seen

    def test_only_the_NEW_bytes_are_read_past_a_mark(self) -> None:
        self.fill()
        mark = sl.journal_mark()
        assert mark is not None
        self.append(line("ORCH_PLAN_START", 7))

        with self.counting_reads() as seen:
            fresh = sl.journal_since(mark)

        self.assertEqual(fresh, [line("ORCH_PLAN_START", 7)])  # exactly this lap, nothing else
        self.assertLess(seen["bytes"], 1024,
                        "the witness read the history it already had a mark for")
        self.assertLess(seen["end"] - seen["seek"], 1024,
                        "the handle walked further than the bytes it returned")

    def test_a_MARKLESS_read_is_still_capped_at_the_tail_window(self) -> None:
        # The fallback path is the one that could quietly become a full read again.
        self.fill()
        with self.counting_reads() as seen:
            fresh = sl.journal_since(None)

        self.assertIsNotNone(fresh)
        self.assertLessEqual(seen["bytes"], sl.JOURNAL_TAIL_BYTES)
        self.assertLessEqual(seen["end"] - seen["seek"], sl.JOURNAL_TAIL_BYTES)

    def test_the_FIXTURE_can_tell_a_full_read_apart(self) -> None:  # NEG-CONTROL
        # Guards the two cases above from passing vacuously: if the journal were small, or the
        # spy blind, "read < 1 KiB" would be true of a reader that slurped the file. A reader
        # that does slurp it (this one) trips both budgets on the SAME fixture.
        self.fill()
        with self.counting_reads() as seen:
            slurped = self.journal.read_bytes()

        self.assertGreater(len(slurped), sl.JOURNAL_TAIL_BYTES, "fixture too small to falsify")
        self.assertGreater(seen["bytes"], sl.JOURNAL_TAIL_BYTES, "the spy must see a full read")
        self.assertGreater(seen["end"] - seen["seek"], sl.JOURNAL_TAIL_BYTES,
                           "the traversal budget must see a full read too")

    def test_the_TRAVERSAL_budget_catches_an_ITERATING_reader(self) -> None:  # NEG-CONTROL
        # The traversal budget is what a rewrite to plain iteration must not sail past: even
        # when `for ln in fh` slips by the byte counters, tell() still moved. Whether the byte
        # counters see iteration AT ALL is interpreter-dependent: CPython 3.12.13 (the dev
        # shell) routes IOBase.__next__ through the instance's `readline`, so the spy counts
        # every byte; other builds this suite has run under counted 0 (the assert
        # `bytes == 0` started failing on an unchanged tree). Only the budget that holds on
        # every interpreter is asserted hard; `bytes` may be all-or-nothing but never partial.
        self.fill()
        with self.counting_reads() as seen:
            with self.journal.open("rb") as fh:
                consumed = sum(len(ln) for ln in fh)

        self.assertGreater(consumed, sl.JOURNAL_TAIL_BYTES)
        self.assertIn(seen["bytes"], (0, consumed),
                      "the byte spy saw a PARTIAL read — neither invisible nor a full count")
        self.assertGreater(seen["end"] - seen["seek"], sl.JOURNAL_TAIL_BYTES)


if __name__ == "__main__":
    unittest.main()
