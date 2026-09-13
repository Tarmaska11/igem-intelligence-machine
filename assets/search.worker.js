"use strict";
/* Search runs here so typing never freezes the page. */

const K1 = 1.2, B = 0.55;
const TOKEN = /[a-z0-9]{2,32}/g;
const ABBREV = /\b([a-z])\.\s*([a-z]{3,})\b/g;
const COMPOUND = /[a-z0-9]+(?:[-_][a-z0-9]+)+/g;

let CARDS = null, INDEX = null, FACETS = null, LSA = null;
let FT = null;              // full-text: {base, shards:Map}
let ftBase = null;

/* Same rule as tokens() in pipeline/build.py - "E. coli" also yields "ecoli". */
function tokenize(text) {
  const t = (text || "").toLowerCase();
  const out = t.match(TOKEN) || [];
  let m;
  ABBREV.lastIndex = 0;
  while ((m = ABBREV.exec(t)) !== null) out.push(m[1] + m[2]);
  for (const c of (t.match(COMPOUND) || [])) out.push(c.replace(/[-_]/g, ""));
  return out;
}

/* Each group is a list of complete spellings. A spelling with several words means
   all of its words must be present, so no single common word can carry the group. */
const SYNONYMS = [
  ["escherichia coli", "ecoli"],
  ["saccharomyces cerevisiae", "scerevisiae", "budding yeast"],
  ["bacillus subtilis", "bsubtilis"],
  ["pseudomonas putida", "pputida"],
  ["green fluorescent protein", "gfp", "sfgfp", "egfp"],
  ["red fluorescent protein", "rfp", "mcherry", "mrfp"],
  ["polymerase chain reaction", "pcr"],
  ["gel electrophoresis", "electrophoresis"],
  ["ribosome binding site", "rbs"],
  ["clustered regularly interspaced short palindromic repeats", "crispr"],
  ["golden gate", "goldengate"],
  ["heavy metal", "heavy metals"],
  ["polyethylene terephthalate", "pet plastic"],
  ["quorum sensing", "quorum"],
  ["site directed mutagenesis", "site-directed mutagenesis"],
  ["western blot", "western blotting", "immunoblot"],
  ["flow cytometry", "facs"],
  ["mass spectrometry", "mass spec"],
  ["high performance liquid chromatography", "hplc"],
  ["enzyme linked immunosorbent assay", "elisa"],
];

const GROUP_OF = new Map();
SYNONYMS.forEach((forms, gi) => {
  forms.forEach((f) => GROUP_OF.set(f, gi));
});

/* A query becomes a list of units. Every unit must match (AND); inside a unit the
   spellings are alternatives (OR). */
function parseQuery(q) {
  const raw = (q || "").toLowerCase().trim();
  if (!raw) return [];
  const words = tokenize(raw);
  const units = [];
  let i = 0;
  while (i < words.length) {
    let matched = false;
    for (let len = Math.min(4, words.length - i); len >= 1 && !matched; len--) {
      const phrase = words.slice(i, i + len).join(" ");
      const gi = GROUP_OF.get(phrase);
      if (gi !== undefined) {
        units.push(SYNONYMS[gi].map((f) => f.split(" ")));
        i += len;
        matched = true;
      }
    }
    if (!matched) {
      if (words[i].length > 1) units.push([[words[i]]]);
      i++;
    }
  }
  return units;
}

function postings(term) {
  const p = INDEX.terms[term];
  if (!p) return null;
  const [deltas, weights] = p;
  const ids = new Int32Array(deltas.length);
  let prev = 0;
  for (let i = 0; i < deltas.length; i++) { prev += deltas[i]; ids[i] = prev; }
  return { ids, weights };
}

/* Score one spelling: all of its words must be in the document. */
function scoreSpelling(words, acc, allow) {
  const lists = [];
  for (const w of words) {
    const p = postings(w);
    if (!p) return null;
    lists.push(p);
  }
  lists.sort((a, b) => a.ids.length - b.ids.length);
  const N = INDEX.n, avgdl = INDEX.avgdl, dl = INDEX.dl;
  const base = lists[0];
  const hits = new Map();
  outer:
  for (let i = 0; i < base.ids.length; i++) {
    const id = base.ids[i];
    if (allow && !allow.has(id)) continue;
    let total = 0;
    for (const l of lists) {
      let lo = 0, hi = l.ids.length - 1, at = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (l.ids[mid] === id) { at = mid; break; }
        if (l.ids[mid] < id) lo = mid + 1; else hi = mid - 1;
      }
      if (at < 0) continue outer;
      const df = l.ids.length;
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const tf = l.weights[at];
      total += idf * (tf * (K1 + 1)) / (tf + K1 * (1 - B + B * dl[id] / avgdl));
    }
    hits.set(id, total);
  }
  for (const [id, s] of hits) acc.set(id, Math.max(acc.get(id) || 0, s));
  return hits.size;
}

