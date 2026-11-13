// RunLedger dashboard. All stored content is untrusted: it only ever reaches the
// page through textContent / DOM construction, never through innerHTML.
"use strict";

const PAGE_SIZE = 50;
const LONG_COMMAND = 160;
const NARROW = window.matchMedia("(max-width: 860px)");
const KNOWN_STATES = ["completed", "failed", "running"];
const USAGE_FIELDS = [
  ["input_tokens", "Input tokens"],
  ["cached_input_tokens", "Cached input"],
  ["cache_write_input_tokens", "Cache writes"],
  ["output_tokens", "Output tokens"],
  ["reasoning_output_tokens", "Reasoning output"],
];

const $ = (id) => document.getElementById(id);
const els = {
  layout: $("layout"), search: $("search"), state: $("state"), filters: $("filters"),
  list: $("run-list"), listState: $("list-state"), listMeta: $("list-meta"), listScroll: $("list-scroll"),
  loadMore: $("load-more"), detail: $("detail"), detailInner: $("detail-inner"),
  refresh: $("refresh"), dbPath: $("db-path"), updated: $("updated"), announcer: $("announcer"),
};

const app = {
  q: "", stateFilter: "", runs: [], total: 0, nextBefore: null,
  selectedId: null, status: null, listToken: 0, detailToken: 0, detailRecord: null,
};

/* ---------- DOM helpers ---------- */

function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}
const icon = (name) => h("span", { class: `icon icon-${name}`, "aria-hidden": "true" });

function announce(message) {
  els.announcer.textContent = "";
  window.setTimeout(() => { els.announcer.textContent = message; }, 30);
}

function plural(n, word, many) {
  return `${n.toLocaleString()} ${n === 1 ? word : (many || word + "s")}`;
}

/* ---------- API ---------- */

class ApiError extends Error {
  constructor(message, status, code, body) {
    super(message);
    this.status = status; this.code = code; this.body = body;
  }
}

async function api(path) {
  let res;
  try {
    res = await fetch(path, { headers: { Accept: "application/json" }, cache: "no-store" });
  } catch (err) {
    throw new ApiError("Cannot reach the dashboard server. Is `runledger.py dashboard` still running?", 0, "network");
  }
  let body = null;
  try { body = await res.json(); } catch (err) { /* non-JSON error page */ }
  if (!res.ok) {
    throw new ApiError((body && body.message) || `Request failed with HTTP ${res.status}.`,
      res.status, body && body.error, body);
  }
  return body;
}

const isSetupError = (err) => err && (err.code === "missing_database" || err.code === "missing_table");

/* ---------- Formatting ---------- */

// The CLI stores `created` with SQLite's CURRENT_TIMESTAMP: "YYYY-MM-DD HH:MM:SS" in UTC.
function parseCreated(value) {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/.exec(value || "");
  if (!m) return { text: value || "Unknown", iso: null, local: null };
  const iso = `${m[1]}T${m[2]}Z`;
  const date = new Date(iso);
  const local = Number.isNaN(date.getTime()) ? null
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
  return { text: `${value} UTC`, iso, local };
}

function timeEl(value, cls) {
  const t = parseCreated(value);
  return h("time", { class: cls, datetime: t.iso, title: t.local ? `Stored as ${t.text} · your local time ${t.local}` : null }, t.text);
}

function stateLabel(state) {
  if (!state) return "Unknown";
  return state.charAt(0).toUpperCase() + state.slice(1);
}

function badge(state, large) {
  const known = KNOWN_STATES.includes(state) ? state : "other";
  return h("span", { class: `badge state-${known}${large ? " badge-lg" : ""}` }, stateLabel(state));
}

function repoName(repo) {
  const parts = String(repo || "").split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : String(repo || "");
}

function runHref(id) { return `#/run/${id}`; }

/* ---------- Copy ---------- */

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    try { await navigator.clipboard.writeText(text); return true; } catch (err) { /* fall back */ }
  }
  const area = h("textarea", { readonly: true, "aria-hidden": "true", class: "visually-hidden" });
  area.value = text;
  document.body.append(area);
  area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
  area.remove();
  return ok;
}

function copyButton(label, getText, opts = {}) {
  const text = h("span", {}, label);
  const ico = icon("copy");
  const btn = h("button", { type: "button", class: `btn ${opts.small === false ? "" : "btn-sm"}`, "aria-label": opts.aria || null }, ico, text);
  let timer = null;
  btn.addEventListener("click", async () => {
    const value = getText();
    const ok = value !== null && value !== undefined && (await copyText(String(value)));
    window.clearTimeout(timer);
    btn.classList.toggle("is-ok", ok);
    btn.classList.toggle("is-bad", !ok);
    ico.className = `icon icon-${ok ? "check" : "x"}`;
    text.textContent = ok ? "Copied" : "Copy failed";
    announce(ok ? `${opts.what || label} copied to clipboard.` : `Could not copy ${opts.what || label}. Select the text and copy it manually.`);
    timer = window.setTimeout(() => {
      btn.classList.remove("is-ok", "is-bad");
      ico.className = "icon icon-copy";
      text.textContent = label;
    }, ok ? 1600 : 3200);
  });
  return btn;
}

