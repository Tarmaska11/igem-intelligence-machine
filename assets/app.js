"use strict";

const DATA_ORIGINS = [
  "https://tarmaska11.github.io/igem-intelligence-machine-db/",
  "https://raw.githubusercontent.com/Tarmaska11/igem-intelligence-machine-db/main/",
];
const DATA_SCHEMA = 2;
const REMOTE_TIMEOUT = 6000;
const PAGE_SIZE = 20;

const FACET_KINDS = [
  ["section",   "Team section"],
  ["year",      "Year"],
  ["track",     "Village"],
  ["chassis",   "Chassis organism"],
  ["molecule",  "Target molecule"],
  ["technique", "Molecular technique"],
  ["part",      "Biological part"],
  ["region",    "Region"],
  ["country",   "Country"],
];
const MAIN_FACETS = 4;
const KIND_LABEL = Object.fromEntries(FACET_KINDS);
const IMP_ICON = { core: "●", supporting: "◐", mentioned: "○", "": "·" };

const MODES = [
  ["lexical", "Keyword", "Exact keyword matching (BM25), with a smart OR fallback for recall"],
  ["hybrid",  "Concept", "Every keyword match, then projects about the same thing", " + Keyword"],
];
const DEFAULT_MODE = "lexical";

const state = {
  q: "",
  mode: DEFAULT_MODE,
  filters: {},
  page: 1,
  facetData: {},
  semantic: false,
  wantedMode: DEFAULT_MODE,
  lastRes: null,
  labels: {},
  view: null,
  base: "baseline/",
  fulltextBases: null,
  meta: null,
  posts: [],
  moreFilters: false,
  filtersHidden: false,
};

const $ = (s) => document.querySelector(s);
const pressable = (node) => {
  node.tabIndex = 0;
  node.setAttribute("role", "button");
  node.addEventListener("keydown", (e) => {
    if (e.target === node && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); node.click(); }
  });
  return node;
};
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

let worker = null;
let _lsaModel = null;
let _records = null;