function runUnits(units, allow) {
  const perUnit = units.map((unit) => {
    const acc = new Map();
    for (const spelling of unit) scoreSpelling(spelling, acc, allow);
    return acc;
  });
  if (!perUnit.length) return null;
  // AND across units; if that is empty, fall back to OR so a long query still answers.
  let ids = null;
  for (const acc of perUnit) {
    if (ids === null) ids = new Set(acc.keys());
    else for (const id of Array.from(ids)) if (!acc.has(id)) ids.delete(id);
  }
  let mode = "all";
  if (!ids || ids.size === 0) {
    ids = new Set();
    for (const acc of perUnit) for (const id of acc.keys()) ids.add(id);
    mode = "any";
  }
  const scored = [];
  for (const id of ids) {
    let s = 0, hitUnits = 0;
    for (const acc of perUnit) {
      const v = acc.get(id);
      if (v !== undefined) { s += v; hitUnits++; }
    }
    scored.push([id, s * (1 + 0.35 * (hitUnits - 1))]);
  }
  scored.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return { scored, mode };
}

function allowedByFilters(filters) {
  const kinds = Object.keys(filters || {}).filter((k) => filters[k] && filters[k].length);
  if (!kinds.length) return null;
  let allow = null;
  for (const kind of kinds) {
    const wanted = new Set(filters[kind]);
    const ids = new Set();
    for (const item of (FACETS[kind] || [])) {
      if (wanted.has(item.k || item.v)) for (const d of item.d) ids.add(d);
    }
    if (allow === null) allow = ids;
    else for (const id of Array.from(allow)) if (!ids.has(id)) allow.delete(id);
  }
  return allow;
}

function facetCounts(resultIds) {
  const set = resultIds instanceof Set ? resultIds : new Set(resultIds);
  const out = {};
  for (const kind of Object.keys(FACETS)) {
    const rows = [];
    for (const item of FACETS[kind]) {
      let n = 0;
      for (const d of item.d) if (set.has(d)) n++;
      if (n) rows.push({ value: item.v, key: item.k || item.v, count: n });
    }
    if (kind === "year") rows.sort((a, b) => Number(b.value) - Number(a.value));
    else rows.sort((a, b) => b.count - a.count || a.value.localeCompare(b.value));
    if (rows.length) out[kind] = rows;
  }
  return out;
}

async function loadShard(term) {
  if (!ftBase) return null;
  const h = shardOf(term);
  if (!FT.shards.has(h)) {
    FT.shards.set(h, (async () => {
      for (const base of ftBase) {
        try {
          const url = base + "fulltext/index/" + String(h).padStart(3, "0") + ".json.gz";
          // a slow shard must never hold up the results the page already has
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 8000);
          const r = await fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(timer));
          if (!r.ok) continue;
          const text = await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
          return JSON.parse(text);
        } catch (e) { /* try the next origin */ }
      }
      return null;
    })());
  }
  return FT.shards.get(h);
}

/* The raw-wiki recall arm. A team whose summary missed the word but whose wiki
   contains it still turns up, ranked below every summary hit - same as before. */
