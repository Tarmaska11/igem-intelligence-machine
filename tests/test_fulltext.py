# -*- coding: utf-8 -*-
"""Check the wiki index points at the right teams.

The shards store record positions, not ids, so if the record order ever drifted
between the two builds every wiki-only hit would name the wrong team while still
looking plausible. This walks a sample back to the actual .txt file.

    python tests/test_fulltext.py
"""
import gzip
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(SITE, "pipeline"))

import build as B

FT = os.path.join(SITE, "dist-data", "fulltext")

failures = []


def check(label, ok, detail=""):
    print(("  ok   " if ok else "  FAIL ") + label + (("  -> " + str(detail)) if detail else ""))
    if not ok:
        failures.append(label)


def main():
    if not os.path.isdir(os.path.join(FT, "index")):
        print("no full-text index built yet")
        sys.exit(1)

    with gzip.open(os.path.join(SITE, "baseline", "cards.json.gz")) as fh:
        cards = json.load(fh)
    paths = B.wiki_paths()
    random.seed(7)

    shard_files = sorted(os.listdir(os.path.join(FT, "index")))
    check("all 256 shards present", len(shard_files) == B.NSHARD, len(shard_files))

    tested = 0
    wrong = []
    cache = {}
    for fn in random.sample(shard_files, 12):
        with gzip.open(os.path.join(FT, "index", fn)) as fh:
            shard = json.load(fh)
        for term in random.sample(list(shard), min(4, len(shard))):
            # the shard a term lives in must be the one it was written to
            if B.shard_of(term) != int(fn.split(".")[0]):
                wrong.append(("shard", term, fn))
                continue
            deltas = shard[term][0]
            pos, doc = 0, []
            for d in deltas:
                pos += d
                doc.append(pos)
            for did in random.sample(doc, min(3, len(doc))):
                if did >= len(cards):
                    wrong.append(("range", term, did))
                    continue
                rid = cards[did]["id"]
                p = paths.get(rid)
                if not p:
                    wrong.append(("nopath", term, rid))
                    continue
                # tokenise the same way the builder did - "p450-dependent" is
                # indexed as p450dependent too, so a raw substring test would lie
                toks = cache.get(rid)
                if toks is None:
                    toks = set(B.tokens(open(p, encoding="utf-8", errors="ignore").read()))
                    cache[rid] = toks
                tested += 1
                if term not in toks:
                    wrong.append(("absent", term, rid))

    check("sampled postings resolve to a real wiki file", tested > 50, tested)
    check("every sampled term is in the wiki it points at", not wrong, wrong[:6])

    # a term the summaries do not carry, to prove the arm adds something
    with gzip.open(os.path.join(SITE, "baseline", "index.json.gz")) as fh:
        summary_terms = set(json.load(fh)["terms"])
    extra = 0
    for fn in shard_files[:8]:
        with gzip.open(os.path.join(FT, "index", fn)) as fh:
            extra += sum(1 for t in json.load(fh) if t not in summary_terms)
    check("wiki index adds terms the summaries never mention", extra > 500, extra)

    print("\n%d failed" % len(failures))
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
