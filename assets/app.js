"use strict";
// iGEM Intelligence Machine - frontend (vanilla JS, no build step)
//
// Same UI as the local version. What changed is where the data comes from: the
// search index is loaded into the page and queried in a worker, instead of a
// Python server. baseline/ ships with the site and always works; the database
// repo on GitHub can serve newer bundles on top of it.

const DATA_ORIGINS = [
  "https://tarmaska11.github.io/igem-intelligence-machine-db/",
  "https://raw.githubusercontent.com/Tarmaska11/igem-intelligence-machine-db/main/",
];
// The bundle shape this build of the site understands. A database repo serving
// anything else is ignored, so a bad publish years from now cannot break the page.
const DATA_SCHEMA = 2;
const REMOTE_TIMEOUT = 6000;
const PAGE_SIZE = 20;

const FACET_KINDS = [
  ["molecule",  "Target molecule"],
  ["chassis",   "Chassis organism"],
  ["technique", "Molecular technique"],
  ["part",      "Biological part"],
  ["domain",    "Application domain"],
  ["track",     "Track"],
  ["year",      "Year"],
  ["region",    "Region"],
  ["country",   "Country"],
  ["section",   "Team section"],
  ["failures",  "Documented failures"],
];
const IMP_ICON = { core: "●", supporting: "◐", mentioned: "○", "": "·" };

// Two search modes: Keyword (default, exact term matching) and Concept + Keyword
// (blends keyword hits with conceptually related teams via LSA). The second needs
// the LSA model; without it only Keyword is offered.
const MODES = [
  ["lexical", "Keyword", "Exact keyword matching (BM25), with a smart OR fallback for recall"],
  // the tail is split off so a narrow phone can drop it and still fit the
  // switch next to the nav buttons
  ["hybrid",  "Concept", "Every keyword match, then projects about the same thing", " + Keyword"],
];
const DEFAULT_MODE = "lexical";

const state = {
  q: "",
  mode: DEFAULT_MODE,
  filters: {},          // kind -> Set(facet key)
  page: 1,
  facetData: {},
  semantic: false,      // whether the LSA model loaded
  wantedMode: DEFAULT_MODE,   // mode asked for in the URL, applied once it can be
  lastRes: null,
  labels: {},           // kind -> {key: display label}
  view: null,           // "custom" or "parts" when one of those pages is open
  base: "baseline/",    // where wiki text and the LSA model come from
  fulltextBases: null,  // set only once a database repo has been accepted
  meta: null,
  posts: [],
};

const $ = (s) => document.querySelector(s);
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

// ---------- data layer ----------
let worker = null;
let _lsaModel = null;   // kept so a worker restart can reload it
let _records = null;
let _partsData = null;

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

async function loadBundles(base, only) {
  const got = {};
  await Promise.all((only || BUNDLES).map(async (n) => { got[n] = await fetchGz(base + n + ".json.gz"); }));
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
    } catch (e) { /* try the next origin */ }
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
  if (_records) return _records;
  for (const base of [state.base, "baseline/"]) {
    try {
      const arr = await fetchGz(base + "records.json.gz");
      _records = new Map(arr.map((r) => [r.id, r]));
      return _records;
    } catch (e) { /* fall through to the bundled copy */ }
  }
  return null;
}

async function getParts() {
  if (_partsData) return _partsData;
  for (const base of [state.base, "baseline/"]) {
    try { _partsData = await fetchGz(base + "parts.json.gz"); return _partsData; }
    catch (e) { /* fall through */ }
  }
  return null;
}

// search goes through the worker; one message answers results + facets together
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
  worker = new Worker("assets/search.worker.js?v=8629a4a5");
  worker.onmessage = (ev) => {
    const m = ev.data;
    const done = _pending.get(m.seq);
    if (done) { _pending.delete(m.seq); done(m); }
  };
  worker.postMessage({
    type: "load", cards: data.cards, index: data.index, facets: data.facets,
    fulltextBases: state.fulltextBases,
  });
  // a fresh worker starts without the concept model, so hand it back
  if (_lsaModel) worker.postMessage({ seq: 0, type: "lsa", model: _lsaModel });
  state.meta = data.meta;
}

