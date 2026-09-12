# -*- coding: utf-8 -*-
import collections, glob, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from teams_meta import TeamDirectory, slug

BASE = r"C:\Users\Admin\Videos\iGEM"
d = TeamDirectory(os.path.join(BASE, "iGEM Intelligence Machine", "csv"))

summaries = {}
for root in (os.path.join(BASE, "Finished DataBase"), os.path.join(BASE, "Output", "pure json")):
    for p in glob.glob(os.path.join(root, "**", "metadata_*.json"), recursive=True):
        try:
            r = json.load(open(p, encoding="utf-8"))
        except Exception:
            continue
        try:
            y = int(r.get("year"))
        except (TypeError, ValueError):
            continue
        summaries.setdefault((slug(r.get("team_name")), y), r)

how = collections.Counter()
unmatched = []
for (s, y), rec in summaries.items():
    row, tag = d.lookup(rec.get("team_name"), y)
    how[tag if row else ("MISS:" + tag)] += 1
    if not row and tag == "unmatched":
        unmatched.append((s, y))

n = len(summaries)
joined = sum(v for k, v in how.items() if not k.startswith("MISS:"))
print("summaries : %d" % n)
print("joined    : %d  (%.1f%%)" % (joined, 100.0 * joined / n))
for k, v in how.most_common():
    print("   %-16s %d" % (k, v))
print("\nstill unmatched (%d), first 40:" % len(unmatched))
for s, y in sorted(unmatched)[:40]:
    print("   %-42s %s" % (s, y))
