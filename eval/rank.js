"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");
const zlib = require("zlib");
const readline = require("readline");

const SITE = path.resolve(__dirname, "..");
const DATA = path.join(SITE, process.argv[2] || "baseline");
const FT = path.join(SITE, "dist-data", "fulltext");

const gz = (p) => JSON.parse(zlib.gunzipSync(fs.readFileSync(p)));
const say = (o) => process.stdout.write(JSON.stringify(o) + "\n");

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
  vm.runInContext(fs.readFileSync(path.join(SITE, "assets", "search.worker.js"), "utf8"),
                  ctx, { filename: "search.worker.js" });
  return {
    ask: (msg) => new Promise((r) => { waiting.push(r); ctx.self.onmessage({ data: msg }); }),
    tell: (msg) => { ctx.self.onmessage({ data: msg }); },
  };
}

async function main() {
  const w = makeWorker();
  const ready = await w.ask({
    type: "load",
    cards: gz(path.join(DATA, "cards.json.gz")),
    index: gz(path.join(DATA, "index.json.gz")),
    facets: gz(path.join(DATA, "facets.json.gz")),
    fulltextBases: null,
  });
  const lsa = await w.ask({ seq: 0, type: "lsa", model: gz(path.join(DATA, "lsa.json.gz")) });
  say({ type: "ready", n: ready.n, terms: ready.terms, lsa: !!lsa.ok });

  let seq = 0;
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    const req = JSON.parse(line);
    if (req.type === "bye") break;
    if (req.type === "wiki") {
      w.tell({ type: "fulltext", bases: req.on ? ["./"] : null });
      say({ ok: true });
      continue;
    }
    const r = await w.ask({
      seq: ++seq, type: "search", q: req.q, filters: req.filters || {},
      page: 1, pageSize: 20, mode: req.mode, idsOnly: true,
    });
    say({ ids: r.ids, total: r.total, ms: r.ms, mode: r.mode,
          matchMode: r.matchMode, wikiOnly: r.wikiOnly });
  }
  process.exit(0);
}

main();