/* ---------- Safe Markdown subset ---------- */

const LIST_RE = /^( *)([-*+]|\d{1,9}[.)])[ \t]+(.*)$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[^`]*$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

function indentOf(line) { return line.length - line.replace(/^ +/, "").length; }
function expandTabs(line) { return line.replace(/^\t+/, (t) => "    ".repeat(t.length)); }

function isBlockStart(line, next) {
  return FENCE_RE.test(line) || /^ {0,3}#{1,6}\s/.test(line) || /^ {0,3}>/.test(line) ||
    LIST_RE.test(line) || /^ {0,3}([-*_])( *\1){2,} *$/.test(line) ||
    (line.includes("|") && next !== undefined && TABLE_SEP_RE.test(next));
}

function safeUrl(raw) {
  try {
    const url = new URL(raw.trim());
    return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch (err) {
    return null;
  }
}

function renderMarkdown(source) {
  const frag = document.createDocumentFragment();
  const lines = String(source).replace(/\r\n?/g, "\n").split("\n").map(expandTabs);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    let m = FENCE_RE.exec(line);
    if (m) {
      const fence = m[1];
      const body = [];
      const indent = indentOf(line);
      i++;
      while (i < lines.length && !(lines[i].trim().startsWith(fence[0].repeat(fence.length)) && /^[`~]+\s*$/.test(lines[i].trim()))) {
        body.push(lines[i].slice(Math.min(indent, indentOf(lines[i]))));
        i++;
      }
      i++; // closing fence (or end of input)
      frag.append(codeBlock(body.join("\n"), m[2]));
      continue;
    }

    m = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/.exec(line);
    if (m) {
      // Page headings are h1/h2, so answer headings start at h3.
      frag.append(h(`h${Math.min(m[1].length + 2, 6)}`, {}, renderInline(m[2])));
      i++; continue;
    }

    if (/^ {0,3}([-*_])( *\1){2,} *$/.test(line)) { frag.append(h("hr")); i++; continue; }

    if (/^ {0,3}>/.test(line)) {
      const quoted = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^ {0,3}> ?/, ""));
        i++;
      }
      frag.append(h("blockquote", {}, renderMarkdown(quoted.join("\n"))));
      continue;
    }

    if (LIST_RE.test(line)) {
      const [list, next] = parseList(lines, i);
      frag.append(list);
      i = next; continue;
    }

    if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
      const [table, next] = parseTable(lines, i);
      frag.append(table);
      i = next; continue;
    }

    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i], lines[i + 1])) {
      para.push(lines[i].trim());
      i++;
    }
    const p = h("p");
    para.forEach((text, idx) => {
      if (idx) p.append(h("br"));
      p.append(renderInline(text));
    });
    frag.append(p);
  }
  return frag;
}

function parseList(lines, start) {
  const first = LIST_RE.exec(lines[start]);
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const list = h(ordered ? "ol" : "ul");
  if (ordered) {
    const n = parseInt(first[2], 10);
    if (n !== 1) list.setAttribute("start", String(n));
  }
  let i = start;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]);
    if (!m || m[1].length !== base || /\d/.test(m[2]) !== ordered) break;
    const contentIndent = base + m[2].length + 1;
    const body = [m[3]];
    i++;
    while (i < lines.length) {
      const l = lines[i];
      if (!l.trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j < lines.length && indentOf(lines[j]) > base) { body.push(""); i++; continue; }
        break;
      }
      const ind = indentOf(l);
      if (ind > base) { body.push(l.slice(Math.min(ind, contentIndent))); i++; continue; }
      if (body[body.length - 1] !== "" && !isBlockStart(l, lines[i + 1])) { body.push(l.trim()); i++; continue; }
      break;
    }
    list.append(h("li", {}, renderMarkdown(body.join("\n"))));
  }
  return [list, i];
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map((cell) => cell.trim());
}

function parseTable(lines, start) {
  const header = splitRow(lines[start]);
  const aligns = splitRow(lines[start + 1]).map((c) =>
    c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : null);
  const thead = h("thead", {}, h("tr", {}, header.map((c, k) => h("th", { scope: "col", align: aligns[k] }, renderInline(c)))));
  const tbody = h("tbody");
  let i = start + 2;
  while (i < lines.length && lines[i].trim() && lines[i].includes("|")) {
    const cells = splitRow(lines[i]);
    tbody.append(h("tr", {}, header.map((_, k) => h("td", { align: aligns[k] }, renderInline(cells[k] || "")))));
    i++;
  }
  return [h("div", { class: "table-wrap" }, h("table", {}, thead, tbody)), i];
}

