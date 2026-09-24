"use strict";
/* Scores the order of the wiki-only block - the part below the starred results.

   Nothing else measures it: the other sets are answered by the summary arm, so the
   wiki block only ever decides what comes after the target.

   The label is the summary. For a query, the teams whose summary has every word are
   the ones the project is really about, so a good wiki ordering puts them high.
   The wiki arm is run with nothing excluded, so those teams are in the list it
   ranks. It is a proxy - the summaries were written from the wikis - so it favours
   whatever the wiki says most often, and the numbers should be read with that.

   Also records how often the "Matched: N times" line goes up while you scroll
   down the real block, and how long the wiki arm takes.

   Run: node eval/wikiorder.js [path/to/search.worker.js] [label]
*/

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");

const SITE = path.resolve(__dirname, "..");
const DATA = path.join(SITE, "dist-data");
const FT = path.join(DATA, "fulltext");
const WORKER = process.argv[2] || path.join(SITE, "assets", "search.worker.js");
const LABEL = process.argv[3] || "run";

const gz = (p) => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)));

function makeWorker() {
  const waiting = [];
  const ctx = {
    console, setTimeout, clearTimeout, AbortController,
    Response, DecompressionStream, atob, performance,
    fetch: async (url) => {
      const p = path.join(FT, String(url).replace(/^.*?fulltext\//, ""));
      if (!fs.existsSync(p)) return new Response(null, { status: 404 });
      return new Response(fs.readFileSync(p), { status: 200 });
    },
  };
  ctx.self = ctx;
  ctx.postMessage = (m) => { const done = waiting.shift(); if (done) done(m); };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(WORKER, "utf8"), ctx, { filename: "search.worker.js" });
  return {
    ctx,
    ask: (msg) => new Promise((r) => { waiting.push(r); ctx.self.onmessage({ data: msg }); }),
    tell: (msg) => { ctx.self.onmessage({ data: msg }); },
    run: (code) => vm.runInContext(code, ctx),
  };
}

/* The same queries every run: summary terms with a real wiki-only tail behind them. */
function mine(index) {
  const terms = index.terms;
  const ids = (t) => { let p = 0; return terms[t][0].map((d) => (p += d)); };
  const single = Object.keys(terms)
    .filter((t) => /^[a-z]{5,}$/.test(t) && terms[t][0].length >= 5 && terms[t][0].length <= 40)
    .sort();
  const pick = (arr, n) => {
    const step = arr.length / n, out = [];
    for (let i = 0; i < n && i * step < arr.length; i++) out.push(arr[Math.floor(i * step)]);
    return out;
  };
  const one = pick(single, 150);
  // two-word queries: two mid-frequency words that share at least three summaries
  const mid = Object.keys(terms)
    .filter((t) => /^[a-z]{5,}$/.test(t) && terms[t][0].length >= 8 && terms[t][0].length <= 150)
    .sort();
  const two = [];
  const cand = pick(mid, 400);
  for (let i = 0; i < cand.length && two.length < 50; i += 2) {
    const a = cand[i];
    const sa = new Set(ids(a));
    for (let j = 1; j < 60; j++) {
      const b = cand[(i + j * 7) % cand.length];
      if (b === a) continue;
      const both = ids(b).filter((x) => sa.has(x)).length;
      if (both >= 3 && both <= 40) { two.push(a + " " + b); break; }
    }
  }
  return one.concat(two);
}

function dcg(rel) {
  let s = 0;
  rel.forEach((r, i) => { if (r) s += 1 / Math.log2(i + 2); });
  return s;
}

function ndcg(ranked, R, k) {
  const got = dcg(ranked.slice(0, k).map((id) => R.has(id)));
  const ideal = dcg(new Array(Math.min(k, R.size)).fill(true));
  return ideal ? got / ideal : 0;
}

function ap(ranked, R) {
  let hit = 0, s = 0;
  ranked.forEach((id, i) => { if (R.has(id)) { hit++; s += hit / (i + 1); } });
  return R.size ? s / R.size : 0;
}

const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const q = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b[Math.floor(p * (b.length - 1))] || 0; };

async function main() {
  const w = makeWorker();
  await w.ask({
    type: "load",
    cards: gz(path.join(DATA, "cards.json.gz")),
    index: gz(path.join(DATA, "index.json.gz")),
    facets: gz(path.join(DATA, "facets.json.gz")),
    fulltextBases: ["./"],
  });
  const index = w.run("INDEX");
  const queries = mine(index);
  w.ctx.__Q = null;

  const rows = [];
  for (const query of queries) {
    w.ctx.__Q = query;
    const summary = w.run("runGroups(parseGroups(__Q), null).scored.map((s) => s[0])");
    const R = new Set(summary);
    // whole ranking, nothing held back: how well does it find the on-topic teams
    const t0 = performance.now();
    const all = await w.run("wikiTailGroups(parseGroups(__Q), null, new Set())");
    const ms = performance.now() - t0;
    const ranked = Array.isArray(all) ? all : all.ids;
    // the block people actually scroll: summary hits taken out
    w.ctx.__P = R;
    const tail = await w.run("wikiTailGroups(parseGroups(__Q), null, __P)");
    let ups = 0, pairs = 0;
    if (tail && tail.count) {
      const n = tail.ids.map((id) => {
        const v = tail.count.get(id);
        return v && typeof v === "object" ? v.n : (v || 0);
      });
      for (let i = 1; i < n.length; i++) { pairs++; if (n[i] > n[i - 1]) ups++; }
    }
    const inWiki = ranked.filter((id) => R.has(id)).length;
    // what a shuffled list would score, for scale
    const rnd = R.size && ranked.length ? inWiki / ranked.length : 0;
    rows.push({
      q: query, rel: R.size, found: inWiki, listed: ranked.length,
      ndcg10: ndcg(ranked, R, 10), ndcg50: ndcg(ranked, R, 50), ap: ap(ranked, R),
      p10: ranked.slice(0, 10).filter((id) => R.has(id)).length / 10,
      rnd, ups, pairs, ms,
    });
  }

  const use = rows.filter((r) => r.found > 0);
  const out = {
    label: LABEL, worker: path.basename(WORKER), queries: rows.length, scored: use.length,
    ndcg10: mean(use.map((r) => r.ndcg10)),
    ndcg50: mean(use.map((r) => r.ndcg50)),
    map: mean(use.map((r) => r.ap)),
    p10: mean(use.map((r) => r.p10)),
    random_p: mean(use.map((r) => r.rnd)),
    count_goes_up: rows.reduce((s, r) => s + r.ups, 0) / (rows.reduce((s, r) => s + r.pairs, 0) || 1),
    ms_median: q(rows.map((r) => r.ms), 0.5),
    ms_p95: q(rows.map((r) => r.ms), 0.95),
    single: mean(use.filter((r) => !r.q.includes(" ")).map((r) => r.ndcg10)),
    double: mean(use.filter((r) => r.q.includes(" ")).map((r) => r.ndcg10)),
  };
  const dir = path.join(__dirname, "results", "wikiorder");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, LABEL + ".json"), JSON.stringify({ summary: out, rows }, null, 1));
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}

main();
