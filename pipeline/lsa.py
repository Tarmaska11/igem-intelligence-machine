import argparse
import array
import base64
import gzip
import json
import math
import os
import re
import sys
import time

for _v in ("OMP_NUM_THREADS", "OPENBLAS_NUM_THREADS", "MKL_NUM_THREADS",
           "NUMEXPR_NUM_THREADS", "VECLIB_MAXIMUM_THREADS"):
    os.environ.setdefault(_v, "2")

import numpy as np
import scipy.sparse as sp
from scipy.sparse.linalg import svds

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
sys.path.insert(0, HERE)

import build as B

STOPWORDS = frozenset("""
a an and are as at be by for from has have had he her his in into is it its of
on or that the their them they this to was were will with we our us you your
i me my be been being do does did doing but not no nor so than then too very can
could should would may might must shall about above after again against all any
because before below between both during each few more most other some such only
own same s t just don now which who whom what when where why how here there
project team teams igem wiki page year university student students member members
http https www com org html index home overview description introduction
""".split())

KEEP_TERMS = frozenset("""
coli escherichia bacteria bacterial cell cells gene genes genetic protein proteins
dna rna plasmid promoter enzyme enzymes sequence expression bacterium yeast
biosensor pathway metabolic synthetic bacteriophage phage antibiotic
""".split())

_TOKEN_RE = re.compile(r"[a-zA-Z][a-zA-Z0-9\-]+")

MAX_VOCAB = 14000
MIN_DF = 3
MAX_DF_RATIO = 0.85
MAX_TOKENS_PER_DOC = 60000
N_COMPONENTS = 200

REST_EVERY = 250
REST_SECONDS = 0.3


def tokenize(text):
    out = []
    for tok in _TOKEN_RE.findall((text or "").lower()):
        tok = tok.strip("-")
        if len(tok) < 3 or len(tok) > 30 or tok in STOPWORDS:
            continue
        if tok.replace("-", "").isdigit():
            continue
        out.append(tok)
    return out


def doc_text(rec, wiki):
    bits = [rec.get("s"), rec.get("p"), rec.get("a"), rec.get("n"),
            rec.get("track"), rec.get("application_domain")]
    bits += rec.get("kr") or []
    bits += rec.get("fm") or []
    bits += B.all_names(rec)
    return " ".join(x for x in bits if x) + " " + (wiki or "")[:400000]


def read_doc(rec, paths, merged):
    try:
        wiki = B.record_text(rec["id"], paths, merged)
    except Exception:
        wiki = ""
    return tokenize(doc_text(rec, wiki))[:MAX_TOKENS_PER_DOC]


def counts_of(toks):
    c = {}
    for t in toks:
        c[t] = c.get(t, 0) + 1
    return c


def quantise(mat):
    peak = float(np.abs(mat).max()) or 1.0
    scale = peak / 127.0
    return np.clip(np.round(mat / scale), -127, 127).astype(np.int8), scale


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--from-db", dest="db", metavar="PATH",
                    help="rebuild from a copy of the database repo instead of the raw sources")
    args = ap.parse_args()
    t0 = time.time()
    records, merged = B.load_inputs(args.db)
    limit = int(os.environ.get("LSA_LIMIT", "0"))
    if limit:
        records = records[:limit]
    paths = B.wiki_paths(args.db)
    n = len(records)
    print("records: %d" % n, flush=True)

    df = {}
    for i, r in enumerate(records):
        for t in set(read_doc(r, paths, merged)):
            df[t] = df.get(t, 0) + 1
        if (i + 1) % REST_EVERY == 0:
            time.sleep(REST_SECONDS)
            if (i + 1) % 1000 == 0:
                print("   pass1 %d/%d" % (i + 1, n), flush=True)

    ceiling = max(MIN_DF, int(MAX_DF_RATIO * n))
    cand = [(t, d) for t, d in df.items()
            if d >= MIN_DF and (d <= ceiling or t in KEEP_TERMS)]
    cand.sort(key=lambda x: (-x[1], x[0]))
    vocab = sorted(t for t, _ in cand[:MAX_VOCAB])
    vidx = {t: i for i, t in enumerate(vocab)}
    v = len(vocab)
    idf = np.empty(v, dtype=np.float32)
    for t, i in vidx.items():
        idf[i] = math.log((n + 1.0) / (df[t] + 1.0)) + 1.0
    del df, cand
    print("vocab: %d (of the full term set)" % v, flush=True)

    rows = array.array("i")
    cols = array.array("i")
    vals = array.array("f")
    for i, r in enumerate(records):
        for t, k in counts_of(read_doc(r, paths, merged)).items():
            j = vidx.get(t)
            if j is not None:
                rows.append(i)
                cols.append(j)
                vals.append((1.0 + math.log(k)) * float(idf[j]))
        if (i + 1) % REST_EVERY == 0:
            time.sleep(REST_SECONDS)
            if (i + 1) % 1000 == 0:
                print("   pass2 %d/%d  (%d nonzeros)" % (i + 1, n, len(rows)), flush=True)

    x = sp.csr_matrix((np.frombuffer(vals, dtype=np.float32),
                       (np.frombuffer(rows, dtype=np.int32),
                        np.frombuffer(cols, dtype=np.int32))),
                      shape=(n, v), dtype=np.float32)
    del rows, cols, vals
    norms = np.sqrt(x.multiply(x).sum(axis=1)).A.ravel()
    norms[norms == 0.0] = 1.0
    x = (sp.diags(1.0 / norms) @ x).astype(np.float32)
    print("tf-idf: %d nonzeros, %.0f MB" % (x.nnz, x.data.nbytes / 1e6), flush=True)

    k = int(min(N_COMPONENTS, min(n, v) - 1))
    print("truncated SVD, k=%d ..." % k, flush=True)
    u, s, vt = svds(x, k=k)
    order = np.argsort(s)[::-1]
    s, u = s[order], u[:, order]
    comp = vt[order, :].T
    docs = u * s[None, :]
    dn = np.linalg.norm(docs, axis=1)
    dn[dn == 0.0] = 1.0
    docs = docs / dn[:, None]
    print("svd done, top singular value %.3f" % s[0], flush=True)

    qc, cs = quantise(comp.astype(np.float32))
    qd, ds = quantise(docs.astype(np.float32))
    out = {
        "k": k, "n": n, "v": v,
        "vocab": vocab,
        "idf": [round(float(z), 4) for z in idf],
        "ids": [r["id"] for r in records],
        "comp_scale": cs, "comp": base64.b64encode(qc.tobytes()).decode("ascii"),
        "docs_scale": ds, "docs": base64.b64encode(qd.tobytes()).decode("ascii"),
    }
    blob = json.dumps(out, separators=(",", ":")).encode("utf-8")
    for target in (os.path.join(SITE, "baseline"), os.path.join(SITE, "dist-data")):
        p = os.path.join(target, "lsa.json.gz")
        with gzip.GzipFile(p, "wb", 9, mtime=0) as fh:
            fh.write(blob)
        print("%s  raw %.1f MB  gz %.1f MB"
              % (os.path.relpath(p, SITE), len(blob) / 1e6, os.path.getsize(p) / 1e6))
    print("done in %.0fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