function withTimeout(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

async function fetchGz(url, signal) {
  const r = await fetch(url, { signal, cache: "no-cache" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  if (!url.endsWith(".gz")) return r.json();
  return JSON.parse(await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text());
}

async function fetchTextGz(url) {
  const r = await fetch(url, { signal: withTimeout(20000) });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
}

const BUNDLES = ["cards", "index", "facets", "meta"];

async function loadBundles(base, only, ms) {
  const got = {};
  const signal = ms ? withTimeout(ms) : undefined;
  await Promise.all((only || BUNDLES).map(async (n) => { got[n] = await fetchGz(base + n + ".json.gz", signal); }));
  return got;
}

async function findRemote() {
  for (const origin of DATA_ORIGINS) {
    try {
      const man = await fetchGz(origin + "manifest.json", withTimeout(REMOTE_TIMEOUT));
      if (!man || !man.files) continue;
      if (man.schema !== DATA_SCHEMA) {
        showNote("The database repo publishes a newer data format than this site " +
                 "understands, so the built-in archive is being used.");
        continue;
      }
      return { base: origin, manifest: man };
    } catch (e) {  }
  }
  return null;
}

function changedBundles(local, remote) {
  if (!local || !local.files || !remote || !remote.files) return BUNDLES;
  return BUNDLES.filter((n) => {
    const a = local.files[n], b = remote.files[n];
    return !a || !b || a.sha !== b.sha;
  });
}

async function getRecords() {
  if (!_records) {
    _records = (async () => {
      for (const base of [state.base, "baseline/"]) {
        try {
          const arr = await fetchGz(base + "records.json.gz", withTimeout(90000));
          return new Map(arr.map((r) => [r.id, r]));
        } catch (e) {  }
      }
      return null;
    })();
  }
  const recs = await _records;
  if (!recs) _records = null;
  return recs;
}

const _pending = new Map();
function askWorker(msg) {
  return new Promise((resolve) => {
    const seq = (askWorker._n = (askWorker._n || 0) + 1);
    _pending.set(seq, resolve);
    worker.postMessage(Object.assign({ seq }, msg));
  });
}

function startWorker(data) {
  if (worker) worker.terminate();
  for (const done of _pending.values()) done({ cancelled: true });
  _pending.clear();
  worker = new Worker("assets/search.worker.js?v=d688ce3c");
  worker.onmessage = (ev) => {
    const m = ev.data;
    const done = _pending.get(m.seq);
    if (done) { _pending.delete(m.seq); done(m); }
  };
  worker.postMessage({
    type: "load", cards: data.cards, index: data.index, facets: data.facets,
    fulltextBases: state.fulltextBases,
  });
  const n = (data.meta && data.meta.record_count) || 0;
  if (_lsaModel && _lsaModel.n === n) {
    worker.postMessage({ seq: 0, type: "lsa", model: _lsaModel });
  } else if (_lsaModel) {
    _lsaModel = null; _conceptLoad = null;
    state.semantic = false; state.mode = "lexical";
  }
  state.meta = data.meta;
}

function readURL() {
  const p = new URLSearchParams(location.search);
  state.q = p.get("q") || "";
  state.page = Math.max(1, parseInt(p.get("page") || "1", 10) || 1);
  const m = (p.get("mode") || "").toLowerCase();
  const wanted = MODES.some(([id]) => id === m) ? m : DEFAULT_MODE;
  state.wantedMode = wanted;
  state.mode = state.semantic ? wanted : "lexical";
  const v = p.get("view");
  state.view = v === "custom" ? v : null;
  state.filters = {};
  for (const [k] of FACET_KINDS) {
    const vals = p.getAll(k);
    const vals2 = vals.filter(Boolean);
    if (vals2.length) state.filters[k] = new Set(vals2.map((v) => v.toLowerCase()));
  }
  $("#q").value = state.q;
}
function writeURL(push) {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  const mode = state.semantic ? state.mode : state.wantedMode;
  if (mode !== DEFAULT_MODE) p.set("mode", mode);
  if (state.page > 1) p.set("page", state.page);
  if (state.view) p.set("view", state.view);
  for (const k in state.filters) for (const v of state.filters[k]) p.append(k, v);
  const url = location.pathname + (p.toString() ? "?" + p.toString() : "");
  if (push) history.pushState({}, "", url); else history.replaceState({}, "", url);
}

function hasQuery() {
  return state.q.trim() !== "" || Object.keys(state.filters).length > 0;
}

let _wasActive = false;
function setMode() {
  const active = hasQuery();
  if (active && !_wasActive) state.filtersHidden = false;
  if (!active) {
    $("#facets").classList.remove("open");
    $("#facetsScrim").hidden = true;
  }
  _wasActive = active;
  $("#topbar").classList.toggle("searching", active);
  $("#hero").hidden = active;
  showFilters();
  $("#filterBtn").hidden = !active || !isNarrow();
  $("#resultsHead").hidden = !active;
  $("#pager").hidden = !active;
  const sw = $(".searchwrap");
  const home = active ? $("#headerSearch") : $("#heroSearch");
  if (sw && sw.parentNode !== home) home.appendChild(sw);
  $("#modeToggle").hidden = !(active && state.semantic);
}

function showFilters() {
  const active = hasQuery();
  const narrow = isNarrow();
  const f = $("#facets");
  f.hidden = !active || !$("#customView").hidden || (narrow && !f.classList.contains("open"));
  f.classList.toggle("collapsed", !narrow && state.filtersHidden);
  const btn = $("#facetsToggle");
  btn.hidden = narrow;
  const label = state.filtersHidden ? "Show filters" : "Hide filters";
  btn.title = label; btn.setAttribute("aria-label", label);
  btn.setAttribute("aria-pressed", state.filtersHidden ? "false" : "true");
}

function renderModeToggle() {
  const box = $("#modeToggle");
  if (!state.semantic || !hasQuery()) { box.hidden = true; return; }
  box.hidden = false;
  if (box.children.length !== MODES.length) {
    box.innerHTML = "";
    for (const [id, label, tip, tail] of MODES) {
      const b = el("button", "modebtn", label);
      if (tail) b.appendChild(el("span", "mode-tail", tail));
      b.title = tip;
      b.dataset.mode = id;
      b.setAttribute("role", "tab");
      b.onclick = () => {
        if (state.mode === id) return;
        state.mode = id; state.wantedMode = id; state.page = 1; run(true);
      };
      box.appendChild(b);
    }
  }
  for (const b of box.children) {
    b.classList.toggle("on", state.mode === b.dataset.mode);
    b.setAttribute("aria-selected", state.mode === b.dataset.mode ? "true" : "false");
  }
}

const SORTNOTE = {
  lexical:  "ranked by keyword relevance",
  hybrid:   "keyword matches first, then related projects",
};

function tag(item) {
  const t = el("span", "tag " + (item.importance || "mentioned"));
  const ic = el("i", "ic", IMP_ICON[item.importance] || "·");
  t.appendChild(ic); t.appendChild(document.createTextNode(item.name));
  return t;
}

function renderResults(data) {
  const box = $("#results"); box.innerHTML = "";
  $("#aiNote").hidden = true;
  $("#resultCount").textContent =
    data.total + (data.total === 1 ? " team" : " teams") +
    (state.q ? ` for “${state.q}”` : "");
  if (!data.results.length) {
    box.appendChild(el("div", "empty", "No matching teams. Try fewer or broader terms."));
    $("#pager").innerHTML = ""; return;
  }
  for (const r of data.results) {
    const c = el("div", "card");
    c.dataset.id = r.id;
    c.onclick = () => openTeam(r.id);
    pressable(c);
    const top = el("div", "card-top");
    if (state.q && !r.wiki_only && !r.related) {
      const s = el("span", "sum-star", "★");
      s.title = "Your words are in this team's summary.";
      top.appendChild(s);
    }
    top.appendChild(el("span", "name", r.team_name));
    top.appendChild(el("span", "year", r.year || ""));
    if (r.domain) top.appendChild(el("span", "domain", r.domain));
    if (r.needs_summary) {
      const b = el("span", "needs-sum", "summary needed");
      b.title = "Full wiki text is indexed and searchable; the AI summary hasn't been extracted yet.";
      top.appendChild(b);
    }
    c.appendChild(top);
    if (r.wiki_only && r.wiki_hits) {
      const times = (n) => n + (n === 1 ? " time" : " times");
      const text = r.wiki_parts
        ? "Matched: " + r.wiki_parts.map(([w, n]) => `${w} ${times(n)}`).join(" · ") + "."
        : `Matched: ${times(r.wiki_hits)}.`;
      const m = el("div", "wiki-hits", text);
      m.title = "How many times your words turn up in this team's wiki text.";
      c.appendChild(m);
    }
    if (r.related) {
      const b = el("span", "needs-sum", "related");
      b.title = "Not a keyword match - this project reads as being about the same thing.";
      top.appendChild(b);
    }
    if (r.snippet) c.appendChild(el("div", "snip", r.snippet));
    const tr = el("div", "tagrow");
    (r.chassis || []).forEach((x) => tr.appendChild(tag(x)));
    (r.techniques || []).forEach((x) => tr.appendChild(tag(x)));
    (r.molecules || []).slice(0, 3).forEach((m) => tr.appendChild(tag({ name: m, importance: "core" })));
    c.appendChild(tr);
    box.appendChild(c);
  }
  renderPager(data);
}

function renderPager(data) {
  const pg = $("#pager"); pg.innerHTML = "";
  const pages = Math.max(1, Math.ceil(data.total / data.page_size));
  const prev = el("button", null, "‹ Prev"); prev.disabled = data.page <= 1;
  prev.onclick = () => { state.page--; run(true); window.scrollTo(0, 0); };
  const next = el("button", null, "Next ›"); next.disabled = data.page >= pages;
  next.onclick = () => { state.page++; run(true); window.scrollTo(0, 0); };
  const info = el("span", "info", `page ${data.page} / ${pages}`);
  pg.append(prev, info, next);
}

function renderActiveChips() {
  const boxes = [$("#activeChips"), $("#activeChipsTop")];
  boxes.forEach((b) => { if (b) b.innerHTML = ""; });
  for (const k in state.filters) for (const v of state.filters[k]) {
    for (const box of boxes) {
      if (!box) continue;
      const chip = el("span", "chip");
      chip.appendChild(el("span", "k", KIND_LABEL[k] || k));
      chip.appendChild(document.createTextNode((state.labels[k] && state.labels[k][v]) || v));
      chip.appendChild(el("span", "x", "✕"));
      chip.onclick = () => { toggleFacet(k, v); };
      box.appendChild(chip);
    }
  }
}

const FACET_SHOW = 14;
const FACET_MIN = 3;
const FACET_MIN_KINDS = new Set(["chassis", "molecule", "technique", "part"]);

function renderFacets(data) {
  const wrap = $("#facetGroups"); wrap.innerHTML = "";
  const kinds = data.kinds || {};
  const more = el("div", "facet-extra");
  const extraOn = FACET_KINDS.slice(MAIN_FACETS).some(([k]) => state.filters[k]);
  FACET_KINDS.forEach(([kind, label], n) => {
    const items = (kinds[kind] || []).filter((it) =>
      !FACET_MIN_KINDS.has(kind) || it.count >= FACET_MIN ||
      (state.filters[kind] && state.filters[kind].has(it.key || it.value.toLowerCase())));
    if (!items || !items.length) return;
    state.labels[kind] = state.labels[kind] || {};
    const g = el("div", "facet-group");
    const h = el("h3"); h.appendChild(el("span", null, label));
    const list = el("div", "facet-list");
    h.onclick = () => list.toggleAttribute("hidden");
    pressable(h);
    g.appendChild(h);
    const on = state.filters[kind];
    const lastOn = on ? items.reduce((m, it, i) => on.has(it.key || it.value.toLowerCase()) ? i : m, -1) : -1;
    let shown = Math.max(FACET_SHOW, lastOn + 1);
    const paint = () => {
      list.innerHTML = "";
      for (const it of items.slice(0, shown)) {
        const key = it.key || it.value.toLowerCase();
        state.labels[kind][key] = it.value;
        const on = state.filters[kind] && state.filters[kind].has(key);
        const row = el("div", "facet-item" + (on ? " on" : ""));
        const nm = el("span", "facet-name", it.value); nm.title = it.value;
        row.appendChild(nm);
        row.appendChild(el("span", "cnt", it.count));
        row.onclick = () => toggleFacet(kind, key);
        pressable(row);
        row.setAttribute("aria-pressed", on ? "true" : "false");
        list.appendChild(row);
      }
      if (items.length > shown) {
        const more = el("button", "link facet-more",
          "show " + Math.min(40, items.length - shown) + " more");
        more.onclick = (e) => { e.stopPropagation(); shown += 40; paint(); };
        list.appendChild(more);
      }
    };
    paint();
    g.appendChild(list);
    (n < MAIN_FACETS ? wrap : more).appendChild(g);
  });
  if (!more.children.length) return;
  const open = state.moreFilters || extraOn;
  const btn = el("button", "facet-toggle", open ? "Fewer filters" : "More filters");
  btn.setAttribute("aria-expanded", open ? "true" : "false");
  more.hidden = !open;
  btn.onclick = () => {
    state.moreFilters = more.hidden;
    more.hidden = !more.hidden;
    btn.textContent = more.hidden ? "More filters" : "Fewer filters";
    btn.setAttribute("aria-expanded", more.hidden ? "false" : "true");
  };
  wrap.append(btn, more);
}

function toggleFacet(kind, key) {
  const set = state.filters[kind] || new Set();
  if (set.has(key)) set.delete(key); else set.add(key);
  if (set.size) state.filters[kind] = set; else delete state.filters[kind];
  state.page = 1;
  run(true);
}

let _curTeam = null;

async function openTeam(id) {
  const recs = await getRecords();
  const t = recs && recs.get(id);
  if (!t) return;
  if (_aiAbort) { _aiAbort.abort(); _aiAbort = null; }
  _curTeam = t;
  const p = $("#drawerPanel"); p.innerHTML = "";

  const dh = el("div", "dh");
  dh.appendChild(el("h2", null, t.t));
  dh.appendChild(el("span", "year", t.y || ""));
  const close = el("button", "close", "✕"); close.onclick = closeDrawer; close.setAttribute("aria-label", "Close");
  dh.appendChild(close); p.appendChild(dh);

  const tabs = el("div", "dtabs");
  const panes = el("div", "dpanes");
  const paneDetails = el("div", "dpane on");
  const paneWork = el("div", "dpane workspace-pane");
  const mkTab = (label, pane, onfirst) => {
    const b = el("button", "dtab" + (pane === paneDetails ? " on" : ""), label);
    b.onclick = () => {
      tabs.querySelectorAll(".dtab").forEach((x) => x.classList.remove("on"));
      panes.querySelectorAll(".dpane").forEach((x) => x.classList.remove("on"));
      b.classList.add("on"); pane.classList.add("on");
      if (onfirst && !pane.dataset.init) { pane.dataset.init = "1"; onfirst(pane); }
    };
    tabs.appendChild(b);
  };
  mkTab("Details", paneDetails);
  mkTab("Wiki + Ask AI", paneWork, initWorkspace);
  p.appendChild(tabs);
  panes.append(paneDetails, paneWork);
  p.appendChild(panes);

  buildDetails(paneDetails, t);
  $("#drawer").hidden = false;
  applyDrawerWidth();
}

function buildDetails(p, t) {
  const meta = el("div", "dmeta");
  if (t.application_domain) meta.appendChild(el("span", null, t.application_domain));
  if (t.track && t.track !== t.application_domain) {
    meta.appendChild(el("span", null, "track: " + t.track));
  }
  if (t.f && t.f.country) {
    meta.appendChild(el("span", null, t.f.country[0] + (t.city ? " · " + t.city : "")));
  }
  if (t.f && t.f.section) meta.appendChild(el("span", null, t.f.section[0]));
  if (t.ml) meta.appendChild(el("span", null, "src: " + t.ml));
  if (t.u) { const a = el("a", null, "open wiki ↗"); a.href = t.u; a.target = "_blank"; a.rel = "noopener"; meta.appendChild(a); }
  p.appendChild(meta);

  const sect = (title, node) => { const s = el("div", "sect"); s.appendChild(el("h4", null, title)); s.appendChild(node); p.appendChild(s); };
  const plain = (txt) => String(txt == null ? "" : txt)
    .replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1");
  const para = (txt) => el("p", null, plain(txt));

  if (t.p) sect("Problem", para(t.p));
  if (t.a) sect("Approach", para(t.a));
  if (t.s) sect("Summary", para(t.s));

  const objList = (arr) => {
    const w = el("div", "itemlist");
    arr.forEach((it) => {
      const row = el("div", "item");
      row.appendChild(el("span", "dot " + (it.importance || "mentioned")));
      const body = el("span");
      body.appendChild(el("b", null, it.name + " "));
      if (it.role) body.appendChild(el("span", "role", "- " + it.role));
      row.appendChild(body); w.appendChild(row);
    });
    return w;
  };
  const partsList = (arr) => {
    const w = el("div", "itemlist");
    arr.forEach((it) => {
      const row = el("div", "item");
      row.appendChild(el("span", "dot " + (it.importance || "mentioned")));
      const body = el("span");
      if (it.registry_url) {
        const a = el("a", "partlink"); a.href = it.registry_url; a.target = "_blank"; a.rel = "noopener";
        a.textContent = it.name;
        a.title = "Open " + it.registry_id + " on registry.igem.org";
        body.appendChild(a);
        if (it.registry_id) body.appendChild(el("span", "bba", " " + it.registry_id));
      } else {
        body.appendChild(el("b", null, it.name));
      }
      if (it.role) body.appendChild(el("span", "role", " - " + it.role));
      row.appendChild(body); w.appendChild(row);
    });
    return w;
  };
  const bullets = (arr, cls) => { const ul = el("ul"); arr.forEach((x) => { const li = el("li", cls); li.textContent = plain(x); ul.appendChild(li); }); return ul; };

  if (t.target_molecules && t.target_molecules.length) {
    const w = el("div"); t.target_molecules.forEach((m) => w.appendChild(el("span", "mol", m))); sect("Target molecules", w);
  }
  if (t.chassis_organisms && t.chassis_organisms.length) sect("Chassis organisms", objList(t.chassis_organisms));
  if (t.molecular_techniques && t.molecular_techniques.length) sect("Molecular techniques", objList(t.molecular_techniques));
  if (t.biological_parts && t.biological_parts.length) sect("Biological parts", partsList(t.biological_parts));
  if (t.kr && t.kr.length) sect("Key results", bullets(t.kr));
  if (t.fm && t.fm.length) sect("Failure modes", bullets(t.fm, "fail"));
  if (t.n) sect("Novelty claim", para(t.n));
  if (t.rf && t.rf.length) {
    const ul = el("ul", "refs");
    [...new Set(t.rf.map((x) => plain(x).trim()).filter(Boolean))].forEach((x) => {
      const li = el("li"); li.appendChild(linkify(x)); ul.appendChild(li);
    });
    sect("Key references", ul);
  }
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/g;
function urlRanges(s) {
  const out = [];
  for (const m of s.matchAll(URL_RE)) {
    const u = m[0].replace(/[.,;:!?)\]}"']+$/, "");
    if (u.length > 10) out.push([m.index, m.index + u.length]);
  }
  return out;
}
function linkify(s) {
  const frag = document.createDocumentFragment();
  let at = 0;
  for (const [a, b] of urlRanges(s)) {
    if (a > at) frag.appendChild(document.createTextNode(s.slice(at, a)));
    const link = el("a", null, s.slice(a, b));
    link.href = s.slice(a, b); link.target = "_blank"; link.rel = "noopener";
    frag.appendChild(link);
    at = b;
  }
  if (at < s.length) frag.appendChild(document.createTextNode(s.slice(at)));
  return frag;
}

let _aiFolded = false;
function initWorkspace(pane) {
  const t = _curTeam;
  const split = el("div", "workspace");
  const wikiCol = el("div", "wiki-col");
  const aiCol = el("div", "ai-col");
  const head = el("div", "ai-head");
  const fold = el("button", "facets-toggle ai-toggle");
  fold.type = "button";
  fold.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg>';
  head.append(fold, el("span", "ai-title", "Ask AI"));
  const body = el("div", "ai-body");
  aiCol.append(head, body);
  const paint = () => {
    split.classList.toggle("ai-folded", _aiFolded);
    const label = _aiFolded ? "Show AI chat" : "Hide AI chat";
    fold.title = label; fold.setAttribute("aria-label", label);
    fold.setAttribute("aria-pressed", _aiFolded ? "false" : "true");
  };
  fold.onclick = () => { _aiFolded = !_aiFolded; paint(); };
  paint();
  split.append(wikiCol, aiCol);
  pane.appendChild(split);
  buildWikiView(wikiCol, t);
  initAiPane(body);
}

const WIKI_MOVE_YEAR = 2022;
const PRE2022_NOTE =
  "Some sites may display incorrectly here. If you see a broken or skewed layout, " +
  "click “Open in new tab ↗” above the wiki to view the original site.";

function embedUrl(t) {
  if (t.y >= WIKI_MOVE_YEAR) return t.u;
  return "https://web.archive.org/web/" + t.y + "/" + t.u;
}

function buildWikiView(container, t) {
  if (!t.u) { container.appendChild(el("div", "empty", "No wiki URL on record for this team.")); return; }
  const archived = t.y < WIKI_MOVE_YEAR;
  const bar = el("div", "wiki-bar");
  const modes = el("div", "wiki-modes");
  const liveBtn = el("button", "wiki-mode on", "Live wiki");
  if (t.y < WIKI_MOVE_YEAR) liveBtn.textContent = "Archived wiki";
  const textBtn = el("button", "wiki-mode", "Saved text");
  modes.append(liveBtn, textBtn);
  const open = el("a", "wiki-open", "Open in new tab ↗"); open.href = t.u; open.target = "_blank"; open.rel = "noopener";
  const url = el("a", "wiki-url", t.u); url.href = t.u; url.target = "_blank"; url.rel = "noopener";
  url.title = "Open the wiki in a new tab";
  bar.append(url, modes, open);
  container.appendChild(bar);

  const stage = el("div", "wiki-stage");
  container.appendChild(stage);

  function showLive() {
    liveBtn.classList.add("on"); textBtn.classList.remove("on");
    stage.innerHTML = "";
    if (archived) {
      stage.appendChild(el("div", "wiki-note",
        "Shown from the Internet Archive - igem.org blocks embedding directly. " +
        "It can take a few seconds to load."));
    }
    const frame = el("iframe", "wiki-frame");
    frame.src = embedUrl(t);
    frame.setAttribute("referrerpolicy", "no-referrer");
    stage.appendChild(frame);
  }
  async function showText(auto) {
    textBtn.classList.add("on"); liveBtn.classList.remove("on");
    stage.innerHTML = "";
    stage.appendChild(el("div", "wiki-note", auto
      ? "This wiki cannot be embedded, so here is the full text we saved from it."
      : "Saved offline wiki text from the corpus."));
    const find = el("div", "wiki-find");
    stage.appendChild(find);
    const body = el("div", "wiki-text"); body.textContent = "Loading saved text…";
    stage.appendChild(body);
    const text = await wikiText(t);
    if (!text) {
      body.textContent = text === null
        ? "The saved wiki text could not be loaded right now. Check your connection and try again."
        : "No saved wiki text is stored for this project.";
      find.remove();
      return;
    }
    body.textContent = "";
    body.appendChild(linkify(text));
    buildFind(find, body, text);
  }
  liveBtn.onclick = showLive;
  textBtn.onclick = () => showText(false);
  showLive();
}

const FIND_MAX = 2000;
let _findInput = null;

function buildFind(bar, body, text) {
  const input = el("input", "find-q");
  input.type = "search"; input.placeholder = "Find in wiki text"; input.spellcheck = false;
  const go = el("button", "find-go", "Find");
  const prev = el("button", "find-step", "↑"); prev.title = "Previous (Shift+Enter)";
  const next = el("button", "find-step", "↓"); next.title = "Next (Enter)";
  const count = el("span", "find-count");
  bar.append(input, go, prev, next, count);
  _findInput = input;

  let query = "", marks = [], total = 0, cur = -1;

  function render(q) {
    query = q; cur = -1;
    const hits = [];
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      let m;
      while ((m = re.exec(text)) && hits.length < FIND_MAX + 1) hits.push([m.index, m.index + m[0].length]);
    }
    total = hits.length;
    if (hits.length > FIND_MAX) hits.length = FIND_MAX;

    const frag = document.createDocumentFragment();
    let h = 0;
    const addText = (parent, a, b) => {
      while (a < b) {
        while (h < hits.length && hits[h][1] <= a) h++;
        if (h >= hits.length || hits[h][0] >= b) { parent.appendChild(document.createTextNode(text.slice(a, b))); return; }
        const [ha, hb] = hits[h];
        if (ha > a) parent.appendChild(document.createTextNode(text.slice(a, ha)));
        const e = Math.min(hb, b);
        const mk = el("mark", "find-hit", text.slice(Math.max(ha, a), e));
        mk.dataset.i = h;
        parent.appendChild(mk);
        a = e;
      }
    };
    let at = 0;
    for (const [a, b] of urlRanges(text)) {
      addText(frag, at, a);
      const link = el("a"); link.href = text.slice(a, b); link.target = "_blank"; link.rel = "noopener";
      addText(link, a, b);
      frag.appendChild(link);
      at = b;
    }
    addText(frag, at, text.length);
    body.textContent = "";
    body.appendChild(frag);
    marks = [...body.querySelectorAll("mark.find-hit")];
    step(1);
  }

  function step(dir) {
    const n = Math.min(total, FIND_MAX);
    if (!query) { count.textContent = ""; return; }
    if (!n) { count.textContent = "no matches"; count.classList.add("none"); return; }
    count.classList.remove("none");
    body.querySelectorAll("mark.cur").forEach((m) => m.classList.remove("cur"));
    cur = cur < 0 ? (dir > 0 ? 0 : n - 1) : (cur + dir + n) % n;
    const here = marks.filter((m) => +m.dataset.i === cur);
    here.forEach((m) => m.classList.add("cur"));
    if (here[0]) body.scrollTop = here[0].offsetTop - body.clientHeight / 3;
    count.textContent = (cur + 1) + " / " + n + (total > FIND_MAX ? "+" : "");
  }

  function search(dir) {
    const q = input.value;
    if (q !== query) render(q);
    else step(dir);
  }
  input.addEventListener("input", () => { if (!input.value && query) render(""); });
  go.onclick = () => search(1);
  next.onclick = () => search(1);
  prev.onclick = () => search(-1);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); search(e.shiftKey ? -1 : 1); }
    else if (e.key === "Escape" && (input.value || query)) { e.stopPropagation(); input.value = ""; render(""); }
  });
}

