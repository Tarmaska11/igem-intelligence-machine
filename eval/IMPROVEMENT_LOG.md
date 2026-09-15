# Search improvement log

Cycles 6 onward, measuring `assets/search.worker.js` — the code that actually ships.

**About cycles 1-5.** They live in the old repo's `eval/IMPROVEMENT_LOG.md` and measured
`server/app.py` over a ~750-record sqlite corpus. That stack was retired in the static-site
port and `data/corpus.sqlite` is now 0 bytes, so those numbers cannot be reproduced and are
not comparable to anything here. Their *conclusions* still hold — the wins were cheap and
lexical, neural embeddings lost on every set — and two of them turned out to have been lost
in the port, which is what cycles 6 and 7 are about.

## The harness

`eval/` drives the real worker under node (`rank.js` — a shim supplying `self`, and a `fetch`
that serves the wiki shards off disk) and scores it on six auto-mined sets. `crosscheck.py`
runs the same queries in a real browser and requires the rankings to be identical, element
for element; without that the numbers would be measuring a fiction.

| set | n | what it measures |
|---|---|---|
| known-item | 4964 | regression guard — the query is the record's own rarest words, so it is answered by construction |
| para-nl | 4221 | regression guard — the query is the record's own problem statement |
| team-lineage | 3837 | can it find a team's *other* years from one year's keywords |
| facet-cohere | 477 | do records sharing a molecule cluster |
| **morph** | 4964 | **new** — the query uses the other grammatical number than the record does |
| **abbrev** | 21 | **new** — the query is an abbreviation, the records only ever spell it out |

The last two exist because the first four are all mined *from the record they are looking
for*, so they only ever type the document's own spelling. That makes them structurally blind
to recall features — which is why folding and synonyms both looked like pure regressions
until the right set existed. Worth remembering before rejecting a recall change on these
four alone.

`known-item` and `para-nl` sit at 0.99 in every arm and every cycle. Read them as "did this
break anything", not as a score.

---

## Cycle 6 — the OR fallback came back

**Found by.** The first harness run: `team-lineage` lexical scored MRR **0.0023**, which is
the exact pathology cycle 4 fixed years ago.

**Cause.** The port narrowed the rule. `server/app.py:224` widened AND to OR whenever AND
returned fewer than `MIN_AND_HITS = 10` records; `search.worker.js` only widened when AND
returned **zero**. A query matching 1-9 records therefore never broadened, and since a
lineage query's keywords AND down to the anchor record alone — which is excluded from the
relevant set — recall was zero by construction. The wiki arm had the same narrowing.

**Change.** Restored `MIN_AND_HITS = 10` in both arms, and kept the original scoping at this
point: Keyword mode widens, Concept mode keeps strict AND, because cycle 4 measured that
broadening the lexical arm dilutes the rank fusion. (Cycle 11 removes that split, by removing
the fusion it was protecting.)

| set | arm | before | after |
|---|---|---|---|
| team-lineage | lexical | MRR 0.0023 | **0.0827** (173 queries better, 0 worse) |
| team-lineage | lexical+wiki | MRR 0.0559 | **0.0829** |
| facet-cohere | lexical | MRR 0.8528 | 0.8538 |
| known-item / para-nl | all | — | bit-identical |

**SHIPPED.**

## Cycle 7 — the wiki tail got its length normalisation back

**Cause.** Another port transcription. The old arm ordered by `bm25(wiki_fts)` — real BM25,
length-normalised. The worker scored `log(1+tf) * log(1+N/df)`, with no length term at all,
so a long wiki outranked a focused one for being long. On `spider`, the tail's top three
wikis were 289/179/101 KB against a 57 KB median.

**Change.** The shards are keyed by term and have no envelope, so document lengths needed a
new file. The count was free — `build.py` already holds `Counter(tokens(text))` in that pass —
so `build_fulltext` now also writes `fulltext/meta.json.gz` (13 KB) and `wikiTail` applies the
standard denominator with `k1=1.2, b=0.75`, matching what FTS5 did. It falls back to the old
formula when the file is absent, so an older database repo still works.

Also added `build.py --index-only`: the wiki rebuild used to re-gzip all 205 MB of saved text
every run with no exists-check, which was most of the ~15 minutes and pure waste when only
the index changed.