// ---------- URL state (shareable / back-button) ----------
function readURL() {
  const p = new URLSearchParams(location.search);
  state.q = p.get("q") || "";
  state.page = parseInt(p.get("page") || "1", 10) || 1;
  const m = p.get("mode");
  const wanted = MODES.some(([id]) => id === m) ? m : DEFAULT_MODE;
  state.wantedMode = wanted;
  state.mode = state.semantic ? wanted : "lexical";
  const v = p.get("view");
  state.view = (v === "custom" || v === "parts") ? v : null;
  state.filters = {};
  for (const [k] of FACET_KINDS) {
    const vals = p.getAll(k);
    if (vals.length) state.filters[k] = new Set(vals.map((v) => v.toLowerCase()));
  }
  $("#q").value = state.q;
}
function writeURL(push) {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.mode !== DEFAULT_MODE) p.set("mode", state.mode);
  if (state.page > 1) p.set("page", state.page);
  if (state.view) p.set("view", state.view);
  for (const k in state.filters) for (const v of state.filters[k]) p.append(k, v);
  const url = location.pathname + (p.toString() ? "?" + p.toString() : "");
  if (push) history.pushState({}, "", url); else history.replaceState({}, "", url);
}

// ---------- rendering ----------
function hasQuery() {
  return state.q.trim() !== "" || Object.keys(state.filters).length > 0;
}

function setMode() {
  const active = hasQuery();
  $("#topbar").classList.toggle("searching", active);
  $("#hero").hidden = active;
  $("#facets").hidden = !active || (isNarrow() && !$("#facets").classList.contains("open"));
  $("#filterBtn").hidden = !active || !isNarrow();
  $("#resultsHead").hidden = !active;
  $("#pager").hidden = !active;
  // one search control, relocated: hero on home, header when showing results
  const sw = $(".searchwrap");
  if (sw) (active ? $("#headerSearch") : $("#heroSearch")).appendChild(sw);
  $("#modeToggle").hidden = !(active && state.semantic);
}

