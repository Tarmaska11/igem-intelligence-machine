# Search evaluation

These numbers measure `assets/search.worker.js`, the file the site ships. They were measured
on the September 2026 build of the data (4,978 records) and before the October 2026 search
changes (mined abbreviations only expand from the short form, two-letter and common-word
abbreviations dropped, a stricter plural rule, hyphenated words matched as one term), so
abbrev and morph in particular need a new run.

## How it is measured

`eval/rank.js` runs the worker under node, with a small `fetch` that reads the wiki shards
from disk. `eval/harness.py` sends it the queries of each set and scores the rankings.
`eval/crosscheck.py` runs the same queries in a real browser and checks that the rankings are
identical, so the node setup measures what visitors get.

| set | queries | what it measures |
|---|---:|---|
| known-item | 4964 | the query is the record's own rarest words (regression guard) |
| para-nl | 4221 | the query is the record's own problem statement (regression guard) |
| team-lineage | 3837 | finding a team's other years from one year's keywords |
| facet-cohere | 477 | records that share a target molecule come up together |
| morph | 4964 | the query uses the other grammatical number (spider / spiders) |
| abbrev | 21 | the query is an abbreviation that the relevant records only spell out |

Scores are MRR unless stated. known-item and para-nl stay around 0.99 in every run, so they
only show whether something broke. morph and abbrev were added because sets mined from the
record itself always use the record's own spelling and cannot measure recall.

Run files with the per-query detail are in `results/runs/`, named by date and label.

## Changes and their results

**1. Widening a very narrow AND to OR.** When all words matched fewer than 10 records, the
search also accepted records with only some of them. team-lineage 0.0023 -> 0.0827 (173
queries better, none worse). Removed again in change 7.

**2. Length normalisation in the wiki-text ranking.** Long wikis no longer rank first just for
being long (the top three for "spider" were 289, 179 and 101 KB against a 57 KB median; after
the change 16, 1 and 101 KB). No change on the sets, because wiki matches always come after
summary matches. Added `fulltext/meta.json.gz` with the wiki lengths and
`build.py --index-only`.

**3. Plurals.** "spider" found 204 teams and "spiders" 78. A plural and its singular are now
searched together when the singular is used by at least 20 records (this stops sars -> sar and
genes -> gen). The form you didn't type counts 0.35 of the form you typed:

| weight of the other form | morph | facet-cohere |
|---|---:|---:|
| not folded | 0.2541 | 0.8539 |
| 0.25 | 0.9140 | 0.8537 |
| 0.35 (used) | 0.9489 | 0.8537 |
| 0.50 | 0.9746 | 0.8492 |
| 0.70 | 0.9844 | 0.8434 |

**4. BM25 k1.** The index stores weighted term counts (name x12, core x7, supporting x3,
text x2), so k1 = 1.2 saturated too early. The weighted to plain mean term count ratio is
2.5, so k1 = 3 was tried and kept. morph 0.9489 -> 0.9595, team-lineage 0.0838 -> 0.0878,
facet-cohere unchanged.

**5. Synonyms from the summaries.** `pipeline/mine_synonyms.py` collects "phrase (ABBR)" pairs
that appear at least twice, which added 162 groups to the 20 written by hand.

| set | mode | before | after |
|---|---|---:|---:|
| abbrev | Keyword | 0.1624 | 0.7129 |
| abbrev | Concept | 0.1585 | 0.6362 |

**6. Concept mode adds results instead of re-ranking.** Mixing the keyword and concept
rankings (reciprocal rank fusion) was worse than keyword search alone on every set. Concept
mode now keeps the keyword ranking exactly and adds related projects (cosine above 0.12)
below it, marked "related".

| set | Concept before | Concept after |
|---|---:|---:|
| known-item | 0.9927 | 0.9967 |
| para-nl | 0.9867 | 0.9917 |
| team-lineage | 0.0505 | 0.0875 |
| facet-cohere | 0.8000 | 0.8505 |

**7. "and" means and.** A decision, not a metric: several words now always have to match
together, and only an explicit `or` gives alternatives. Typical queries are unaffected
(spider silk 118, heavy metal biosensor 459, quorum sensing biofilm 336, microbial fuel cell
558), but one misspelled word now gives an empty list. morph (0.9583 -> 0.1225) and
team-lineage (0.0874 -> 0.0000) collapse because their queries are eight rare words at once,
which no person types, so these two sets are no longer read in Keyword mode.

**8. Wiki matches ordered by mentions.** A decision: the wiki-only block is sorted by how many
times the words appear, so the "Matched: N times" number on each card goes down the list.
With several words the order follows the least mentioned word. Measured with
`eval/wikiorder.js` (200 queries, the label is "the summary has every word"):

| | BM25 order (before) | mentions (now) |
|---|---:|---:|
| nDCG@10 | 0.349 | 0.314 |
| MAP | 0.282 | 0.245 |
| count goes up somewhere down the list | 34.5% of queries | 0% |
| wiki ranking time, median / p95 | 19.6 / 72 ms | 17.5 / 47 ms |

The order is a little less relevant on this proxy (a random order scores 0.075) but can be
read at a glance.

## Where it ended up

| set | mode | start | now |
|---|---|---:|---:|
| known-item | Keyword | 0.9962 | 0.9967 |
| para-nl | Keyword | 0.9967 | 0.9917 |
| facet-cohere | Keyword | 0.8528 | 0.8505 |
| abbrev | Keyword | 0.1624 | 0.7129 |
| team-lineage | Concept | 0.0505 | 0.0875 |
| facet-cohere | Concept | 0.8000 | 0.8505 |

Neural embeddings were tested earlier on the old version of this tool and lost to these
methods on every set, so they are not used.

## Open questions

- Filter counts mix summary matches and wiki-only matches into one number.
- There is no graded relevance set yet, so the order within the first ten results is not
  measured.
