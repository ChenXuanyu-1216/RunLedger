import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import runledger as rl


class RunTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.repo = self.base / "project"
        subprocess.run(["git", "init", "-q", self.repo], check=True)
        self.db = rl.connect(self.base / "history.db")
        self.addCleanup(self.db.close)
        self.fake = self.base / "fixture.py"
        self.bin = [sys.executable, str(self.fake)]

    def fixture(self, events, extra=""):
        self.fake.write_text("import pathlib, sys\nsys.stdin.read()\n" + extra + "\n" +
                             "\n".join("print(" + repr(json.dumps(e)) + ")" for e in events),
                             encoding="utf-8")

    def test_run_resume_and_retrieve_evidence(self):
        (self.repo / "old.txt").write_text("already dirty")
        self.fixture([
            {"type":"thread.started","thread_id":"test-thread"},
            {"type":"item.completed","item":{"type":"command_execution","command":"pytest","exit_code":1}},
            {"type":"item.completed","item":{"type":"agent_message","text":"Tests passed"}},
            {"type":"turn.completed","usage":{"input_tokens":5}}],
            "pathlib.Path('new.txt').write_text('new')")
        rid = rl.execute(self.db, self.repo, "Review", self.bin)
        result = rl.get(self.db, rid)
        self.assertEqual(result["state"], "completed")
        self.assertEqual(result["changes"], {"added":["new.txt"],"modified":[],"removed":[]})
        self.assertEqual(result["commands"][0]["exit_code"], 1)
        self.fixture([{"type":"item.completed","item":{"type":"agent_message","text":"Follow-up"}},
                      {"type":"turn.completed"}],
                     "assert 'resume' in sys.argv and 'test-thread' in sys.argv")
        child = rl.execute(self.db, self.repo, "Why?", self.bin, parent=rid)
        self.assertEqual(rl.get(self.db, child)["parent"], rid)

    def test_partial_text_is_not_a_completed_answer(self):
        self.fixture([{"type":"item.completed","item":{"type":"agent_message","text":"Almost done"}}])
        rid = rl.execute(self.db, self.repo, "Review", self.bin)
        self.assertEqual(rl.get(self.db, rid)["state"], "failed")
        self.assertFalse(rl.get(self.db, rid)["answer"])

    def test_existing_dirty_file_changed_again(self):
        (self.repo / "old.txt").write_text("before")
        self.fixture([{"type":"item.completed","item":{"type":"agent_message","text":"done"}},
                      {"type":"turn.completed"}], "pathlib.Path('old.txt').write_text('after')")
        rid = rl.execute(self.db, self.repo, "Edit", self.bin)
        self.assertEqual(rl.get(self.db, rid)["changes"]["modified"], ["old.txt"])
