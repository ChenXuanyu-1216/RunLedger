"""Local, searchable Codex runs with command outcomes and working-tree evidence."""
import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import subprocess
import sys
from pathlib import Path


def connect(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    db.row_factory = sqlite3.Row
    db.execute("""CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY, created TEXT DEFAULT CURRENT_TIMESTAMP,
        repo TEXT, prompt TEXT, parent INTEGER, access TEXT, state TEXT,
        thread TEXT, answer TEXT, error TEXT, commands TEXT DEFAULT '[]',
        changes TEXT, usage TEXT)""")
    return db


def get(db, rid):
    row = db.execute("SELECT * FROM runs WHERE id=?", (rid,)).fetchone()
    if row is None:
        raise ValueError(f"Unknown run {rid}")
    data = dict(row)
    for field in ("commands", "changes", "usage"):
        if data[field] is not None:
            data[field] = json.loads(data[field])
    return data


def snapshot(repo):
    paths = subprocess.check_output(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd=repo
    )
    result = {}
    for raw in set(paths.split(b"\0")) - {b""}:
        name = os.fsdecode(raw)
        path = repo / name
        if path.is_symlink():
            result[name] = ("link", os.readlink(path))
        elif path.is_file():
            digest = hashlib.sha256()
            with path.open("rb") as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            result[name] = ("file", digest.digest())
    return result


def delta(before, after):
    return {"added": sorted(after.keys() - before.keys()),
            "removed": sorted(before.keys() - after.keys()),
            "modified": sorted(k for k in before.keys() & after.keys() if before[k] != after[k])}


def execute(db, repo, prompt, program, parent=None, edit=False):
    repo = Path(repo).resolve()
    access = "workspace-write" if edit else "read-only"
    args = [*program, "exec"]
    thread = None
    if parent is not None:
        previous = get(db, parent)
        thread = previous["thread"]
        if not thread or not re.fullmatch(r"[A-Za-z0-9_-]+", thread) or thread.startswith("-"):
            raise ValueError("This run has no resumable thread.")
        repo = Path(previous["repo"])
        access = previous["access"]
        args.append("resume")
    args += ["--json", "-c", f'sandbox_mode="{access}"', "-c", 'approval_policy="never"']
    if thread:
        args.append(thread)
    args.append("-")  # All user text travels on stdin, including on Windows.
    before = snapshot(repo)
    with db:
        rid = db.execute("""INSERT INTO runs(repo,prompt,parent,access,state,thread)
                            VALUES(?,?,?,?,'running',?)""",
                         (str(repo), prompt, parent, access, thread)).lastrowid
    answer = ""
    commands = []
    usage = None
    changes = None
    error = ""
    complete = False
    try:
        proc = subprocess.run(args, input=prompt, cwd=repo, capture_output=True,
                              text=True, encoding="utf-8", errors="replace")
        for line in proc.stdout.splitlines():
            try:
                event = json.loads(line)
            except ValueError:
                continue
            if not isinstance(event, dict):
                continue
            kind = event.get("type")
            if kind == "thread.started":
                thread = event.get("thread_id") or thread
            elif kind == "item.completed":
                item = event.get("item") or {}
                if item.get("type") == "agent_message":
                    answer = item.get("text") or ""
                elif item.get("type") == "command_execution":
                    commands.append({"command": item.get("command"), "exit_code": item.get("exit_code")})
            elif kind == "turn.completed":
                complete = True
                usage = event.get("usage")
            elif kind == "turn.failed":
                error = (event.get("error") or {}).get("message") or "Codex turn failed."
        if proc.returncode or not complete or not answer.strip():
            error = error or proc.stderr.strip()[-2000:] or "Codex exited without a completed answer."
    except (OSError, KeyboardInterrupt) as exc:
        error = str(exc) or "Interrupted"
    try:
        changes = delta(before, snapshot(repo))
    except (OSError, subprocess.SubprocessError) as exc:
        error = (error + "\nCannot collect final file evidence: " + str(exc)).strip()
    with db:
        db.execute("""UPDATE runs SET state=?, thread=?, answer=?, error=?, commands=?,
                      changes=?, usage=? WHERE id=?""",
                   ("failed" if error else "completed", thread, answer if complete else "",
                    error, json.dumps(commands), json.dumps(changes), json.dumps(usage), rid))
    return rid


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("--db", type=Path, default=Path.home() / ".runledger" / "runs.db")
    subs = cli.add_subparsers(dest="action", required=True)
    run = subs.add_parser("run")
    run.add_argument("--repo", type=Path, default=Path.cwd())
    run.add_argument("--edit", action="store_true")
    run.add_argument("prompt")
    resume = subs.add_parser("resume")
    resume.add_argument("id", type=int)
    resume.add_argument("prompt")
    subs.add_parser("show").add_argument("id", type=int)
    subs.add_parser("list").add_argument("--search", default="")
    args = cli.parse_args()
    db = connect(args.db)
    try:
        if args.action == "list":
            rows = db.execute("""SELECT id,created,repo,prompt,state FROM runs
                WHERE instr(lower(prompt || ' ' || coalesce(answer,'') || ' ' || repo),lower(?))>0
                ORDER BY id DESC""", (args.search,))
            print(json.dumps([dict(row) for row in rows], ensure_ascii=False, indent=2))
            return 0
        if args.action == "show":
            rid = args.id
        else:
            program = os.environ.get("RUNLEDGER_CODEX") or shutil.which("codex")
            if not program:
                raise ValueError("Install Codex CLI or set RUNLEDGER_CODEX to its executable path.")
            repo = getattr(args, "repo", Path.cwd())
            rid = execute(db, repo, args.prompt, [program], getattr(args, "id", None),
                          getattr(args, "edit", False))
        result = get(db, rid)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return int(result["state"] == "failed")
    finally:
        db.close()


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError, sqlite3.Error, subprocess.SubprocessError) as exc:
        sys.exit(str(exc))
