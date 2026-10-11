"use strict";

const K1 = 3, B = 0.55;
const TOKEN = /[a-z0-9]{2,32}/g;
const ABBREV = /\b([a-z])\.\s*([a-z]{3,})\b/g;
const COMPOUND = /[a-z0-9]+(?:[-_][a-z0-9]+)+/g;

let CARDS = null, INDEX = null, FACETS = null, LSA = null;
let FT = null;
let ftBase = null;

function tokenize(text) {
  const t = (text || "").toLowerCase();
  const out = t.match(TOKEN) || [];
  let m;
  ABBREV.lastIndex = 0;
  while ((m = ABBREV.exec(t)) !== null) out.push(m[1] + m[2]);
  for (const c of (t.match(COMPOUND) || [])) out.push(c.replace(/[-_]/g, ""));
  return out;
}

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
  ["quorum sensing", "quorum", "qs"],
  ["bacillus thuringiensis", "bt"],
  ["site directed mutagenesis", "sitedirected mutagenesis"],
  ["western blot", "western blotting", "immunoblot"],
  ["flow cytometry", "facs"],
  ["mass spectrometry", "mass spec"],
  ["high performance liquid chromatography", "hplc"],
  ["enzyme linked immunosorbent assay", "elisa"],
];

const ABBREVIATIONS = [
  ["adaptive laboratory evolution", "ale"],
  ["african swine fever", "asf"],
  ["amoebic gill disease", "agd"],
  ["amyotrophic lateral sclerosis", "als"],
  ["anaerobic fluorescent protein", "afp"],
  ["antifungal porphyrin based intervention system", "apis"],
  ["aptamer lateral flow assay", "alfa"],
  ["arsenic binding peptide", "abp"],
  ["autism spectrum disorder", "asd"],
  ["bacillus thuringiensis", "bt"],
  ["bacterial cellulose", "bc"],
  ["bacterial leaf blight", "blb"],
  ["banana xanthomonas wilt", "bxw"],
  ["batrachochytrium dendrobatidis", "bd"],
  ["beet yellows virus", "byv"],
  ["biofrag isolation unit", "biu"],
  ["bovine respiratory disease", "brd"],
  ["burst size distribution", "bsd"],
  ["buruli ulcer", "bu"],
  ["carbonic anhydrase", "ca"],
  ["catalytic hairpin assembly", "cha"],
  ["cellulose binding domain", "cbd"],
  ["chimeric antigen receptor", "car"],
  ["chronic inflammatory diseases", "cid"],
  ["chronic kidney disease", "ckd"],
  ["chronic lymphocytic leukemia", "cll"],
  ["circular polymerase extension cloning", "cpec"],
  ["circulating tumor cell", "ctc"],
  ["colony collapse disorder", "ccd"],
  ["continuous directed evolution", "cde"],
  ["coronary artery disease", "cad"],
  ["cyclic chain displacement reaction", "ccdr"],
  ["cysteine sulfinic acid decarboxylase", "csad"],
  ["cystic fibrosis", "cf"],
  ["cytochrome maturation", "ccm"],
  ["deformed wing virus", "dwv"],
  ["degradation tag", "dt"],
  ["deinococcus radiodurans", "dr"],
  ["diabetic nephropathy", "dn"],
  ["diffusible signaling factor", "dsf"],
  ["digital in line holographic microscope", "dihm"],
  ["double vector system", "dvs"],
  ["dystrophic epidermolysis bullosa", "deb"],
  ["electrochemical impedance spectroscopy", "eis"],
  ["emerald ash borer", "eab"],
  ["enhanced yellow fluorescent protein", "eyfp"],
  ["enzymatic fuel cell", "efc"],
  ["enzymatic microbial fuel cell", "emfc"],
  ["enzyme fragment complementation assay", "efca"],
  ["enzyme replacement therapy", "ert"],
  ["epidermal growth factor", "egf"],
  ["ethylene glycol", "eg"],
  ["exocrine pancreatic insufficiency", "epi"],
  ["feed forward loop", "ffl"],
  ["finite state automaton", "fsa"],
  ["fluorescence resonance energy transfer", "fret"],
  ["flux balance analysis", "fba"],
  ["fusarium head blight", "fhb"],
  ["generalized additive models", "gam"],
  ["glucocorticoid receptor", "gr"],
  ["green fluorescent protein", "gfp"],
  ["health risk detection kit", "hrdk"],
  ["heat shock protein", "hsp"],
  ["hepatic encephalopathy", "he"],
  ["hepatitis virus", "hbv"],
  ["hepatitis virus", "hcv"],
  ["hereditary fructose intolerance", "hfi"],
  ["horizontal gene transfer", "hgt"],
  ["human chorionic gonadotropin", "hcg"],
  ["human estrogen receptor", "her"],
  ["human gastric intrinsic factor", "hgif"],
  ["human serum albumin", "hsa"],
  ["hyaluronic acid", "ha"],
  ["hybridization chain reaction", "hcr"],
  ["ice nucleation protein", "inp"],
  ["idealized protein purification", "ipp"],
  ["idiopathic pulmonary fibrosis", "ipf"],
  ["inflammatory bowel disease", "ibd"],
  ["integrated human practices", "ihp"],
  ["intrinsic factor", "if"],
  ["invasive candidiasis", "ic"],
  ["irritable bowel syndrome", "ibs"],
  ["iterative capped assembly", "ica"],
  ["lactic acid mediated", "lam"],
  ["lateral flow assay", "lfa"],
  ["leaf compost cutinase", "lcc"],
  ["lethal toxin neutralizing factor", "ltnf"],
  ["ligase chain reaction", "lcr"],
  ["live biotherapeutic product", "lbp"],
  ["localized surface plasmon resonance", "lspr"],
  ["logical genetic diagram", "lgd"],
  ["major depressive disorder", "mdd"],
  ["maple syrup urine disease", "msud"],
  ["methicillin resistant staphylococcus aureus", "mrsa"],
  ["microbial desalination cell", "mdc"],
  ["microbial enhanced oil recovery", "meor"],
  ["microbial fuel cell", "mfc"],
  ["microbially induced calcite precipitation", "micp"],
  ["mild traumatic brain injury", "mtbi"],
  ["mini bioproduction cycle system", "mbcs"],
  ["modular receptor platform", "mrp"],
  ["mountain pine beetle", "mpb"],
  ["multiplex automated genome engineering", "mage"],
  ["mussel foot protein", "mfp"],
  ["nitric oxide", "no"],
  ["nuclear receptor", "nr"],
  ["oak processionary caterpillar", "opc"],
  ["oil mill wastewater", "omw"],
  ["open sequence format", "osf"],
  ["oral squamous cell carcinoma", "oscc"],
  ["paper analytical device", "pad"],
  ["paralytic shellfish poisoning", "psp"],
  ["pattern recognition receptor", "prr"],
  ["pernicious anaemia", "pa"],
  ["phenylalanine ammonia lyase", "pal"],
  ["phosphate binding protein", "pbp"],
  ["poly lactic acid", "pla"],
  ["precipitated calcium carbonate", "pcc"],
  ["protective phytochemical quantifier", "ppq"],
  ["protein degradation tags", "pdt"],
  ["pyruvate dehydrogenase complex", "pdc"],
  ["quartz crystal microbalance", "qcm"],
  ["quorum sensing", "qs"],
  ["random positioning machine", "rpm"],
  ["reactive oxygen species", "ros"],
  ["recombinant epidermal growth factor", "regf"],
  ["recombinase polymerase amplification", "rpa"],
  ["recombination directionality factor", "rdf"],
  ["red fluorescent protein", "rfp"],
  ["reduced graphene oxide", "rgo"],
  ["regulatory flux balance analysis", "rfba"],
  ["rheumatoid arthritis", "ra"],
  ["ribosome binding site", "rbs"],
  ["rna iii inhibiting peptide", "rip"],
  ["rolling circle amplification", "rca"],
  ["rolling circle replication", "rcr"],
  ["rotating biological contactor", "rbc"],
  ["salicylic acid", "sa"],
  ["small heat shock proteins", "shsp"],
  ["soil based microbial fuel cell", "smfc"],
  ["spinal cord injury", "sci"],
  ["stony coral tissue loss disease", "sctld"],
  ["stop codon readthrough", "scr"],
  ["sulfide quinone reductase", "sqr"],
  ["sustainable aviation fuel", "saf"],
  ["synthetic expression system", "ses"],
  ["terminal deoxynucleotidyl transferase", "tdt"],
  ["tetracycline mimic inhibitor peptide", "tip"],
  ["tobacco mosaic virus", "tmv"],
  ["tomato spotted wilt virus", "tswv"],
  ["toxic shock syndrome", "tss"],
  ["transmembrane readiness framework", "trf"],
  ["trigger factor", "tf"],
  ["triple negative breast cancer", "tnbc"],
  ["tyrosine ammonia lyase", "tal"],
  ["universal bacterial expression resource", "uber"],
  ["unnatural amino acid", "uaa"],
  ["uric acid", "ua"],
  ["west nile virus", "wnv"],
  ["white nose syndrome", "wns"],
  ["yellow fluorescent protein", "yfp"],
  ["zosteric acid", "za"],
];