document.addEventListener("wheel", (e) => {
  const f = $("#facets");
  if (!f || f.hidden || isNarrow() || !$("#drawer").hidden) return;
  if (f.contains(e.target) || e.clientX >= f.getBoundingClientRect().right) return;
  f.scrollTop += e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  e.preventDefault();
}, { passive: false });

document.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== "f") return;
  if (!_findInput || !_findInput.isConnected || $("#drawer").hidden) return;
  if (!_findInput.closest(".dpane.on")) return;
  e.preventDefault();
  _findInput.focus(); _findInput.select();
});

const _textCache = new Map();
async function wikiText(t) {
  if (_textCache.has(t.id)) return _textCache.get(t.id);
  const bases = [...new Set([state.base, ...DATA_ORIGINS])].filter((b) => b !== "baseline/");
  let missing = 0;
  for (const base of bases) {
    try {
      const out = await fetchTextGz(base + "fulltext/text/" + t.id + ".txt.gz");
      _textCache.set(t.id, out);
      return out;
    } catch (e) {
      if (/HTTP 404/.test(e.message)) missing++;
    }
  }
  if (missing === bases.length) {
    _textCache.set(t.id, "");
    return "";
  }
  return null;
}

const AI_FORMATS = ["gemini", "openai", "anthropic"];
const AI_CONTEXT = 120000;
const AI_INSTRUCTIONS =
  "You answer questions about one iGEM team project, using only the material below. " +
  "If the material does not contain the answer, say so plainly. Be concise.";
