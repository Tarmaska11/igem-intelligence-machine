# -*- coding: utf-8 -*-
"""What do the facet values look like after plain normalisation, before any alias map?"""
import collections, glob, json, os, re, sys

BASE = r"C:\Users\Admin\Videos\iGEM"
GREEK = {"\u03b1": "alpha", "\u03b2": "beta", "\u03b3": "gamma", "\u03bc": "u", "\u2019": "'"}

def norm(s):
    s = (s or "").strip().lower()
    for a, b in GREEK.items():
        s = s.replace(a, b)
    s = re.sub(r"\([^)]*\)", " ", s)          # drop "(PCR)" style asides
    s = re.sub(r"[_/,;:]+", " ", s)
    s = re.sub(r"[^a-z0-9+\-. ]", " ", s)
    s = re.sub(r"\s+", " ", s).strip(" .-")
    s = re.sub(r"\bassays\b", "assay", s)
    s = re.sub(r"\b(\w{4,})s\b", r"\1", s)     # crude singular
    return s

FIELDS = {"chassis": "chassis_organisms", "technique": "molecular_techniques",
          "part": "biological_parts", "molecule": "target_molecules",
          "domain": "application_domain", "track": "track"}

seen = {}
for root in (os.path.join(BASE, "Finished DataBase"), os.path.join(BASE, "Output", "pure json")):
    for p in glob.glob(os.path.join(root, "**", "metadata_*.json"), recursive=True):
        try: d = json.load(open(p, encoding="utf-8"))
        except Exception: continue
        seen.setdefault((str(d.get("team_name")).lower(), d.get("year")), d)

docs = collections.defaultdict(lambda: collections.defaultdict(set))
for i, d in enumerate(seen.values()):
    for kind, field in FIELDS.items():
        v = d.get(field)
        items = v if isinstance(v, list) else ([v] if isinstance(v, str) else [])
        for it in items:
            name = it.get("name") if isinstance(it, dict) else it
            n = norm(name if isinstance(name, str) else "")
            if n:
                docs[kind][n].add(i)

N = len(seen)
want = sys.argv[1] if len(sys.argv) > 1 else None
for kind in FIELDS:
    if want and kind != want:
        continue
    c = {k: len(v) for k, v in docs[kind].items()}
    top = sorted(c.items(), key=lambda kv: -kv[1])
    print("\n===== %s : %d distinct after norm (was raw) =====" % (kind, len(c)))
    lim = 120 if want else 25
    for v, n in top[:lim]:
        print("  %5d  %5.1f%%  %s" % (n, 100.0 * n / N, v))
