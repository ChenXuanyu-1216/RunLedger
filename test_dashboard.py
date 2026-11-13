import hashlib
import json
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

import runledger as rl
import runledger_dashboard as dash

HOSTILE = '<script>alert("x")</script><img src=x onerror=alert(1)> & [click](javascript:alert(2))'
LONG_COMMAND = ('"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command '
                "\"Get-ChildItem -Recurse -File 'D:\\我的项目\\RunLedger' | Select-String -Pattern "
                "'completeRun|finishRun|recordUsage' | ForEach-Object { $_.Path + ':' + $_.LineNumber }\"")


def make_fixture(path):
    """Create a demo database (never the real history) covering the dashboard's edge cases."""
    if Path(path).exists():
        raise FileExistsError(f"{path} already exists; fixtures are only written to a new file.")
    db = rl.connect(Path(path))
    rows = [
        ("2026-11-12 16:39:20", r"D:\我的项目\RunLedger", "Explain how runs are finalized.", None,
         "read-only", "failed", "019a-thread-one", "",
         "You've hit your usage limit. Visit https://chatgpt.com/settings/usage to check it.",
         [{"command": LONG_COMMAND, "exit_code": 0}], {"added": [], "removed": [], "modified": []}, None),
        ("2026-11-13 05:06:04", r"D:\我的项目\RunLedger", "Which file starts this app? Cite the path.", None,
         "read-only", "completed", "019a-thread-two",
         "The entry point is [runledger.py](D:\\我的项目\\RunLedger\\runledger.py:168).\n\n"
         "## How it starts\n\n1. `main()` parses arguments.\n2. It opens **SQLite**.\n   - nested detail\n\n"
         "```powershell\npython runledger.py show 2\n```\n\nSee https://example.com/docs for more.",
         "", [{"command": "git status --short", "exit_code": 0},
              {"command": "python -m unittest -v", "exit_code": 1}, {"command": LONG_COMMAND, "exit_code": None}],
         {"added": ["docs/new.md"], "removed": ["old.txt"], "modified": [r"src\very\long\path\module.py"]},
         {"input_tokens": 66803, "cached_input_tokens": 54656, "cache_write_input_tokens": 0,
          "output_tokens": 512, "reasoning_output_tokens": 6}),
        ("2026-11-13 05:07:55", r"D:\我的项目\RunLedger", "Which test would you run first, and why?", 2,
         "read-only", "completed", "019a-thread-two", "Run `test_run_resume_and_retrieve_evidence` first.",
         "", [], {"added": [], "removed": [], "modified": []}, {"input_tokens": 92701, "output_tokens": 649}),
        ("2026-11-13 06:00:00", "/home/me/web-app", HOSTILE, None, "workspace-write", "completed",
         "019a-thread-four", HOSTILE + "\n\n- [ok](https://example.com)\n- [bad](data:text/html,hi)",
         "", [{"command": "echo '<b>bold</b>'", "exit_code": 0}], None, None),
    ]
    with db:
        for created, repo, prompt, parent, access, state, thread, answer, error, cmds, changes, usage in rows:
            db.execute("""INSERT INTO runs(created,repo,prompt,parent,access,state,thread,answer,error,
                                           commands,changes,usage) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""",
                       (created, repo, prompt, parent, access, state, thread, answer, error,
                        json.dumps(cmds), json.dumps(changes), json.dumps(usage)))
    db.close()


class DashboardTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.db_path = self.base / "fixture.db"

    def serve(self, db_path):
        server = dash.make_server(db_path, "127.0.0.1", 0)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server.server_address[1]

    def fetch(self, port, path, headers=None, method="GET"):
        req = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers=headers or {}, method=method)
        try:
            with urllib.request.urlopen(req, timeout=5) as res:
                return res.status, dict(res.headers), res.read()
        except urllib.error.HTTPError as err:
            return err.code, dict(err.headers), err.read()

    def get_json(self, port, path):
        code, headers, body = self.fetch(port, path)
        self.assertEqual(headers["Content-Type"], "application/json; charset=utf-8")
        return code, json.loads(body)

    def test_missing_database_is_reported_and_not_created(self):
        port = self.serve(self.db_path)
        code, status = self.get_json(port, "/api/status")
        self.assertEqual((code, status["ready"], status["error"]), (200, False, "missing_database"))
        code, body = self.get_json(port, "/api/runs")
        self.assertEqual((code, body["error"]), (503, "missing_database"))
        code, body = self.get_json(port, "/api/runs/1")
        self.assertEqual((code, body["error"]), (503, "missing_database"))
        self.assertFalse(self.db_path.exists())
        self.assertEqual(self.fetch(port, "/")[0], 200)  # The page still loads to show setup steps.

    def test_database_without_runs_table(self):
        import sqlite3
        sqlite3.connect(self.db_path).close()
        port = self.serve(self.db_path)
        code, body = self.get_json(port, "/api/runs")
        self.assertEqual((code, body["error"]), (503, "missing_table"))

    def test_list_search_filter_and_pagination(self):
        make_fixture(self.db_path)
        port = self.serve(self.db_path)
        _, page = self.get_json(port, "/api/runs")
        self.assertEqual([r["id"] for r in page["runs"]], [4, 3, 2, 1])
        self.assertEqual(page["runs"][1]["parent"], 2)
        self.assertEqual(page["runs"][2]["repo_name"], "RunLedger")
        self.assertEqual(page["runs"][3]["created"], "2026-11-12 16:39:20")  # Stored value, unconverted.
        # Search covers prompts and answers (and repo paths, like `list --search`), case-insensitively.
        _, page = self.get_json(port, "/api/runs?q=WHICH+FILE")
        self.assertEqual([r["id"] for r in page["runs"]], [2])
        _, page = self.get_json(port, "/api/runs?q=retrieve_evidence")
        self.assertEqual([r["id"] for r in page["runs"]], [3])
        _, page = self.get_json(port, "/api/runs?q=web-app")
        self.assertEqual([r["id"] for r in page["runs"]], [4])
        _, page = self.get_json(port, "/api/runs?state=failed")
        self.assertEqual(([r["id"] for r in page["runs"]], page["total"]), ([1], 1))
        _, page = self.get_json(port, "/api/runs?state=completed&q=which")
        self.assertEqual([r["id"] for r in page["runs"]], [3, 2])
        _, page = self.get_json(port, "/api/runs?q=nothing-matches-this")
        self.assertEqual((page["runs"], page["total"], page["has_more"]), ([], 0, False))
        # Keyset pagination stays bounded and does not repeat rows.
        _, first = self.get_json(port, "/api/runs?limit=3")
        self.assertEqual(([r["id"] for r in first["runs"]], first["has_more"], first["total"]), ([4, 3, 2], True, 4))
        _, second = self.get_json(port, f"/api/runs?limit=3&before={first['next_before']}")
        self.assertEqual(([r["id"] for r in second["runs"]], second["has_more"]), ([1], False))
        for bad in ("limit=0", "limit=999", "limit=abc", "before=-1"):
            self.assertEqual(self.get_json(port, "/api/runs?" + bad)[0], 400)
        _, status = self.get_json(port, "/api/status")
        self.assertEqual((status["total"], status["states"]), (4, {"completed": 3, "failed": 1}))

    def test_detail_matches_show_output_and_links_runs(self):
        make_fixture(self.db_path)
        port = self.serve(self.db_path)
        code, body = self.get_json(port, "/api/runs/2")
        self.assertEqual(code, 200)
        db = rl.connect(self.db_path)
        self.addCleanup(db.close)
        self.assertEqual(body["run"], rl.get(db, 2))  # Same record `runledger.py show 2` prints.
        self.assertEqual(body["children"], [3])
        self.assertEqual(body["run"]["commands"][1]["exit_code"], 1)
        self.assertIsNone(body["run"]["commands"][2]["exit_code"])
        _, child = self.get_json(port, "/api/runs/3")
        self.assertEqual((child["run"]["parent"], child["parent_exists"]), (2, True))
        _, failed = self.get_json(port, "/api/runs/1")
        self.assertIsNone(failed["run"]["usage"])
        self.assertEqual(failed["run"]["answer"], "")
        code, missing = self.get_json(port, "/api/runs/999")
        self.assertEqual((code, missing["error"]), (404, "not_found"))
        self.assertEqual(self.fetch(port, "/api/runs/abc")[0], 404)

    def test_corrupt_json_fields_are_returned_as_text(self):
        make_fixture(self.db_path)
        db = rl.connect(self.db_path)
        with db:
            db.execute("UPDATE runs SET usage='{not json' WHERE id=1")
        db.close()
        port = self.serve(self.db_path)
        code, body = self.get_json(port, "/api/runs/1")
        self.assertEqual((code, body["run"]["usage"]), (200, "{not json"))

    def test_stored_html_is_inert_json(self):
        make_fixture(self.db_path)
        port = self.serve(self.db_path)
        code, headers, raw = self.fetch(port, "/api/runs/4")
        self.assertEqual(code, 200)
        self.assertNotIn(b"<script", raw)
        self.assertNotIn(b"<img", raw)
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        body = json.loads(raw)
        self.assertEqual(body["run"]["prompt"], HOSTILE)  # Content is preserved exactly.
        _, page = self.get_json(port, "/api/runs?q=onerror")
        self.assertEqual([r["id"] for r in page["runs"]], [4])
        code, headers, html = self.fetch(port, "/")
        self.assertIn("script-src 'self'", headers["Content-Security-Policy"])
        self.assertNotIn("unsafe-inline", headers["Content-Security-Policy"])
        self.assertIn(b"/app.js", html)

    def test_read_only_server_rejects_writes_hosts_and_unknown_paths(self):
        make_fixture(self.db_path)
        digest = hashlib.sha256(self.db_path.read_bytes()).hexdigest()
        port = self.serve(self.db_path)
        for path in ("/api/status", "/api/runs?q=x", "/api/runs/1", "/api/runs/999"):
            self.fetch(port, path)
        self.assertEqual(self.fetch(port, "/api/runs/1", method="POST")[0], 405)
        self.assertEqual(self.fetch(port, "/api/runs/1", method="DELETE")[0], 405)
        self.assertEqual(self.fetch(port, "/api/runs", headers={"Host": "evil.example"})[0], 421)
        for path in ("/../runledger.py", "/dashboard/app.js", "/%2e%2e/runledger.py", "/runledger.py"):
            self.assertEqual(self.fetch(port, path)[0], 404, path)
        self.assertEqual(self.fetch(port, "/app.js")[1]["Content-Type"], "text/javascript; charset=utf-8")
        self.assertEqual(hashlib.sha256(self.db_path.read_bytes()).hexdigest(), digest)
        self.assertEqual(sorted(p.name for p in self.base.iterdir()), ["fixture.db"])

    def test_cli_dashboard_command_does_not_create_database(self):
        from unittest import mock
        missing = self.base / "nested" / "runs.db"
        for argv in (["--db", str(missing), "dashboard", "--no-browser"],
                     ["dashboard", "--db", str(missing), "--port", "9000", "--no-browser"]):
            with mock.patch("sys.argv", ["runledger.py", *argv]), \
                    mock.patch.object(dash, "serve", return_value=0) as serve:
                self.assertEqual(rl.main(), 0)
            self.assertEqual(serve.call_args.args[0], missing)
            self.assertFalse(serve.call_args.args[3])
        self.assertEqual(serve.call_args.args[2], 9000)
        self.assertFalse(missing.parent.exists())


if __name__ == "__main__":
    unittest.main()
