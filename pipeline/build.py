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
from teams_meta import JUNK_NAME, NOT_TEAMS, TeamDirectory, slug

CONF = json.load(open(os.path.join(HERE, "sources.json"), encoding="utf-8"))
SRC = os.path.abspath(os.path.join(SITE, CONF["source_root"]))

BASELINE = os.path.join(SITE, "baseline")
DIST = os.path.join(SITE, "dist-data")

TOKEN = re.compile(r"[a-z0-9]{2,32}")
COMPOUND = re.compile(r"[a-z0-9]+(?:[-_][a-z0-9]+)+")
DATA_SCHEMA = 2

NSHARD = 256
MIN_DF = 2

MIN_YEAR, MAX_YEAR = 2004, 2025

W_NAME, W_CORE, W_SUPPORT, W_BODY = 12, 7, 3, 2

FACET_FIELDS = [("chassis", "chassis_organisms"), ("technique", "molecular_techniques"),
                ("part", "biological_parts"), ("molecule", "target_molecules"),
                ("domain", "application_domain")]


ABBREV = re.compile(r"\b([a-z])\.\s*([a-z]{3,})\b")


def shard_of(term):
    h = 5381
    for ch in term:
        h = (h * 33 + ord(ch)) & 0xFFFFFFFF
    return h % NSHARD


def tokens(text):
    t = (text or "").lower()
    out = TOKEN.findall(t)
    out.extend(a + b for a, b in ABBREV.findall(t))
    out.extend(re.sub(r"[-_]", "", c) for c in COMPOUND.findall(t))
    return out


SCHEMA_FIELD = {"chassis": "chassis_organisms", "technique": "molecular_techniques",
                "part": "biological_parts", "molecule": "target_molecules"}

_BBA_RE = re.compile(r"BBa[_\s]?([A-Za-z0-9]{4,12})", re.I)


def part_registry(name):
    m = _BBA_RE.search(name or "")
    if not m:
        return None, None
    code = "BBa_" + m.group(1).upper()
    return code, "https://registry.igem.org/parts/%s" % code.lower().replace("_", "-")


def items_of(value):
    raw = value if isinstance(value, list) else ([value] if isinstance(value, str) else [])
    out = []
    for it in raw:
        if isinstance(it, dict):
            nm = it.get("name")
            if isinstance(nm, str) and nm.strip():
                out.append({"name": nm.strip(),
                            "importance": (it.get("importance") or "mentioned").lower(),
                            "role": it.get("role") or ""})
        elif isinstance(it, str) and it.strip():
            out.append({"name": it.strip(), "importance": "core", "role": ""})
    return out


def model_of(d, path):
    gen = d.get("_generation") or {}
    name = gen.get("model") or d.get("Processed by") or ""
    if not name:
        base = os.path.basename(path)
        if base.startswith("metadata_") and base.endswith(".json"):
            name = base[len("metadata_"):-len(".json")]
    slug = re.sub(r"\s+", "-", str(name).strip().lower()) or "unknown"
    return MODEL_NAMES.get(slug, slug)


MODEL_NAMES = {"chibimaid-e4b": "Gemma 3n E4B"}


WIKI_MOVE_YEAR = 2022


def wiki_url(team, year, row):
    name = ((row.get("name") if row else "") or team or "").strip()
    if not name:
        return ""
    if year >= WIKI_MOVE_YEAR:
        slug = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")
        return "https://%d.igem.wiki/%s/" % (year, slug)
    return "https://%d.igem.org/Team:%s" % (year, name.replace(" ", "_"))


def identity_from_path(path):
    year_dir = os.path.basename(os.path.dirname(path))
    team_dir = os.path.basename(os.path.dirname(os.path.dirname(path)))
    try:
        return team_dir, int(year_dir)
    except (TypeError, ValueError):
        return team_dir, None


def load_records():
    seen = {}
    for entry in CONF["summaries"]:
        root = os.path.join(SRC, entry["root"])
        for path in glob.glob(os.path.join(root, entry["glob"]), recursive=True):
            try:
                d = json.load(open(path, encoding="utf-8"))
            except Exception:
                continue
            team, year = identity_from_path(path)
            if year is None:
                try:
                    year = int(d.get("year"))
                except (TypeError, ValueError):
                    continue
            if not (MIN_YEAR <= year <= MAX_YEAR):
                continue
            key = (slug(team), year)
            if not key[0]:
                continue
            d["_src_path"] = path
            d["_team"] = team
            d["_year"] = year
            seen.setdefault(key, d)
    return seen


