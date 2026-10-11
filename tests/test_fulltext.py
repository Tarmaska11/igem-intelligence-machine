import gzip
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(SITE, "pipeline"))

import build as B

DB = sys.argv[1] if len(sys.argv) > 1 else os.path.join(SITE, "dist-data")
FT = os.path.join(DB, "fulltext")

failures = []


def check(label, ok, detail=""):
    print(("  ok   " if ok else "  FAIL ") + label + (("  -> " + str(detail)) if detail else ""))
    if not ok:
        failures.append(label)


def main():
    if not os.path.isdir(os.path.join(FT, "index")):
        print("no full-text index built yet")
        sys.exit(1)

    with gzip.open(os.path.join(DB, "cards.json.gz")) as fh:
        cards = json.load(fh)
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
                p = os.path.join(FT, "text", rid + ".txt.gz")
                if not os.path.exists(p):
                    wrong.append(("nopath", term, rid))
                    continue
                toks = cache.get(rid)
                if toks is None:
                    toks = set(B.tokens(B.read_text(p)))
                    cache[rid] = toks
                tested += 1
                if term not in toks:
                    wrong.append(("absent", term, rid))

    check("sampled postings resolve to a real wiki file", tested > 50, tested)
    check("every sampled term is in the wiki it points at", not wrong, wrong[:6])

    with gzip.open(os.path.join(DB, "index.json.gz")) as fh:
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
