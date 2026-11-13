# RunLedger

A local CLI for reviewing Codex work across small Git projects. Each run stores the final answer alongside the commands Codex reported, their exit codes, and an independent comparison of file contents before and after the run. Read the answer later, search past prompts and answers, or continue the same Codex thread.

## First run on Windows

You need Python 3.10+, Git, and a signed-in Codex CLI with JSON output and session resume. No Python packages are required. Extract the ZIP and open PowerShell in its folder. Supply your own local Git project path.

```powershell
codex login status
python runledger.py run --repo "D:\我的项目\DailyBoss" "Which file starts this app? Cite the path."
python runledger.py list --search "starts this app"
python runledger.py show 1
python runledger.py resume 1 "Which test would you run first, and why?"
```

Use the actual run ID printed by the first command. If Codex is installed outside PATH, set `$env:RUNLEDGER_CODEX` to the full path to the executable. Calls use the CLI's existing authentication and consume your account's usual Codex allowance. A normal run requests read-only access. Add `--edit` to the run command to request workspace edits. A follow-up inherits its parent's folder and access mode.

## Dashboard

Browse saved runs in a local web page: searchable history on the left, the selected run's answer, commands, exit codes, file changes and usage on the right. It uses only the Python standard library. From PowerShell in the project folder:

```powershell
python runledger.py dashboard
```

This reads the default database (`~/.runledger/runs.db`), serves the page at `http://127.0.0.1:8765/` and opens it in your browser. Press `Ctrl+C` in PowerShell to stop it.

Choose a database with either form:

```powershell
python runledger.py dashboard --db "D:\path\to\runs.db"
python runledger.py --db "D:\path\to\runs.db" dashboard
```

Other options:

| Option | Default | Purpose |
| --- | --- | --- |
| `--db PATH` | `~/.runledger/runs.db` | Database to read. A `--db` after `dashboard` overrides one before it. |
| `--port N` | `8765` | Use another port if 8765 is taken, for example `--port 8780`. |
| `--host ADDR` | `127.0.0.1` | Keep the default. Any other address can expose your prompts and answers to other machines. |
| `--no-browser` | off | Print the URL without opening a browser. |

The dashboard is read-only. It opens SQLite in read-only mode on every request, and never creates, migrates or changes the database. If the file does not exist yet, the page shows setup steps. Record a run with `python runledger.py run ...`, then press Refresh. Starting runs and resuming threads stay in the CLI. Stored `created` values come from SQLite's `CURRENT_TIMESTAMP`, so they are UTC. The page shows them unchanged with a `UTC` label and your local time beside them. All stored text is rendered as untrusted: no HTML is interpreted, and only `http`, `https` and `mailto` links are clickable. Windows paths in answers stay as readable text.

## How it works

The CLI starts a Codex process in the chosen directory, sends the prompt on standard input, then reads newline-delimited JSON from stdout. It stores the thread ID, completed agent message, usage when supplied, command outcomes, and run state in SQLite. A follow-up gets its own run ID and links back to its parent. Both records remain available. The database defaults to `~/.runledger/runs.db`. Set a different location with `--db PATH` before the subcommand; keep it outside the measured repository.

The snapshots hash bytes of Git-tracked and nonignored untracked files under the requested folder. They can detect another edit to a file that was already dirty. A recorded change can come from another program working in the same folder. Ignored untracked files, nested submodule contents, permissions, index-only changes and temporary edits reverted during the run are outside this comparison. Large datasets can make scanning slow. An exit code is evidence about that particular command, and a command list covers only the events Codex emitted.

A completed run indicates that the CLI exited successfully with a completed answer. Check command exit codes and file changes to judge the result. A normal process failure is saved and returns exit status 1. If the wrapper itself is forcibly killed, the run can remain marked running. This first version runs on demand and returns a JSON report when the process exits. Prompts, answers, command strings, and error details are saved locally in plain text.

## Verification

`python -m unittest -v` uses a fixture subprocess and real temporary Git repositories to check run retrieval, follow-up arguments, interrupted output, failed command evidence, and pre-existing changes. The first-run commands above also give you a live read-only smoke test. `test_dashboard.py` runs the dashboard server against temporary fixture databases. It covers missing databases and records, search, status filters, pagination, read-only access and stored HTML-like text.

To try the dashboard on demo data without touching your history:

```powershell
python -c "import test_dashboard; test_dashboard.make_fixture(r'$env:TEMP\runledger-demo.db')"
python runledger.py dashboard --db "$env:TEMP\runledger-demo.db"
```