const COMMON_WORDS = new Set(["her", "tip", "pad", "rip", "lam", "gam", "cad"]);
const GROUPS = SYNONYMS.slice();
const GROUP_OF = new Map();
SYNONYMS.forEach((forms, gi) => {
  forms.forEach((f) => GROUP_OF.set(f, gi));
});
for (const [long, short] of ABBREVIATIONS) {
  if (short.length < 3 || COMMON_WORDS.has(short) || GROUP_OF.has(short)) continue;
  const gi = GROUP_OF.get(long);
  GROUPS.push(gi === undefined ? [long, short] : GROUPS[gi].concat([short]));
  GROUP_OF.set(short, GROUPS.length - 1);
}

const PIECE = /[a-z0-9]+(?:[-_][a-z0-9]+)+|[a-z0-9]+/g;

function parseQuery(q) {
  const raw = (q || "").toLowerCase().trim();
  if (!raw) return [];
  const units = [];
  let words = [];
  for (const piece of raw.match(PIECE) || []) {
    if (!/[-_]/.test(piece)) {
      words.push(...(piece.match(TOKEN) || []));
      continue;
    }
    addWords(words, units);
    words = [];
    const parts = piece.match(TOKEN) || [];
    const joined = piece.replace(/[-_]/g, "");
    const unit = [];
    if (parts.length) unit.push({ w: parts, m: 1 });
    if (joined.length > 1) unit.push({ w: [joined], m: 1 });
    if (unit.length) {
      unit.label = piece;
      units.push(unit);
    }
  }
  let m;
  ABBREV.lastIndex = 0;
  while ((m = ABBREV.exec(raw)) !== null) words.push(m[1] + m[2]);
  addWords(words, units);
  return units;
}

