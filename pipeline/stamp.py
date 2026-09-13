# -*- coding: utf-8 -*-
"""Stamp a content hash onto the CSS and JS links so browsers cannot serve a stale copy.

GitHub Pages sends `cache-control: max-age=600`, so after a change a browser will
happily keep showing the old stylesheet. Adding ?v=<hash of the file> changes the
URL whenever the file changes, which makes the cache miss and fetch the new one.

    python pipeline/stamp.py
"""
import hashlib
import io
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)

ASSETS = ["assets/style.css", "assets/app.js", "assets/search.worker.js"]


def digest(rel):
    h = hashlib.sha256()
    with open(os.path.join(SITE, rel), "rb") as fh:
        h.update(fh.read())
    return h.hexdigest()[:8]


def restamp(text, rel, ver):
    """Replace any existing ?v=… on this asset, or add one."""
    esc = re.escape(rel)
    text = re.sub(esc + r"\?v=[0-9a-f]+", rel + "?v=" + ver, text)
    if rel + "?v=" not in text:
        text = text.replace(rel, rel + "?v=" + ver)
    return text


def main():
    vers = {rel: digest(rel) for rel in ASSETS}

    # the worker is loaded from app.js, so stamp that reference first - it changes
    # app.js, which is why app.js is hashed afterwards
    p = os.path.join(SITE, "assets", "app.js")
    js = io.open(p, encoding="utf-8").read()
    new = restamp(js, "assets/search.worker.js", vers["assets/search.worker.js"])
    if new != js:
        io.open(p, "w", encoding="utf-8", newline="\n").write(new)
        vers["assets/app.js"] = digest("assets/app.js")

    p = os.path.join(SITE, "index.html")
    html = io.open(p, encoding="utf-8").read()
    for rel in ("assets/style.css", "assets/app.js"):
        html = restamp(html, rel, vers[rel])
    io.open(p, "w", encoding="utf-8", newline="\n").write(html)

    for rel in ASSETS:
        print("  %-28s v=%s" % (rel, vers[rel]))


if __name__ == "__main__":
    main()
