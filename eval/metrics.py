import math


def first_rank(ordered, relevant):
    rel = set(relevant)
    for i, rid in enumerate(ordered, 1):
        if rid in rel:
            return i
    return None


def recall_at_k(ordered, relevant, k):
    rel = set(relevant)
    hit = sum(1 for rid in ordered[:k] if rid in rel)
    return hit / len(rel) if rel else 0.0


def ndcg_at_k(ordered, relevant, k):
    rel = set(relevant)
    dcg = sum(1.0 / math.log2(i + 1) for i, rid in enumerate(ordered[:k], 1) if rid in rel)
    ideal = sum(1.0 / math.log2(i + 1) for i in range(1, min(len(rel), k) + 1))
    return dcg / ideal if ideal else 0.0


def score(rankings, queries, k=10):
    n = len(queries)
    if not n:
        return {"n": 0}
    rr = hit1 = rec = nd = 0.0
    saturated = no_hit = 0
    detail = []
    for ordered, q in zip(rankings, queries):
        fr = first_rank(ordered, q["rel"])
        rr += (1.0 / fr) if fr else 0.0
        if fr == 1:
            hit1 += 1
            saturated += 1
        if fr is None:
            no_hit += 1
        r = recall_at_k(ordered, q["rel"], k)
        d = ndcg_at_k(ordered, q["rel"], k)
        rec += r
        nd += d
        detail.append((fr, round(r, 4), round(d, 4)))
    return {
        "n": n, "MRR": rr / n, "Hit@1": hit1 / n,
        "Recall@%d" % k: rec / n, "nDCG@%d" % k: nd / n,
        "saturated": saturated / n, "no_hit": no_hit / n,
        "detail": detail,
    }


def ceilings(queries, k=10):
    n = len(queries) or 1
    return {
        "recall_ceiling": sum(min(len(q["rel"]), k) / len(q["rel"]) for q in queries) / n,
        "mean_relevant": sum(len(q["rel"]) for q in queries) / float(n),
    }
