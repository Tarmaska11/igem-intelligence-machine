import collections
import gzip
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import build as B

PAIR = re.compile(r"([A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z][A-Za-z0-9-]*){1,5})"
                  r"\s*\(\s*([A-Za-z][A-Za-z0-9-]{1,9})\s*\)")

LEAD = set("a an the to of in on for with by using use develop developed developing "
           "produce produced producing create created creating based and or that this "
           "these those we our their its is are was were as at from into through".split())

MIN_SEEN = 2


def phrase_for(full, abbrev):
    words = full.split()
    n = len(abbrev)
    if len(words) < n:
        return None
    tail = words[-n:]
    if "".join(w[0].lower() for w in tail) != abbrev.lower():
        return None
    if tail[0].lower() in LEAD:
        return None
    return " ".join(w.lower() for w in tail)


def mine():
    recs = json.load(gzip.open(os.path.join(SITE, "baseline", "records.json.gz"),
                               "rt", encoding="utf-8"))
    seen = collections.Counter()
    for r in recs:
        text = " ".join(str(r.get(k) or "") for k in ("s", "p", "a", "n"))
        for full, ab in PAIR.findall(text):
            a = ab.lower()
            if not a.isalpha() or len(a) < 2:
                continue
            phrase = phrase_for(full, a)
            if phrase:
                seen[(phrase, a)] += 1
    return seen


def main():
    seen = mine()
    out, taken = [], set()
    for (phrase, ab), n in seen.most_common():
        if n < MIN_SEEN or ab in taken:
            continue
        words = B.TOKEN.findall(phrase)
        if len(words) < 2 or B.TOKEN.findall(ab) != [ab]:
            continue
        taken.add(ab)
        out.append((" ".join(words), ab, n))

    print("  // mined from the summaries by pipeline/mine_synonyms.py")
    for phrase, ab, n in sorted(out):
        print('  ["%s", "%s"],' % (phrase, ab))
    print("\n// %d pairs (seen at least %d times)" % (len(out), MIN_SEEN), file=sys.stderr)


if __name__ == "__main__":
    main()
