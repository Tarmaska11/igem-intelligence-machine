# -*- coding: utf-8 -*-
"""Checks on the built data. No browser needed, so CI can always run it.

    python tests/test_data.py
"""
import gzip
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
BASELINE = os.path.join(SITE, "baseline")

failures = []
checks = 0


def check(label, ok, detail=""):
    global checks
    checks += 1
    print(("  ok   " if ok else "  FAIL ") + label + (("  -> " + str(detail)) if detail else ""))
    if not ok:
        failures.append(label)


def load(name):
    with gzip.open(os.path.join(BASELINE, name + ".json.gz")) as fh:
        return json.load(fh)


def main():
    print("manifest")
    man = json.load(open(os.path.join(BASELINE, "manifest.json"), encoding="utf-8"))
    check("schema is recorded", isinstance(man.get("schema"), int), man.get("schema"))
    for name, info in man["files"].items():
        p = os.path.join(BASELINE, info["path"])
        h = hashlib.sha256()
        with open(p, "rb") as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b""):
                h.update(chunk)
        check("%s matches its checksum" % name, h.hexdigest()[:16] == info["sha"])

    print("\nrecords")
    cards = load("cards")
    records = load("records")
    meta = load("meta")
    facets = load("facets")
    index = load("index")
    n = len(cards)
    check("cards and records agree", n == len(records), "%d vs %d" % (n, len(records)))
    check("meta count agrees", meta["record_count"] == n)
    check("index covers every record", index["n"] == n)
    check("document lengths present", len(index["dl"]) == n)
    check("year range is real", meta["years"] == sorted(set(meta["years"]))
          and 2004 <= meta["years"][0] and meta["years"][-1] <= 2025, meta["year_range"])

    ids = [c["id"] for c in cards]
    check("ids are unique", len(set(ids)) == n)
    check("every card has a team name", all((c["team_name"] or "").strip() for c in cards))
    junk = [c["team_name"] for c in cards
            if any(ch in (c["team_name"] or "") for ch in "[]{}<>")
            or (c["team_name"] or "").lower() in ("example", "example2", "gallery", "team name")]
    check("no placeholder team names", not junk, junk[:5])
    check("records keep importance tags",
          all("importance" in x for r in records for x in (r.get("chassis_organisms") or [])[:1]))

    matched = sum(1 for r in records if r.get("mt"))
    rate = 100.0 * matched / n
    check("official metadata joined for >=95%% of records (%.1f%%)" % rate, rate >= 95)
    unmatched = [r["t"] for r in records if not r.get("mt")]
    check("few unmatched team names left", len(unmatched) < 150, len(unmatched))

    print("\nparts")
    parts = load("parts")
    check("parts index built", parts["total_unique"] > 1000, parts["total_unique"])
    check("some parts link to the Registry", parts["coded"] > 500, parts["coded"])
    check("coded parts carry a url",
          all(p["url"] for p in parts["parts"][:2000] if p["coded"]))

    print("\nfilters")
    for kind in ("year", "track", "domain", "chassis", "technique", "molecule", "part"):
        rows = facets.get(kind)
        check("%s group exists" % kind, bool(rows))
        if not rows:
            continue
        check("%s values have stable keys" % kind, all("k" in r and r["k"] for r in rows))
        top = rows[:20]
        covered = set()
        for r in top:
            covered.update(r["d"])
        pct = 100.0 * len(covered) / n
        enough = pct >= 70 or kind == "molecule"   # target molecules are a genuine long tail
        check("%s top-20 coverage %.1f%%" % (kind, pct), enough)
        distinct = sum(1 for r in rows if r["n"] >= n * 0.01)
        check("%s has >=8 values at >=1%%" % kind,
              distinct >= 8 or kind in ("section", "failures", "region"), distinct)

    print("\n%d checks, %d failed" % (checks, len(failures)))
    if failures:
        for f in failures:
            print("  - " + f)
        sys.exit(1)
    print("all good")


if __name__ == "__main__":
    main()