const AI_DEFAULTS = {
  default: "gemini",
  providers: [
    { id: "gemini", label: "Google Gemini", format: "gemini",
      base: "https://generativelanguage.googleapis.com/v1beta",
      models: ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.5-pro"],
      note: "Uses your own Google AI Studio key, free tier.",
      key_placeholder: "Paste your Google AI Studio API key",
      help: "<b>Get a free Gemini API key (stays in your browser only):</b><br>" +
        "1. Open <a href='https://aistudio.google.com/apikey'>aistudio.google.com/apikey</a> and sign in.<br>" +
        "2. Click <b>Create API key</b> (no billing/card needed).<br>" +
        "3. Paste it in the box above. It is saved only in this browser (localStorage) - " +
        "never uploaded to this site or shared. Clear it anytime by emptying the box.<br>" +
        "<i>Free tier uses the Flash models and has per-minute/day limits.</i>" },
    { id: "groq", label: "Groq", format: "openai",
      base: "https://api.groq.com/openai/v1",
      models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
      context_chars: 20000,
      note: "Uses your own Groq key, free tier. Long wikis are cut short to fit its limits.",
      key_placeholder: "Paste your Groq API key",
      help: "<b>Get a free Groq API key:</b><br>" +
        "1. Open <a href='https://console.groq.com/keys'>console.groq.com/keys</a> and sign in.<br>" +
        "2. Click <b>Create API Key</b> and paste it above. It stays in this browser only." },
    { id: "openrouter", label: "OpenRouter", format: "openai",
      base: "https://openrouter.ai/api/v1",
      models: ["openrouter/auto"],
      note: "Uses your own OpenRouter key. Many models, some free.",
      key_placeholder: "Paste your OpenRouter API key",
      help: "<b>Get an OpenRouter API key:</b><br>" +
        "1. Open <a href='https://openrouter.ai/keys'>openrouter.ai/keys</a> and sign in.<br>" +
        "2. Create a key and paste it above. Pick any model name from " +
        "<a href='https://openrouter.ai/models'>openrouter.ai/models</a> under <b>Other model</b>." },
    { id: "openai", label: "OpenAI", format: "openai",
      base: "https://api.openai.com/v1",
      models: ["gpt-4.1-mini", "gpt-4o-mini"],
      note: "Uses your own OpenAI key (paid).",
      key_placeholder: "Paste your OpenAI API key",
      help: "Create a key at <a href='https://platform.openai.com/api-keys'>platform.openai.com/api-keys</a>. It stays in this browser only." },
    { id: "anthropic", label: "Anthropic Claude", format: "anthropic",
      base: "https://api.anthropic.com/v1",
      models: ["claude-haiku-4-5-20251001", "claude-sonnet-5-5"],
      note: "Uses your own Anthropic key (paid).",
      key_placeholder: "Paste your Anthropic API key",
      help: "Create a key at <a href='https://console.anthropic.com/settings/keys'>console.anthropic.com</a>. It stays in this browser only." },
    { id: "custom", label: "Other (OpenAI-compatible)", format: "openai", custom: true,
      base: "", models: [],
      note: "Any service with an OpenAI-style /chat/completions endpoint - DeepSeek, Mistral, Together, a local LM Studio...",
      key_placeholder: "Paste the service's API key",
      help: "Enter the service's API base URL (the part before <b>/chat/completions</b>, " +
        "e.g. <b>https://api.deepseek.com</b>) and a model name, then your key. " +
        "The service has to accept requests from websites; most big ones do." },
  ],
};

