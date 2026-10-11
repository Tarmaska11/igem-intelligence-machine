import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "pipeline"))

import mine_synonyms as MS

MIN_REL, MAX_REL = 3, 25


def build(records, ids):
    pairs = [(p, a) for (p, a), n in MS.mine().most_common() if n >= MS.MIN_SEEN]
    seen_ab = set()
    out = []
    for phrase, ab in pairs:
        if ab in seen_ab or len(phrase.split()) < 2:
            continue
        seen_ab.add(ab)
        long_re = re.compile(r"\b" + r"\s+".join(re.escape(w) for w in phrase.split()) + r"\b",
                             re.I)
        short_re = re.compile(r"\b" + re.escape(ab) + r"\b", re.I)
        rel = []
        for i, r in enumerate(records):
            text = " ".join(str(r.get(k) or "") for k in ("s", "p", "a", "n"))
            if long_re.search(text) and not short_re.search(text):
                rel.append(i)
        if MIN_REL <= len(rel) <= MAX_REL:
            out.append({"query": ab, "rel": rel, "rel_ids": [ids[i] for i in rel],
                        "long": phrase})
    return out