async function wikiTail(units, allow, primary) {
  if (!ftBase || !units.length) return [];
  const wanted = new Set();
  for (const unit of units) for (const spelling of unit) for (const w of spelling) wanted.add(w);
  const shards = new Map();
  await Promise.all(Array.from(wanted).map(async (w) => { shards.set(w, await loadShard(w)); }));

  const listOf = (w) => {
    const sh = shards.get(w);
    const p = sh && sh[w];
    if (!p) return null;
    const [deltas, tfs] = p;
    const ids = new Int32Array(deltas.length);
    let prev = 0;
    for (let i = 0; i < deltas.length; i++) { prev += deltas[i]; ids[i] = prev; }
    return { ids, tfs };
  };

  // one score map per unit, OR-ing its spellings
  const perUnit = [];
  for (const unit of units) {
    const acc = new Map();
    for (const spelling of unit) {
      const lists = [];
      let ok = true;
      for (const w of spelling) {
        const l = listOf(w);
        if (!l) { ok = false; break; }
        lists.push(l);
      }
      if (!ok) continue;
      lists.sort((a, b) => a.ids.length - b.ids.length);
      const base = lists[0];
      for (let i = 0; i < base.ids.length; i++) {
        const id = base.ids[i];
        let score = 0, present = true;
        for (const l of lists) {
          let lo = 0, hi = l.ids.length - 1, at = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (l.ids[mid] === id) { at = mid; break; }
            if (l.ids[mid] < id) lo = mid + 1; else hi = mid - 1;
          }
          if (at < 0) { present = false; break; }
          score += Math.log(1 + l.tfs[at]) * Math.log(1 + CARDS.length / l.ids.length);
        }
        if (present) acc.set(id, Math.max(acc.get(id) || 0, score));
      }
    }
    perUnit.push(acc);
  }
  if (!perUnit.length) return [];

  let ids = null;
  for (const acc of perUnit) {
    if (ids === null) ids = new Set(acc.keys());
    else for (const id of Array.from(ids)) if (!acc.has(id)) ids.delete(id);
  }
  if (!ids || !ids.size) {
    ids = new Set();
    for (const acc of perUnit) for (const id of acc.keys()) ids.add(id);
  }
  const out = [];
  for (const id of ids) {
    if (primary.has(id)) continue;
    if (allow && !allow.has(id)) continue;
    let s = 0;
    for (const acc of perUnit) s += acc.get(id) || 0;
    out.push([id, s]);
  }
  out.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return out.map((x) => x[0]);
}

/* Must match shard_of() in pipeline/build.py. */
function shardOf(term) {
  let h = 5381;
  for (let i = 0; i < term.length; i++) h = (Math.imul(h, 33) + term.charCodeAt(i)) >>> 0;
  return h % 256;
}

/* A short passage around the first query word, like the old server snippet. */
function snippet(text, words) {
  const t = (text || "").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\*([^*]+)\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1").replace(/\s+/g, " ").trim();
  if (!t) return "";
  const low = t.toLowerCase();
  let at = -1;
  for (const w of words) {
    const i = low.indexOf(w);
    if (i >= 0 && (at < 0 || i < at)) at = i;
  }
  if (at < 0) return t.slice(0, 260) + (t.length > 260 ? " …" : "");
  const start = Math.max(0, at - 90);
  const end = Math.min(t.length, at + 190);
  return (start ? "… " : "") + t.slice(start, end) + (end < t.length ? " …" : "");
}

/* ---- concept space (LSA), same model as the desktop build, quantised to int8 ---- */
const LSA_STOP = new Set(("a an and are as at be by for from has have had he her his in into is it its of " +
  "on or that the their them they this to was were will with we our us you your i me my been being do does " +
  "did doing but not no nor so than then too very can could should would may might must shall about above " +
  "after again against all any because before below between both during each few more most other some such " +
  "only own same just now which who whom what when where why how here there project team teams igem wiki " +
  "page year university student students member members http https www com org html index home overview " +
  "description introduction").split(" "));
const LSA_TOKEN = /[a-zA-Z][a-zA-Z0-9-]+/g;

function b64ToI8(b64) {
  const bin = atob(b64);
  const out = new Int8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = (bin.charCodeAt(i) << 24) >> 24;
  return out;
}

function lsaTokens(text) {
  const out = [];
  for (const raw of ((text || "").toLowerCase().match(LSA_TOKEN) || [])) {
    const t = raw.replace(/^-+|-+$/g, "");
    if (t.length < 3 || t.length > 30 || LSA_STOP.has(t)) continue;
    if (/^\d+$/.test(t.replace(/-/g, ""))) continue;
    out.push(t);
  }
  return out;
}

function setLsa(model) {
  const vi = new Map();
  model.vocab.forEach((t, i) => vi.set(t, i));
  LSA = {
    k: model.k, n: model.n, v: model.v, vi: vi, idf: model.idf,
    comp: b64ToI8(model.comp), compScale: model.comp_scale,
    docs: b64ToI8(model.docs), docsScale: model.docs_scale,
  };
}

