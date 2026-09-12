# -*- coding: utf-8 -*-
"""Build the data bundles the website loads.

Reads the per-team JSON summaries, the official iGEM team CSVs and the scraped wiki
text, and writes gzipped JSON into baseline/ (shipped with the site) and dist-data/
(pushed to the database repo).

    python pipeline/build.py            # bundles only
    python pipeline/build.py --fulltext # also the sharded wiki index + wiki text
"""
import argparse
import collections
import glob
import gzip
import hashlib
import json
import math
import os
import re
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import canon
from teams_meta import NOT_TEAMS, TeamDirectory, slug

CONF = json.load(open(os.path.join(HERE, "sources.json"), encoding="utf-8"))
SRC = os.path.abspath(os.path.join(SITE, CONF["source_root"]))

BASELINE = os.path.join(SITE, "baseline")
DIST = os.path.join(SITE, "dist-data")

TOKEN = re.compile(r"[a-z0-9]{2,32}")
COMPOUND = re.compile(r"[a-z0-9]+(?:[-_][a-z0-9]+)+")
NSHARD = 256
MIN_DF = 2

# A few summaries carry a year the competition never ran. Keep the real range.
MIN_YEAR, MAX_YEAR = 2004, 2025

# How much each part of a record counts towards the score.
W_NAME, W_CORE, W_SUPPORT, W_BODY = 12, 7, 3, 2

FACET_FIELDS = [("chassis", "chassis_organisms"), ("technique", "molecular_techniques"),
                ("part", "biological_parts"), ("molecule", "target_molecules"),
                ("domain", "application_domain")]


ABBREV = re.compile(r"\b([a-z])\.\s*([a-z]{3,})\b")


def shard_of(term):
    """Which shard a term lives in. Must match shardOf() in search.worker.js."""
    h = 5381
    for ch in term:
        h = (h * 33 + ord(ch)) & 0xFFFFFFFF
    return h % NSHARD


def tokens(text):
    """Split text into search terms. Keep identical to tokenize() in search.worker.js.

    "E. coli" also yields "ecoli", and "CRISPR-Cas9" yields crispr, cas9 and
    crisprcas9, so searching either half or the whole thing works.
    """
    t = (text or "").lower()
    out = TOKEN.findall(t)
    out.extend(a + b for a, b in ABBREV.findall(t))
    out.extend(re.sub(r"[-_]", "", c) for c in COMPOUND.findall(t))
    return out


def names(value):
    """Facet fields are either a list of strings or a list of {name, importance, role}."""
    items = value if isinstance(value, list) else ([value] if isinstance(value, str) else [])
    for it in items:
        if isinstance(it, dict):
            n = it.get("name")
            if isinstance(n, str) and n.strip():
                yield n.strip(), (it.get("importance") or "").lower()
        elif isinstance(it, str) and it.strip():
            yield it.strip(), ""


def model_of(d, path):
    """Which model produced this summary. Used for the AI disclosure in the README.

    The local pass records it in _generation; the earlier worker passes only encode
    it in the file name (metadata_gemini.json and so on).
    """
    gen = d.get("_generation") or {}
    name = gen.get("model") or d.get("Processed by") or ""
    if not name:
        base = os.path.basename(path)
        if base.startswith("metadata_") and base.endswith(".json"):
            name = base[len("metadata_"):-len(".json")]
    return re.sub(r"\s+", "-", str(name).strip().lower()) or "unknown"


def load_records():
    seen = {}
    for entry in CONF["summaries"]:
        root = os.path.join(SRC, entry["root"])
        for path in glob.glob(os.path.join(root, entry["glob"]), recursive=True):
            try:
                d = json.load(open(path, encoding="utf-8"))
            except Exception:
                continue
            try:
                year = int(d.get("year"))
            except (TypeError, ValueError):
                continue
            if not (MIN_YEAR <= year <= MAX_YEAR):
                continue
            key = (slug(d.get("team_name")), year)
            if not key[0]:
                continue
            d["_src_path"] = path
            seen.setdefault(key, d)
    return seen