function okBase(u) {
  return typeof u === "string" && /^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/)/i.test(u);
}
function cleanProvider(p) {
  if (!p || typeof p !== "object") return null;
  if (typeof p.id !== "string" || !/^[\w-]{1,40}$/.test(p.id)) return null;
  if (!AI_FORMATS.includes(p.format)) return null;
  const custom = p.custom === true;
  if (!custom && !okBase(p.base)) return null;
  const str = (x, d) => (typeof x === "string" ? x : d);
  return {
    id: p.id, format: p.format, custom,
    label: str(p.label, p.id),
    base: custom ? "" : p.base.replace(/\/+$/, ""),
    models: Array.isArray(p.models) ? p.models.filter((m) => typeof m === "string" && m.trim()) : [],
    note: str(p.note, ""),
    key_placeholder: str(p.key_placeholder, "Paste your API key"),
    help: str(p.help, ""),
    context_chars: p.context_chars > 0 ? Math.floor(p.context_chars) : AI_CONTEXT,
  };
}
function aiConfig() {
  const remote = state.site && state.site.ai;
  let list = remote && Array.isArray(remote.providers) ? remote.providers.map(cleanProvider).filter(Boolean) : [];
  let def = remote && remote.default;
  if (!list.length) { list = AI_DEFAULTS.providers.map(cleanProvider); def = AI_DEFAULTS.default; }
  if (!list.some((p) => p.custom) && !(remote && remote.allow_custom === false)) {
    list.push(cleanProvider(AI_DEFAULTS.providers.find((p) => p.custom)));
  }
  const own = remote && typeof remote.instructions === "string" && remote.instructions.trim();
  return { providers: list, default: list.some((p) => p.id === def) ? def : list[0].id,
           instructions: own ? fill(own) : AI_INSTRUCTIONS };
}

function store(k, v) {
  try { if (v === undefined) return localStorage.getItem(k) || ""; localStorage.setItem(k, v); } catch (e) { return ""; }
  return v;
}
const GEM_KEY = "igem_gemini_api_key";
function hostOf(base) { try { return new URL(base).host; } catch (e) { return ""; } }
function keyName(base) { return "igem_ai_key:" + hostOf(base); }
function readKey(base) {
  if (!hostOf(base)) return "";
  const old = store(GEM_KEY).trim();
  if (old) {
    const name = keyName("https://generativelanguage.googleapis.com/");
    if (!store(name).trim()) store(name, old);
    try { localStorage.removeItem(GEM_KEY); } catch (e) { }
  }
  return store(keyName(base)).trim();
}

function aiField(label, node) {
  const w = el("label", "ai-field");
  w.appendChild(el("span", "ai-flabel", label));
  w.appendChild(node);
  return w;
}

const OTHER_MODEL = "\u0000other";
let _aiAbort = null;

function initAiPane(pane) {
  const t = _curTeam;
  const cfg = aiConfig();
  const log = el("div", "ai-log");

  const ctl = el("div", "ai-ctl");
  const provSel = el("select", "ai-prov");
  cfg.providers.forEach((p) => { const o = el("option", null, p.label); o.value = p.id; provSel.appendChild(o); });
  const saved = store("igem_ai_provider");
  provSel.value = cfg.providers.some((p) => p.id === saved) ? saved : cfg.default;
  const modelSel = el("select", "ai-model");
  const modelText = el("input", "ai-url ai-model-name");
  modelText.placeholder = "model name"; modelText.spellcheck = false;
  const modelField = aiField("Model", modelSel);
  modelField.appendChild(modelText);
  ctl.append(aiField("Provider", provSel), modelField);
  pane.appendChild(ctl);

  const baseInput = el("input", "ai-url");
  baseInput.type = "url"; baseInput.spellcheck = false;
  baseInput.placeholder = "https://api.example.com/v1";
  const baseRow = aiField("API base URL", baseInput);
  baseRow.classList.add("ai-baserow");
  pane.appendChild(baseRow);

  const usage = el("div", "ai-usage");
  pane.appendChild(usage);

  const keyRow = el("div", "ai-keyrow");
  const keyInput = el("input", "ai-key");
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  keyInput.spellcheck = false;
  const infoBtn = el("button", "ai-info", "ⓘ");
  infoBtn.type = "button";
  infoBtn.title = "How to get an API key";
  const help = el("div", "ai-help");
  help.hidden = true;
  infoBtn.onclick = () => { help.hidden = !help.hidden; };
  keyRow.append(keyInput, infoBtn);
  pane.appendChild(keyRow);
  pane.appendChild(help);

  const hint = el("div", "ai-hint");
  log.appendChild(hint);
  if (t.y && t.y < 2022) pane.appendChild(el("div", "ai-layout-note", PRE2022_NOTE));
  pane.appendChild(log);

  const prov = () => cfg.providers.find((p) => p.id === provSel.value) || cfg.providers[0];
  const baseOf = (p) => (p.custom ? baseInput.value.trim().replace(/\/+$/, "") : p.base);
  const modelOf = () => (modelSel.hidden || modelSel.value === OTHER_MODEL ? modelText.value.trim() : modelSel.value);

  function paintProvider() {
    const p = prov();
    modelSel.innerHTML = "";
    p.models.forEach((m) => { const x = el("option", null, m); x.value = m; modelSel.appendChild(x); });
    const o = el("option", null, "Other model…"); o.value = OTHER_MODEL; modelSel.appendChild(o);
    modelSel.hidden = !p.models.length;
    const want = store("igem_ai_model:" + p.id);
    if (want && p.models.includes(want)) modelSel.value = want;
    else if (want) { modelSel.value = OTHER_MODEL; modelText.value = want; }
    else { modelText.value = ""; if (p.models.length) modelSel.value = p.models[0]; }
    modelText.hidden = !(modelSel.hidden || modelSel.value === OTHER_MODEL);
    baseRow.hidden = !p.custom;
    if (p.custom) baseInput.value = store("igem_ai_base:" + p.id);
    usage.textContent = p.note;
    usage.hidden = !p.note;
    keyInput.placeholder = p.key_placeholder;
    keyInput.value = readKey(baseOf(p));
    help.innerHTML = sanitize(p.help);
    infoBtn.hidden = !p.help;
    if (!p.help) help.hidden = true;
    hint.textContent = "Answers come only from this project's stored wiki text. The request goes straight " +
      "from your browser to " + (p.custom ? "the service you choose" : p.label) + " with your own key.";
  }
  provSel.onchange = () => { store("igem_ai_provider", provSel.value); paintProvider(); };
  modelSel.onchange = () => {
    modelText.hidden = modelSel.value !== OTHER_MODEL;
    if (modelSel.value !== OTHER_MODEL) store("igem_ai_model:" + prov().id, modelSel.value);
    else modelText.focus();
  };
  modelText.addEventListener("input", () => store("igem_ai_model:" + prov().id, modelText.value.trim()));
  baseInput.addEventListener("input", () => {
    store("igem_ai_base:" + prov().id, baseInput.value.trim());
    const saved = readKey(baseOf(prov()));
    if (saved) keyInput.value = saved;
  });
  keyInput.addEventListener("input", () => {
    const b = baseOf(prov());
    if (hostOf(b)) store(keyName(b), keyInput.value.trim());
  });
  paintProvider();

  const form = el("div", "ai-form");
  const ta = el("textarea", "ai-q");
  ta.placeholder = "Ask about this project - what chassis, what results, what failed?";
  ta.rows = 2;
  const send = el("button", "ai-send", "Ask");
  form.append(ta, send);
  pane.appendChild(form);

  let busy = false;
  const history = [];
  async function ask() {
    const q = ta.value.trim();
    if (!q || busy) return;
    const p = prov();
    const base = baseOf(p);
    const model = modelOf();
    const apiKey = keyInput.value.trim() || readKey(base);
    if (apiKey && hostOf(base)) store(keyName(base), apiKey);
    let missing = "";
    if (p.custom && !okBase(base + "/")) missing = "To answer, I need the service's API base URL - it has to start with https://.";
    else if (!model) missing = "To answer, I need a model name. Type one in the Model box above.";
    else if (!apiKey) missing = "To answer, I need an API key. Paste yours in the box above " +
      "(click ⓘ for a quick setup guide). It is stored only in your browser - never uploaded or shared.";
    if (missing) {
      addMsg(log, "you", q); ta.value = "";
      addMsg(log, "ai", missing);
      return;
    }
    busy = true; send.disabled = true;
    addMsg(log, "you", q); ta.value = "";
    const ans = addMsg(log, "ai", "");
    ans.classList.add("streaming");
    const ctrl = new AbortController();
    _aiAbort = ctrl;
    let answer = "";
    try {
      const text = await wikiText(t);
      if (!text && !history.length) {
        log.insertBefore(el("div", "ai-hint", "The saved wiki text could not be loaded, so this answer " +
          "only uses the project summary."), ans);
      }
      const sys = cfg.instructions + "\n\n" + groundingFor(t, text, p.context_chars);
      answer = await streamChat({ p, base, model, apiKey, sys, history: history.slice(), question: q,
                                  signal: ctrl.signal }, ans, log);
    } catch (e) {
      if (!ctrl.signal.aborted) { ans.classList.add("err"); ans.textContent = "⚠ " + aiError(e, p); }
    }
    if (_aiAbort === ctrl) _aiAbort = null;
    ans.classList.remove("streaming");
    if (answer && !ans.classList.contains("err")) {
      ans.textContent = ""; ans.appendChild(linkify(answer));
      history.push({ role: "user", text: q }, { role: "assistant", text: answer });
      if (history.length > 24) history.splice(0, history.length - 24);
    }
    busy = false; send.disabled = false;
    if (ta.isConnected) ta.focus();
  }
  send.onclick = ask;
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); }
  });
}