/* Project a query into concept space, then cosine against every record. */
function semanticScores(q) {
  if (!LSA) return null;
  const counts = new Map();
  for (const t of lsaTokens(q)) counts.set(t, (counts.get(t) || 0) + 1);
  const k = LSA.k;
  const vec = new Float64Array(k);
  let any = false;
  for (const [t, c] of counts) {
    const j = LSA.vi.get(t);
    if (j === undefined) continue;
    any = true;
    const w = (1 + Math.log(c)) * LSA.idf[j];
    const off = j * k;
    for (let d = 0; d < k; d++) vec[d] += w * LSA.comp[off + d] * LSA.compScale;
  }
  if (!any) return null;
  let nrm = 0;
  for (let d = 0; d < k; d++) nrm += vec[d] * vec[d];
  nrm = Math.sqrt(nrm) || 1;
  for (let d = 0; d < k; d++) vec[d] /= nrm;

  const out = new Float64Array(LSA.n);
  for (let i = 0; i < LSA.n; i++) {
    const off = i * k;
    let s = 0;
    for (let d = 0; d < k; d++) s += vec[d] * LSA.docs[off + d];
    out[i] = s * LSA.docsScale;
  }
  return out;
}

const RRF_C = 60, SEM_TOPN = 400;

/* Reciprocal rank fusion of the keyword ranking and the concept ranking. */
function fuse(lexIds, sem, allow) {
  const lexRank = new Map();
  lexIds.forEach((id, i) => lexRank.set(id, i + 1));
  const pool = [];
  for (let i = 0; i < sem.length; i++) {
    if (allow && !allow.has(i)) continue;
    pool.push([i, sem[i]]);
  }
  pool.sort((a, b) => b[1] - a[1]);
  const semRank = new Map();
  pool.slice(0, SEM_TOPN).forEach(([id], i) => semRank.set(id, i + 1));

  const all = new Set([...lexRank.keys(), ...semRank.keys()]);
  const scored = [];
  for (const id of all) {
    let s = 0;
    if (lexRank.has(id)) s += 1 / (RRF_C + lexRank.get(id));
    if (semRank.has(id)) s += 1 / (RRF_C + semRank.get(id));
    scored.push([id, s]);
  }
  scored.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return scored.map((x) => x[0]);
}

self.onmessage = async (ev) => {
  const msg = ev.data;

  if (msg.type === "fulltext") {
    ftBase = (msg.bases && msg.bases.length) ? msg.bases : null;
    FT = { base: ftBase, shards: new Map() };
    return;
  }

  if (msg.type === "lsa") {
    try { setLsa(msg.model); self.postMessage({ seq: msg.seq, ok: true }); }
    catch (e) { self.postMessage({ seq: msg.seq, ok: false }); }
    return;
  }

  if (msg.type === "load") {
    CARDS = msg.cards;
    INDEX = msg.index;
    FACETS = msg.facets;
    ftBase = (msg.fulltextBases && msg.fulltextBases.length) ? msg.fulltextBases : null;
    FT = { base: ftBase, shards: new Map() };
    self.postMessage({ type: "ready", n: CARDS.length, terms: Object.keys(INDEX.terms).length });
    return;
  }

  if (msg.type === "search") {
    const t0 = performance.now();
    const allow = allowedByFilters(msg.filters);
    const units = parseQuery(msg.q);
    let ids, scores = null, matchMode = null, wikiOnly = new Set(), usedMode = "lexical";

    if (!units.length) {
      ids = allow ? Array.from(allow) : CARDS.map((_, i) => i);
      ids.sort((a, b) => (CARDS[b].y - CARDS[a].y) || CARDS[a].t.localeCompare(CARDS[b].t));
    } else {
      const res = runUnits(units, allow);
      scores = res.scored;
      matchMode = res.mode;
      ids = scores.map((s) => s[0]);
      if (msg.mode === "hybrid" && LSA) {
        const sem = semanticScores(msg.q);
        if (sem) { ids = fuse(ids, sem, allow); usedMode = "hybrid"; }
      }
      const primary = new Set(ids);
      const tail = await wikiTail(units, allow, primary);
      wikiOnly = new Set(tail);
      ids = ids.concat(tail);
    }

    const page = Math.max(1, msg.page || 1);
    const size = msg.pageSize || 20;
    const slice = ids.slice((page - 1) * size, page * size);
    const words = [];
    for (const unit of units) for (const spelling of unit) for (const w of spelling) words.push(w);
    const results = slice.map((i) => {
      const c = CARDS[i];
      const r = Object.assign({}, c, { snippet: snippet(c.summary, words) });
      if (wikiOnly.has(i)) r.wiki_only = true;
      return r;
    });
    self.postMessage({
      type: "results",
      seq: msg.seq,
      total: ids.length,
      page: page,
      mode: usedMode,
      matchMode: matchMode,
      ms: Math.round(performance.now() - t0),
      results: results,
      facets: facetCounts(ids),
    });
  }
};