def build_records(seen, td, qa):
    out, dropped = [], collections.Counter()
    for (s, year), d in sorted(seen.items()):
        name = (d.get("team_name") or "").strip()
        if s in NOT_TEAMS:
            dropped["not-a-team"] += 1
            continue
        row, how = td.lookup(name, year)
        rec = {
            "id": "%s-%d" % (s, year),
            "t": name,
            "y": year,
            "u": d.get("wiki_url") or "",
            "s": d.get("summary") or "",
            "p": d.get("problem_statement") or "",
            "a": d.get("approach_statement") or "",
            "n": d.get("novelty_claim") or "",
            "kr": [x for x in (d.get("key_results") or []) if isinstance(x, str)],
            "fm": [x for x in (d.get("failure_modes") or []) if isinstance(x, str)],
            "rf": [x for x in (d.get("key_references") or []) if isinstance(x, str)],
            "ml": model_of(d, d.get("_src_path", "")),
        }
        raw, core, facets = {}, [], collections.defaultdict(list)
        for kind, field in FACET_FIELDS:
            vals = []
            for nm, imp in names(d.get(field)):
                vals.append(nm)
                if imp == "core":
                    core.append(nm)
                lab = canon.canon(kind, nm)
                if lab and lab not in facets[kind]:
                    facets[kind].append(lab)
            raw[kind] = vals
        rec["raw"] = raw
        if row:
            rec["mt"] = how
            for kind, col in (("track", "village"), ("region", "region"),
                              ("country", "country"), ("section", "section")):
                v = (row.get(col) or "").strip()
                if v:
                    facets[kind] = [v]
            rec["city"] = row.get("city") or ""
        facets["year"] = [str(year)]
        if rec["fm"]:
            facets["failures"] = ["Documents failures"]
        rec["f"] = {k: v for k, v in facets.items() if v}
        rec["core"] = core
        q = qa.get(rec["id"])
        if q:
            rec["qa"] = q
        out.append(rec)
    return out, dropped


def load_qa():
    path = os.path.join(SRC, "IGEM_CORPUS", "_qa_report.json")
    if not os.path.exists(path):
        return {}
    try:
        data = json.load(open(path, encoding="utf-8"))
    except Exception:
        return {}
    rows = data.get("records") or data.get("teams") or []
    out = {}
    for r in rows:
        try:
            out["%s-%d" % (slug(r.get("team")), int(r.get("year")))] = r.get("bucket") or r.get("qa")
        except (TypeError, ValueError):
            continue
    return out


def build_index(records):
    """One inverted index over the summaries, with the field weights folded into tf."""
    postings = collections.defaultdict(list)
    lengths = []
    for i, r in enumerate(records):
        weighted = collections.Counter()
        for t in tokens(r["t"]):
            weighted[t] += W_NAME
        for t in tokens(" ".join(r["core"])):
            weighted[t] += W_CORE
        support = " ".join(sum(r["raw"].values(), []) + r["rf"])
        for t in tokens(support):
            weighted[t] += W_SUPPORT
        body = " ".join([r["s"], r["p"], r["a"], r["n"]] + r["kr"] + r["fm"])
        for t in tokens(body):
            weighted[t] += W_BODY
        lengths.append(sum(weighted.values()))
        for t, w in weighted.items():
            postings[t].append((i, min(w, 65535)))

    index = {}
    for t, plist in postings.items():
        if len(plist) < MIN_DF and len(t) < 4:
            continue
        ids, ws, prev = [], [], 0
        for did, w in plist:
            ids.append(did - prev)
            prev = did
            ws.append(w)
        index[t] = [ids, ws]
    avg = sum(lengths) / float(len(lengths) or 1)
    return {"n": len(records), "avgdl": round(avg, 2), "dl": lengths, "terms": index}


def facet_key(kind, value):
    """Stable id for a facet value. Links use this, not the label, so renaming a
    label later does not break every URL people have shared."""
    k = re.sub(r"[^a-z0-9]+", "-", value.lower()).strip("-")
    return k or "x"


def build_facets(records):
    groups = collections.defaultdict(lambda: collections.defaultdict(list))
    for i, r in enumerate(records):
        for kind, labels in r["f"].items():
            for lab in labels:
                groups[kind][lab].append(i)
    out = {}
    for kind, vals in groups.items():
        items = sorted(vals.items(), key=lambda kv: (-len(kv[1]), kv[0]))
        if kind == "year":
            items = sorted(vals.items(), key=lambda kv: -int(kv[0]))
        out[kind] = [{"v": v, "k": facet_key(kind, v), "n": len(ids), "d": ids}
                     for v, ids in items]
    return out


