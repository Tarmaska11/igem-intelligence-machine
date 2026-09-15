"""Reads the built bundles and refuses to work on a set that no longer fits them.

Everything in the ranker is addressed by record position, so a rebuild that adds or
drops one record silently repoints every label in an eval set. Nothing throws when
that happens - the numbers just quietly describe the wrong teams. So the checks here
fail hard rather than warn.
"""

import gzip
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)


def read_gz(path):
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def data_dir(name="baseline"):
    return os.path.join(SITE, name)


def load(name="baseline", what=("cards", "records", "facets", "lsa")):
    d = data_dir(name)
    return {k: read_gz(os.path.join(d, k + ".json.gz")) for k in what}


def fingerprint(name="baseline"):
    """What an eval set depends on. The manifest covers neither lsa nor the wiki
    shards, so those are pinned separately."""
    d = data_dir(name)
    man = json.load(open(os.path.join(d, "manifest.json"), encoding="utf-8"))
    lsa = read_gz(os.path.join(d, "lsa.json.gz"))
    return {
        "schema": man["schema"], "version": man["version"], "records": man["records"],
        "cards_sha": man["files"]["cards"]["sha"],
        "index_sha": man["files"]["index"]["sha"],
        "lsa_n": lsa["n"], "lsa_first": lsa["ids"][0], "lsa_last": lsa["ids"][-1],
    }


def preflight(name="baseline", want_fulltext=False):
    """Positions must line up across every bundle before anything is scored."""
    d = data_dir(name)
    cards = read_gz(os.path.join(d, "cards.json.gz"))
    index = read_gz(os.path.join(d, "index.json.gz"))
    lsa = read_gz(os.path.join(d, "lsa.json.gz"))
    n = len(cards)
    bad = []
    if index["n"] != n:
        bad.append("index n %d != %d cards" % (index["n"], n))
    if len(index["dl"]) != n:
        bad.append("index dl %d != %d cards" % (len(index["dl"]), n))
    if lsa["n"] != n:
        bad.append("lsa n %d != %d cards" % (lsa["n"], n))
    if len(lsa["ids"]) == n:
        off = [i for i in range(n) if lsa["ids"][i] != cards[i]["id"]]
        if off:
            bad.append("lsa ids differ from cards at %d positions (first %d)"
                       % (len(off), off[0]))
    else:
        bad.append("lsa ids %d != %d cards" % (len(lsa["ids"]), n))

    if want_fulltext:
        tdir = os.path.join(SITE, "dist-data", "fulltext", "text")
        if not os.path.isdir(tdir):
            bad.append("no dist-data/fulltext/text")
        else:
            have = {f[:-7] for f in os.listdir(tdir) if f.endswith(".txt.gz")}
            want = {c["id"] for c in cards}
            if have != want:
                bad.append("wiki text files differ from cards: %d missing, %d extra"
                           % (len(want - have), len(have - want)))
    if bad:
        raise SystemExit("preflight failed:\n  " + "\n  ".join(bad))
    return cards


if __name__ == "__main__":
    cards = preflight("baseline", want_fulltext=True)
    print("preflight ok: %d records" % len(cards))
    for k, v in fingerprint("baseline").items():
        print("  %-12s %s" % (k, v))