def build_records(seen, td, qa):
    out, dropped = [], collections.Counter()
    for (s, year), d in sorted(seen.items()):
        name = (d.get("_team") or d.get("team_name") or "").strip()
        if s in NOT_TEAMS or JUNK_NAME.search(name):
            dropped["not-a-team"] += 1
            continue
        row, how = td.lookup(name, year)
        rec = {
            "id": "%s-%d" % (s, year),
            "t": name,
            "y": year,
            "u": wiki_url(name, year, row),
            "s": d.get("summary") or "",
            "p": d.get("problem_statement") or "",
            "a": d.get("approach_statement") or "",
            "n": d.get("novelty_claim") or "",
            "kr": [x for x in (d.get("key_results") or []) if isinstance(x, str)],
            "fm": [x for x in (d.get("failure_modes") or []) if isinstance(x, str)],
            "rf": [x for x in (d.get("key_references") or []) if isinstance(x, str)],
            "ml": model_of(d, d.get("_src_path", "")),
        }
        core, facets = [], collections.defaultdict(list)
        for kind, field in FACET_FIELDS:
            if kind == "domain":
                lab = canon.canon("domain", d.get("application_domain"))
                if lab:
                    facets["domain"].append(lab)
                continue
            items = items_of(d.get(field))
            for it in items:
                if it["importance"] == "core":
                    core.append(it["name"])
                lab = canon.canon(kind, it["name"])
                if lab and lab not in facets[kind]:
                    facets[kind].append(lab)
            if kind == "part":
                for it in items:
                    code, url = part_registry(it["name"])
                    if code:
                        it["registry_id"], it["registry_url"] = code, url
            rec[SCHEMA_FIELD[kind]] = items
        rec["target_molecules"] = [x["name"] for x in rec.get("target_molecules", [])]
        rec["track"] = (d.get("track") or "").strip()
        rec["application_domain"] = (d.get("application_domain") or "").strip()
        if row:
            rec["mt"] = how
            for kind, col in (("track", "village"), ("region", "region"),
                              ("country", "country"), ("section", "section")):
                v = (row.get(col) or "").strip()
                if v:
                    facets[kind] = [canon.label_meta(kind, v)]
            rec["city"] = row.get("city") or ""
        if facets.get("track"):
            vil = canon.village(facets["track"][0], (facets.get("domain") or [""])[0])
            facets["track"] = [vil] if vil else []
        facets["year"] = [str(year)]
        rec["f"] = {k: v for k, v in facets.items() if v}
        rec["core"] = core
        q = qa.get(rec["id"])
        if q:
            rec["qa"] = q
        out.append(rec)
    return out, dropped


MATCH_RANK = {"exact": 0, "relaxed": 1, "fuzzy": 2, "prefix": 3}


def page_name(url):
    last = (url or "").rstrip("/").rsplit("/", 1)[-1].split(":", 1)[-1]
    return re.sub(r"[^a-z0-9]+", "", last.lower())


def dedupe(records):
    groups = collections.defaultdict(list)
    for r in records:
        if re.match(r"example([\W_]|$)", r["t"].lower()):
            continue
        groups[r["u"] or r["id"]].append(r)
    keep, merged = set(), {}
    for rs in groups.values():
        target = page_name(rs[0]["u"])
        best = min(rs, key=lambda r: (MATCH_RANK.get(r.get("mt"), 4),
                                      re.sub(r"[^a-z0-9]+", "", r["t"].lower()) != target,
                                      len(r["t"]), r["id"]))
        keep.add(best["id"])
        others = sorted(r["id"] for r in rs if r is not best)
        if others:
            merged[best["id"]] = others
    return [r for r in records if r["id"] in keep], merged


def load_inputs(db=None):
    if db:
        records = db_records(db)
    else:
        td = TeamDirectory(os.path.join(SRC, CONF["teams_csv"]))
        records, dropped = build_records(load_records(), td, load_qa())
        print("records   : %d read  (dropped %s)" % (len(records), dict(dropped)))
    before = len(records)
    records, merged = dedupe(records)
    print("records   : %d  (%d duplicates and templates removed)" % (len(records), before - len(records)))
    return records, merged


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


def all_names(r):
    out = list(r.get("target_molecules") or [])
    for f in ("chassis_organisms", "molecular_techniques", "biological_parts"):
        out.extend(x["name"] for x in (r.get(f) or []))
    for f in ("track", "application_domain"):
        if r.get(f):
            out.append(r[f])
    return out