function addWords(words, units) {
  let i = 0;
  while (i < words.length) {
    let matched = false;
    for (let len = Math.min(4, words.length - i); len >= 1 && !matched; len--) {
      const phrase = words.slice(i, i + len).join(" ");
      const gi = GROUP_OF.get(phrase);
      if (gi !== undefined) {
        units.push(GROUPS[gi].map((f) => ({ w: f.split(" "), m: 1 })));
        units[units.length - 1].label = phrase;
        i += len;
        matched = true;
      }
    }
    if (!matched) {
      const w = words[i];
      if (w.length > 1) {
        const g = spellingsFor(w);
        units.push(g ? g.map((f, n) => ({ w: [f], m: n ? FOLD_WEIGHT : 1 }))
                     : [{ w: [w], m: 1 }]);
        units[units.length - 1].label = w;
      }
      i++;
    }
  }
}

const FOLD_MIN_DF = 20;
const FOLD_WEIGHT = 0.35;
let FOLDS = null;

function stemOf(w, minDf) {
  const terms = INDEX.terms;
  for (const [suf, rep] of [["ies", "y"], ["s", ""], ["es", ""]]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) {
      const c = w.slice(0, w.length - suf.length) + rep;
      if (suf === "es" && !/(s|x|z|ch|sh)$/.test(c)) continue;
      if (c !== w && terms[c] && terms[c][0].length >= minDf) return c;
    }
  }
  return null;
}