const INLINE_SOURCE = [
  "(`+)([^`]|[^`][\\s\\S]*?[^`])\\1(?!`)",                               // 1,2 code span
  "\\[([^\\]\\n]+)\\]\\((<[^>\\n]+>|[^\\s()]+(?:\\([^\\s()]*\\)[^\\s()]*)*)(?:\\s+\"[^\"\\n]*\")?\\)", // 3,4 link
  "<((?:https?|mailto):[^\\s<>]+)>",                                     // 5 autolink
  "\\b(https?:\\/\\/[^\\s<>\"'`]*[^\\s<>\"'`.,;:!?)\\]])",               // 6 bare URL
  "\\*\\*(?=\\S)([^*\\n]*?\\S)\\*\\*",                                    // 7 bold
  "(?<![\\w*])\\*(?=[^\\s*])([^*\\n]*?[^\\s*])\\*(?![\\w*])",            // 8 emphasis
].join("|");

function link(href, label) {
  return h("a", { href, target: "_blank", rel: "noopener noreferrer nofollow" }, label);
}

function renderInline(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  // A fresh regex per call: link labels and bold text recurse into renderInline,
  // and a shared global regex would have its lastIndex reset underneath us.
  const re = new RegExp(INLINE_SOURCE, "g");
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    if (m[1] !== undefined) {
      const code = m[2].length > 2 && m[2].startsWith(" ") && m[2].endsWith(" ") ? m[2].slice(1, -1) : m[2];
      frag.append(h("code", {}, code));
    } else if (m[3] !== undefined) {
      let target = m[4];
      if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
      const href = safeUrl(target);
      if (href) {
        frag.append(link(href, renderInline(m[3])));
      } else {
        // File references and disallowed protocols stay readable as text, never as links.
        const span = h("span", { class: "fileref", title: target }, renderInline(m[3]));
        if (target.trim() && target.trim() !== m[3].trim()) {
          span.append(" ", h("span", { class: "fileref-path" }, `(${target})`));
        }
        frag.append(span);
      }
    } else if (m[5] !== undefined || m[6] !== undefined) {
      const raw = m[5] || m[6];
      const href = safeUrl(raw);
      frag.append(href ? link(href, raw) : raw);
    } else if (m[7] !== undefined) {
      frag.append(h("strong", {}, renderInline(m[7])));
    } else if (m[8] !== undefined) {
      frag.append(h("em", {}, renderInline(m[8])));
    }
    last = re.lastIndex;
    if (m[0].length === 0) re.lastIndex++; // Defensive: never loop on an empty match.
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

function codeBlock(code, lang) {
  return h("div", { class: "codeblock" },
    h("div", { class: "codeblock-bar" },
      h("span", {}, lang || "code"),
      copyButton("Copy", () => code, { what: "Code block" })),
    h("pre", { tabindex: "0", "aria-label": `${lang || "Code"} block` }, h("code", {}, code)));
}

/* ---------- Run list ---------- */

function listSkeleton() {
  return h("div", { class: "skeleton", "aria-hidden": "true" },
    [0, 1, 2, 3, 4].map(() => h("div", { class: "skeleton-item" },
      h("div", { class: "skeleton-line w30" }), h("div", { class: "skeleton-line w90" }), h("div", { class: "skeleton-line w50" }))));
}

function runItem(run) {
  const selected = run.id === app.selectedId;
  return h("li", {},
    h("a", { class: "run-item", href: runHref(run.id), "aria-current": selected ? "true" : null, "data-id": run.id },
      h("div", { class: "run-row" },
        h("span", { class: "run-id" }, `#${run.id}`),
        badge(run.state),
        timeEl(run.created, "run-time")),
      h("p", { class: "run-preview" }, run.preview || h("span", { class: "unavailable" }, "Empty prompt")),
      h("div", { class: "run-sub" },
        h("span", { class: "run-repo", title: run.repo || "" }, run.repo_name || "Unknown repository"),
        run.parent !== null && run.parent !== undefined
          ? h("span", { class: "run-followup" }, icon("down"), `follow-up of #${run.parent}`) : null)));
}

function renderList() {
  els.list.replaceChildren(...app.runs.map(runItem));
  els.loadMore.hidden = !app.nextBefore;
  if (app.runs.length) {
    const filtered = app.q || app.stateFilter;
    els.listMeta.textContent = `Showing ${app.runs.length.toLocaleString()} of ${plural(app.total, filtered ? "matching run" : "run")}`;
  }
}

function markSelectedInList() {
  for (const a of els.list.querySelectorAll(".run-item")) {
    if (Number(a.dataset.id) === app.selectedId) a.setAttribute("aria-current", "true");
    else a.removeAttribute("aria-current");
  }
}

function listMessage(title, text, action, cls) {
  els.listState.className = `list-state${cls ? " " + cls : ""}`;
  els.listState.replaceChildren(...[h("h3", {}, title), text ? h("p", {}, text) : null, action].filter(Boolean));
}

async function loadRuns({ append = false } = {}) {
  const token = ++app.listToken;
  const params = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (app.q) params.set("q", app.q);
  if (app.stateFilter) params.set("state", app.stateFilter);
  if (append && app.nextBefore) params.set("before", String(app.nextBefore));
  if (!append) {
    els.list.replaceChildren();
    els.loadMore.hidden = true;
    els.listMeta.textContent = "Loading runs…";
    els.listState.className = "list-state";
    els.listState.replaceChildren(listSkeleton());
    els.listScroll.setAttribute("aria-busy", "true");
  } else {
    els.loadMore.disabled = true;
    els.loadMore.textContent = "Loading…";
  }
  try {
    const page = await api(`/api/runs?${params}`);
    if (token !== app.listToken) return null;
    app.runs = append ? app.runs.concat(page.runs) : page.runs;
    app.total = page.total;
    app.nextBefore = page.next_before;
    els.listState.replaceChildren();
    renderList();
    if (!app.runs.length) {
      if (app.q || app.stateFilter) {
        els.listMeta.textContent = "No matches";
        const what = [app.q ? `“${app.q}”` : null, app.stateFilter ? `status ${stateLabel(app.stateFilter)}` : null].filter(Boolean).join(" with ");
        listMessage("No runs match", `Nothing matches ${what}. Search covers prompts, answers and repository paths.`,
          h("button", { type: "button", class: "btn btn-sm", onclick: clearFilters }, "Clear search and filter"));
      } else {
        els.listMeta.textContent = "No runs yet";
        listMessage("No runs recorded yet", "Start one from PowerShell, then press Refresh.");
      }
    }
    if (append) announce(`Loaded ${plural(page.runs.length, "more run")}.`);
    return page;
  } catch (err) {
    if (token !== app.listToken) return null;
    app.runs = []; app.nextBefore = null;
    renderList();
    if (isSetupError(err)) {
      els.listMeta.textContent = "Database not found";
      listMessage("No history to show", "See setup steps on the right.", null);
    } else {
      els.listMeta.textContent = "";
      listMessage("Couldn’t load runs", err.message,
        h("button", { type: "button", class: "btn btn-sm", onclick: () => refreshAll() }, "Try again"), "is-error");
    }
    throw err;
  } finally {
    if (token === app.listToken) {
      els.listScroll.removeAttribute("aria-busy");
      els.loadMore.disabled = false;
      els.loadMore.textContent = "Load more";
    }
  }
}

function clearFilters() {
  els.search.value = "";
  els.state.value = "";
  app.q = ""; app.stateFilter = "";
  loadRuns().catch(() => {});
  els.search.focus();
}

/* ---------- Status ---------- */

function renderStatus(info) {
  els.dbPath.textContent = info.database;
  els.dbPath.title = info.database;
  const current = els.state.value;
  const states = new Set(KNOWN_STATES);
  Object.keys(info.states || {}).forEach((s) => states.add(s));
  const options = [h("option", { value: "" }, `All statuses${info.ready ? ` (${info.total})` : ""}`)];
  for (const s of states) {
    const count = (info.states || {})[s] || 0;
    options.push(h("option", { value: s }, `${stateLabel(s)} (${count})`));
  }
  els.state.replaceChildren(...options);
  els.state.value = states.has(current) ? current : "";
}

/* ---------- Detail ---------- */

function setView(view) {
  els.layout.dataset.view = view;
}

function detailSkeleton() {
  return h("div", { "aria-hidden": "true" },
    h("div", { class: "skeleton-line w30" }), h("div", { class: "skeleton-line w50" }),
    h("div", { class: "skeleton-block" }), h("div", { class: "skeleton-block tall" }));
}

function backButton() {
  return h("a", { class: "btn btn-sm back-btn", href: "#/" }, icon("back"), "All runs");
}

function statePanel({ title, body, actions, iconName = "search", bad = false, headingLevel = "h1" }) {
  return h("section", { class: "state-panel" },
    h("div", { class: `state-icon${bad ? " bad" : ""}`, "aria-hidden": "true" }, icon(iconName)),
    h(headingLevel, { tabindex: "-1", class: "panel-title" }, title),
    body,
    actions ? h("div", { class: "actions" }, actions) : null);
}

function renderSetup(info) {
  const db = info.database || "the selected path";
  const quotedDb = "'" + db.replace(/'/g, "''") + "'";
  const missingTable = info.error === "missing_table";
  els.detailInner.replaceChildren(h("section", { class: "state-panel setup" },
    h("p", { class: "eyebrow" }, "Setup needed"),
    h("h1", { tabindex: "-1", class: "panel-title" }, missingTable ? "This database has no runs table yet" : "No RunLedger database found"),
    h("p", {}, "The dashboard is reading:"),
    h("pre", { class: "shell" }, db),
    h("p", {}, missingTable
      ? "The file exists but RunLedger has not written to it. Record a run with this database, then press Refresh."
      : "Record your first run with the CLI (this creates the database), then press Refresh. The dashboard itself never creates or changes the database."),
    h("pre", { class: "shell" }, `python runledger.py --db ${quotedDb} run --repo . "Which file starts this app?"`),
    h("p", {}, "Using a different database? Restart the dashboard and point it there:"),
    h("pre", { class: "shell" }, 'python runledger.py dashboard --db "D:\\path\\to\\runs.db"'),
    h("div", { class: "actions" }, h("button", { type: "button", class: "btn", onclick: () => refreshAll() }, icon("refresh"), "Refresh"))));
}

function renderPlaceholder() {
  if (!app.runs.length) {
    els.detailInner.replaceChildren(statePanel({
      title: app.q || app.stateFilter ? "No run selected" : "No runs yet",
      body: h("p", {}, app.q || app.stateFilter
        ? "Adjust the search or status filter to find a run."
        : "Runs you record with python runledger.py run will appear here."),
    }));
  } else {
    els.detailInner.replaceChildren(statePanel({ title: "Select a run", body: h("p", {}, "Choose a run from the history to see its answer, commands and file changes.") }));
  }
}

function metaItem(label, value, wide) {
  return h("div", { class: wide ? "meta-wide" : null }, h("dt", {}, label), h("dd", {}, value));
}

function unavailable(text = "Unavailable") { return h("span", { class: "unavailable" }, text); }

function renderCommands(commands) {
  const card = h("section", { class: "card", "aria-labelledby": "cmd-heading" });
  const head = h("div", { class: "card-head" }, h("h2", { id: "cmd-heading" }, "Commands"));
  card.append(head);
  if (!Array.isArray(commands)) {
    card.append(h("div", { class: "card-body" },
      commands === null || commands === undefined
        ? h("p", { class: "card-note" }, "No command list was stored for this run.")
        : [h("p", { class: "card-note" }, "The stored command list could not be read as JSON:"), h("pre", { class: "cmd-text" }, String(commands))]));
    return card;
  }
  if (!commands.length) {
    head.append(h("span", { class: "count" }, "0"));
    card.append(h("div", { class: "card-body" }, h("p", { class: "card-note" }, "Codex reported no command executions for this run.")));
    return card;
  }
  const nonzero = commands.filter((c) => c && typeof c.exit_code === "number" && c.exit_code !== 0).length;
  const unknown = commands.filter((c) => !c || typeof c.exit_code !== "number").length;
  head.append(h("span", { class: "count" }, String(commands.length)), h("span", { class: "spacer" }),
    h("span", { class: "cmd-summary" },
      nonzero ? h("strong", {}, `${nonzero} nonzero exit`) : `${commands.length - unknown} exited 0`,
      unknown ? ` · ${unknown} without exit code` : ""));
  const list = h("ol", { class: "cmd-list" });
  commands.forEach((cmd, idx) => {
    const text = cmd && cmd.command !== null && cmd.command !== undefined ? String(cmd.command) : "";
    const code = cmd ? cmd.exit_code : null;
    let exitEl;
    if (typeof code === "number") {
      exitEl = h("span", { class: `exit ${code === 0 ? "exit-ok" : "exit-bad"}`, title: `Exit code ${code}` },
        icon(code === 0 ? "check" : "x"), `exit ${code}`);
    } else {
      exitEl = h("span", { class: "exit exit-unknown", title: "Exit code unavailable" }, code === null || code === undefined ? "exit —" : `exit ${String(code)}`);
    }
    let body;
    if (!text) {
      body = h("pre", { class: "cmd-text" }, unavailable("Command text unavailable"));
    } else if (text.length > LONG_COMMAND || text.includes("\n")) {
      const firstLine = text.split("\n")[0];
      body = h("details", {},
        h("summary", {}, icon("chevron"),
          h("span", { class: "cmd-preview" }, firstLine),
          h("span", { class: "cmd-len" }, `${text.length.toLocaleString()} chars`)),
        h("pre", { class: "cmd-text", tabindex: "0" }, text));
    } else {
      body = h("pre", { class: "cmd-text" }, text);
    }
    list.append(h("li", { class: "cmd" }, h("span", { class: "cmd-index", "aria-hidden": "true" }, String(idx + 1)), body, exitEl));
  });
  card.append(list);
  return card;
}

function renderChanges(changes) {
  const card = h("section", { class: "card", "aria-labelledby": "changes-heading" });
  const head = h("div", { class: "card-head" }, h("h2", { id: "changes-heading" }, "File changes"));
  const body = h("div", { class: "card-body" });
  card.append(head, body);
  if (changes === null || changes === undefined) {
    body.append(h("p", { class: "card-note" }, "File evidence was not collected for this run."));
    return card;
  }
  if (typeof changes !== "object" || Array.isArray(changes)) {
    body.append(h("p", { class: "card-note" }, "The stored file changes could not be read:"), h("pre", { class: "cmd-text" }, String(JSON.stringify(changes))));
    return card;
  }
  const groups = [["added", "Added", "+"], ["removed", "Removed", "−"], ["modified", "Modified", "~"]];
  const lists = groups.map(([key]) => (Array.isArray(changes[key]) ? changes[key] : []));
  const total = lists.reduce((n, l) => n + l.length, 0);
  head.append(h("span", { class: "spacer" }),
    h("span", { class: "change-totals" }, groups.map(([, label], k) => `${lists[k].length} ${label.toLowerCase()}`).join(" · ")));
  if (!total) {
    body.append(h("p", { class: "card-note" }, "No added, removed or modified files were detected."));
    return card;
  }
  const wrap = h("div", { class: "changes" });
  groups.forEach(([key, label, mark], k) => {
    if (!lists[k].length) return;
    wrap.append(h("div", { class: `change-group change-${key}` },
      h("h3", {}, h("span", { class: "change-mark", "aria-hidden": "true" }, mark), `${label} (${lists[k].length})`),
      h("ul", { class: "path-list", "aria-label": `${label} files` }, lists[k].map((p) => h("li", {}, String(p))))));
  });
  body.append(wrap);
  return card;
}

function formatUsageValue(value) {
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function renderUsage(usage) {
  const card = h("section", { class: "card", "aria-labelledby": "usage-heading" });
  card.append(h("div", { class: "card-head" }, h("h2", { id: "usage-heading" }, "Usage")));
  const body = h("div", { class: "card-body" });
  card.append(body);
  if (usage !== null && usage !== undefined && (typeof usage !== "object" || Array.isArray(usage))) {
    body.append(h("p", { class: "card-note" }, "Stored usage is not an object:"), h("pre", { class: "cmd-text" }, String(JSON.stringify(usage))));
    return card;
  }
  const data = usage || {};
  const keys = USAGE_FIELDS.map(([k]) => k);
  const extra = Object.keys(data).filter((k) => !keys.includes(k));
  const fields = USAGE_FIELDS.concat(extra.map((k) => [k, k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase())]));
  body.append(h("dl", { class: "usage" }, fields.map(([key, label]) => {
    const present = Object.prototype.hasOwnProperty.call(data, key) && data[key] !== null && data[key] !== undefined;
    return h("div", { class: "stat" },
      h("dt", {}, label, h("span", { class: "key" }, key)),
      present ? h("dd", {}, formatUsageValue(data[key])) : h("dd", { class: "unavailable" }, "Unavailable"));
  })));
  if (!usage) body.append(h("p", { class: "usage-note" }, "Codex did not report usage for this run."));
  return card;
}

function renderDetail(payload) {
  const run = payload.run;
  const created = parseCreated(run.created);
  const nodes = [backButton()];

  const lineage = h("div", { class: "lineage" });
  if (run.parent !== null && run.parent !== undefined) {
    lineage.append(h("span", {}, icon("up"), "Follow-up of",
      payload.parent_exists === false
        ? h("span", {}, `#${run.parent} (not in this database)`)
        : h("a", { class: "link-btn", href: runHref(run.parent), "data-nav": "parent" }, `Run #${run.parent}`)));
  }
  if (payload.children && payload.children.length) {
    lineage.append(h("span", {}, icon("down"), payload.children.length === 1 ? "Follow-up:" : "Follow-ups:",
      payload.children.map((id) => h("a", { class: "link-btn", href: runHref(id) }, `Run #${id}`))));
  }

  nodes.push(h("header", { class: "detail-head" },
    h("div", { class: "title-row" },
      h("h1", { tabindex: "-1", class: "panel-title" }, h("span", { class: "hash" }, "Run "), `#${run.id}`),
      badge(run.state, true),
      h("div", { class: "title-actions" },
        copyButton("Copy raw JSON", () => JSON.stringify(run, null, 2), { what: "Raw JSON" }))),
    lineage.childNodes.length ? lineage : null,
    h("dl", { class: "meta" },
      metaItem("Created", [h("time", { datetime: created.iso }, created.text),
        created.local ? h("span", { class: "sub" }, `Local: ${created.local}`) : null]),
      metaItem("Access mode", run.access ? h("span", { class: "mono" }, run.access) : unavailable()),
      metaItem("Status", stateLabel(run.state)),
      metaItem("Repository", run.repo ? h("span", { class: "mono" }, run.repo) : unavailable(), true),
      metaItem("Thread ID", run.thread
        ? h("div", { class: "inline-copy" }, h("span", { class: "mono" }, run.thread), copyButton("Copy", () => run.thread, { what: "Thread ID", aria: "Copy thread ID" }))
        : unavailable("No thread recorded"), true))));

  if (run.error) {
    nodes.push(h("section", { class: "callout callout-error", role: "group", "aria-labelledby": "error-heading" },
      icon("x"),
      h("div", { class: "callout-body" }, h("h2", { id: "error-heading" }, "Error"), h("pre", { class: "error-text", tabindex: "0" }, String(run.error)))));
  }

  const commands = Array.isArray(run.commands) ? run.commands : [];
  const nonzero = commands.filter((c) => c && typeof c.exit_code === "number" && c.exit_code !== 0).length;
  if (run.state === "completed" && nonzero) {
    nodes.push(h("div", { class: "callout callout-warn" }, h("div", { class: "callout-body" },
      h("h3", {}, `Completed with ${plural(nonzero, "nonzero command exit")}`),
      h("p", {}, "The run state reflects the Codex turn finishing with an answer. Check the command exit codes below to judge the result."))));
  }

  nodes.push(h("section", { class: "card card-prompt", "aria-labelledby": "prompt-heading" },
    h("div", { class: "card-head" }, h("h2", { id: "prompt-heading" }, "Prompt")),
    h("div", { class: "card-body" }, run.prompt ? h("div", { class: "prompt-text", tabindex: "0" }, String(run.prompt)) : h("p", { class: "card-note" }, "Empty prompt."))));

  const answer = typeof run.answer === "string" ? run.answer : "";
  nodes.push(h("section", { class: "card card-answer", "aria-labelledby": "answer-heading" },
    h("div", { class: "card-head" }, h("h2", { id: "answer-heading" }, "Answer"), h("span", { class: "spacer" }),
      answer.trim() ? copyButton("Copy answer", () => answer, { what: "Answer" }) : null),
    h("div", { class: "card-body" }, answer.trim()
      ? h("div", { class: "md" }, renderMarkdown(answer))
      : h("p", { class: "card-note" }, run.state === "failed"
        ? "No completed answer was recorded because this run failed."
        : run.state === "running" ? "No answer yet. This run is still marked running." : "The stored answer is empty."))));

  nodes.push(renderCommands(run.commands), renderChanges(run.changes), renderUsage(run.usage));

  nodes.push(h("section", { class: "card", "aria-label": "Raw record" },
    h("details", {},
      h("summary", { class: "card-head raw-toggle" }, icon("chevron"), "Raw record (JSON)"),
      h("pre", { class: "raw-json", tabindex: "0" }, JSON.stringify(run, null, 2)))));

  els.detailInner.replaceChildren(...nodes);
}

async function loadDetail(id, { focus = false, quiet = false } = {}) {
  const token = ++app.detailToken;
  if (!quiet) els.detailInner.replaceChildren(backButton(), detailSkeleton());
  els.detail.setAttribute("aria-busy", "true");
  try {
    const payload = await api(`/api/runs/${id}`);
    if (token !== app.detailToken) return;
    app.detailRecord = payload;
    const scroll = els.detail.scrollTop;
    renderDetail(payload);
    if (quiet) els.detail.scrollTop = scroll; else els.detail.scrollTop = 0;
    if (!quiet) window.scrollTo({ top: 0 });
  } catch (err) {
    if (token !== app.detailToken) return;
    app.detailRecord = null;
    if (isSetupError(err)) {
      renderSetup(err.body || {});
    } else if (err.status === 404) {
      els.detailInner.replaceChildren(backButton(), statePanel({
        title: `Run #${id} was not found`, iconName: "search",
        body: h("p", {}, "It is not in the selected database. It may belong to a different database file."),
        actions: h("a", { class: "btn", href: "#/" }, "Back to latest run"),
      }));
    } else {
      els.detailInner.replaceChildren(backButton(), statePanel({
        title: "Couldn’t load this run", iconName: "x", bad: true,
        body: h("p", {}, err.message),
        actions: h("button", { type: "button", class: "btn", onclick: () => loadDetail(id, { focus: true }) }, icon("refresh"), "Try again"),
      }));
    }
  } finally {
    if (token === app.detailToken) els.detail.removeAttribute("aria-busy");
  }
  if (focus && token === app.detailToken) {
    const title = els.detailInner.querySelector(".panel-title");
    if (title) title.focus({ preventScroll: true });
  }
}

/* ---------- Routing ---------- */

function routeId() {
  const m = /^#\/run\/(\d{1,15})$/.exec(location.hash);
  return m ? Number(m[1]) : null;
}

let focusDetailOnRoute = false;

function onRoute() {
  const id = routeId();
  if (id === null) {
    // Invalidate requests for the run we just left before showing the list.
    app.detailToken++;
    app.detailRecord = null;
    els.detail.removeAttribute("aria-busy");
    app.selectedId = null;
    markSelectedInList();
    setView("list");
    if (!NARROW.matches && app.runs.length) {
      history.replaceState(null, "", runHref(app.runs[0].id));
      return onRoute();
    }
    if (app.status && !app.status.ready) renderSetup(app.status);
    else renderPlaceholder();
    return;
  }
  const focus = focusDetailOnRoute || NARROW.matches;
  focusDetailOnRoute = false;
  app.selectedId = id;
  markSelectedInList();
  setView("detail");
  loadDetail(id, { focus });
}

/* ---------- Refresh ---------- */

async function refreshAll({ initial = false } = {}) {
  els.refresh.disabled = true;
  els.refresh.classList.add("is-busy");
  els.refresh.setAttribute("aria-busy", "true");
  let ok = true;
  try {
    let statusError = null;
    try {
      app.status = await api("/api/status");
      renderStatus(app.status);
    } catch (err) {
      ok = false;
      statusError = err;
      app.status = null;
      els.dbPath.textContent = "Server unavailable";
    }
    try { await loadRuns(); } catch (err) { if (!isSetupError(err)) ok = false; }
    if (statusError) {
      // Keep a run that is already on screen; otherwise replace any stale panel with the error.
      if (!app.detailRecord) {
        els.detailInner.replaceChildren(statePanel({
          title: "Dashboard server unavailable", iconName: "x", bad: true,
          body: h("p", {}, statusError.message),
          actions: h("button", { type: "button", class: "btn", onclick: () => refreshAll() }, icon("refresh"), "Try again"),
        }));
        setView("detail");
      }
    } else if (app.status && !app.status.ready) {
      app.detailRecord = null;
      renderSetup(app.status);
      setView("detail");
    } else if (initial || routeId() === null) {
      onRoute();
    } else if (app.selectedId !== null) {
      await loadDetail(app.selectedId, { quiet: true });
    }
  } finally {
    els.refresh.disabled = false;
    els.refresh.classList.remove("is-busy");
    els.refresh.removeAttribute("aria-busy");
  }
  const now = new Date().toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  els.updated.textContent = ok ? `Updated ${now}` : `Refresh failed at ${now}`;
  if (!initial) announce(ok ? "History refreshed." : "Refresh failed.");
}

/* ---------- Events ---------- */

let searchTimer = null;
els.search.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => {
    const q = els.search.value.trim();
    if (q === app.q) return;
    app.q = q;
    loadRuns().catch(() => {});
  }, 220);
});
els.search.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && els.search.value) {
    e.preventDefault();
    els.search.value = "";
    els.search.dispatchEvent(new Event("input"));
  } else if (e.key === "ArrowDown") {
    const first = els.list.querySelector(".run-item");
    if (first) { e.preventDefault(); first.focus(); }
  }
});
els.filters.addEventListener("submit", (e) => {
  e.preventDefault();
  window.clearTimeout(searchTimer);
  app.q = els.search.value.trim();
  loadRuns().catch(() => {});
});
els.state.addEventListener("change", () => {
  app.stateFilter = els.state.value;
  loadRuns().catch(() => {});
});
els.refresh.addEventListener("click", () => refreshAll());
els.loadMore.addEventListener("click", () => loadRuns({ append: true }).catch(() => {}));

els.list.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const items = [...els.list.querySelectorAll(".run-item")];
  const idx = items.indexOf(document.activeElement);
  if (idx < 0) return;
  e.preventDefault();
  const next = items[idx + (e.key === "ArrowDown" ? 1 : -1)];
  if (next) next.focus();
  else if (e.key === "ArrowUp") els.search.focus();
});

// Links inside the detail pane (parent / follow-up) move focus to the new run's heading.
els.detailInner.addEventListener("click", (e) => {
  const a = e.target.closest && e.target.closest("a[href^='#/run/']");
  if (a) focusDetailOnRoute = true;
});

document.addEventListener("keydown", (e) => {
  if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const tag = (document.activeElement && document.activeElement.tagName) || "";
    if (!["INPUT", "TEXTAREA", "SELECT"].includes(tag)) {
      e.preventDefault();
      if (NARROW.matches && els.layout.dataset.view === "detail") location.hash = "#/";
      els.search.focus();
    }
  }
});

window.addEventListener("hashchange", onRoute);
NARROW.addEventListener("change", () => {
  if (!NARROW.matches && routeId() === null && app.runs.length) onRoute();
});

refreshAll({ initial: true });
