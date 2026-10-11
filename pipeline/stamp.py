import hashlib
import io
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SITE = os.path.dirname(HERE)

ASSETS = ["assets/style.css", "assets/app.js", "assets/search.worker.js", "assets/favicon.svg"]


def digest(rel):
    h = hashlib.sha256()
    with open(os.path.join(SITE, rel), "rb") as fh:
        h.update(fh.read())
    return h.hexdigest()[:8]


def restamp(text, rel, ver):
    esc = re.escape(rel)
    text = re.sub(esc + r"\?v=[0-9a-f]+", rel + "?v=" + ver, text)
    if rel + "?v=" not in text:
        text = text.replace(rel, rel + "?v=" + ver)
    return text


def main():
    vers = {rel: digest(rel) for rel in ASSETS}

    p = os.path.join(SITE, "assets", "app.js")
    js = io.open(p, encoding="utf-8").read()
    new = restamp(js, "assets/search.worker.js", vers["assets/search.worker.js"])
    if new != js:
        io.open(p, "w", encoding="utf-8", newline="\n").write(new)
        vers["assets/app.js"] = digest("assets/app.js")

    p = os.path.join(SITE, "index.html")
    html = io.open(p, encoding="utf-8").read()
    for rel in ("assets/style.css", "assets/app.js", "assets/favicon.svg"):
        html = restamp(html, rel, vers[rel])
    io.open(p, "w", encoding="utf-8", newline="\n").write(html)

    for rel in ASSETS:
        print("  %-28s v=%s" % (rel, vers[rel]))


if __name__ == "__main__":
    main()
