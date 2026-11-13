"""Read-only local web dashboard for browsing RunLedger history.

Start it through the CLI: ``python runledger.py dashboard`` (see README.md).
The server opens the SQLite database in read-only mode for every request and
never creates, migrates, or modifies run records.
"""
import json
import re
import socket
import sqlite3
import sys
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

import runledger

STATIC_DIR = Path(__file__).resolve().with_name("dashboard")
STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/index.html": ("index.html", "text/html; charset=utf-8"),
    "/app.js": ("app.js", "text/javascript; charset=utf-8"),
    "/styles.css": ("styles.css", "text/css; charset=utf-8"),
}
DEFAULT_LIMIT = 50
MAX_LIMIT = 200
MAX_QUERY = 500
PREVIEW_CHARS = 160
SECURITY_HEADERS = {
    "Content-Security-Policy": (
        "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
        "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Cache-Control": "no-store",
}


class DashboardError(Exception):
    """An API failure with an HTTP status and a stable machine-readable code."""

    def __init__(self, status, code, message):
        super().__init__(message)
        self.status, self.code, self.message = status, code, message


def resolve_db_path(path):
    return Path(path).expanduser().resolve()


def open_readonly(path):
    """Open an existing RunLedger database without the ability to write to it."""
    path = resolve_db_path(path)
    if not path.is_file():
        raise DashboardError(503, "missing_database", f"No RunLedger database exists at {path}.")
    try:
        db = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True, timeout=5)
    except sqlite3.Error as exc:
        raise DashboardError(500, "database_error", f"Cannot open {path}: {exc}") from exc
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA query_only = ON")
        table = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='runs'").fetchone()
    except sqlite3.Error as exc:
        db.close()
        raise DashboardError(500, "database_error", f"Cannot read {path}: {exc}") from exc
    if table is None:
        db.close()
        raise DashboardError(503, "missing_table",
                             f"{path} exists but has no RunLedger runs table yet.")
    return db


def repo_name(repo):
    parts = [p for p in re.split(r"[\\/]+", repo or "") if p]
    return parts[-1] if parts else (repo or "")


def preview(text, limit=PREVIEW_CHARS):
    flat = " ".join((text or "").split())
    return flat if len(flat) <= limit else flat[:limit - 1].rstrip() + "…"


def _filters(query="", state=""):
    where, params = [], []
    if query:
        # Same matching rule as `runledger.py list --search`: prompt, answer and repository.
        where.append("instr(lower(coalesce(prompt,'') || ' ' || coalesce(answer,'') || ' ' || "
                     "coalesce(repo,'')), lower(?)) > 0")
        params.append(query)
    if state:
        where.append("state = ?")
        params.append(state)
    return where, params


def list_runs(db, query="", state="", limit=DEFAULT_LIMIT, before=None):
    """Return one page of run summaries, newest first, using keyset pagination."""
    where, params = _filters(query, state)
    total = db.execute("SELECT count(*) FROM runs" + (" WHERE " + " AND ".join(where) if where else ""),
                       params).fetchone()[0]
    if before is not None:
        where.append("id < ?")
        params.append(before)
    clause = " WHERE " + " AND ".join(where) if where else ""
    rows = db.execute(f"""SELECT id, created, repo, prompt, parent, state, thread,
                                 length(coalesce(error, '')) > 0 AS has_error
                          FROM runs{clause} ORDER BY id DESC LIMIT ?""",
                      [*params, limit + 1]).fetchall()
    more = len(rows) > limit
    runs = [{
        "id": row["id"], "created": row["created"], "repo": row["repo"],
        "repo_name": repo_name(row["repo"]), "preview": preview(row["prompt"]),
        "parent": row["parent"], "state": row["state"], "has_error": bool(row["has_error"]),
    } for row in rows[:limit]]
    return {"runs": runs, "total": total, "has_more": more,
            "next_before": runs[-1]["id"] if more and runs else None}


def _decode_tolerant(row):
    data = dict(row)
    for field in ("commands", "changes", "usage"):
        raw = data.get(field)
        if isinstance(raw, str):
            try:
                data[field] = json.loads(raw)
            except ValueError:
                data[field] = raw  # Keep unreadable stored JSON visible as text.
    return data


def get_run(db, rid):
    """Return the same record `runledger.py show` prints, plus navigation metadata."""
    try:
        run = runledger.get(db, rid)
    except json.JSONDecodeError:
        run = _decode_tolerant(db.execute("SELECT * FROM runs WHERE id=?", (rid,)).fetchone())
    except ValueError:
        raise DashboardError(404, "not_found", f"Run {rid} does not exist in this database.")
    children = [r[0] for r in db.execute("SELECT id FROM runs WHERE parent=? ORDER BY id", (rid,))]
    parent_exists = None
    if run.get("parent") is not None:
        parent_exists = db.execute("SELECT 1 FROM runs WHERE id=?", (run["parent"],)).fetchone() is not None
    return {"run": run, "children": children, "parent_exists": parent_exists,
            "repo_name": repo_name(run.get("repo"))}


def status(path):
    path = resolve_db_path(path)
    info = {"database": str(path), "ready": False, "total": 0, "states": {}}
    try:
        db = open_readonly(path)
    except DashboardError as exc:
        info.update(error=exc.code, message=exc.message)
        return info
    try:
        rows = db.execute("SELECT coalesce(state, 'unknown'), count(*) FROM runs GROUP BY 1 ORDER BY 1")
        info["states"] = {state: count for state, count in rows}
        info["total"] = sum(info["states"].values())
        info["ready"] = True
    finally:
        db.close()
    return info


