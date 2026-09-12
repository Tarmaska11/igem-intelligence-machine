# -*- coding: utf-8 -*-
"""Does the new filter list pass? Prints coverage per facet group."""
import collections, glob, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import canon
from teams_meta import TeamDirectory, slug

BASE = r"C:\Users\Admin\Videos\iGEM"
FIELDS = {"chassis": "chassis_organisms", "technique": "molecular_techniques",
          "part": "biological_parts", "molecule": "target_molecules",
          "domain": "application_domain"}

seen = {}
for root in (os.path.join(BASE, "Finished DataBase"), os.path.join(BASE, "Output", "pure json")):
    for p in glob.glob(os.path.join(root, "**", "metadata_*.json"), recursive=True):
        try: d = json.load(open(p, encoding="utf-8"))
        except Exception: continue
        seen.setdefault((slug(d.get("team_name")), d.get("year")), d)

td = TeamDirectory(os.path.join(BASE, "iGEM Intelligence Machine", "csv"))
recs = list(seen.values())
N = len(recs)
groups = collections.defaultdict(lambda: collections.defaultdict(set))

for i, d in enumerate(recs):
    for kind, field in FIELDS.items():
        v = d.get(field)
        items = v if isinstance(v, list) else ([v] if isinstance(v, str) else [])
        for it in items:
            nm = it.get("name") if isinstance(it, dict) else it
            if isinstance(nm, str):
                lab = canon.canon(kind, nm)
                if lab:
                    groups[kind][lab].add(i)
    row, _ = td.lookup(d.get("team_name"), d.get("year"))
    if row:
        for kind, col in (("track", "village"), ("region", "region"),
                          ("country", "country"), ("section", "section")):
            val = row.get(col)
            if val:
                groups[kind][val].add(i)
    if isinstance(d.get("year"), int):
        groups["year"][str(d["year"])].add(i)
    if d.get("failure_modes"):
        groups["failures"]["Documents failures"].add(i)

print("records: %d\n" % N)
print("%-10s %6s %8s %8s %8s  %s" % ("group", "values", "top20%", "max%", ">=1%", "verdict"))
print("-" * 78)
for kind in ("year", "track", "region", "country", "section", "domain",
             "chassis", "technique", "molecule", "part", "failures"):
    g = groups[kind]
    if not g:
        continue
    top = sorted(g.items(), key=lambda kv: -len(kv[1]))
    cov20 = len(set().union(*[v for _, v in top[:20]])) if top else 0
    mx = len(top[0][1])
    n1 = sum(1 for _, v in top if len(v) >= N * 0.01)
    ok = (100.0 * cov20 / N >= 70) and (n1 >= 8 or kind in ("section", "failures", "region"))
    print("%-10s %6d %7.1f%% %7.1f%% %8d  %s" % (
        kind, len(g), 100.0 * cov20 / N, 100.0 * mx / N, n1, "PASS" if ok else "FAIL"))

for kind in ("domain", "chassis", "technique", "molecule", "part"):
    top = sorted(groups[kind].items(), key=lambda kv: -len(kv[1]))
    print("\n-- %s : %d values, top 22 --" % (kind, len(groups[kind])))
    for lab, ids in top[:22]:
        print("   %5d %5.1f%%  %s" % (len(ids), 100.0 * len(ids) / N, lab))
