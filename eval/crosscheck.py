"""Checks that the harness measures what a browser actually does.

eval/rank.js runs the worker under node with a stand-in fetch. If that ever drifts
from the real thing, every number the harness produces is fiction. So: run the same
queries in a real browser, in a real Worker, and require the rankings to be equal.

Needs the site served locally:  python run.py 8899
Run: python eval/crosscheck.py
"""

import json
import os
import subprocess
import sys

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8899/"

QUERIES = [
    ("spider", "lexical"), ("spiders", "lexical"),
    ("biosensor", "lexical"), ("heavy metal biosensors", "lexical"),
    ("casein and milk or bovine albumin and coffee", "lexical"),
    ("reactive oxygen species", "lexical"), ("ros", "lexical"),
    ("quorum sensing", "hybrid"), ("spider silk", "hybrid"),
    ("microbial fuel cell", "hybrid"),
]

IN_PAGE = """
async (args) => {
  const [base, queries] = args;
  const gz = async (u) => {
    const r = await fetch(base + u);
    return JSON.parse(await new Response(
      r.body.pipeThrough(new DecompressionStream("gzip"))).text());
  };
  const [cards, index, facets, lsa] = await Promise.all(
    ["cards", "index", "facets", "lsa"].map((n) => gz("baseline/" + n + ".json.gz")));

  const w = new Worker(base + "assets/search.worker.js");
  const waiting = [];
  w.onmessage = (e) => { const d = waiting.shift(); if (d) d(e.data); };
  const ask = (m) => new Promise((r) => { waiting.push(r); w.postMessage(m); });

  await ask({ type: "load", cards, index, facets, fulltextBases: [base + "dist-data/"] });
  await ask({ seq: 0, type: "lsa", model: lsa });

  const out = [];
  for (const [q, mode] of queries) {
    const full = await ask({ seq: 1, type: "search", q, mode, idsOnly: true });
    const paged = await ask({ seq: 2, type: "search", q, mode, page: 1, pageSize: 20 });
    out.push({ q, mode, ids: full.ids, total: full.total,
               page1: paged.results.map((r) => r.id) });
  }
  return out;
}
"""


def from_shim():
    lines = [json.dumps({"type": "wiki", "on": True})]
    lines += [json.dumps({"q": q, "mode": m}) for q, m in QUERIES]
    lines.append(json.dumps({"type": "bye"}))
    p = subprocess.run(["node", os.path.join(HERE, "rank.js"), "baseline"],
                       input="\n".join(lines) + "\n", capture_output=True,
                       text=True, encoding="utf-8", cwd=SITE)
    if p.returncode != 0:
        print(p.stderr)
        raise SystemExit("rank.js failed")
    rows = [json.loads(l) for l in p.stdout.splitlines() if l.strip()]
    return [r for r in rows if "ids" in r]


def main():
    shim = from_shim()
    with sync_playwright() as pw:
        b = pw.chromium.launch()
        page = b.new_page()
        page.goto(BASE, wait_until="domcontentloaded")
        browser = page.evaluate(IN_PAGE, [BASE, [list(x) for x in QUERIES]])
        b.close()

    cards = json.load(__import__("gzip").open(
        os.path.join(SITE, "baseline", "cards.json.gz"), "rt", encoding="utf-8"))
    failed = 0
    for (q, mode), s, bro in zip(QUERIES, shim, browser):
        same = s["ids"] == bro["ids"]
        # the idsOnly shortcut must not have changed what the page itself shows
        page_ok = bro["page1"] == [cards[i]["id"] for i in bro["ids"][:20]]
        if same and page_ok:
            print("  ok   %-45s %s  n=%d" % (q[:45], mode, s["total"]))
        else:
            failed += 1
            print("  FAIL %-45s %s  shim=%d browser=%d  identical=%s page1=%s"
                  % (q[:45], mode, s["total"], bro["total"], same, page_ok))

    print("\n%d queries, %d failed" % (len(QUERIES), failed))
    if failed:
        raise SystemExit(1)
    print("the harness and the browser rank identically")


if __name__ == "__main__":
    main()
