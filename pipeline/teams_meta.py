# -*- coding: utf-8 -*-
"""Official iGEM team metadata (csv/teams-*.csv) and how we match it to a summary.

The CSVs give us region, country, section and village (= the real competition track).
Team names in the summaries came from wiki folder names, so they drift from the official
spelling and we need a few fallbacks to match them.
"""
import csv
import difflib
import glob
import os
import re

# Wiki pages that got scraped as if they were teams. They are not.
NOT_TEAMS = {
    "", "acknowledgement", "acknowledgements", "banner", "biosafety", "safety",
    "template", "templates", "main", "home", "index", "test", "sandbox",
    "notebook", "results", "team", "teams", "project", "collaborations",
    "humanpractices", "attributions", "judging", "medals", "sponsors",
    "example", "example2", "example3", "gallery", "teamname", "yourteam",
    "placeholder", "untitled", "demo", "wikitemplate", "xyzlink",
}

# Names that are obviously a template placeholder rather than a real team.
JUNK_NAME = re.compile(r"[\[\]{}<>]|^(your|insert|enter)|^tbd$", re.I)

# Words that appear in one spelling of a name but not the other.
_NOISE = re.compile(
    r"(university|universite|universitat|universidad|college|school|institute|"
    r"technology|igem|team|the)"
)


def slug(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _keys(name, year):
    """Progressively looser spellings of one team name."""
    s = slug(name)
    out = [s]
    no_year = re.sub(r"(19|20)\d{2}$", "", s)
    if no_year != s and no_year:
        out.append(no_year)
    stripped = _NOISE.sub("", no_year)
    if stripped and stripped not in out:
        out.append(stripped)
    return out


class TeamDirectory(object):
    def __init__(self, csv_dir):
        self.rows = {}          # (slug, year) -> row
        self.by_year = {}       # year -> {slug: row}
        for path in sorted(glob.glob(os.path.join(csv_dir, "teams-*.csv"))):
            with open(path, encoding="utf-8-sig", newline="") as fh:
                for row in csv.DictReader(fh):
                    try:
                        year = int(row["year"])
                    except (TypeError, ValueError):
                        continue
                    row = {k: (v or "").strip() for k, v in row.items()}
                    row["year"] = year
                    for k in _keys(row["name"], year):
                        self.rows.setdefault((k, year), row)
                        self.by_year.setdefault(year, {}).setdefault(k, row)

    def lookup(self, team_name, year):
        """Return (row, how) or (None, reason)."""
        s = slug(team_name)
        if s in NOT_TEAMS or JUNK_NAME.search(team_name or ""):
            return None, "not-a-team"
        try:
            year = int(year)
        except (TypeError, ValueError):
            return None, "no-year"

        pool = self.by_year.get(year)
        if not pool:
            return None, "no-such-year"

        for i, k in enumerate(_keys(team_name, year)):
            row = pool.get(k)
            if row:
                return row, ("exact" if i == 0 else "relaxed")

        # One official name contains ours (or the other way round) and only one does.
        hits = [r for k, r in pool.items() if len(k) >= 5 and (k.startswith(s) or s.startswith(k))]
        uniq = {id(r): r for r in hits}
        if len(uniq) == 1:
            return list(uniq.values())[0], "prefix"

        near = difflib.get_close_matches(s, list(pool), n=2, cutoff=0.88)
        if len(near) == 1 or (len(near) == 2 and pool[near[0]] is pool[near[1]]):
            return pool[near[0]], "fuzzy"
        return None, "unmatched"