def build_index(records):
    postings = collections.defaultdict(list)
    lengths = []
    for i, r in enumerate(records):
        weighted = collections.Counter()
        for t in tokens(r["t"]):
            weighted[t] += W_NAME
        for t in tokens(" ".join(r["core"])):
            weighted[t] += W_CORE
        support = " ".join(all_names(r) + r["rf"])
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
                     for v, ids in items if canon.keep_value(kind, v, len(ids))]
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
    return {
        "id": r["id"], "team_name": r["t"], "year": r["y"],
        "domain": r.get("application_domain") or r.get("track") or "",
        "summary": r.get("s") or "",
        "needs_summary": not (r.get("s") or "").strip(),
        "chassis": [{"name": x["name"], "importance": x["importance"]}
                    for x in (r.get("chassis_organisms") or [])[:4]],
        "techniques": [{"name": x["name"], "importance": x["importance"]}
                       for x in (r.get("molecular_techniques") or [])[:4]],
        "molecules": (r.get("target_molecules") or [])[:3],
        "f": r.get("f", {}),
    }


def build_parts(records):
    agg = {}
    for r in records:
        for it in (r.get("biological_parts") or []):
            name = it["name"]
            key = re.sub(r"\s+", " ", name.lower())
            slot = agg.get(key)
            if slot is None:
                code, url = part_registry(name)
                slot = agg[key] = {"name": name, "count": 0, "teams": [],
                                   "registry_id": code, "url": url, "coded": bool(code)}
            slot["count"] += 1
            if len(slot["teams"]) < 8:
                slot["teams"].append(r["id"])
    parts = sorted(agg.values(), key=lambda x: (-x["count"], x["name"].lower()))
    return {"total_unique": len(agg), "coded": sum(1 for x in agg.values() if x["coded"]),
            "parts": parts}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--fulltext", action="store_true")
    ap.add_argument("--from-db", dest="db", metavar="PATH",
                    help="rebuild from a copy of the database repo instead of the raw sources")
    ap.add_argument("--index-only", dest="index_only", action="store_true",
                    help="rebuild the wiki index but leave the saved text alone")
    args = ap.parse_args()
    t0 = time.time()

    records, merged = load_inputs(args.db)
    matched = sum(1 for r in records if r.get("mt"))
    print("metadata  : %d joined (%.1f%%)" % (matched, 100.0 * matched / len(records)))

    if args.index_only:
        build_fulltext(records, index_only=True, db=args.db, merged=merged)
        print("\ndone in %.0fs" % (time.time() - t0))
        return

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
            "molecule": len({x for r in records for x in (r.get("target_molecules") or [])}),
            "chassis": len({x["name"] for r in records for x in (r.get("chassis_organisms") or [])}),
            "technique": len({x["name"] for r in records for x in (r.get("molecular_techniques") or [])}),
            "part": len({x["name"] for r in records for x in (r.get("biological_parts") or [])}),
        },
    }

    parts = build_parts(records)
    for target in (BASELINE, DIST):
        os.makedirs(target, exist_ok=True)
        sizes = {}
        bundles = [("cards", [card(r) for r in records]),
                   ("records", records),
                   ("index", index),
                   ("facets", facets),
                   ("meta", meta)]
        if target == DIST:
            bundles.insert(4, ("parts", parts))
        for name, obj in bundles:
            p = os.path.join(target, name + ".json.gz")
            raw, gz = write_gz(p, obj)
            sizes[name] = (raw, gz)
        total = sum(g for _, g in sizes.values())
        print("\n%s" % os.path.relpath(target, SITE))
        for name, (raw, gz) in sizes.items():
            print("   %-9s raw %7.1f MB   gz %6.2f MB" % (name, raw / 1e6, gz / 1e6))
        print("   %-9s %20s gz %6.2f MB" % ("TOTAL", "", total / 1e6))

        man = {"schema": DATA_SCHEMA, "version": meta["built_at"],
               "generated_at": meta["built_at"], "records": len(records), "files": {}}
        for name, _ in bundles:
            rel = name + ".json.gz"
            man["files"][name] = {"path": rel, "sha": sha(os.path.join(target, rel)),
                                  "bytes": os.path.getsize(os.path.join(target, rel))}
        with open(os.path.join(target, "manifest.json"), "w", encoding="utf-8", newline="\n") as fh:
            json.dump(man, fh, indent=2)

    if args.fulltext or args.index_only:
        build_fulltext(records, index_only=args.index_only, db=args.db, merged=merged)
    print("\ndone in %.0fs" % (time.time() - t0))


_WIKI_INDEX = None


def db_records(db):
    with gzip.open(os.path.join(db, "records.json.gz")) as fh:
        return json.load(fh)


def read_text(path):
    if path.endswith(".gz"):
        with gzip.open(path, "rb") as fh:
            return fh.read().decode("utf-8", errors="ignore")
    with open(path, encoding="utf-8", errors="ignore") as fh:
        return fh.read()


