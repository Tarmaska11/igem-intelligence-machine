"""Scores the shipped search worker on the four eval sets.

Starts eval/rank.js, feeds it queries, scores what comes back, and writes one run
record per run so cycles can be compared later. The worker file is hashed into the
run, because a number only means something next to the code that produced it.

Run: python eval/harness.py --label c6-baseline
     python eval/harness.py --label c6-stem --arms lexical,hybrid
"""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import time

import bundles
import metrics

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)
SETS = os.path.join(HERE, "sets")
RUNS = os.path.join(HERE, "results", "runs")

# known-item and para-nl are answered by construction - the query is the record's
# own rarest words - so they are regression guards, not measuring instruments.
# Sampling them down keeps a cycle affordable on this machine.
SAMPLE = {"known-item": 200, "para-nl": 200, "morph": 400,
          "team-lineage": 800, "facet-cohere": 0}

ARMS = {
    "lexical":      ("lexical", False),
    "hybrid":       ("hybrid",  False),
    "lexical+wiki": ("lexical", True),
    "hybrid+wiki":  ("hybrid",  True),
}


def sha256(path):
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read()).hexdigest()[:16]


def load_set(name, fp, sample):
    with open(os.path.join(SETS, name + ".json"), encoding="utf-8") as fh:
        obj = json.load(fh)
    if obj["fingerprint"] != fp:
        raise SystemExit("set %s was mined against different bundles - run "
                         "python eval/mine.py" % name)
    q = obj["queries"]
    if sample and sample < len(q):
        step = len(q) / float(sample)
        q = [q[int(i * step)] for i in range(sample)]
    return q


class Ranker:
    """One node process holding the loaded bundles for the whole run."""

    def __init__(self, data="baseline"):
        self.p = subprocess.Popen(
            ["node", "--max-old-space-size=2048", os.path.join(HERE, "rank.js"), data],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            cwd=SITE, text=True, encoding="utf-8", bufsize=1)
        hello = json.loads(self.p.stdout.readline())
        if not hello.get("lsa"):
            raise SystemExit("rank.js started without the concept model")
        self.n = hello["n"]
        self.wiki = False

    def send(self, obj):
        self.p.stdin.write(json.dumps(obj) + "\n")
        self.p.stdin.flush()
        return json.loads(self.p.stdout.readline())

    def set_wiki(self, on):
        if on != self.wiki:
            self.send({"type": "wiki", "on": bool(on)})
            self.wiki = bool(on)

    def rank(self, q, mode):
        return self.send({"q": q, "mode": mode})

    def close(self):
        try:
            self.p.stdin.write('{"type":"bye"}\n')
            self.p.stdin.flush()
        except Exception:
            pass
        self.p.wait(timeout=20)


def run_arm(r, arm, queries, k, rest_every, rest_seconds):
    mode, wiki = ARMS[arm]
    r.set_wiki(wiki)
    rankings, ms, wiki_only = [], [], []
    for i, q in enumerate(queries, 1):
        got = r.rank(q["query"], mode)
        rankings.append(got["ids"])
        ms.append(got["ms"])
        wiki_only.append(got.get("wikiOnly") or 0)
        # this laptop has shut down under sustained load, so let it breathe
        if rest_every and i % rest_every == 0:
            time.sleep(rest_seconds)
    out = metrics.score(rankings, queries, k)
    ms.sort()
    out["ms_median"] = ms[len(ms) // 2] if ms else 0
    out["wiki_only_mean"] = sum(wiki_only) / float(len(wiki_only) or 1)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--arms", default="lexical,hybrid,lexical+wiki,hybrid+wiki")
    ap.add_argument("--sets", default="known-item,para-nl,team-lineage,facet-cohere")
    ap.add_argument("--k", type=int, default=10)
    ap.add_argument("--data", default="baseline")
    ap.add_argument("--full", action="store_true", help="no sampling")
    ap.add_argument("--sample", type=int, default=0, help="cap every set at this many")
    ap.add_argument("--rest-every", type=int, default=250)
    ap.add_argument("--rest-seconds", type=float, default=0.3)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    arms = [a for a in args.arms.split(",") if a]
    want_wiki = any(ARMS[a][1] for a in arms)
    bundles.preflight(args.data, want_fulltext=want_wiki)
    fp = bundles.fingerprint(args.data)

    sets = {}
    for name in args.sets.split(","):
        cap = 0 if args.full else (args.sample or SAMPLE.get(name, 0))
        sets[name] = load_set(name, fp, cap)

    r = Ranker(args.data)
    started = time.time()
    results, setinfo = {}, {}
    for name, queries in sets.items():
        setinfo[name] = dict(n_scored=len(queries), **metrics.ceilings(queries, args.k))
        results[name] = {}
        for arm in arms:
            t0 = time.time()
            out = run_arm(r, arm, queries, args.k, args.rest_every, args.rest_seconds)
            detail = out.pop("detail")
            results[name][arm] = out
            results[name][arm]["_detail"] = detail
            if not args.quiet:
                print("%-14s %-13s MRR %.4f  Hit@1 %.3f  R@%d %.4f  nDCG@%d %.4f  "
                      "sat %.2f  miss %.2f  %.0fs"
                      % (name, arm, out["MRR"], out["Hit@1"], args.k,
                         out["Recall@%d" % args.k], args.k, out["nDCG@%d" % args.k],
                         out["saturated"], out["no_hit"], time.time() - t0))
        sys.stdout.flush()
    r.close()

    os.makedirs(RUNS, exist_ok=True)
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    path = os.path.join(RUNS, "%s-%s.json" % (stamp, args.label))
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({
            "label": args.label, "at": stamp, "k": args.k,
            "worker_sha": sha256(os.path.join(SITE, "assets", "search.worker.js")),
            "data": {"dir": args.data, "fingerprint": fp},
            "arms": arms, "sets": setinfo, "results": results,
            "seconds": round(time.time() - started, 1),
        }, fh)
    print("\nwrote %s  (%.0fs)" % (os.path.relpath(path, SITE), time.time() - started))


if __name__ == "__main__":
    main()