def write_gz(path, obj):
    blob = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with gzip.GzipFile(path, "wb", 9, mtime=0) as fh:
        fh.write(blob)
    return len(blob), os.path.getsize(path)


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def card(r):
    """The trimmed record the results list needs. Detail comes from records.json.gz."""
    return {k: r[k] for k in ("id", "t", "y", "u", "s", "f") if k in r}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fulltext", action="store_true")
    args = ap.parse_args()
    t0 = time.time()

    td = TeamDirectory(os.path.join(SRC, CONF["teams_csv"]))
    qa = load_qa()
    seen = load_records()
    records, dropped = build_records(seen, td, qa)
    print("records   : %d  (dropped %s)" % (len(records), dict(dropped)))
    matched = sum(1 for r in records if r.get("mt"))
    print("metadata  : %d joined (%.1f%%)" % (matched, 100.0 * matched / len(records)))

    years = sorted({r["y"] for r in records})
    facets = build_facets(records)
    index = build_index(records)
    print("index     : %d terms" % len(index["terms"]))

    meta = {
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "record_count": len(records),
        "years": years,
        "year_range": "%d-%d" % (years[0], years[-1]),
        "counts": {k: len(v) for k, v in facets.items()},
        "models": dict(collections.Counter(r.get("ml", "unknown") for r in records).most_common()),
        "distinct": {
            "molecule": len({x for r in records for x in r["raw"].get("molecule", [])}),
            "chassis": len({x for r in records for x in r["raw"].get("chassis", [])}),
            "technique": len({x for r in records for x in r["raw"].get("technique", [])}),
            "part": len({x for r in records for x in r["raw"].get("part", [])}),
        },
    }

    for target in (BASELINE, DIST):
        os.makedirs(target, exist_ok=True)
        sizes = {}
        for name, obj in (("cards", [card(r) for r in records]),
                          ("records", records),
                          ("index", index),
                          ("facets", facets),
                          ("meta", meta)):
            p = os.path.join(target, name + ".json.gz")
            raw, gz = write_gz(p, obj)
            sizes[name] = (raw, gz)
        total = sum(g for _, g in sizes.values())
        print("\n%s" % os.path.relpath(target, SITE))
        for name, (raw, gz) in sizes.items():
            print("   %-9s raw %7.1f MB   gz %6.2f MB" % (name, raw / 1e6, gz / 1e6))
        print("   %-9s %20s gz %6.2f MB" % ("TOTAL", "", total / 1e6))

        man = {"schema": 1, "version": meta["built_at"], "generated_at": meta["built_at"],
               "files": {}}
        for name in ("cards", "records", "index", "facets", "meta"):
            rel = name + ".json.gz"
            man["files"][name] = {"path": rel, "sha": sha(os.path.join(target, rel)),
                                  "bytes": os.path.getsize(os.path.join(target, rel))}
        with open(os.path.join(target, "manifest.json"), "w", encoding="utf-8", newline="\n") as fh:
            json.dump(man, fh, indent=2)

    if args.fulltext:
        build_fulltext(records)
    print("\ndone in %.0fs" % (time.time() - t0))


def wiki_path(rec):
    root = os.path.join(SRC, "IGEM_CORPUS")
    for d in glob.glob(os.path.join(root, "*", str(rec["y"]))):
        if slug(os.path.basename(os.path.dirname(d))) == rec["id"].rsplit("-", 1)[0]:
            hits = glob.glob(os.path.join(d, "*.txt"))
            if hits:
                return hits[0]
    return None


def build_fulltext(records):
    """Sharded inverted index over the raw wiki text, plus the text itself."""
    out = os.path.join(DIST, "fulltext")
    os.makedirs(os.path.join(out, "text"), exist_ok=True)
    print("\n[fulltext] scanning wiki text ...")

    df = collections.Counter()
    paths = {}
    for i, r in enumerate(records):
        p = wiki_path(r)
        if not p:
            continue
        paths[i] = p
        df.update(set(tokens(open(p, encoding="utf-8", errors="ignore").read())))
        if i % 500 == 0:
            print("   pass1 %d/%d" % (i, len(records)), flush=True)
    keep = {t for t, c in df.items() if c >= MIN_DF}
    print("[fulltext] %d docs, %d terms kept (of %d)" % (len(paths), len(keep), len(df)))

    shards = collections.defaultdict(lambda: collections.defaultdict(list))
    for n, (i, p) in enumerate(sorted(paths.items())):
        text = open(p, encoding="utf-8", errors="ignore").read()
        tf = collections.Counter(tokens(text))
        for t, c in tf.items():
            if t in keep:
                s = shard_of(t)
                shards[s][t].append((i, min(c, 255)))
        gzp = os.path.join(out, "text", records[i]["id"] + ".txt.gz")
        with gzip.GzipFile(gzp, "wb", 9, mtime=0) as fh:
            fh.write(text.encode("utf-8"))
        if n % 500 == 0:
            print("   pass2 %d/%d" % (n, len(paths)), flush=True)

    total = 0
    for s, terms in shards.items():
        obj = {}
        for t, plist in terms.items():
            ids, cs, prev = [], [], 0
            for did, c in sorted(plist):
                ids.append(did - prev)
                prev = did
                cs.append(c)
            obj[t] = [ids, cs]
        p = os.path.join(out, "index", "%03d.json.gz" % s)
        _, gz = write_gz(p, obj)
        total += gz
    print("[fulltext] %d shards, %.1f MB gz" % (len(shards), total / 1e6))


if __name__ == "__main__":
    main()