function renderModeToggle() {
  const box = $("#modeToggle");
  if (!state.semantic || !hasQuery()) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = "";
  for (const [id, label, tip, tail] of MODES) {
    const b = el("button", "modebtn" + (state.mode === id ? " on" : ""), label);
    if (tail) b.appendChild(el("span", "mode-tail", tail));
    b.title = tip;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", state.mode === id ? "true" : "false");
    b.onclick = () => {
      if (state.mode === id) return;
      state.mode = id; state.page = 1; run(true);
    };
    box.appendChild(b);
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
  // the second row sits above the results and only shows on a narrow screen,
  // where the filter panel is off-canvas and you cannot see what is applied
  const boxes = [$("#activeChips"), $("#activeChipsTop")];
  boxes.forEach((b) => { if (b) b.innerHTML = ""; });
  for (const k in state.filters) for (const v of state.filters[k]) {
    for (const box of boxes) {
      if (!box) continue;
      const chip = el("span", "chip");
      chip.appendChild(el("span", "k", k));
      chip.appendChild(document.createTextNode((state.labels[k] && state.labels[k][v]) || v));
      chip.appendChild(el("span", "x", "✕"));
      chip.onclick = () => { toggleFacet(k, v); };
      box.appendChild(chip);
    }
  }
}

const FACET_SHOW = 14;

function renderFacets(data) {
  const wrap = $("#facetGroups"); wrap.innerHTML = "";
  const kinds = data.kinds || {};
  for (const [kind, label] of FACET_KINDS) {
    const items = kinds[kind];
    if (!items || !items.length) continue;
    state.labels[kind] = state.labels[kind] || {};
    const g = el("div", "facet-group");
    const h = el("h3"); h.appendChild(el("span", null, label));
    const list = el("div", "facet-list");
    h.onclick = () => list.toggleAttribute("hidden");
    g.appendChild(h);
    let shown = FACET_SHOW;
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
    wrap.appendChild(g);
  }
}

function toggleFacet(kind, key) {
  const set = state.filters[kind] || new Set();
  if (set.has(key)) set.delete(key); else set.add(key);
  if (set.size) state.filters[kind] = set; else delete state.filters[kind];
  state.page = 1;
  run(true);
}

// ---------- team drawer (tabs: Details / Wiki + Ask AI) ----------
let _curTeam = null;

async function openTeam(id) {
  const recs = await getRecords();
  const t = recs && recs.get(id);
  if (!t) return;
  _curTeam = t;
  const p = $("#drawerPanel"); p.innerHTML = "";

  const dh = el("div", "dh");
  dh.appendChild(el("h2", null, t.t));
  dh.appendChild(el("span", "year", t.y || ""));
  const close = el("button", "close", "✕"); close.onclick = closeDrawer;
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
  // the track and the domain are often the same word - saying it twice reads as a bug
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
  // biological parts: each name links to its iGEM Registry page when it has a BBa code
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
  if (t.rf && t.rf.length) sect("Key references", bullets(t.rf));
}

// ---- Workspace: wiki (left) + Ask-AI chat (right), side by side ----
function initWorkspace(pane) {
  const t = _curTeam;
  const split = el("div", "workspace");
  const wikiCol = el("div", "wiki-col");
  const aiCol = el("div", "ai-col");
  split.append(wikiCol, aiCol);
  pane.appendChild(split);
  buildWikiView(wikiCol, t);
  initAiPane(aiCol);
}

// ---- Wiki view: the live page in a frame, with a Live/Saved toggle. Some iGEM
//      wikis refuse to be framed, so Saved text is always one click away. ----
/* Wikis from before 2022 sit on igem.org, which sends X-Frame-Options and so can
   never be framed from here. The Internet Archive keeps a copy of the same page
   and does not block framing, so that is what we embed for those years. */
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
  bar.append(el("span", "wiki-url", t.u), modes, open);
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
    const body = el("div", "wiki-text"); body.textContent = "Loading saved text…";
    stage.appendChild(body);
    body.textContent = (await wikiText(t)) || "No saved wiki text is stored for this project.";
  }
  liveBtn.onclick = showLive;
  textBtn.onclick = () => showText(false);
  showLive();
}

const _textCache = new Map();
async function wikiText(t) {
  if (_textCache.has(t.id)) return _textCache.get(t.id);
  let out = "";
  try { out = await fetchTextGz(state.base + "fulltext/text/" + t.id + ".txt.gz"); }
  catch (e) { out = ""; }
  _textCache.set(t.id, out);
  return out;
}

// ---- Ask-AI pane: chat grounded in this project's wiki text ----
// On the website there is no local CLI, so the browser talks to Gemini directly
// with a key the visitor pastes. The key stays in their browser and nowhere else.
// iGEM moved wikis to <year>.igem.wiki in 2022. The older ones on igem.org send
// X-Frame-Options, so they can never be shown in a frame from another site.
const WIKI_MOVE_YEAR = 2022;
const GEM_KEY = "igem_gemini_api_key";
const GEM_MODELS = ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.0-flash"];
const PRE2022_NOTE =
  "Some sites may display incorrectly here. If you see a broken or skewed layout, " +
  "click “Open in new tab ↗” above the wiki to view the original site.";

function aiField(label, node) {
  const w = el("label", "ai-field");
  w.appendChild(el("span", "ai-flabel", label));
  w.appendChild(node);
  return w;
}

function readKey() { try { return (localStorage.getItem(GEM_KEY) || "").trim(); } catch (e) { return ""; } }

