# -*- coding: utf-8 -*-
"""Smoke test: load the site and check every feature is still there.

    python -m http.server 8899 &
    python tests/smoke.py http://127.0.0.1:8899/

Needs playwright (pip install playwright && playwright install chromium).
Exits non-zero on the first failure, so CI can run it on every push.
"""
import sys

from playwright.sync_api import sync_playwright

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8899/").rstrip("/") + "/"

failures = []
checks = 0


def check(label, ok, detail=""):
    global checks
    checks += 1
    print(("  ok   " if ok else "  FAIL ") + label + (("  -> " + str(detail)) if detail else ""))
    if not ok:
        failures.append(label)


def main():
    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True)
        errors = []
        page = browser.new_page(viewport={"width": 1400, "height": 900})
        page.on("pageerror", lambda e: errors.append(str(e)))

        print("home page")
        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_selector("#heroStats:not(:empty)", timeout=40000)
        check("stats line rendered", "projects" in page.inner_text("#heroStats"))
        check("hero year range", "-" in page.inner_text("#heroYears"))
        check("no results on the home page", page.locator("#results .card").count() == 0)
        check("search box is in the hero",
              page.locator("#heroSearch .searchwrap").count() == 1)

        print("search")
        page.goto(BASE + "?q=biosensor", wait_until="domcontentloaded")
        page.wait_for_function("()=>document.querySelectorAll('.card').length>0", timeout=40000)
        page.wait_for_timeout(4000)
        check("results returned", page.locator(".card").count() > 0)
        check("card has a name", page.locator(".card .name").first.inner_text() != "")
        check("card has a snippet", page.locator(".card .snip").count() > 0)
        check("card has tags", page.locator(".card .tagrow .tag").count() > 0)
        check("importance icons", page.locator(".card .tag .ic").count() > 0)
        check("result count shown", "team" in page.inner_text("#resultCount"))
        check("search box moved to the header",
              page.locator("#headerSearch .searchwrap").count() == 1)

        print("filters")
        groups = [h.inner_text() for h in page.locator("#facetGroups h3").all()]
        check("facet groups present", len(groups) >= 6, groups)
        before = page.inner_text("#resultCount")
        page.locator(".facet-item").first.click()
        page.wait_for_timeout(1200)
        check("clicking a filter narrows the results", page.inner_text("#resultCount") != before)
        check("active chip shown", page.locator("#activeChips .chip").count() > 0)
        page.locator("#clearFilters").click()
        page.wait_for_timeout(900)
        check("clear all removes the chips", page.locator("#activeChips .chip").count() == 0)

        print("team drawer")
        page.locator(".card").first.click()
        page.wait_for_selector(".dh h2", timeout=30000)
        page.wait_for_timeout(1200)
        check("drawer title", page.inner_text(".dh h2") != "")
        tabs = [t.inner_text() for t in page.locator(".dtab").all()]
        check("both tabs", tabs == ["Details", "Wiki + Ask AI"], tabs)
        check("detail sections", len(page.locator(".sect h4").all()) >= 3)

        w0 = page.evaluate("()=>document.querySelector('#drawerPanel').getBoundingClientRect().width")
        box = page.locator("#drawerResizer").bounding_box()
        page.mouse.move(box["x"] + 6, 400)
        page.mouse.down()
        page.mouse.move(box["x"] + 420, 400, steps=12)
        page.mouse.up()
        page.wait_for_timeout(600)
        w1 = page.evaluate("()=>document.querySelector('#drawerPanel').getBoundingClientRect().width")
        check("drawer is resizable", w1 < w0 - 150, "%d -> %d" % (w0, w1))
        check("width is remembered",
              page.evaluate("()=>localStorage.getItem('igem_drawer_width')") is not None)

        page.locator(".dtab").nth(1).click()
        page.wait_for_timeout(2500)
        check("wiki column", page.locator(".wiki-col").count() == 1)
        check("ai column", page.locator(".ai-col").count() == 1)
        check("live / saved toggle",
              [x.inner_text() for x in page.locator(".wiki-mode").all()] == ["Live wiki", "Saved text"])
        check("ask-ai controls",
              page.locator(".ai-key").count() == 1 and page.locator(".ai-send").count() == 1)
        page.locator(".ai-q").fill("test")
        page.locator(".ai-send").click()
        page.wait_for_timeout(1200)
        check("chat answers without a key instead of failing",
              page.locator(".ai-msg").count() >= 2)

        print("blog")
        page.keyboard.press("Escape")
        page.wait_for_timeout(300)
        page.click("#brandHome")
        page.wait_for_timeout(1500)
        if page.locator(".post-card").count():
            page.locator(".post-card").first.click()
            page.wait_for_timeout(900)
            check("post reader opens", page.locator("#blogReader").is_visible())
            check("reader has a title", page.inner_text(".reader-title") != "")
            page.keyboard.press("Escape")
            page.wait_for_timeout(500)
            check("post reader closes", page.locator("#blogReader").is_hidden())
        else:
            print("  skip  no posts published")

        print("parts registry")
        # the button is off by default; site.json can turn it on
        page.evaluate("()=>{document.querySelector('#partsBtn').hidden=false;}")
        page.locator("#partsBtn").click()
        page.wait_for_selector(".part-row", timeout=30000)
        check("parts list renders", page.locator(".part-row").count() > 100)
        check("parts summary", "unique parts" in page.inner_text("#partsSummary"))
        page.fill("#partsFilter", "BBa_K")
        page.wait_for_timeout(900)
        check("parts filter works", "match" in page.inner_text("#partsSummary"))
        check("registry links present", page.locator("a.part-name.coded").count() > 0)

        print("navigation")
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        page.click("#brandHome")
        page.wait_for_timeout(1200)
        check("home clears the results", page.locator("#results .card").count() == 0)

        print("mobile")
        page.set_viewport_size({"width": 390, "height": 844})
        page.goto(BASE + "?q=biosensor", wait_until="domcontentloaded")
        page.wait_for_function("()=>document.querySelectorAll('.card').length>0", timeout=40000)
        page.wait_for_timeout(1500)
        check("no sideways scrolling",
              not page.evaluate("()=>document.documentElement.scrollWidth>window.innerWidth+1"))
        check("filters button is offered", page.locator("#filterBtn").is_visible())
        page.locator("#filterBtn").click()
        page.wait_for_timeout(700)
        check("filter panel opens", page.locator("#facets").is_visible())

        check("no javascript errors", not errors, errors[:3])
        browser.close()

    print("\n%d checks, %d failed" % (checks, len(failures)))
    if failures:
        for f in failures:
            print("  - " + f)
        sys.exit(1)
    print("all good")


if __name__ == "__main__":
    main()