def _int_param(params, name, default, low, high):
    raw = params.get(name, [""])[0]
    if raw == "":
        return default
    if not re.fullmatch(r"\d{1,18}", raw) or not low <= int(raw) <= high:
        raise DashboardError(400, "bad_request", f"{name} must be an integer from {low} to {high}.")
    return int(raw)


class DashboardServer(ThreadingHTTPServer):
    daemon_threads = True
    # On Windows SO_REUSEADDR lets a second server silently share a busy port.
    allow_reuse_address = sys.platform != "win32"

    def __init__(self, address, db_path, verbose=False):
        if ":" in address[0]:
            self.address_family = socket.AF_INET6
        self.db_path = resolve_db_path(db_path)
        self.verbose = verbose
        super().__init__(address, DashboardHandler)
        host = address[0]
        port = self.server_address[1]
        loopback = host in ("127.0.0.1", "localhost", "::1")
        self.allowed_hosts = None if not loopback else {
            f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}

    @property
    def url(self):
        host = self.server_address[0]
        host = f"[{host}]" if ":" in host else host
        return f"http://{host}:{self.server_address[1]}/"


class DashboardHandler(BaseHTTPRequestHandler):
    server_version = "RunLedgerDashboard"
    sys_version = ""

    def log_message(self, format, *args):  # noqa: A002 - signature from the base class
        if self.server.verbose:
            super().log_message(format, *args)

    def do_GET(self):
        self._dispatch(send_body=True)

    def do_HEAD(self):
        self._dispatch(send_body=False)

    def _not_allowed(self):
        self._send_json(405, {"error": "method_not_allowed",
                              "message": "The dashboard is read-only."}, extra={"Allow": "GET, HEAD"})

    do_POST = do_PUT = do_PATCH = do_DELETE = _not_allowed

    def _dispatch(self, send_body):
        self._send_body = send_body
        allowed = self.server.allowed_hosts
        if allowed is not None and (self.headers.get("Host") or "").lower() not in allowed:
            # Rejects DNS-rebinding pages that resolve their own name to 127.0.0.1.
            return self._send_json(421, {"error": "bad_host", "message": "Unexpected Host header."})
        url = urlsplit(self.path)
        try:
            if url.path in STATIC_FILES:
                return self._send_static(*STATIC_FILES[url.path])
            if url.path == "/api/status":
                return self._send_json(200, status(self.server.db_path))
            if url.path == "/api/runs":
                return self._send_json(200, self._runs(parse_qs(url.query)))
            match = re.fullmatch(r"/api/runs/(\d{1,18})", url.path)
            if match:
                return self._send_json(200, self._with_db(lambda db: get_run(db, int(match.group(1)))))
            raise DashboardError(404, "not_found", "No such page.")
        except DashboardError as exc:
            self._send_json(exc.status, {"error": exc.code, "message": exc.message,
                                         "database": str(self.server.db_path)})
        except sqlite3.Error as exc:
            self._send_json(500, {"error": "database_error", "message": f"Database error: {exc}"})

    def _with_db(self, action):
        db = open_readonly(self.server.db_path)
        try:
            return action(db)
        finally:
            db.close()

    def _runs(self, params):
        query = params.get("q", [""])[0].strip()
        state = params.get("state", [""])[0].strip()
        if len(query) > MAX_QUERY or len(state) > 64:
            raise DashboardError(400, "bad_request", "Search text is too long.")
        limit = _int_param(params, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT)
        before = _int_param(params, "before", None, 1, 10 ** 18)
        return self._with_db(lambda db: list_runs(db, query, state, limit, before))

    def _send_static(self, name, content_type):
        try:
            body = (STATIC_DIR / name).read_bytes()
        except OSError:
            raise DashboardError(500, "missing_asset", f"Dashboard file {name} is missing.")
        self._send(200, body, content_type)

    def _send_json(self, code, payload, extra=None):
        # Escaping "<" keeps stored HTML-like text inert even if the JSON is misinterpreted.
        text = json.dumps(payload, ensure_ascii=False).replace("<", "\\u003c")
        self._send(code, text.encode("utf-8"), "application/json; charset=utf-8", extra)

    def _send(self, code, body, content_type, extra=None):
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        for name, value in {**SECURITY_HEADERS, **(extra or {})}.items():
            self.send_header(name, value)
        self.end_headers()
        if getattr(self, "_send_body", True):
            self.wfile.write(body)


def make_server(db_path, host="127.0.0.1", port=8765, verbose=False):
    try:
        return DashboardServer((host, port), db_path, verbose)
    except OSError as exc:
        raise OSError(f"Cannot listen on {host}:{port} ({exc.strerror or exc}). "
                      "Choose another port with --port.") from exc


def serve(db_path, host="127.0.0.1", port=8765, open_browser=True, verbose=False):
    server = make_server(db_path, host, port, verbose)
    info = status(server.db_path)
    print(f"RunLedger dashboard: {server.url}")
    print(f"Database (read-only): {server.db_path}")
    if not info["ready"]:
        print(f"Note: {info['message']} The page will show setup steps.")
    if server.allowed_hosts is None:
        print("Warning: listening beyond this computer; anyone who can reach it can read your runs.")
    print("Press Ctrl+C to stop.", flush=True)
    if open_browser:
        try:
            webbrowser.open(server.url)
        except webbrowser.Error:
            pass
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        print("\nDashboard stopped.")
    finally:
        server.server_close()
    return 0
