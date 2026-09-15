"""The builder and the search worker have to split text the same way.

pipeline/build.py writes the index and assets/search.worker.js reads it, so the two
tokenizers are copies of each other. If they ever drift, a word typed in the search
box stops matching the postings that were written for it - and nothing errors, the
results just quietly go missing. Same for shard_of, which decides which wiki shard a
term was written into.

Run: python tests/test_parity.py
"""

import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(SITE, "pipeline"))

import build as B

SAMPLES = [
    "E. coli biosensor",
    "CRISPR-Cas9 knock-in",
    "Spider silk (MaSp1) fibres",
    "pH-responsive hydrogel, 37C",
    "S. cerevisiae + B. subtilis co-culture",
    "BBa_K1234567 and BBa_25Y42N8F",
    "heavy-metal_uptake",
    "a b cd 12 x9",
    "Quorum sensing / AHL signalling",
    "naringenin, p-coumaric acid; 4CL",
    "anti-CRISPR AcrIIA4",
    "Plastic (PET) degradation by IsPETase",
    "",
    "   ",
    "München Team 2019",
]

JS = r"""
const fs = require("fs");
const src = fs.readFileSync(process.argv[2], "utf8");
// pull the two functions out of the worker without running its message loop
const api = {};
// the worker registers a handler on self at the end, so give it somewhere to land
new Function("api", "self",
             src + "\napi.tokenize = tokenize; api.shardOf = shardOf;")(api, {});
const samples = JSON.parse(process.argv[3]);
const rows = samples.map(function (s) {
  const toks = api.tokenize(s);
  return { tokens: toks, shards: toks.map(api.shardOf) };
});
process.stdout.write(JSON.stringify(rows));
"""


def main():
    worker = os.path.join(SITE, "assets", "search.worker.js")
    script = os.path.join(HERE, "_parity.js")
    with open(script, "w", encoding="utf-8") as fh:
        fh.write(JS)
    try:
        got = subprocess.run(["node", script, worker, json.dumps(SAMPLES)],
                             capture_output=True, text=True, encoding="utf-8", cwd=SITE)
    finally:
        os.remove(script)
    if got.returncode != 0:
        print(got.stderr)
        raise SystemExit("node failed")
    js = json.loads(got.stdout)

    def show(t):
        return t.encode("ascii", "backslashreplace").decode("ascii")

    failed = 0
    for sample, side in zip(SAMPLES, js):
        py_tokens = B.tokens(sample)
        py_shards = [B.shard_of(t) for t in py_tokens]
        if py_tokens != side["tokens"]:
            failed += 1
            print("  FAIL tokens  %r\n    build.py %s\n    worker   %s"
                  % (show(sample), py_tokens, side["tokens"]))
        elif py_shards != side["shards"]:
            failed += 1
            print("  FAIL shards  %r\n    build.py %s\n    worker   %s"
                  % (show(sample), py_shards, side["shards"]))
        else:
            print("  ok   %r -> %d tokens" % (show(sample), len(py_tokens)))

    print("\n%d samples, %d failed" % (len(SAMPLES), failed))
    if failed:
        raise SystemExit(1)
    print("build.py and search.worker.js agree")


if __name__ == "__main__":
    main()