**Result: no measurable change on any set**, and that is expected — the tail ranks strictly
below every summary hit, so @10 metrics almost never reach it. Kept anyway: it restores
documented pre-port behaviour, and the length bias is gone by direct measurement (top of the
tail now 16/1/101/38 KB against a 54 KB median). A case where the sets cannot see a fix.

**SHIPPED** on correctness, with zero regression.

## Cycle 8 — plurals

**Cause.** `spider` returned 204 and `spiders` 78. No stemming anywhere, and 3,425
singular/plural pairs split in the index. Worst on multi-word queries, where every word must
match something: `heavy metal biosensors` returned 12 where the singular returned 36.

**Change.** Folds are derived from the shipped index at load time rather than from a word
list: strip `ies/es/s`, and keep the pair only if the singular is already a term with
`df >= 20`. That threshold is doing real work — the vocabulary check alone happily folds
`sars -> sar`:

```
rejected:  sars->sar (df 2)   genes->gen (6)   synthesis->synthesi (1)   rates->rat (12)
kept:      spiders->spider (34)   challenges->challenge (450)   biosensors->biosensor (631)
```

2,445 terms end up in a group; building the map costs 119 ms once. A fold is structurally the
same thing as a synonym group, so it reuses `parseQuery`/`scoreSpelling` with no new scoring
code and **no rebuild** — the rule can change without touching the bundles.

**The first attempt was a clear regression** — facet-cohere MRR -0.0481, 62 queries worse, 3
better. Diagnosing rather than rejecting showed why: queries like `Cas9 protein` and `Small
molecules` fold their common word, which explodes that unit and dilutes the AND.

**The fix** was to stop treating the two spellings as equals. A folded spelling now scores
`FOLD_WEIGHT` of the typed one, so a record that really uses the word typed still comes first
and the fold only adds a tail. Sweeping it:

| weight | morph MRR | facet MRR |
|---|---|---|
| none | 0.2541 | 0.8539 |
| 0.25 | 0.9140 | 0.8537 |
| **0.35** | **0.9489** | **0.8537** |
| 0.50 | 0.9746 | 0.8492 |
| 0.70 | 0.9844 | 0.8434 |

0.35 takes 95% of the gain at no measurable cost. Query words missing from the index fold too,
so typing a plural the corpus never uses still finds the singular.

**morph MRR 0.2541 -> 0.9489. known-item and para-nl unchanged; facet-cohere -0.0002.**

**SHIPPED.**

## Cycle 9 — K1

**Cause.** `build.py` folds field weights into tf at index time (name x12, core x7, support
x3, body x2) — correct BM25F — but `K1` stayed at 1.2, the value for *unweighted* counts. The
standard adjustment scales k1 by the ratio of weighted to unweighted mean term frequency,
measured here at **960.4 / 381.4 = 2.518**, i.e. K1 ~= 3. At 1.2 everything saturated early:
one body mention 0.63, a title mention 0.91, a project entirely about the term 0.98.

**Change.** Swept K1 over {1.2, 2, 3, 4, 6}. team-lineage rose monotonically, morph peaked
around 3-4, facet-cohere was flat throughout. Took **K1 = 3** — the value the theory predicts,
with 3 through 6 inside the noise of each other; picking 4 for a 0.001 difference would be
overfitting.

| set | arm | before | after |
|---|---|---|---|
| morph | lexical | MRR 0.9489 | 0.9595 (11 better, 2 worse) |
| team-lineage | lexical | MRR 0.0838 | 0.0878 (87 better, 33 worse) |
| facet-cohere | lexical | MRR 0.8537 | 0.8534 |

**SHIPPED.**

## Cycle 10 — synonyms mined from the corpus

**Cause.** 20 hand-written groups is thin for a biology corpus, and teams define their own
vocabulary: "reactive oxygen species (ROS)" once, "ROS" thereafter.

**Change.** `pipeline/mine_synonyms.py` extracts `phrase (ABBREV)` pairs from the summaries,
keeping only the last *n* words whose initials match, dropping sentence fragments, and
requiring the pair twice. 162 pairs, appended to `SYNONYMS`.

**Again invisible to the four original sets** — nothing in them types an abbreviation the
record spells out — so the `abbrev` set was built: query is the short form, relevant is every
record that uses the long phrase and *never* the short one, so it cannot be matched literally.

