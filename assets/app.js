"use strict";
/* iGEM Intelligence Machine — the whole front end.

   Data comes from two places. baseline/ ships with the site and always works.
   The database repo on GitHub can serve newer bundles; if it is slow, gone or
   broken we just keep the baseline. */

const DATA_ORIGINS = [
  "https://tarmaska11.github.io/igem-intelligence-machine-db/",
  "https://raw.githubusercontent.com/Tarmaska11/igem-intelligence-machine-db/main/",
];
const REMOTE_TIMEOUT = 6000;
const PAGE_SIZE = 20;
const CACHE_NAME = "igem-im-data-v1";

const FACET_GROUPS = [
  ["year", "Year"],
  ["track", "Track"],
  ["domain", "Application area"],
  ["chassis", "Chassis organism"],
  ["technique", "Molecular technique"],
  ["molecule", "Target molecule"],
  ["part", "Biological part"],
  ["region", "Region"],
  ["country", "Country"],
  ["section", "Team section"],
  ["failures", "Documented failures"],
];
const FACET_SHOW = 12;

const $ = (s) => document.querySelector(s);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const state = {
  q: "", filters: {}, page: 1,
  meta: null, site: null, posts: [],
  source: "baseline", base: "baseline/",
  records: null, lastResults: null, seq: 0,
};

let worker = null;

/* ---------- loading ---------- */

