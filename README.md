# iGEM Intelligence Machine

A search engine over every iGEM team project from 2008 to 2025 - 4,978 projects. Search by
idea, chassis organism, molecular technique, biological part, target molecule, result or
failure, and find the teams who already tried what you are about to try.

It is a static website: no server, no install, no account. Search runs in your browser.

- Live site: https://tarmaska11.github.io/igem-intelligence-machine/
- Database (all data the site runs on): https://github.com/Tarmaska11/igem-intelligence-machine-db

## Who it is for

iGEM teams at the start of a season, when they are choosing a project and planning their
experiments, and anyone who wants to know what has already been done in synthetic biology
at iGEM. You don't need to know how to program to use it.

## What it does

- **Keyword search** over the summary of every project. Words are combined with AND by
  default, and `OR` makes alternatives: `spider silk`, `casein and milk`,
  `gfp or mcherry`. Plurals, common abbreviations (`E. coli`, `ecoli`) and about 180
  groups of synonyms (`reactive oxygen species` / `ros`) are matched automatically.
- **Wiki matches.** Teams whose summary doesn't mention your words but whose full wiki text
  does are listed after the summary matches, sorted by how often the words appear.
- **Concept + Keyword mode** adds projects about the same topic that never use your exact
  words (an LSA model over the summaries and wikis).
- **Filters**: team section, year, village, chassis organism, target molecule, molecular
  technique, biological part, region and country. Several values can be combined.
- **Project summaries**: problem, approach, summary, target molecules, chassis organisms,
  techniques, biological parts (linked to the iGEM Registry), key results, failure modes,
  novelty claim and key references.
- **Wiki view**: the team's wiki inside the page (2022 and later from igem.wiki, older years
  from the Internet Archive), or the full saved text of the wiki with its own find box.
- **Ask AI**: questions about one project, answered from that project's summary and saved
  wiki text. The visitor uses their own API key (Gemini, Groq, OpenRouter, OpenAI,
  Anthropic or any OpenAI-compatible service). The key stays in their browser and the request
  goes straight from the browser to that service.
- **Database page**: the whole dataset can be downloaded for your own analysis.
- Searches, filters and the open page are kept in the URL, so a search can be shared and the
  back button works.

## Running it

```
git clone https://github.com/Tarmaska11/igem-intelligence-machine.git
cd igem-intelligence-machine
python run.py
```

This serves the folder on http://127.0.0.1:8899/ and opens it in the browser (`run.bat` does
the same on Windows, `python run.py 9000` picks another port). Any static file server works
too, for example `python -m http.server 8899`. Nothing needs to be installed or built.

The repository works on its own: `baseline/` holds the complete 2008-2025 search data, so
search, filters, summaries and Concept mode work with no network. These parts need the
database repository online: matches in the full wiki text, the saved wiki text, the wiki text
given to Ask AI, the blog and the Database page. Ask AI and the wiki view also need internet
access to reach the AI service and the wikis.

## How it works

```
index.html, assets/      the page: app.js (interface), search.worker.js (search), style.css
baseline/                the built-in copy of the search data (gzipped JSON)
pipeline/                Python scripts that build the data
tests/                   data checks, a tokenizer check and a browser test
eval/                    the search evaluation harness
run.py, run.bat          local server
```

1. The page loads `baseline/` and starts the search worker, so the first search is ready
   straight away.
2. It then reads `manifest.json` from the database repository. If the schema matches, it
   downloads only the files whose checksum differs from the built-in copy, and loads the
   blog (`posts.json`), the site texts and settings (`site.json`) and the Database page
   (`pages/custom.html`).
3. If the database repository is unreachable or publishes a schema this site does not know,
   the page keeps using `baseline/`. It never stops working because of the database.

Search is BM25 over one inverted index of the summaries, team names and structured fields,
with field weights (team name > core items > supporting items > text). The full wiki text
has its own index, split into 256 shards that are only downloaded for the words you search.
Concept mode projects the query into a 200-dimension LSA space and adds the closest
projects after the keyword matches, without changing their order.

The database repository address is set once, in `DATA_ORIGINS` at the top of
`assets/app.js`.

## Changing content without changing the code