function initAiPane(pane) {
  const t = _curTeam;
  const log = el("div", "ai-log");

  const ctl = el("div", "ai-ctl");
  const provSel = el("select", "ai-prov");
  const o = el("option", null, "gemini"); o.value = "gemini"; provSel.appendChild(o);
  const modelSel = el("select", "ai-model");
  GEM_MODELS.forEach((m) => { const x = el("option", null, m); x.value = m; modelSel.appendChild(x); });
  ctl.append(aiField("Agent", provSel), aiField("Model", modelSel));
  pane.appendChild(ctl);
  pane.appendChild(el("div", "ai-usage", "Uses your own Google AI Studio key, free tier."));

  const keyRow = el("div", "ai-keyrow");
  const keyInput = el("input", "ai-key");
  keyInput.type = "password";
  keyInput.autocomplete = "off";
  keyInput.spellcheck = false;
  keyInput.placeholder = "Paste your Google AI Studio API key";
  keyInput.value = readKey();
  keyInput.addEventListener("input", () => {
    try { localStorage.setItem(GEM_KEY, keyInput.value.trim()); } catch (e) {}
  });
  const infoBtn = el("button", "ai-info", "ⓘ");
  infoBtn.type = "button";
  infoBtn.title = "How to get a free API key";
  const help = el("div", "ai-help");
  help.hidden = true;
  help.innerHTML =
    "<b>Get a free Gemini API key (stays in your browser only):</b><br>" +
    "1. Open <a href='https://aistudio.google.com/apikey' target='_blank' rel='noopener'>aistudio.google.com/apikey</a> and sign in.<br>" +
    "2. Click <b>Create API key</b> (no billing/card needed).<br>" +
    "3. Paste it in the box above. It is saved only in this browser (localStorage) - " +
    "never uploaded to this site or shared. Clear it anytime by emptying the box.<br>" +
    "<i>Free tier uses the Flash models and has per-minute/day limits.</i>";
  infoBtn.onclick = () => { help.hidden = !help.hidden; };
  keyRow.append(keyInput, infoBtn);
  pane.appendChild(keyRow);
  pane.appendChild(help);

  log.appendChild(el("div", "ai-hint",
    "Answers come only from this project's stored wiki text. The request goes straight " +
    "from your browser to Google with your own key."));
  if (t.y && t.y < 2022) pane.appendChild(el("div", "ai-layout-note", PRE2022_NOTE));
  pane.appendChild(log);

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
    const apiKey = readKey();
    if (!apiKey) {
      addMsg(log, "you", q); ta.value = "";
      addMsg(log, "ai", "To answer, I need a Google AI Studio API key. Paste yours in " +
        "the box above (click ⓘ for a quick setup guide). It is stored only in your " +
        "browser - never uploaded or shared.");
      return;
    }
    busy = true; send.disabled = true;
    addMsg(log, "you", q); ta.value = "";
    const ans = addMsg(log, "ai", "");
    ans.classList.add("streaming");
    let answer = "";
    try {
      answer = await streamChat(t, q, modelSel.value, apiKey, history.slice(), ans, log);
    } catch (e) {
      ans.classList.add("err"); ans.textContent = "⚠ " + e;
    }
    ans.classList.remove("streaming");
    if (answer && !ans.classList.contains("err")) {
      history.push({ role: "user", text: q }, { role: "model", text: answer });
      if (history.length > 24) history.splice(0, history.length - 24);
    }
    busy = false; send.disabled = false; ta.focus();
  }
  send.onclick = ask;
  ta.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); ask(); } });
}

function addMsg(log, who, txt) {
  const m = el("div", "ai-msg " + who);
  m.textContent = txt;
  log.appendChild(m);
  log.scrollTop = log.scrollHeight;
  return m;
}

// The structured record is always there; the full wiki text is added when we have it.
function groundingFor(t, text) {
  const head = [
    "Team: " + t.t + " (" + t.y + ")",
    t.track ? "Track: " + t.track : "",
    t.s ? "Summary: " + t.s : "",
    t.p ? "Problem: " + t.p : "",
    t.a ? "Approach: " + t.a : "",
    (t.kr || []).length ? "Key results:\n- " + t.kr.join("\n- ") : "",
    (t.fm || []).length ? "Failure modes:\n- " + t.fm.join("\n- ") : "",
  ].filter(Boolean).join("\n\n");
  const wiki = (text || "").slice(0, 120000);
  return head + (wiki ? "\n\n--- FULL WIKI TEXT ---\n" + wiki : "");
}