async function fetchGz(url, signal) {
  const r = await fetch(url, { signal, cache: "no-cache" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  if (!url.endsWith(".gz")) return r.json();
  const stream = r.body.pipeThrough(new DecompressionStream("gzip"));
  return JSON.parse(await new Response(stream).text());
}

function withTimeout(ms) {
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

/* Try each remote origin in turn. Returns a base URL or null. */
async function findRemote() {
  for (const origin of DATA_ORIGINS) {
    try {
      const man = await fetchGz(origin + "manifest.json", withTimeout(REMOTE_TIMEOUT));
      if (man && man.files) return { base: origin, manifest: man };
    } catch (e) { /* try the next one */ }
  }
  return null;
}

async function loadBundles(base) {
  const [cards, index, facets, meta] = await Promise.all([
    fetchGz(base + "cards.json.gz"),
    fetchGz(base + "index.json.gz"),
    fetchGz(base + "facets.json.gz"),
    fetchGz(base + "meta.json.gz"),
  ]);
  return { cards, index, facets, meta };
}

async function boot() {
  bindUI();
  renderBlog();

  let data = null;
  try {
    data = await loadBundles("baseline/");
    state.source = "baseline";
  } catch (e) {
    showNote("The bundled data could not be read. The page cannot search.");
    return;
  }
  startWorker(data);
  applyMeta(data.meta);
  readURL();
  run(false);

  // Now see whether the database repo has something newer.
  const remote = await findRemote();
  if (!remote) { showNote("Showing the built-in 2008-2025 archive (database repo unreachable)."); return; }
  state.base = remote.base;
  try {
    const fresh = await loadBundles(remote.base);
    if (fresh.meta && fresh.meta.built_at !== data.meta.built_at) {
      startWorker(fresh);
      applyMeta(fresh.meta);
      state.source = "remote";
      run(false);
    }
  } catch (e) { /* keep the baseline */ }
  loadRemoteContent(remote.base);
}

function startWorker(data) {
  if (worker) worker.terminate();
  worker = new Worker("assets/search.worker.js");
  worker.onmessage = onWorkerMessage;
  worker.postMessage({
    type: "load", cards: data.cards, index: data.index, facets: data.facets,
    fulltextBase: state.base,
  });
  state.meta = data.meta;
}

/* Blog, hero wording and the extra nav button all come from the database repo. */
async function loadRemoteContent(base) {
  try {
    const site = await fetchGz(base + "site.json", withTimeout(REMOTE_TIMEOUT));
    state.site = site;
    applySite(site);
  } catch (e) { /* the built-in wording stays */ }
  try {
    const data = await fetchGz(base + "posts.json", withTimeout(REMOTE_TIMEOUT));
    state.posts = Array.isArray(data) ? data : (data.posts || []);
    renderBlog();
  } catch (e) { /* no posts */ }
}

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
  const hs = $("#heroStats");
  hs.textContent = "";
  segs.forEach((s, i) => {
    if (i) hs.appendChild(el("span", "dot", "·"));
    hs.appendChild(el("span", "seg", s));
  });
}

function applySite(site) {
  if (site.hero && site.hero.year_range) $("#heroYears").textContent = site.hero.year_range;
  if (site.stats && Array.isArray(site.stats.segments) && site.stats.segments.length) {
    const hs = $("#heroStats");
    hs.textContent = "";
    site.stats.segments.forEach((s, i) => {
      if (i) hs.appendChild(el("span", "dot", "·"));
      hs.appendChild(el("span", "seg", String(s)));
    });
  }
  const nav = site.nav_button || {};
  const btn = $("#customBtn");
  if (nav.enabled && nav.page) {
    btn.textContent = nav.label || "More";
    btn.hidden = false;
    btn.onclick = () => openCustom(nav.page);
  } else {
    btn.hidden = true;
  }
}

function showNote(msg) {
  const n = $("#dataNote");
  n.textContent = msg;
  n.hidden = false;
  setTimeout(() => { n.hidden = true; }, 9000);
}

/* ---------- url state ---------- */

function readURL() {
  const p = new URLSearchParams(location.search);
  state.q = p.get("q") || "";
  state.page = Math.max(1, parseInt(p.get("page") || "1", 10) || 1);
  state.filters = {};
  for (const [kind] of FACET_GROUPS) {
    const vals = p.getAll(kind);
    if (vals.length) state.filters[kind] = vals;
  }
  $("#q").value = state.q;
}

function writeURL(push) {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.page > 1) p.set("page", String(state.page));
  for (const kind of Object.keys(state.filters)) {
    for (const v of state.filters[kind]) p.append(kind, v);
  }
  const url = location.pathname + (p.toString() ? "?" + p : "");
  if (push) history.pushState(null, "", url);
  else history.replaceState(null, "", url);
}

const hasQuery = () => state.q.trim() !== "" || Object.keys(state.filters).length > 0;

/* ---------- running a search ---------- */

function run(push) {
  closeCustom();
  const searching = hasQuery();
  $("#hero").hidden = searching;
  $("#resultsHead").hidden = !searching;
  $("#pager").hidden = !searching;
  $("#facets").hidden = !searching || isNarrow();
  $("#filterBtn").hidden = !searching || !isNarrow();
  $("#results").textContent = "";

  // in results mode the search box moves up into the header
  const wrap = document.querySelector(".searchwrap");
  const target = searching ? $("#headerSearch") : $("#heroSearch");
  if (wrap && wrap.parentElement !== target) target.appendChild(wrap);

  writeURL(push);
  if (!worker) return;
  state.seq++;
  worker.postMessage({
    type: "search", seq: state.seq, q: state.q, filters: state.filters,
    page: state.page, pageSize: PAGE_SIZE,
  });
}

function onWorkerMessage(ev) {
  const m = ev.data;
  if (m.type === "ready") return;
  if (m.type !== "results" || m.seq !== state.seq) return;
  state.lastResults = m;
  renderResults(m);
  renderFacets(m.facets);
  renderChips();
  renderPager(m);
  $("#resultCount").textContent =
    m.total.toLocaleString("en-US") + (m.total === 1 ? " project" : " projects");
  $("#sortnote").textContent = state.q
    ? "ranked by relevance · " + m.ms + " ms"
    : "newest first";
}

function renderResults(m) {
  const box = $("#results");
  box.textContent = "";
  if (!m.cards.length) {
    box.appendChild(el("div", "empty", "Nothing matched. Try fewer words, or clear a filter."));
    return;
  }
  for (const c of m.cards) {
    const card = el("article", "card");
    card.tabIndex = 0;
    const top = el("div", "card-top");
    const h = el("h3", null, c.t);
    top.appendChild(h);
    top.appendChild(el("span", "year", String(c.y)));
    const dom = (c.f && c.f.domain && c.f.domain[0]) || (c.f && c.f.track && c.f.track[0]);
    if (dom) top.appendChild(el("span", "domain", dom));
    card.appendChild(top);
    card.appendChild(el("p", "snip", (c.s || "").slice(0, 280)));
    const tags = el("div", "tagrow");
    for (const kind of ["chassis", "technique", "molecule"]) {
      for (const v of ((c.f && c.f[kind]) || []).slice(0, 3)) {
        tags.appendChild(el("span", "tag " + kind, v));
      }
    }
    card.appendChild(tags);
    card.onclick = () => openTeam(c.id);
    card.onkeydown = (e) => { if (e.key === "Enter") openTeam(c.id); };
    box.appendChild(card);
  }
}

function renderFacets(facets) {
  const box = $("#facetGroups");
  box.textContent = "";
  for (const [kind, label] of FACET_GROUPS) {
    const rows = facets[kind];
    if (!rows || !rows.length) continue;
    const group = el("div", "facet-group");
    const head = el("div", "facet-head");
    head.appendChild(el("span", null, label));
    head.appendChild(el("span", "facet-n", String(rows.length)));
    const list = el("div", "facet-list");
    const selected = new Set(state.filters[kind] || []);
    let shown = FACET_SHOW;
    const paint = () => {
      list.textContent = "";
      for (const r of rows.slice(0, shown)) {
        const row = el("div", "facet-item" + (selected.has(r.v) ? " on" : ""));
        row.appendChild(el("span", "facet-v", r.v));
        row.appendChild(el("span", "facet-c", String(r.n)));
        row.onclick = () => toggleFacet(kind, r.v);
        list.appendChild(row);
      }
      if (rows.length > shown) {
        const more = el("button", "facet-more", "show " + Math.min(30, rows.length - shown) + " more");
        more.onclick = (e) => { e.stopPropagation(); shown += 30; paint(); };
        list.appendChild(more);
      }
    };
    paint();
    head.onclick = () => list.toggleAttribute("hidden");
    group.appendChild(head);
    group.appendChild(list);
    box.appendChild(group);
  }
}

function renderChips() {
  const box = $("#activeChips");
  box.textContent = "";
  for (const kind of Object.keys(state.filters)) {
    for (const v of state.filters[kind]) {
      const chip = el("button", "chip", v + "  ×");
      chip.onclick = () => toggleFacet(kind, v);
      box.appendChild(chip);
    }
  }
}

function toggleFacet(kind, value) {
  const cur = new Set(state.filters[kind] || []);
  if (cur.has(value)) cur.delete(value); else cur.add(value);
  if (cur.size) state.filters[kind] = Array.from(cur);
  else delete state.filters[kind];
  state.page = 1;
  run(true);
}

function renderPager(m) {
  const box = $("#pager");
  box.textContent = "";
  const pages = Math.ceil(m.total / PAGE_SIZE);
  if (pages <= 1) return;
  const mk = (label, page, disabled) => {
    const b = el("button", "page-btn", label);
    b.disabled = !!disabled;
    b.onclick = () => { state.page = page; run(true); window.scrollTo(0, 0); };
    return b;
  };
  box.appendChild(mk("← previous", state.page - 1, state.page <= 1));
  box.appendChild(el("span", "page-now", "page " + state.page + " of " + pages));
  box.appendChild(mk("next →", state.page + 1, state.page >= pages));
}

/* ---------- team detail ---------- */

async function ensureRecords() {
  if (state.records) return state.records;
  for (const base of [state.base, "baseline/"]) {
    try {
      const arr = await fetchGz(base + "records.json.gz");
      state.records = new Map(arr.map((r) => [r.id, r]));
      return state.records;
    } catch (e) { /* try baseline */ }
  }
  return null;
}

async function openTeam(id) {
  const panel = $("#drawerPanel");
  panel.textContent = "";
  panel.appendChild(el("div", "drawer-loading", "Loading…"));
  $("#drawer").hidden = false;
  document.body.style.overflow = "hidden";

  const recs = await ensureRecords();
  const r = recs && recs.get(id);
  panel.textContent = "";
  const close = el("button", "drawer-close", "×");
  close.onclick = closeDrawer;
  panel.appendChild(close);
  if (!r) {
    panel.appendChild(el("p", "empty", "Could not load this record."));
    return;
  }
  const head = el("div", "drawer-head");
  head.appendChild(el("h2", null, r.t));
  head.appendChild(el("span", "year", String(r.y)));
  panel.appendChild(head);

  const meta = el("div", "drawer-meta");
  const bits = [];
  if (r.f && r.f.track) bits.push(r.f.track[0]);
  if (r.f && r.f.country) bits.push(r.f.country[0]);
  if (r.city) bits.push(r.city);
  if (r.f && r.f.section) bits.push(r.f.section[0]);
  meta.textContent = bits.join(" · ");
  panel.appendChild(meta);

  if (r.u) {
    const a = el("a", "wiki-link", "Open the team wiki ↗");
    a.href = r.u; a.target = "_blank"; a.rel = "noopener noreferrer";
    panel.appendChild(a);
  }

  const section = (title, body) => {
    if (!body || (Array.isArray(body) && !body.length)) return;
    panel.appendChild(el("h3", "drawer-h", title));
    if (Array.isArray(body)) {
      const ul = el("ul", "drawer-list");
      for (const x of body) ul.appendChild(el("li", null, x));
      panel.appendChild(ul);
    } else {
      panel.appendChild(el("p", "drawer-p", body));
    }
  };
  section("Summary", r.s);
  section("Problem", r.p);
  section("Approach", r.a);
  section("Novelty", r.n);
  section("Key results", r.kr);
  section("What did not work", r.fm);

  for (const [kind, label] of [["chassis", "Chassis organisms"], ["technique", "Molecular techniques"],
                               ["part", "Biological parts"], ["molecule", "Target molecules"]]) {
    const vals = (r.raw && r.raw[kind]) || [];
    if (!vals.length) continue;
    panel.appendChild(el("h3", "drawer-h", label));
    const wrap = el("div", "tagrow");
    for (const v of vals) wrap.appendChild(el("span", "tag " + kind, v));
    panel.appendChild(wrap);
  }
  section("References", r.rf);
}

function closeDrawer() {
  $("#drawer").hidden = true;
  document.body.style.overflow = "";
}

/* ---------- the configurable page from the database repo ---------- */

async function openCustom(page) {
  const view = $("#customView");
  const frame = $("#customFrame");
  try {
    const r = await fetch(state.base + page, { signal: withTimeout(REMOTE_TIMEOUT) });
    if (!r.ok) throw new Error("HTTP " + r.status);
    frame.srcdoc = await r.text();
  } catch (e) {
    frame.srcdoc = "<p style='font:14px system-ui;padding:24px'>This page is not available right now.</p>";
  }
  $("#content").hidden = true;
  $("#facets").hidden = true;
  view.hidden = false;
}

function closeCustom() {
  $("#customView").hidden = true;
  $("#content").hidden = false;
}

/* ---------- blog ---------- */

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

/* Post bodies now arrive over the network, so only a few tags are allowed through. */
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

function fmtDate(s) {
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
  list.textContent = "";
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
    meta.appendChild(el("span", null, [p.author, fmtDate(p.date)].filter(Boolean).join(" · ")));
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
  more.textContent = "";
  if (order.length > blogShown) {
    const b = el("button", "blog-more-btn", "↓ more posts");
    b.onclick = () => { blogShown += BLOG_STEP; renderBlog(); };
    more.appendChild(b);
  }
}

function openPost(p, i) {
  const panel = $("#readerPanel");
  panel.textContent = "";
  const close = el("button", "reader-close", "×");
  close.onclick = closeReader;
  panel.appendChild(close);
  const hero = el("img", "reader-hero");
  hero.src = p.image || placeholderImage(i);
  hero.alt = "";
  panel.appendChild(hero);
  panel.appendChild(el("div", "reader-meta",
    [p.author, fmtDate(p.date)].filter(Boolean).join(" · ")));
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

/* ---------- wiring ---------- */

const isNarrow = () => window.matchMedia("(max-width: 880px)").matches;

function bindUI() {
  $("#searchBtn").onclick = () => { state.q = $("#q").value; state.page = 1; run(true); };
  $("#q").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { state.q = $("#q").value; state.page = 1; run(true); }
  });
  $("#brandHome").onclick = () => {
    state.q = ""; state.filters = {}; state.page = 1;
    $("#q").value = "";
    run(true);
  };
  $("#clearFilters").onclick = () => { state.filters = {}; state.page = 1; run(true); };
  $("#filterBtn").onclick = () => {
    $("#facets").hidden = false;
    $("#facets").classList.add("open");
    $("#facetsScrim").hidden = false;
    $("#closeFacets").hidden = false;
  };
  const hideFacets = () => {
    $("#facets").classList.remove("open");
    $("#facetsScrim").hidden = true;
    if (isNarrow()) $("#facets").hidden = true;
  };
  $("#facetsScrim").onclick = hideFacets;
  $("#closeFacets").onclick = hideFacets;
  $("#drawer").querySelector(".drawer-bg").onclick = closeDrawer;
  $("#blogReader").querySelector(".reader-bg").onclick = closeReader;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!$("#blogReader").hidden) closeReader();
    else if (!$("#drawer").hidden) closeDrawer();
    else if (!$("#customView").hidden) { closeCustom(); }
  });
  window.addEventListener("popstate", () => { readURL(); run(false); });
  window.addEventListener("resize", () => {
    if (!hasQuery()) return;
    if (!isNarrow()) { $("#facets").hidden = false; $("#filterBtn").hidden = true; $("#facetsScrim").hidden = true; }
    else if (!$("#facets").classList.contains("open")) { $("#facets").hidden = true; $("#filterBtn").hidden = false; }
  });
}

boot();