function addMsg(log, who, txt) {
  const m = el("div", "ai-msg " + who);
  m.textContent = txt;
  log.appendChild(m);
  log.scrollTop = log.scrollHeight;
  return m;
}

function groundingFor(t, text, limit) {
  const head = [
    "Team: " + t.t + " (" + t.y + ")",
    t.track ? "Track: " + t.track : "",
    t.s ? "Summary: " + t.s : "",
    t.p ? "Problem: " + t.p : "",
    t.a ? "Approach: " + t.a : "",
    (t.kr || []).length ? "Key results:\n- " + t.kr.join("\n- ") : "",
    (t.fm || []).length ? "Failure modes:\n- " + t.fm.join("\n- ") : "",
  ].filter(Boolean).join("\n\n");
  const wiki = (text || "").slice(0, limit || AI_CONTEXT);
  return head + (wiki ? "\n\n--- FULL WIKI TEXT ---\n" + wiki : "");
}

const AI_ADAPTERS = {
  gemini: (r) => ({
    url: r.base + "/models/" + encodeURIComponent(r.model) + ":streamGenerateContent?alt=sse",
    headers: { "x-goog-api-key": r.apiKey },
    body: {
      contents: r.history.map((h) => ({ role: h.role === "assistant" ? "model" : "user", parts: [{ text: h.text }] }))
        .concat([{ role: "user", parts: [{ text: r.question }] }]),
      systemInstruction: { parts: [{ text: r.sys }] },
    },
    text: (o) => ((((o.candidates || [])[0] || {}).content || {}).parts || []).map((b) => b.text || "").join(""),
  }),
  openai: (r) => ({
    url: r.base + "/chat/completions",
    headers: { Authorization: "Bearer " + r.apiKey },
    body: {
      model: r.model, stream: true,
      messages: [{ role: "system", content: r.sys }]
        .concat(r.history.map((h) => ({ role: h.role, content: h.text })))
        .concat([{ role: "user", content: r.question }]),
    },
    text: (o) => (((o.choices || [])[0] || {}).delta || {}).content || "",
  }),
  anthropic: (r) => ({
    url: r.base + "/messages",
    headers: { "x-api-key": r.apiKey, "anthropic-version": "2023-06-01",
               "anthropic-dangerous-direct-browser-access": "true" },
    body: {
      model: r.model, max_tokens: 2048, stream: true, system: r.sys,
      messages: r.history.map((h) => ({ role: h.role, content: h.text }))
        .concat([{ role: "user", content: r.question }]),
    },
    text: (o) => (o.type === "content_block_delta" && o.delta && o.delta.text) || "",
  }),
};

class AiError extends Error {
  constructor(status, detail) { super(detail || ""); this.status = status; }
}

function aiError(e, p) {
  const name = p.custom ? "The service" : p.label;
  const detail = e && e.message ? " (" + String(e.message).slice(0, 300) + ")" : "";
  if (!(e instanceof AiError)) {
    return "Could not reach " + (p.custom ? "that address" : p.label) + ". Check your connection - " +
      "or the service does not accept requests from websites.";
  }
  if (e.status === 401 || e.status === 403) return name + " rejected that API key. Check it in the box above." + detail;
  if (e.status === 429) return name + " says you hit its rate limit. Wait a minute and try again." + detail;
  if (e.status === 404) return name + " does not know that model or address." + detail;
  if (e.status === 400) return name + " refused the request" + detail +
    ". If it mentions length or tokens, this wiki is too long for that model.";
  if (e.status === "stream") return name + " stopped with an error" + detail + ".";
  return name + " answered with an error" + (e.status ? " " + e.status : "") + detail + ".";
}

async function streamChat(r, ansEl, log) {
  const a = AI_ADAPTERS[r.p.format](r);
  let resp;
  try {
    resp = await fetch(a.url, {
      method: "POST", signal: r.signal,
      headers: Object.assign({ "Content-Type": "application/json" }, a.headers),
      body: JSON.stringify(a.body),
    });
  } catch (e) {
    if (r.signal.aborted) throw e;
    throw new TypeError(String(e));
  }
  if (!resp.ok) {
    let msg = "";
    try {
      const raw = await resp.text();
      try { const j = JSON.parse(raw); const x = Array.isArray(j) ? j[0] : j; msg = (x.error && (x.error.message || x.error)) || x.message || ""; }
      catch (e) { msg = raw.slice(0, 200); }
    } catch (e) {  }
    throw new AiError(resp.status, typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  let acc = "";
  await readEvents(resp, (o) => {
    if (o.error || o.type === "error") {
      const er = o.error || {};
      throw new AiError("stream", er.message || String(er));
    }
    const bit = a.text(o);
    if (bit) { acc += bit; ansEl.textContent = acc; log.scrollTop = log.scrollHeight; }
  });
  if (!acc) ansEl.textContent = "(no answer)";
  return acc;
}

async function readEvents(resp, onEvent) {
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const handle = (block) => {
    const data = block.split("\n").filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    if (!data || data === "[DONE]") return;
    let obj;
    try { obj = JSON.parse(data); } catch (e) { return; }
    onEvent(obj);
  };
  let cr = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    let s = cr + dec.decode(value, { stream: true });
    cr = s.endsWith("\r") ? "\r" : "";
    if (cr) s = s.slice(0, -1);
    buf += s.replace(/\r\n?/g, "\n");
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, idx); buf = buf.slice(idx + 2);
      handle(block);
    }
  }
  buf += (cr + dec.decode()).replace(/\r\n?/g, "\n");
  if (buf.trim()) handle(buf);
}

function closeDrawer() {
  $("#drawer").hidden = true;
  if (_aiAbort) { _aiAbort.abort(); _aiAbort = null; }
  const f = $("#drawerPanel").querySelector("iframe.wiki-frame");
  if (f) f.src = "about:blank";
}

const DW_KEY = "igem_drawer_width";
function clampDrawerW(w) {
  const min = Math.min(420, window.innerWidth);
  return Math.max(min, Math.min(w, window.innerWidth - 24));
}
function applyDrawerWidth(w) {
  const panel = $("#drawerPanel"), rz = $("#drawerResizer");
  if (!panel) return 0;
  if (w == null) {
    const saved = parseInt(store(DW_KEY), 10);
    w = saved > 0 ? saved : panel.getBoundingClientRect().width;
  }
  w = clampDrawerW(w);
  panel.style.width = w + "px";
  if (rz) rz.style.right = w + "px";
  return w;
}
function initDrawerResize() {
  const rz = $("#drawerResizer"); if (!rz) return;
  let dragging = false, cur = 0;
  const start = (e) => { dragging = true; document.body.classList.add("resizing-drawer"); e.preventDefault(); };
  const move = (e) => {
    if (!dragging) return;
    const x = e.touches ? e.touches[0].clientX : e.clientX;
    cur = applyDrawerWidth(window.innerWidth - x);
  };
  const end = () => {
    if (!dragging) return;
    dragging = false; document.body.classList.remove("resizing-drawer");
    if (cur) store(DW_KEY, String(Math.round(cur)));
  };
  rz.addEventListener("mousedown", start);
  rz.addEventListener("touchstart", start, { passive: false });
  document.addEventListener("mousemove", move);
  document.addEventListener("touchmove", move, { passive: false });
  document.addEventListener("mouseup", end);
  document.addEventListener("touchend", end);
  window.addEventListener("resize", () => { if (!$("#drawer").hidden) applyDrawerWidth(); });
}

let _customLoaded = null, _customLoad = null;

function setFrame(html) {
  const old = $("#customFrame");
  const f = old.cloneNode(false);
  f.srcdoc = html;
  old.replaceWith(f);
}
const frameNote = (msg) => "<p style='font:14px system-ui;padding:24px;color:#565a61'>" + msg + "</p>";

function loadCustom(page) {
  if (_customLoad && _customLoad.page === page) return _customLoad.done;
  setFrame(frameNote("Loading…"));
  const done = (async () => {
    let html = null;
    for (const base of new Set([state.base, ...DATA_ORIGINS])) {
      if (base === "baseline/") continue;
      try {
        const r = await fetch(base + page, { signal: withTimeout(REMOTE_TIMEOUT) });
        const text = r.ok ? await r.text() : "";
        if (text.trim()) { html = text; break; }
      } catch (e) {  }
    }
    _customLoad = null;
    if (html) { setFrame(fill(html)); _customLoaded = page; }
    else setFrame(frameNote("This page is not available right now."));
  })();
  _customLoad = { page, done };
  return done;
}