async function streamChat(t, question, model, apiKey, history, ansEl, log) {
  const sys =
    "You answer questions about one iGEM team project, using only the material below. " +
    "If the material does not contain the answer, say so plainly. Be concise.\n\n" +
    groundingFor(t, await wikiText(t));
  const contents = [];
  for (const h of history) contents.push({ role: h.role, parts: [{ text: h.text }] });
  contents.push({ role: "user", parts: [{ text: question }] });

  const url = "https://generativelanguage.googleapis.com/v1beta/models/" +
    encodeURIComponent(model) + ":streamGenerateContent?alt=sse&key=" + encodeURIComponent(apiKey);
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents, systemInstruction: { parts: [{ text: sys }] } }),
    });
  } catch (e) { ansEl.classList.add("err"); ansEl.textContent = "⚠ request failed"; return ""; }
  if (!resp.ok) {
    ansEl.classList.add("err");
    ansEl.textContent = (resp.status === 400 || resp.status === 403)
      ? "⚠ that API key was rejected. Check it in the box above."
      : "⚠ request failed (" + resp.status + ")";
    return "";
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "", acc = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n\n")) >= 0) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
      const line = raw.replace(/^data: ?/, "");
      if (!line) continue;
      let obj; try { obj = JSON.parse(line); } catch (e) { continue; }
      const bits = (((obj.candidates || [])[0] || {}).content || {}).parts || [];
      for (const b of bits) if (b.text) { acc += b.text; ansEl.textContent = acc; log.scrollTop = log.scrollHeight; }
    }
  }
  if (!acc && !ansEl.textContent) ansEl.textContent = "(no answer)";
  return acc;
}

function closeDrawer() {
  $("#drawer").hidden = true;
  // an embedded team wiki keeps loading and running its own scripts otherwise
  const f = $("#drawerPanel").querySelector("iframe.wiki-frame");
  if (f) f.src = "about:blank";
}

// ---------- resizable drawer (drag the left-edge handle; width persisted) ----------
const DW_KEY = "igem_drawer_width";
function clampDrawerW(w) {
  const min = Math.min(420, window.innerWidth);
  return Math.max(min, Math.min(w, window.innerWidth - 24));
}
function applyDrawerWidth(w) {
  const panel = $("#drawerPanel"), rz = $("#drawerResizer");
  if (!panel) return 0;
  if (w == null) {
    const saved = parseInt(localStorage.getItem(DW_KEY) || "", 10);
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
    if (cur) localStorage.setItem(DW_KEY, String(Math.round(cur)));
  };
  rz.addEventListener("mousedown", start);
  rz.addEventListener("touchstart", start, { passive: false });
  document.addEventListener("mousemove", move);
  document.addEventListener("touchmove", move, { passive: false });
  document.addEventListener("mouseup", end);
  document.addEventListener("touchend", end);
  window.addEventListener("resize", () => { if (!$("#drawer").hidden) applyDrawerWidth(); });
}

