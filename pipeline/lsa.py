# -*- coding: utf-8 -*-
"""Build the concept-search model and write it in a form the browser can read.

Same LSA as the local version: TF-IDF over the corpus, reduced to 200 latent
dimensions through the small Gram matrix. The result is quantised to int8 so it
can ship with the site instead of sitting in a 34 MB .npy.

    python pipeline/lsa.py
"""
import base64
import gzip
import json
import math
import os
import re
import sys

import numpy as np

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

MAX_VOCAB = 16000        # smaller than the desktop build so the matrix fits in RAM
MIN_DF = 3
MAX_DF_RATIO = 0.85
MAX_TOKENS_PER_DOC = 60000
N_COMPONENTS = 200


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
    bits = [rec.get("s"), rec.get("p"), rec.get("a"), rec.get("n"), rec.get("track"),
            rec.get("application_domain")]
    bits += rec.get("kr") or []
    bits += rec.get("fm") or []
    bits += B.all_names(rec)
    body = " ".join(x for x in bits if x)
    return body + " " + (wiki or "")[:400000]


def quantise(mat):
    """int8 with one scale for the whole matrix - good enough for cosine ranking."""
    peak = float(np.abs(mat).max()) or 1.0
    scale = peak / 127.0
    return np.clip(np.round(mat / scale), -127, 127).astype(np.int8), scale


def main():
    td = B.TeamDirectory(os.path.join(B.SRC, B.CONF["teams_csv"]))
    qa = B.load_qa()
    records, _ = B.build_records(B.load_records(), td, qa)
    paths = B.wiki_paths()
    n = len(records)
    print("records: %d" % n)

    doc_counts, df = [], {}
    for i, r in enumerate(records):
        wiki = ""
        p = paths.get(r["id"])
        if p:
            try:
                wiki = open(p, encoding="utf-8", errors="ignore").read()
            except Exception:
                wiki = ""
        toks = tokenize(doc_text(r, wiki))[:MAX_TOKENS_PER_DOC]
        counts = {}
        for t in toks:
            counts[t] = counts.get(t, 0) + 1
        doc_counts.append(counts)
        for t in counts:
            df[t] = df.get(t, 0) + 1
        if i % 500 == 0:
            print("  tokenised %d/%d" % (i, n), flush=True)

    ceiling = max(MIN_DF, int(MAX_DF_RATIO * n))
    cand = [(t, d) for t, d in df.items()
            if d >= MIN_DF and (d <= ceiling or t in KEEP_TERMS)]
    cand.sort(key=lambda x: (-x[1], x[0]))
    vocab = sorted(t for t, _ in cand[:MAX_VOCAB])
    vidx = {t: i for i, t in enumerate(vocab)}
    v = len(vocab)
    print("vocab: %d" % v)

    idf = np.empty(v, dtype=np.float32)
    for t, i in vidx.items():
        idf[i] = math.log((n + 1.0) / (df[t] + 1.0)) + 1.0

    x = np.zeros((n, v), dtype=np.float32)
    for r, counts in enumerate(doc_counts):
        for t, c in counts.items():
            j = vidx.get(t)
            if j is not None:
                x[r, j] = (1.0 + math.log(c)) * idf[j]
    norms = np.linalg.norm(x, axis=1)
    norms[norms == 0.0] = 1.0
    x /= norms[:, None]
    print("tf-idf matrix: %.0f MB" % (x.nbytes / 1e6))

    k = int(min(N_COMPONENTS, n - 1, v))
    g = (x @ x.T).astype(np.float64)
    evals, evecs = np.linalg.eigh(g)
    order = np.argsort(evals)[::-1][:k]
    sk = np.sqrt(np.clip(evals[order], 0.0, None))
    uk = evecs[:, order]
    safe = np.where(sk > 1e-9, sk, 1.0)
    comp = (x.T.astype(np.float64) @ uk) / safe[None, :]      # V x k
    docs = uk * sk[None, :]                                   # N x k
    dn = np.linalg.norm(docs, axis=1)
    dn[dn == 0.0] = 1.0
    docs /= dn[:, None]

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
    for target in (os.path.join(SITE, "baseline"), os.path.join(SITE, "dist-data")):
        p = os.path.join(target, "lsa.json.gz")
        blob = json.dumps(out, separators=(",", ":")).encode("utf-8")
        with gzip.GzipFile(p, "wb", 9, mtime=0) as fh:
            fh.write(blob)
        print("%s: raw %.1f MB  gz %.1f MB" % (p, len(blob) / 1e6, os.path.getsize(p) / 1e6))


if __name__ == "__main__":
    main()