function spellingsFor(w) {
  const g = FOLDS && FOLDS.get(w);
  if (g) return g;
  if (INDEX.terms[w]) return null;
  const stem = stemOf(w, FOLD_MIN_DF);
  return stem ? [w, stem] : null;
}

function buildFolds() {
  FOLDS = new Map();
  const terms = INDEX.terms;
  for (const w in terms) {
    const stem = stemOf(w, FOLD_MIN_DF);
    if (!stem) continue;
    for (const [a, b] of [[w, stem], [stem, w]]) {
      let g = FOLDS.get(a);
      if (!g) { g = [a]; FOLDS.set(a, g); }
      if (g.indexOf(b) < 0) g.push(b);
    }
  }
}

function parseGroups(q) {
  const raw = (q || "").trim().replace(/^(?:(?:and|or)(?:\s+|$))+|(?:(?:^|\s+)(?:and|or))+$/gi, "").trim();
  if (!raw) return [];
  const groups = [];
  for (const part of raw.split(/\s+or\s+/i)) {
    const units = parseQuery(part.replace(/\s+and\s+/gi, " "));
    if (units.length) groups.push(units);
  }
  return groups;
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

function scoreSpelling(words, acc, allow, mult) {
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
    hits.set(id, total * (mult === undefined ? 1 : mult));
  }
  for (const [id, s] of hits) acc.set(id, Math.max(acc.get(id) || 0, s));
  return hits.size;
}

function runUnits(units, allow) {
  const perUnit = units.map((unit) => {
    const acc = new Map();
    for (const sp of unit) scoreSpelling(sp.w, acc, allow, sp.m);
    return acc;
  });
  if (!perUnit.length) return null;
  let ids = null;
  for (const acc of perUnit) {
    if (ids === null) ids = new Set(acc.keys());
    else for (const id of Array.from(ids)) if (!acc.has(id)) ids.delete(id);
  }
  const scored = [];
  for (const id of (ids || [])) {
    let s = 0;
    for (const acc of perUnit) s += acc.get(id) || 0;
    scored.push([id, s]);
  }
  scored.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return { scored, mode: "all" };
}