// ---------- parts registry view ----------
async function openParts(push) {
  closeCustom();
  state.view = "parts";
  if (push !== false) writeURL(true);
  $("#content").hidden = true;
  $("#facets").hidden = true;
  $("#partsView").hidden = false;
  $("#topbar").classList.remove("searching");
  $("#partsBtn").classList.add("on");
  if (!_partsData) {
    $("#partsList").innerHTML = "";
    $("#partsSummary").textContent = "Loading parts…";
    await getParts();
  }
  $("#partsFilter").value = "";
  renderParts("");
  $("#partsFilter").focus();
}
function closeParts() {
  $("#partsView").hidden = true;
  $("#content").hidden = false;
  $("#partsBtn").classList.remove("on");
  if (state.view === "parts") state.view = null;
}
function renderParts(filter) {
  const d = _partsData; if (!d) return;
  const f = (filter || "").trim().toLowerCase();
  let parts = d.parts;
  if (f) parts = parts.filter((p) => p.name.toLowerCase().includes(f) ||
                                      (p.registry_id || "").toLowerCase().includes(f));
  $("#partsSummary").textContent =
    `${d.total_unique.toLocaleString()} unique parts across all teams · ` +
    `${d.coded.toLocaleString()} linked to a BBa Registry page` +
    (f ? ` · ${parts.length.toLocaleString()} match “${filter}”` : "");
  const box = $("#partsList"); box.innerHTML = "";
  const SHOW = 600;
  parts.slice(0, SHOW).forEach((p) => {
    const row = el("div", "part-row");
    if (p.url) {
      const a = el("a", "part-name" + (p.coded ? " coded" : ""));
      a.href = p.url; a.target = "_blank"; a.rel = "noopener"; a.textContent = p.name;
      a.title = "Open " + p.registry_id + " on registry.igem.org";
      row.appendChild(a);
    } else {
      // descriptive name with no real Registry entry -> plain text, no dead link
      row.appendChild(el("span", "part-name", p.name));
    }
    if (p.registry_id) row.appendChild(el("span", "part-id", p.registry_id));
    row.appendChild(el("span", "part-count", p.count + (p.count === 1 ? " team" : " teams")));
    box.appendChild(row);
  });
  if (!parts.length) box.appendChild(el("div", "empty", "No parts match that filter."));
  else if (parts.length > SHOW)
    box.appendChild(el("div", "empty",
      `Showing the top ${SHOW} of ${parts.length.toLocaleString()} - refine the filter to see more.`));
}