async function openCustom(page, push) {
  const again = state.view === "custom";
  state.view = "custom";
  if (push !== false && !again) writeURL(true);
  if (_customLoaded !== page) loadCustom(page);
  $("#content").hidden = true;
  $("#facets").hidden = true;
  $("#customView").hidden = false;
  $("#customBtn").classList.add("on");
}
function closeCustom() {
  $("#customView").hidden = true;
  $("#content").hidden = false;
  $("#customBtn").classList.remove("on");
  if (state.view === "custom") state.view = null;
}

let _runSeq = 0;
async function run(push) {
  const seq = ++_runSeq;
  const wanted = push ? null : state.view;
  closeCustom();
  setMode();
  renderModeToggle();
  state.view = wanted;
  writeURL(push);
  if (!hasQuery()) {
    $("#results").innerHTML = ""; $("#pager").innerHTML = "";
    restoreView(wanted);
    return;
  }
  const filters = {};
  for (const k in state.filters) filters[k] = Array.from(state.filters[k]);
  const m = await askWorker({
    type: "search", q: state.q, filters, page: state.page,
    pageSize: PAGE_SIZE, mode: state.mode,
  });
  if (seq !== _runSeq) return;
  if (m.cancelled) return;
  if (m.error) showNote("That search hit a problem: " + m.error);
  $("#sortnote").textContent = SORTNOTE[m.mode] || SORTNOTE.lexical;
  if (m.page && m.page !== state.page) { state.page = m.page; writeURL(false); }
  const res = { total: m.total, page: m.page, page_size: PAGE_SIZE, results: m.results };
  renderResults(res);
  state.lastRes = res;
  state.facetData = { kinds: m.facets };
  renderFacets(state.facetData);
  renderActiveChips();
  restoreView(wanted);
}

function restoreView(wanted) {
  if (wanted === "custom") {
    const nav = (state.site && state.site.nav_button) || {};
    if (nav.enabled && nav.page) openCustom(nav.page, false);
  }
}

const BLOG_INITIAL = 3, BLOG_STEP = 10;
let blogShown = BLOG_INITIAL;

function placeholderImage(seed) {
  const hues = [["#eaf1eb", "#1f6b45"], ["#eff1e8", "#5a6a2e"],
                ["#ece9f1", "#4b3e7a"], ["#f1ede7", "#9a6a1e"]];
  const [bg, ink] = hues[seed % hues.length];
  let lines = "";
  for (let x = 32; x < 800; x += 32) lines += `<line x1='${x}' y1='0' x2='${x}' y2='500'/>`;
  for (let y = 32; y < 500; y += 32) lines += `<line x1='0' y1='${y}' x2='800' y2='${y}'/>`;
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 500'>` +
    `<rect width='800' height='500' fill='${bg}'/>` +
    `<g stroke='${ink}' stroke-opacity='0.09' stroke-width='1'>${lines}</g>` +
    `<line x1='60' y1='0' x2='60' y2='500' stroke='${ink}' stroke-opacity='0.22' stroke-width='1.5'/></svg>`;
  return "data:image/svg+xml," + encodeURIComponent(svg);
}

const ALLOWED = new Set(["P", "H3", "H4", "UL", "OL", "LI", "STRONG", "EM", "B", "I",
                         "BLOCKQUOTE", "A", "CODE", "PRE", "BR", "HR", "IMG", "FIGURE", "FIGCAPTION"]);
const DROPPED = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH", "TEMPLATE",
                         "NOSCRIPT", "FRAME", "FRAMESET", "LINK", "META", "BASE", "FORM", "TEXTAREA", "SELECT"]);
function sanitize(html) {
  const doc = new DOMParser().parseFromString("<div>" + (html || "") + "</div>", "text/html");
  const walk = (node) => {
    for (const child of Array.from(node.children)) {
      if (DROPPED.has(child.tagName.toUpperCase())) { child.remove(); continue; }
      if (!ALLOWED.has(child.tagName)) { walk(child); child.replaceWith(...child.childNodes); continue; }
      for (const attr of Array.from(child.attributes)) {
        const ok = (child.tagName === "A" && attr.name === "href" && /^https?:/i.test(attr.value)) ||
                   (child.tagName === "IMG" && attr.name === "src" && /^https?:|^data:image\//i.test(attr.value)) ||
                   (child.tagName === "IMG" && attr.name === "alt");
        if (!ok) child.removeAttribute(attr.name);
      }
      if (child.tagName === "A") { child.target = "_blank"; child.rel = "noopener noreferrer"; }
      walk(child);
    }
  };
  walk(doc.body.firstChild);
  return doc.body.firstChild.innerHTML;
}

function fmtPostDate(s) {
  const d = new Date(s);
  const opts = { day: "numeric", month: "long", year: "numeric" };
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(s))) opts.timeZone = "UTC";
  return isNaN(d) ? (s || "") : d.toLocaleDateString("en-GB", opts);
}

function renderBlog() {
  const section = $("#blog");
  const posts = state.posts || [];
  if (!posts.length) { section.hidden = true; return; }
  section.hidden = false;
  const order = posts.map((p, i) => ({ p, i }))
    .sort((a, b) => (b.p.pinned ? 1 : 0) - (a.p.pinned ? 1 : 0));
  const list = $("#blogList");
  list.innerHTML = "";
  for (const { p, i } of order.slice(0, blogShown)) {
    const card = el("article", "post-card");
    card.tabIndex = 0;
    const img = el("img", "post-thumb");
    img.loading = "lazy";
    img.src = p.image || placeholderImage(i);
    img.alt = "";
    card.appendChild(img);
    const body = el("div", "post-body");
    const meta = el("div", "post-meta");
    if (p.pinned) meta.appendChild(el("span", "post-pin", "Pinned"));
    meta.appendChild(el("span", null, [p.author, fmtPostDate(p.date)].filter(Boolean).join(" · ")));
    body.appendChild(meta);
    body.appendChild(el("h3", "post-title", fill(p.title) || "Untitled"));
    body.appendChild(el("p", "post-abstract", fill(p.abstract)));
    body.appendChild(el("span", "post-more", "Read article →"));
    card.appendChild(body);
    card.onclick = () => openPost(p, i);
    card.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openPost(p, i); } };
    list.appendChild(card);
  }
  const more = $("#blogMore");
  more.innerHTML = "";
  if (order.length > blogShown) {
    const b = el("button", "blog-more-btn", "↓ more posts");
    b.onclick = () => { blogShown += BLOG_STEP; renderBlog(); };
    more.appendChild(b);
  }
}

function openPost(p, i) {
  const panel = $("#readerPanel");
  panel.innerHTML = "";
  const close = el("button", "reader-close", "✕");
  close.setAttribute("aria-label", "Close");
  close.onclick = closeReader;
  panel.appendChild(close);
  const hero = el("img", "reader-hero");
  hero.src = p.image || placeholderImage(i);
  hero.alt = "";
  panel.appendChild(hero);
  panel.appendChild(el("div", "reader-meta",
    [p.author, fmtPostDate(p.date)].filter(Boolean).join(" · ")));
  panel.appendChild(el("h1", "reader-title", fill(p.title) || "Untitled"));
  const content = el("div", "reader-content");
  content.innerHTML = sanitize(fill(p.body));
  panel.appendChild(content);
  $("#blogReader").hidden = false;
  document.body.style.overflow = "hidden";
  close.focus();
}
function closeReader() {
  $("#blogReader").hidden = true;
  document.body.style.overflow = "";
}

function applyMeta(meta) {
  if (!meta) return;
  const n = (x) => (x || 0).toLocaleString("en-US").replace(/,/g, " ");
  const years = $("#heroYears");
  if (years) years.textContent = meta.year_range || "2008-2025";
  const d = meta.distinct || {};
  const segs = [
    n(meta.record_count) + " projects",
    (meta.years || []).length + " years (" + (meta.year_range || "") + ")",
    n(d.molecule) + " molecules", n(d.chassis) + " chassis",
    n(d.technique) + " techniques", n(d.part) + " parts",
  ];
  paintStats(segs);
}

function fill(text) {
  const m = state.meta || {};
  const d = m.distinct || {};
  const years = m.years || [];
  const hero = (state.site && state.site.hero) || {};
  const n = (x) => (x || 0).toLocaleString("en-US");
  const vals = {
    projects: n(m.record_count),
    years: String(years.length),
    year_range: hero.year_range || m.year_range || "",
    first_year: years.length ? String(years[0]) : "",
    last_year: years.length ? String(years[years.length - 1]) : "",
    molecules: n(d.molecule),
    chassis: n(d.chassis),
    techniques: n(d.technique),
    parts: n(d.part),
  };
  return String(text == null ? "" : text).replace(/\{\{\s*(\w+)\s*\}\}/g,
    (all, k) => (Object.prototype.hasOwnProperty.call(vals, k) ? vals[k] : all));
}

