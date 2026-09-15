"""Compares two runs, per set and arm, with paired counts.

A mean delta on its own does not say whether a change helped broadly or just moved
three queries, so the better/worse/same counts come from the per-query detail.

Run: python eval/report.py baseline c6-orfallback
"""

import glob
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
RUNS = os.path.join(HERE, "results", "runs")


def load(label):
    hits = sorted(glob.glob(os.path.join(RUNS, "*-%s.json" % label)))
    if not hits:
        raise SystemExit("no run labelled %s" % label)
    with open(hits[-1], encoding="utf-8") as fh:
        return json.load(fh)


def main():
    a, b = load(sys.argv[1]), load(sys.argv[2])
    if a["data"]["fingerprint"] != b["data"]["fingerprint"]:
        print("! different bundles - positions may not line up\n")
    k = a["k"]
    print("%s (worker %s)  ->  %s (worker %s)\n"
          % (sys.argv[1], a["worker_sha"], sys.argv[2], b["worker_sha"]))
    for name in a["results"]:
        if name not in b["results"]:
            continue
        print("=== %s (n=%d, @%d) ===" % (name, a["sets"][name]["n_scored"], k))
        print("  %-14s %9s %9s %9s   %6s %6s %6s" %
              ("arm", "MRR", "R@%d" % k, "nDCG@%d" % k, "bett", "wors", "same"))
        for arm in a["results"][name]:
            if arm not in b["results"][name]:
                continue
            x, y = a["results"][name][arm], b["results"][name][arm]
            bet = wor = sam = 0
            for da, db in zip(x.get("_detail", []), y.get("_detail", [])):
                if db[2] > da[2]:
                    bet += 1
                elif db[2] < da[2]:
                    wor += 1
                else:
                    sam += 1
            print("  %-14s %9.4f %9.4f %9.4f" %
                  (arm, x["MRR"], x["Recall@%d" % k], x["nDCG@%d" % k]))
            print("  %-14s %+9.4f %+9.4f %+9.4f   %6d %6d %6d" %
                  ("", y["MRR"] - x["MRR"],
                   y["Recall@%d" % k] - x["Recall@%d" % k],
                   y["nDCG@%d" % k] - x["nDCG@%d" % k], bet, wor, sam))
        print()


if __name__ == "__main__":
    main()
