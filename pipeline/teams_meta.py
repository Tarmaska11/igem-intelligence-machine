import csv
import difflib
import glob
import os
import re

NOT_TEAMS = {
    "", "acknowledgement", "acknowledgements", "banner", "biosafety", "safety",
    "template", "templates", "main", "home", "index", "test", "sandbox",
    "notebook", "results", "team", "teams", "project", "collaborations",
    "humanpractices", "attributions", "judging", "medals", "sponsors",
    "example", "example2", "example3", "gallery", "teamname", "yourteam",
    "placeholder", "untitled", "demo", "wikitemplate", "xyzlink",
}

JUNK_NAME = re.compile(r"[\[\]{}<>]|^(your|insert|enter)\b|^tbd$", re.I)

_NOISE = re.compile(
    r"(university|universite|universitat|universidad|college|school|institute|"
    r"technology|igem|team|the)"
)


def slug(s):
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def _keys(name, year):
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
        self.rows = {}
        self.by_year = {}
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

        hits = [r for k, r in pool.items() if len(k) >= 5 and (k.startswith(s) or s.startswith(k))]
        uniq = {id(r): r for r in hits}
        if len(uniq) == 1:
            return list(uniq.values())[0], "prefix"

        near = difflib.get_close_matches(s, list(pool), n=2, cutoff=0.88)
        if len(near) == 1 or (len(near) == 2 and pool[near[0]] is pool[near[1]]):
            return pool[near[0]], "fuzzy"
        return None, "unmatched"