function runGroups(groups, allow) {
  if (groups.length === 1) return runUnits(groups[0], allow);
  const best = new Map();
  for (const units of groups) {
    const r = runUnits(units, allow);
    if (!r) continue;
    for (const [id, s] of r.scored) best.set(id, Math.max(best.get(id) || 0, s));
  }
  const scored = Array.from(best);
  scored.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  return { scored, mode: "any-of" };
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

async function rank(msg, groups, allow) {
  let ids, scores = null, matchMode = null, wikiOnly = new Set(), wikiCount = new Map(),
      relatedOnly = new Set(), usedMode = "lexical";

  if (!groups.length && (msg.q || "").trim()) {
    ids = [];
  } else if (!groups.length) {
    ids = allow ? Array.from(allow) : CARDS.map((_, i) => i);
    ids.sort((a, b) => (CARDS[b].year - CARDS[a].year) ||
                       CARDS[a].team_name.localeCompare(CARDS[b].team_name));
  } else {
    const res = runGroups(groups, allow);
    scores = res.scored;
    matchMode = res.mode;
    ids = scores.map((s) => s[0]);
    let primary = new Set(ids);
    if (msg.mode === "hybrid" && LSA) {
      const sem = semanticScores(msg.q);
      if (sem) {
        const related = conceptTail(ids, sem, allow, primary);
        relatedOnly = new Set(related);
        ids = ids.concat(related);
        primary = new Set(ids);
        usedMode = "hybrid";
      }
    }
    const tail = await wikiTailGroups(groups, allow, primary);
    wikiOnly = new Set(tail.ids);
    wikiCount = tail.count;
    ids = ids.concat(tail.ids);
  }
  return { ids, matchMode, usedMode, wikiOnly, wikiCount, relatedOnly };
}

async function ownFilterPools(msg, groups) {
  const pools = {};
  const f = msg.filters || {};
  for (const kind of Object.keys(f)) {
    if (!f[kind] || !f[kind].length) continue;
    const others = Object.assign({}, f);
    delete others[kind];
    pools[kind] = (await rank(msg, groups, allowedByFilters(others))).ids;
  }
  return pools;
}

function facetCounts(resultIds, pools) {
  const all = resultIds instanceof Set ? resultIds : new Set(resultIds);
  const out = {};
  for (const kind of Object.keys(FACETS)) {
    const set = pools && pools[kind] ? new Set(pools[kind]) : all;
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

async function loadWikiMeta() {
  if (!ftBase) return null;
  if (!FT.meta) {
    FT.meta = (async () => {
      for (const base of ftBase) {
        try {
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 8000);
          const r = await fetch(base + "fulltext/meta.json.gz", { signal: ctl.signal })
            .finally(() => clearTimeout(timer));
          if (!r.ok) continue;
          const text = await new Response(
            r.body.pipeThrough(new DecompressionStream("gzip"))).text();
          return JSON.parse(text);
        } catch (e) {  }
      }
      return null;
    })();
  }
  return FT.meta;
}

async function loadShard(term) {
  if (!ftBase) return null;
  const h = shardOf(term);
  if (!FT.shards.has(h)) {
    FT.shards.set(h, (async () => {
      for (const base of ftBase) {
        try {
          const url = base + "fulltext/index/" + String(h).padStart(3, "0") + ".json.gz";
          const ctl = new AbortController();
          const timer = setTimeout(() => ctl.abort(), 8000);
          const r = await fetch(url, { signal: ctl.signal }).finally(() => clearTimeout(timer));
          if (!r.ok) continue;
          const text = await new Response(r.body.pipeThrough(new DecompressionStream("gzip"))).text();
          return JSON.parse(text);
        } catch (e) {  }
      }
      return null;
    })());
  }
  const got = await FT.shards.get(h);
  if (got === null && FT.shards.has(h)) FT.shards.delete(h);
  return got;
}

async function wikiTail(units, allow, primary) {
  if (!ftBase || !units.length) return [];
  const wanted = new Set();
  for (const unit of units) for (const sp of unit) for (const w of sp.w) wanted.add(w);
  if (wanted.size > 32) return [];
  const shards = new Map();
  await Promise.all(Array.from(wanted).map(async (w) => { shards.set(w, await loadShard(w)); }));
  const wmeta = await loadWikiMeta();
  if (wmeta && wmeta.n !== CARDS.length) return [];
  const wdl = wmeta && wmeta.dl;

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

  const perUnit = [];
  for (const unit of units) {
    const hit = new Map();
    for (const sp of unit) {
      const lists = [];
      let ok = true;
      for (const w of sp.w) {
        const l = listOf(w);
        if (!l) { ok = false; break; }
        lists.push(l);
      }
      if (!ok) continue;
      lists.sort((a, b) => a.ids.length - b.ids.length);
      const base = lists[0];
      for (let i = 0; i < base.ids.length; i++) {
        const id = base.ids[i];
        let n = Infinity;
        for (const l of lists) {
          let lo = 0, hi = l.ids.length - 1, at = -1;
          while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (l.ids[mid] === id) { at = mid; break; }
            if (l.ids[mid] < id) lo = mid + 1; else hi = mid - 1;
          }
          if (at < 0) { n = 0; break; }
          n = Math.min(n, l.tfs[at]);
        }
        if (n) hit.set(id, (hit.get(id) || 0) + n);
      }
    }
    perUnit.push(hit);
  }
  if (!perUnit.length) return [];

  let ids = null;
  for (const hit of perUnit) {
    if (ids === null) ids = new Set(hit.keys());
    else for (const id of Array.from(ids)) if (!hit.has(id)) ids.delete(id);
  }

  const out = [];
  for (const id of (ids || [])) {
    if (primary.has(id)) continue;
    if (allow && !allow.has(id)) continue;
    const parts = perUnit.map((hit, u) => [units[u].label || units[u][0].w.join(" "), hit.get(id)]);
    let n = Infinity, sum = 0;
    for (const [, c] of parts) { n = Math.min(n, c); sum += c; }
    out.push({ id, n, sum, len: wdl ? wdl[id] : 0, parts });
  }
  out.sort(byMentions);
  return out;
}

function byMentions(a, b) {
  return b.n - a.n || b.sum - a.sum || a.len - b.len || a.id - b.id;
}

async function wikiTailGroups(groups, allow, primary) {
  const best = new Map();
  for (const units of groups) {
    for (const x of await wikiTail(units, allow, primary)) {
      const had = best.get(x.id);
      if (!had || byMentions(x, had) < 0) best.set(x.id, x);
    }
  }
  const out = Array.from(best.values()).sort(byMentions);
  return { ids: out.map((x) => x.id), count: new Map(out.map((x) => [x.id, x])) };
}

function shardOf(term) {
  let h = 5381;
  for (let i = 0; i < term.length; i++) h = (Math.imul(h, 33) + term.charCodeAt(i)) >>> 0;
  return h % 256;
}

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

const SEM_TOPN = 400;
const SEM_MIN = 0.12;

function conceptTail(lexIds, sem, allow, primary) {
  const pool = [];
  for (let i = 0; i < sem.length; i++) {
    if (primary.has(i)) continue;
    if (allow && !allow.has(i)) continue;
    if (sem[i] <= SEM_MIN) continue;
    pool.push([i, sem[i]]);
  }
  pool.sort((a, b) => b[1] - a[1]);
  return pool.slice(0, SEM_TOPN).map((x) => x[0]);
}

self.onmessage = async (ev) => {
  const msg = ev.data;

  if (msg.type === "fulltext") {
    ftBase = (msg.bases && msg.bases.length) ? msg.bases : null;
    FT = { base: ftBase, shards: new Map(), meta: null };
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
    buildFolds();
    FACETS = msg.facets;
    ftBase = (msg.fulltextBases && msg.fulltextBases.length) ? msg.fulltextBases : null;
    FT = { base: ftBase, shards: new Map(), meta: null };
    self.postMessage({ type: "ready", n: CARDS.length, terms: Object.keys(INDEX.terms).length });
    return;
  }

  if (msg.type === "search") {
    try {
      const t0 = performance.now();
      const allow = allowedByFilters(msg.filters);
      const groups = parseGroups(msg.q);
      const { ids, matchMode, usedMode, wikiOnly, wikiCount, relatedOnly } =
        await rank(msg, groups, allow);

      if (msg.idsOnly) {
        self.postMessage({
          type: "results", seq: msg.seq, total: ids.length, mode: usedMode,
          matchMode: matchMode, wikiOnly: wikiOnly.size,
          ms: Math.round(performance.now() - t0), ids: ids,
        });
        return;
      }

      const size = msg.pageSize || 20;
      const page = Math.min(Math.max(1, msg.page || 1), Math.max(1, Math.ceil(ids.length / size)));
      const slice = ids.slice((page - 1) * size, page * size);
      const words = [];
      for (const g of groups) for (const u of g) for (const sp of u) for (const w of sp.w) words.push(w);
      const results = slice.map((i) => {
        const c = CARDS[i];
        const r = Object.assign({}, c, { snippet: snippet(c.summary, words) });
        if (wikiOnly.has(i)) {
          const h = wikiCount.get(i);
          r.wiki_only = true;
          r.wiki_hits = h ? h.n : 0;
          if (h && h.parts.length > 1) r.wiki_parts = h.parts;
        }
        if (relatedOnly.has(i)) r.related = true;
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
        facets: facetCounts(ids, await ownFilterPools(msg, groups)),
      });
    } catch (e) {
      self.postMessage({ type: "results", seq: msg.seq, error: String(e), total: 0, page: 1,
                         mode: "lexical", results: [], facets: {} });
    }
  }

};