// ---------- the page configured from the database repo ----------
let _customLoaded = null;
async function openCustom(page, push) {
  closeParts();
  state.view = "custom";
  if (push !== false) writeURL(true);
  const frame = $("#customFrame");
  if (_customLoaded !== page) {
    try {
      const r = await fetch(state.base + page, { signal: withTimeout(REMOTE_TIMEOUT) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      frame.srcdoc = await r.text();
      _customLoaded = page;
    } catch (e) {
      frame.srcdoc = "<p style='font:14px system-ui;padding:24px;color:#565a61'>" +
        "This page is not available right now.</p>";
    }
  }
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

// ---------- main run ----------
let _runSeq = 0;
async function run(push) {
  const seq = ++_runSeq;
  const wanted = state.view;
  closeParts();
  closeCustom();
  setMode();
  renderModeToggle();
  // closing the panels above cleared state.view; put it back before the URL is
  // written, or the address loses the page we are about to reopen
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
  if (seq !== _runSeq) return;   // a newer run started while we waited
  if (m.mode && m.mode !== state.mode) { state.mode = m.mode; renderModeToggle(); }
  $("#sortnote").textContent = (SORTNOTE[m.mode] || SORTNOTE.lexical) +
    (m.ms != null ? " · " + m.ms + " ms" : "");
  const res = { total: m.total, page: m.page, page_size: PAGE_SIZE, results: m.results };
  renderResults(res);
  state.lastRes = res;
  state.facetData = { kinds: m.facets };
  renderActiveChips();
  renderFacets(state.facetData);
  restoreView(wanted);
}

/* A reload or a Back gesture can land on ?view=..., so put that page back up. */
function restoreView(wanted) {
  if (wanted === "custom") {
    const nav = (state.site && state.site.nav_button) || {};
    if (nav.page) openCustom(nav.page, false);
  } else if (wanted === "parts") {
    openParts(false);
  }
}

// ---------- blog (home) ----------
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

// Post bodies arrive over the network now, so only a few tags are let through.
const ALLOWED = new Set(["P", "H3", "H4", "UL", "OL", "LI", "STRONG", "EM", "B", "I",
                         "BLOCKQUOTE", "A", "CODE", "PRE", "BR", "HR", "IMG", "FIGURE", "FIGCAPTION"]);
function sanitize(html) {
  const doc = new DOMParser().parseFromString("<div>" + (html || "") + "</div>", "text/html");
  const walk = (node) => {
    for (const child of Array.from(node.children)) {
      if (!ALLOWED.has(child.tagName)) { child.replaceWith(...child.childNodes); continue; }
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
  return isNaN(d) ? (s || "") : d.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
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
    body.appendChild(el("h3", "post-title", p.title || "Untitled"));
    body.appendChild(el("p", "post-abstract", p.abstract || ""));
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
  close.onclick = closeReader;
  panel.appendChild(close);
  const hero = el("img", "reader-hero");
  hero.src = p.image || placeholderImage(i);
  hero.alt = "";
  panel.appendChild(hero);
  panel.appendChild(el("div", "reader-meta",
    [p.author, fmtPostDate(p.date)].filter(Boolean).join(" · ")));
  panel.appendChild(el("h1", "reader-title", p.title || "Untitled"));
  const content = el("div", "reader-content");
  content.innerHTML = sanitize(p.body);
  panel.appendChild(content);
  $("#blogReader").hidden = false;
  document.body.style.overflow = "hidden";
  close.focus();
}
function closeReader() {
  $("#blogReader").hidden = true;
  document.body.style.overflow = "";
}

// ---------- content that the database repo controls ----------
function applyMeta(meta) {
  if (!meta) return;
  const n = (x) => (x || 0).toLocaleString("en-US").replace(/,/g, " ");
  $("#heroYears").textContent = meta.year_range || "2008-2025";
  const d = meta.distinct || {};
  const segs = [
    n(meta.record_count) + " projects",
    (meta.years || []).length + " years (" + (meta.year_range || "") + ")",
    n(d.molecule) + " molecules", n(d.chassis) + " chassis",
    n(d.technique) + " techniques", n(d.part) + " parts",
  ];
  $("#stats").textContent = segs.join(" · ");
  paintStats(segs);
}

/* each figure gets its own pill, so the row stays readable at any width */
function paintStats(segs) {
  const hs = $("#heroStats");
  hs.innerHTML = "";
  segs.forEach((s) => hs.appendChild(el("span", "seg", String(s))));
}

function applySite(site) {
  if (site.hero && site.hero.year_range) $("#heroYears").textContent = site.hero.year_range;
  if (site.stats && Array.isArray(site.stats.segments) && site.stats.segments.length) {
    paintStats(site.stats.segments);
  }
  const nav = site.nav_button || {};
  const btn = $("#customBtn");
  if (nav.enabled && nav.page) {
    btn.textContent = nav.label || "More";
    btn.hidden = false;
    btn.onclick = () => openCustom(nav.page);
    state.site = site;
  } else {
    btn.hidden = true;
  }
  if (site.parts_button === true) $("#partsBtn").hidden = false;
  applyFooter(site.footer);
}

/* Each sentence gets its own element so a phone can put them on separate lines. */
function setNote(box, text) {
  // split on sentence ends and put the full stop back on the piece it came from
  const parts = String(text).split(". ")
    .map((s, i, all) => (i < all.length - 1 ? s + "." : s))
    .filter(Boolean);
  box.innerHTML = "";
  parts.forEach((sent, i) => {
    if (i) box.appendChild(document.createTextNode(" "));
    box.appendChild(el("span", "fsent", sent));
  });
}

/* The footer ships with sensible text in the page, so it reads correctly with no
   database at all; anything set here replaces it. */
function applyFooter(f) {
  if (!f) return;
  if (f.enabled === false) { $("#siteFooter").hidden = true; return; }
  if (typeof f.note === "string") setNote($("#footerNote"), f.note);
  if (typeof f.legal === "string") $("#footerLegal").textContent = f.legal;
  if (typeof f.copyright === "string") $("#footerCopy").textContent = f.copyright;
  if (Array.isArray(f.links)) {
    const box = $("#footerLinks");
    box.innerHTML = "";
    for (const l of f.links) {
      if (!l || !l.label) continue;
      const linked = l.url && /^https?:/i.test(l.url);
      // "prefix" stays plain text so only the name itself is a link
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
  } catch (e) { /* built-in wording stays */ }
  try {
    const d = await fetchGz(base + "posts.json", withTimeout(REMOTE_TIMEOUT));
    state.posts = Array.isArray(d) ? d : (d.posts || []);
    renderBlog();
  } catch (e) { /* no posts */ }
}

/* Concept mode needs the LSA model. It loads after the first paint; until it
   arrives (or if it never does) only Keyword is offered, same as before. */
async function loadConcept(base) {
  if (state.semantic) return;
  try {
    const model = await fetchGz(base + "lsa.json.gz");
    // the model is a row per record, in order, so a stale one must be ignored
    const n = (state.meta && state.meta.record_count) || 0;
    if (model.n !== n) return;
    const ok = await askWorker({ type: "lsa", model });
    if (ok && ok.ok) {
      _lsaModel = model;
      state.semantic = true;
      // a shared ?mode=hybrid link asked for concept search before we could offer it
      if (state.wantedMode && state.wantedMode !== state.mode) {
        state.mode = state.wantedMode;
        if (hasQuery()) { run(false); return; }
      }
      renderModeToggle();
      setMode();
    }
  } catch (e) { /* keyword only */ }
}

/* "Last updated" comes from the database repo's own Last-Modified header, so it
   moves by itself whenever anything there is republished. */
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

// ---------- boot ----------
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
  readURL();
  await run(false);
  loadConcept("baseline/");

  // Only fetch what the database repo actually has a newer version of.
  const remote = await findRemote();
  if (!remote) {
    showNote("Showing the built-in 2008-2025 archive (database repo unreachable).");
    return;
  }
  state.base = remote.base;
  const changed = changedBundles(localManifest, remote.manifest);
  // the wiki shards are addressed by record position, so only trust them when the
  // repo was built for the same record set we are actually searching
  const remoteRecords = remote.manifest.records;
  const localRecords = (data.meta && data.meta.record_count) || 0;
  if (changed.length || remoteRecords === localRecords) {
    state.fulltextBases = DATA_ORIGINS;
  }
  if (changed.length) {
    try {
      const fresh = await loadBundles(remote.base, changed);
      startWorker(Object.assign({}, data, fresh));
      if (fresh.meta) applyMeta(fresh.meta);
      _records = null; _partsData = null;
      await run(false);
    } catch (e) { /* keep the baseline */ }
  }
  if (!changed.length && state.fulltextBases) {
    worker.postMessage({ type: "fulltext", bases: state.fulltextBases });
    // the first search already ran without the wiki index, so ask again
    if (hasQuery()) run(false);
  }
  loadRemoteContent(remote.base);
  loadConcept(remote.base);
}

function bindUI() {
  const go = () => { state.q = $("#q").value; state.page = 1; run(true); };
  $("#searchBtn").onclick = go;
  $("#q").addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  $("#brandHome").onclick = () => {
    state.q = ""; state.filters = {}; state.page = 1; state.view = null;
    $("#q").value = "";
    run(true);
  };
  $("#clearFilters").onclick = () => { state.filters = {}; state.page = 1; run(true); };
  $("#partsBtn").onclick = openParts;
  $("#partsFilter").addEventListener("input", (e) => renderParts(e.target.value));

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
  $("#closeFacets").onclick = hideFacets;

  $("#drawer").querySelector(".drawer-bg").onclick = closeDrawer;
  $("#blogReader").querySelector(".reader-bg").onclick = closeReader;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#blogReader").hidden) closeReader();
    else if (!$("#drawer").hidden) closeDrawer();
    else if (!$("#partsView").hidden) closeParts();
    else if (!$("#customView").hidden) closeCustom();
  });
  window.addEventListener("popstate", () => { readURL(); run(false); });
  window.addEventListener("resize", () => {
    if (!hasQuery()) return;
    if (!isNarrow()) {
      $("#facets").hidden = false;
      $("#facets").classList.remove("open");
      $("#filterBtn").hidden = true;
      $("#facetsScrim").hidden = true;
    } else if (!$("#facets").classList.contains("open")) {
      $("#facets").hidden = true;
      $("#filterBtn").hidden = false;
    }
  });
}

boot();
