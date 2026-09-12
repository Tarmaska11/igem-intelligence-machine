"use strict";
/* Search runs here so typing never freezes the page. */

const K1 = 1.2, B = 0.55;
const TOKEN = /[a-z0-9]{2,32}/g;
const ABBREV = /\b([a-z])\.\s*([a-z]{3,})\b/g;
const COMPOUND = /[a-z0-9]+(?:[-_][a-z0-9]+)+/g;

let CARDS = null, INDEX = null, FACETS = null;
let FT = null;              // full-text: {base, shards:Map}
let ftBase = null;

/* Same rule as tokens() in pipeline/build.py — "E. coli" also yields "ecoli". */
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
      if (n) rows.push({ v: item.v, k: item.k || item.v, n: n });
    }
    if (kind === "year") rows.sort((a, b) => Number(b.v) - Number(a.v));
    else rows.sort((a, b) => b.n - a.n || a.v.localeCompare(b.v));
    if (rows.length) out[kind] = rows;
  }
  return out;
}

async function loadShard(term) {
  if (!ftBase) return null;
  const h = shardOf(term);
  if (!FT.shards.has(h)) {
    FT.shards.set(h, (async () => {
      try {
        const url = ftBase + "fulltext/index/" + String(h).padStart(3, "0") + ".json.gz";
        const r = await fetch(url);
        if (!r.ok) throw new Error("HTTP " + r.status);
        const text = await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
        return JSON.parse(text);
      } catch (e) {
        return null;
      }
    })());
  }
  return FT.shards.get(h);
}

/* Must match shard_of() in pipeline/build.py. */
function shardOf(term) {
  let h = 5381;
  for (let i = 0; i < term.length; i++) h = (Math.imul(h, 33) + term.charCodeAt(i)) >>> 0;
  return h % 256;
}

self.onmessage = async (ev) => {
  const msg = ev.data;

  if (msg.type === "load") {
    CARDS = msg.cards;
    INDEX = msg.index;
    FACETS = msg.facets;
    ftBase = msg.fulltextBase || null;
    FT = { base: ftBase, shards: new Map() };
    self.postMessage({ type: "ready", n: CARDS.length, terms: Object.keys(INDEX.terms).length });
    return;
  }

  if (msg.type === "search") {
    const t0 = performance.now();
    const allow = allowedByFilters(msg.filters);
    const units = parseQuery(msg.q);
    let ids, scores = null, matchMode = null;

    if (!units.length) {
      ids = allow ? Array.from(allow) : CARDS.map((_, i) => i);
      ids.sort((a, b) => (CARDS[b].y - CARDS[a].y) || CARDS[a].t.localeCompare(CARDS[b].t));
    } else {
      const res = runUnits(units, allow);
      scores = res.scored;
      matchMode = res.mode;
      ids = scores.map((s) => s[0]);
    }

    const page = Math.max(1, msg.page || 1);
    const size = msg.pageSize || 20;
    const slice = ids.slice((page - 1) * size, page * size);
    self.postMessage({
      type: "results",
      seq: msg.seq,
      total: ids.length,
      page: page,
      matchMode: matchMode,
      ms: Math.round(performance.now() - t0),
      ids: slice,
      cards: slice.map((i) => CARDS[i]),
      facets: facetCounts(ids),
    });
  }
};