def record_text(rid, paths, merged=None):
    main = read_text(paths[rid]) if rid in paths else ""
    extra = [read_text(paths[o]) for o in (merged or {}).get(rid, []) if o in paths]
    if not extra:
        return main
    seen = {line.strip() for line in main.split("\n") if line.strip()}
    out = [main] if main.strip() else []
    for text in extra:
        keep = []
        for line in text.split("\n"):
            key = line.strip()
            if key and key in seen:
                continue
            seen.add(key)
            keep.append(line)
        part = "\n".join(keep).strip("\n")
        if part.strip():
            out.append(part)
    return "\n\n".join(out)


def wiki_paths(db=None):
    global _WIKI_INDEX
    if _WIKI_INDEX is not None:
        return _WIKI_INDEX
    _WIKI_INDEX = {}
    if db:
        root = os.path.join(db, "fulltext", "text")
        for fn in os.listdir(root):
            if fn.endswith(".txt.gz"):
                _WIKI_INDEX[fn[:-len(".txt.gz")]] = os.path.join(root, fn)
        return _WIKI_INDEX
    root = os.path.join(SRC, "IGEM_CORPUS")
    for team in os.listdir(root):
        tdir = os.path.join(root, team)
        if not os.path.isdir(tdir):
            continue
        for year in os.listdir(tdir):
            ydir = os.path.join(tdir, year)
            if not os.path.isdir(ydir):
                continue
            for fn in os.listdir(ydir):
                if fn.lower().endswith(".txt"):
                    _WIKI_INDEX.setdefault("%s-%s" % (slug(team), year), os.path.join(ydir, fn))
                    break
    return _WIKI_INDEX


def build_fulltext(records, index_only=False, db=None, merged=None):
    out = os.path.join(DIST, "fulltext")
    tmp = os.path.join(out, "_tmp")
    os.makedirs(os.path.join(out, "text"), exist_ok=True)
    os.makedirs(tmp, exist_ok=True)
    print("\n[fulltext] scanning wiki text ...", flush=True)

    index = wiki_paths(db)
    df = collections.Counter()
    paths = {}
    merged = merged or {}
    for i, r in enumerate(records):
        if r["id"] not in index and not any(o in index for o in merged.get(r["id"], [])):
            continue
        paths[i] = r["id"]
        df.update(set(tokens(record_text(r["id"], index, merged))))
        if i % 500 == 0:
            print("   pass1 %d/%d" % (i, len(records)), flush=True)
    keep = {t for t, c in df.items() if c >= MIN_DF}
    print("[fulltext] %d docs, %d terms kept (of %d)" % (len(paths), len(keep), len(df)), flush=True)
    del df

    spool = [open(os.path.join(tmp, "%03d.txt" % s), "w", encoding="utf-8") for s in range(NSHARD)]
    lengths = [0] * len(records)
    for n, (i, rid) in enumerate(sorted(paths.items())):
        text = record_text(rid, index, merged)
        tf = collections.Counter(tokens(text))
        lengths[i] = sum(tf.values())
        for t, c in tf.items():
            if t in keep:
                spool[shard_of(t)].write("%s\t%d\t%d\n" % (t, i, min(c, 255)))
        if not index_only:
            gzp = os.path.join(out, "text", records[i]["id"] + ".txt.gz")
            with gzip.GzipFile(gzp, "wb", 9, mtime=0) as fh:
                fh.write(text.encode("utf-8"))
        if n % 500 == 0:
            for f in spool:
                f.flush()
            print("   pass2 %d/%d" % (n, len(paths)), flush=True)
    for f in spool:
        f.close()
    del keep

    total = 0
    for s in range(NSHARD):
        path = os.path.join(tmp, "%03d.txt" % s)
        postings = collections.defaultdict(list)
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                t, did, c = line.rstrip("\n").split("\t")
                postings[t].append((int(did), int(c)))
        obj = {}
        for t, plist in postings.items():
            ids, cs, prev = [], [], 0
            for did, c in sorted(plist):
                ids.append(did - prev)
                prev = did
                cs.append(c)
            obj[t] = [ids, cs]
        _, gz = write_gz(os.path.join(out, "index", "%03d.json.gz" % s), obj)
        total += gz
        os.remove(path)
        if s % 64 == 0:
            print("   merged shard %d/%d" % (s, NSHARD), flush=True)
    os.rmdir(tmp)
    nz = [x for x in lengths if x]
    meta = {"n": len(lengths), "docs": len(nz),
            "avgdl": round(sum(nz) / float(len(nz) or 1), 2), "dl": lengths}
    _, mgz = write_gz(os.path.join(out, "meta.json.gz"), meta)
    total += mgz
    print("[fulltext] %d shards, %.1f MB gz, avgdl %.0f"
          % (NSHARD, total / 1e6, meta["avgdl"]), flush=True)


if __name__ == "__main__":
    main()
