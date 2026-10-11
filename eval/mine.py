import json
import os
import re

import bundles

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "sets")

LSA_TOKEN = re.compile(r"[a-zA-Z][a-zA-Z0-9-]+")


def lsa_tokens(text):
    out = []
    for raw in LSA_TOKEN.findall((text or "").lower()):
        t = raw.strip("-")
        if len(t) < 3 or len(t) > 30:
            continue
        if t.replace("-", "").isdigit():
            continue
        out.append(t)
    return out


def distinctive_keywords(vidx, idf, text, n=8):
    seen, scored = set(), []
    for tok in lsa_tokens(text):
        if tok in seen:
            continue
        seen.add(tok)
        j = vidx.get(tok)
        if j is not None:
            scored.append((float(idf[j]), tok))
    scored.sort(reverse=True)
    return " ".join(t for _, t in scored[:n])


def flip_number(w):
    if len(w) < 4:
        return w
    if w.endswith("ies"):
        return w[:-3] + "y"
    if w.endswith("ses") or w.endswith("xes") or w.endswith("ches") or w.endswith("shes"):
        return w[:-2]
    if w.endswith("s"):
        return w[:-1]
    if w.endswith("y") and w[-2] not in "aeiou":
        return w[:-1] + "ies"
    if w.endswith(("s", "x", "ch", "sh")):
        return w + "es"
    return w + "s"


def team_of(rid):
    return re.sub(r"-(\d{4}|na)$", "", rid)


def build(name="baseline"):
    cards = bundles.preflight(name)
    b = bundles.load(name, ("records", "facets", "lsa"))
    records, facets, lsa = b["records"], b["facets"], b["lsa"]
    vidx = {t: i for i, t in enumerate(lsa["vocab"])}
    idf = lsa["idf"]

    kw = [distinctive_keywords(vidx, idf, r.get("s") or r.get("p") or "") for r in records]
    ids = [c["id"] for c in cards]
    sets = {}

    sets["known-item"] = [
        {"query": kw[i], "rel": [i], "rel_ids": [ids[i]]}
        for i in range(len(records)) if len(kw[i].split()) >= 3
    ]

    para = []
    for i, r in enumerate(records):
        ps = (r.get("p") or "").strip().split()
        if len(ps) >= 12:
            para.append({"query": " ".join(ps[:60]), "rel": [i], "rel_ids": [ids[i]]})
    sets["para-nl"] = para

    by_team = {}
    for i, rid in enumerate(ids):
        by_team.setdefault(team_of(rid), []).append(i)
    lineage = []
    for members in by_team.values():
        years = {records[i].get("y") for i in members}
        if len(members) < 2 or len(years) < 2:
            continue
        for anchor in members:
            others = [i for i in members if i != anchor]
            if kw[anchor] and others:
                lineage.append({"query": kw[anchor], "rel": others,
                                "rel_ids": [ids[i] for i in others],
                                "anchor": anchor, "anchor_id": ids[anchor]})
    sets["team-lineage"] = lineage

    morph = []
    for i in range(len(records)):
        words = kw[i].split()
        if len(words) < 3:
            continue
        flipped, changed = [], 0
        for w in words:
            f = flip_number(w)
            if f != w:
                changed += 1
            flipped.append(f)
        if changed >= 2:
            morph.append({"query": " ".join(flipped), "rel": [i], "rel_ids": [ids[i]]})
    sets["morph"] = morph

    import mine_abbrev
    sets["abbrev"] = mine_abbrev.build(records, ids)

    facet = []
    for item in facets.get("molecule", []):
        d = item["d"]
        if 3 <= len(d) <= 25 and len(item.get("k") or item["v"]) >= 3:
            facet.append({"query": item["v"], "rel": sorted(d),
                          "rel_ids": [ids[i] for i in sorted(d)]})
    sets["facet-cohere"] = facet

    return sets, bundles.fingerprint(name)


def main():
    sets, fp = build()
    os.makedirs(OUT, exist_ok=True)
    for name, queries in sets.items():
        path = os.path.join(OUT, name + ".json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump({"set": name, "fingerprint": fp, "queries": queries}, fh)
        rel = sum(len(q["rel"]) for q in queries) / float(len(queries) or 1)
        print("%-14s n=%-5d mean relevant=%.2f" % (name, len(queries), rel))


if __name__ == "__main__":
    main()