Texts, numbers, blog posts, the Ask AI services and the data itself all live in the database
repository and can be edited there; the site picks up changes on the next visit. Texts can
use `{{projects}}`, `{{year_range}}`, `{{first_year}}`, `{{last_year}}`, `{{years}}`,
`{{molecules}}`, `{{chassis}}`, `{{techniques}}` and `{{parts}}`, which are filled in from
the current data. See the README of the database repository for every setting.

## Rebuilding the data

Everything in `baseline/` and in the database repository can be rebuilt from the database
repository itself:

```
git clone https://github.com/Tarmaska11/igem-intelligence-machine-db.git ../db
python pipeline/build.py --from-db ../db              # search bundles, about 30 s
python pipeline/build.py --from-db ../db --fulltext   # also the wiki-text index, about 15 min
python pipeline/lsa.py --from-db ../db                # Concept model, needs numpy and scipy
```

The build is deterministic: the same input gives byte-identical files, apart from the build
date in `meta.json.gz`. It also folds duplicate records of the same wiki into one and leaves
out iGEM's template pages. Results go to `baseline/` (shipped with the site) and `dist-data/`
(copied over the database repository). Without `--from-db` the scripts read the original
sources listed in `pipeline/sources.json`: the per-team JSON summaries, the official iGEM team
lists and the scraped wiki texts.

After editing any CSS or JS, run `python pipeline/stamp.py` so browsers load the new files.

The bundles need only the Python standard library (3.9+). `requirements.txt` pins numpy and
scipy for `pipeline/lsa.py` and playwright for the browser test.

## Tests

```
python tests/test_data.py                      # the built data: checksums, counts, filters
python tests/test_parity.py                    # build.py and the worker split text the same way (needs node)
python tests/test_fulltext.py                  # the wiki index points at the right teams (needs dist-data)
python tests/smoke.py http://127.0.0.1:8899/   # every feature in a real browser, desktop and phone
```

`tests/smoke.py` needs playwright (`pip install -r requirements.txt` and
`playwright install chromium`). `.gitlab-ci.yml` runs the data test and the browser test on
every push.

## Search evaluation

`eval/` scores the search worker that ships, run under node, on query sets mined from the
data: known-item and problem-statement queries (regression guards), finding a team's other
years, records sharing a target molecule, singular/plural variants and abbreviations.
`eval/crosscheck.py` runs the same queries in a browser and checks the rankings are identical.
`eval/EVALUATION.md` lists the results.

```
python eval/mine.py                  # builds the query sets into eval/sets/
python eval/harness.py --label run1  # scores the current worker, writes eval/results/runs/
python eval/report.py run1 run2      # compares two runs, query by query
```

## Where the data comes from

1. **Project summaries.** One structured record per team and year, generated by language
   models that read the team's own wiki text: Gemma 3n E4B run locally (4,208 projects),
   Gemini (323), GitHub Copilot (239), Codex (202) and Claude (6). Each record stores the
   model that wrote it in the `ml` field and shows it in the summary as "src".
2. **Official iGEM team lists** (2008-2025): team name, region, country, city, section and
   village. 98.6% of records are matched to an official team.
3. **Wiki texts.** Pre-2022 wikis were collected from igem.org and the Internet Archive,
   2022 and later from the wiki repositories on iGEM's GitLab.

The summaries are not checked sentence by sentence and can contain mistakes. Treat a summary
as a pointer to the wiki, not as a citable statement of what a team did. Every record links
to its wiki. Some pre-2022 wikis were only partly archived, so their saved text can be
incomplete.

## Licence

Code: MIT, see [LICENSE](LICENSE). The wiki content and the project summaries derived from it
belong to the respective iGEM teams; iGEM wikis are published under Creative Commons
Attribution licences, and every record links to the wiki it came from.

This is a project of the iGEM Latvia-Riga team, not an official tool of the iGEM Foundation.
"iGEM" is a trademark of the iGEM Foundation.

| asset | source | licence |
|---|---|---|
| Literata, Nunito Sans (`assets/fonts/`) | Google Fonts | SIL Open Font License 1.1, `assets/fonts/OFL.txt` |
| microbiology mark and favicon | Google Material Symbols | Apache License 2.0, `assets/ICON-LICENSE.txt` |