function paintStats(segs) {
  const hs = $("#heroStats");
  hs.innerHTML = "";
  segs.forEach((s) => hs.appendChild(el("span", "seg", String(s))));
}

function applySite(site) {
  if (!site || typeof site !== "object") return;
  state.site = site;
  const hero = site.hero || {};
  if (typeof hero.title === "string" && hero.title.trim()) $("#hero h1").textContent = fill(hero.title);
  if (typeof hero.text === "string" && hero.text.trim()) $("#hero > p").innerHTML = sanitize(fill(hero.text));
  else if (hero.year_range && $("#heroYears")) $("#heroYears").textContent = hero.year_range;
  if (typeof hero.placeholder === "string" && hero.placeholder.trim()) $("#q").placeholder = fill(hero.placeholder);
  if (site.stats && Array.isArray(site.stats.segments) && site.stats.segments.length) {
    paintStats(site.stats.segments.map(fill));
  }
  const nav = site.nav_button || {};
  const btn = $("#customBtn");
  if (nav.enabled && nav.page) {
    btn.textContent = nav.label || "More";
    btn.hidden = false;
    btn.onclick = () => openCustom(nav.page);
    if (state.view === "custom" && $("#customView").hidden) openCustom(nav.page, false);
  } else {
    btn.hidden = true;
  }
  applyFooter(site.footer);
}

function setNote(box, text) {
  const parts = String(text).split(". ")
    .map((s, i, all) => (i < all.length - 1 ? s + "." : s))
    .filter(Boolean);
  box.innerHTML = "";
  parts.forEach((sent, i) => {
    if (i) box.appendChild(document.createTextNode(" "));
    box.appendChild(el("span", "fsent", sent));
  });
}

function applyFooter(f) {
  if (!f) return;
  if (f.enabled === false) { $("#siteFooter").hidden = true; return; }
  if (typeof f.note === "string") setNote($("#footerNote"), fill(f.note));
  if (typeof f.legal === "string") $("#footerLegal").textContent = fill(f.legal);
  if (typeof f.copyright === "string") $("#footerCopy").textContent = f.copyright;
  if (Array.isArray(f.links)) {
    const box = $("#footerLinks");
    box.innerHTML = "";
    for (const l of f.links) {
      if (!l || !l.label) continue;
      const linked = l.url && /^https?:/i.test(l.url);
      if (l.prefix) {
        const wrap = el("span", "footer-pair", l.prefix);
        if (linked) {
          const a = el("a", null, l.label);
          a.href = l.url; a.target = "_blank"; a.rel = "noopener noreferrer";
          wrap.appendChild(a);
        } else {
          wrap.appendChild(el("span", null, l.label));
        }
        box.appendChild(wrap);
      } else if (linked) {
        const a = el("a", null, l.label);
        a.href = l.url; a.target = "_blank"; a.rel = "noopener noreferrer";
        box.appendChild(a);
      } else {
        box.appendChild(el("span", null, l.label));
      }
    }
  }
}

async function loadRemoteContent(base) {
  try {
    const r = await fetch(base + "site.json", { signal: withTimeout(REMOTE_TIMEOUT), cache: "no-cache" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    showUpdated(r.headers.get("last-modified"));
    applySite(await r.json());
  } catch (e) {  }
  try {
    const d = await fetchGz(base + "posts.json", withTimeout(20000));
    state.posts = Array.isArray(d) ? d : (d.posts || []);
    renderBlog();
  } catch (e) {  }
}

let _conceptLoad = null;
async function loadConcept(base) {
  if (_conceptLoad) await _conceptLoad.catch(() => {});
  if (state.semantic) return;
  _conceptLoad = (async () => {
    const model = await fetchGz(base + "lsa.json.gz");
    const n = (state.meta && state.meta.record_count) || 0;
    if (model.n !== n) return;
    const ok = await askWorker({ type: "lsa", model });
    if (!(ok && ok.ok) || state.semantic) return;
    _lsaModel = model;
    state.semantic = true;
    if (state.wantedMode === "hybrid" && state.mode !== "hybrid") {
      state.mode = "hybrid";
      if (hasQuery()) { run(false); return; }
    }
    renderModeToggle();
    setMode();
  })();
  try { await _conceptLoad; } catch (e) {  }
}

function showUpdated(httpDate) {
  if (!httpDate) return;
  const d = new Date(httpDate);
  if (isNaN(d)) return;
  const when = d.toLocaleString("en-GB", {
    day: "numeric", month: "long", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
  $("#footerUpdated").textContent = "Last updated: " + when;
}

function showNote(msg) {
  const n = $("#dataNote");
  n.textContent = msg;
  n.hidden = false;
  setTimeout(() => { n.hidden = true; }, 9000);
}

const isNarrow = () => window.matchMedia("(max-width: 880px)").matches;

async function boot() {
  bindUI();
  initDrawerResize();

  let data = null, localManifest = null;
  try {
    [data, localManifest] = await Promise.all([
      loadBundles("baseline/"),
      fetchGz("baseline/manifest.json").catch(() => null),
    ]);
  } catch (e) {
    showNote("The bundled data could not be read. The page cannot search.");
    return;
  }
  startWorker(data);
  applyMeta(data.meta);
  const typed = $("#q").value;
  readURL();
  if (!state.q && typed) $("#q").value = typed;
  await run(false);
  loadConcept("baseline/");

  const remote = await findRemote();
  if (!remote) {
    const yr = data.meta && data.meta.year_range;
    if ($("#dataNote").hidden) showNote("Showing the built-in " + (yr ? yr + " " : "") + "archive (database repo unreachable).");
    return;
  }
  state.base = remote.base;
  const changed = changedBundles(localManifest, remote.manifest);
  const remoteRecords = remote.manifest.records;
  const localRecords = (data.meta && data.meta.record_count) || 0;
  if (changed.length || remoteRecords === localRecords) {
    state.fulltextBases = [remote.base, ...DATA_ORIGINS.filter((o) => o !== remote.base)];
  }
  if (changed.length) {
    try {
      const fresh = await loadBundles(remote.base, changed, 90000);
      startWorker(Object.assign({}, data, fresh));
      if (fresh.meta) applyMeta(fresh.meta);
      _records = null;
      await run(false);
    } catch (e) {  }
  }
  if (!changed.length && state.fulltextBases) {
    worker.postMessage({ type: "fulltext", bases: state.fulltextBases });
    if (hasQuery()) run(false);
  }
  loadRemoteContent(remote.base);
  loadConcept(remote.base);
}

function bindUI() {
  const go = () => { state.q = $("#q").value; state.page = 1; run(true); };
  $("#searchBtn").onclick = go;
  $("#q").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.isComposing) go(); });
  pressable($("#brandHome"));
  $("#brandHome").onclick = () => {
    state.q = ""; state.filters = {}; state.page = 1; state.view = null;
    $("#q").value = "";
    run(true);
  };
  $("#clearFilters").onclick = () => { state.filters = {}; state.page = 1; run(true); };

  const showFacets = () => {
    $("#facets").hidden = false;
    $("#facets").classList.add("open");
    $("#facetsScrim").hidden = false;
  };
  const hideFacets = () => {
    $("#facets").classList.remove("open");
    $("#facetsScrim").hidden = true;
    if (isNarrow()) $("#facets").hidden = true;
  };
  $("#filterBtn").onclick = showFacets;
  $("#facetsScrim").onclick = hideFacets;
  $("#facetsToggle").onclick = () => { state.filtersHidden = !state.filtersHidden; showFilters(); };
  $("#closeFacets").onclick = hideFacets;

  $("#drawer").querySelector(".drawer-bg").onclick = closeDrawer;
  $("#blogReader").querySelector(".reader-bg").onclick = closeReader;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || e.isComposing) return;
    if (!$("#blogReader").hidden) closeReader();
    else if (!$("#drawer").hidden) closeDrawer();
    else if (!$("#customView").hidden) { state.view = null; run(true); }
  });
  window.addEventListener("popstate", () => { readURL(); run(false); });
  window.addEventListener("resize", () => {
    if (!hasQuery()) return;
    if (!isNarrow()) {
      $("#facets").classList.remove("open");
      $("#filterBtn").hidden = true;
      $("#facetsScrim").hidden = true;
    } else if (!$("#facets").classList.contains("open")) {
      $("#filterBtn").hidden = false;
    }
    showFilters();
  });
}

boot();