| set | arm | before | after |
|---|---|---|---|
| abbrev | lexical | MRR 0.1624, nDCG 0.0947 | **0.7129 / 0.4807** |
| abbrev | hybrid | MRR 0.1585, nDCG 0.0818 | **0.6362 / 0.4265** |
| everything else | | | within noise (11 queries of 2077 slightly worse) |

**SHIPPED.**

## Cycle 11 — Concept mode stops re-ranking and starts adding

**Cause.** After cycles 6-10, Concept mode lost to Keyword mode on *every* set
(facet-cohere 0.7945 vs 0.8505). Two reasons, both consequences of the earlier work:
its keyword half was the crippled strict-AND one, so it got none of the OR fallback,
folding or synonyms; and reciprocal rank fusion gives the concept ranking an equal
vote, so the weaker of the two rankings pulled good keyword hits down.

**What did not work.** Simply letting the fusion use the good keyword arm was much
worse — known-item MRR 0.9927 -> 0.7133 — which reproduces cycle 4's original finding
that broadening the lexical list dilutes the fusion. Weighting the concept arm down
helped monotonically all the way to 0.05, which is really the measurement saying the
fusion should not be happening at all:

| SEM_W | known-item | morph | facet |
|---|---|---|---|
| 1.0 | 0.9927 | 0.4561 | 0.7945 |
| 0.35 | 0.9955 | 0.6586 | 0.8222 |
| 0.1 | 0.9960 | 0.8509 | 0.8483 |

**Change.** Concept mode now **appends instead of fusing**. The keyword ranking is
used exactly as Keyword mode produces it — untouched, so precision cannot regress —
and the concept arm adds related projects below it, above the wiki tail, filtered at
cosine `SEM_MIN = 0.12`. Those rows are labelled "related" in the results, so it is
visible which hits matched words and which are there by meaning. This is also what
the mode's own description always claimed it did.

| set | arm | before | after |
|---|---|---|---|
| known-item | hybrid | 0.9927 | **0.9967** |
| para-nl | hybrid | 0.9867 | **0.9917** |
| team-lineage | hybrid | 0.0505 | **0.0875** |
| facet-cohere | hybrid | 0.8000 | **0.8505** |

**Concept mode is now >= Keyword mode on all six sets**, which was the thing that
needed fixing.

**An honest caveat.** The concept arm now adds very little *measurable* value — the
appended tail barely moves Recall@50 — because the improved keyword arm already finds
what these sets count as relevant. It is not a no-op though: `heavy metal biosensor`
gains 259 related projects including Korea_U_Seoul 2010 ("detecting heavy metals") and
Istanbul_United 2021 ("heavy metal pollution"), neither of which is a keyword match.
The sets cannot credit that because their relevant sets are one record or one molecule
tag. Judging browse quality needs the graded set that still does not exist.

**SHIPPED.**

---

## Where it ended up

| set | arm | start | end |
|---|---|---|---|
| known-item | lexical | 0.9962 | 0.9967 |
| para-nl | lexical | 0.9967 | 0.9917 |
| team-lineage | lexical | 0.0023 | **0.0874** |
| facet-cohere | lexical | 0.8528 | 0.8505 |
| morph | lexical | 0.2541 | **0.9583** |
| abbrev | lexical | 0.1624 | **0.7129** |
| team-lineage | **concept** | 0.0505 | **0.0875** |
| facet-cohere | **concept** | 0.8000 | **0.8505** |

## Lessons

- **Two of the five cycles were port regressions, not new ideas.** The ranking was
  reimplemented in JavaScript and two eval-verified decisions quietly did not survive. Nobody
  noticed for a year because nothing measured the shipped file.
- **The eval sets decide what you are allowed to discover.** Folding and synonyms both looked
  like pure regressions on the inherited sets and are both large wins. Any set mined from the
  document it is searching for cannot measure recall.
- **Diagnose a regression before rejecting it.** Cycle 8's first attempt was a clean reject on
  the numbers. Looking at *which* queries broke turned it into the run's biggest win.
- Still unmeasured: ordering *within* the correct block, which is what a judged set would be
  for. `known-item` at 0.9967 cannot say whether the top ten are in a sensible order.

## Not attempted

Neural embeddings and chunked LSA — rejected on evidence in cycles 1-3, and the neural build
crashed this laptop twice. Nothing here changes that.

## Still open

- Facet counts mix summary hits and wiki-only hits into one number.
- The hard tier split: a wiki-only hit can never outrank a weak summary hit. Worth testing a
  discount against the current hard append.
