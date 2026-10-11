import json
import re
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
        watching = [True]
        page.on("pageerror", lambda e: errors.append(str(e)) if watching[0] else None)

        print("home page")
        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_selector("#heroStats:not(:empty)", timeout=40000)
        check("stats line rendered", "projects" in page.inner_text("#heroStats"))
        check("hero year range", "-" in page.inner_text("#heroYears"))
        check("no results on the home page", page.locator("#results .card").count() == 0)
        check("search box is in the hero",
              page.locator("#heroSearch .searchwrap").count() == 1)
        mark = page.evaluate("""()=>{const s=document.querySelector('.brand .logo svg');
            if(!s) return null; const r=s.getBoundingClientRect();
            const p=s.querySelector('path');
            return {w:r.width,h:r.height,d:(p&&p.getAttribute('d')||'').length};}""")
        check("brand mark drawn", bool(mark) and mark["h"] > 10 and mark["w"] > 10
              and mark["d"] > 100, mark)
        check("favicon served as svg",
              page.evaluate("""async()=>{const l=document.querySelector('link[rel=icon]');
                  if(!l) return 'no link';
                  const r=await fetch(l.href); return r.status+' '+r.headers.get('content-type');}""")
              .startswith("200 image/svg+xml"))

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

        print("and / or in the search box")

        def total_for(q):
            page.goto(BASE + "?q=" + q.replace(" ", "+"), wait_until="networkidle")
            page.wait_for_function("()=>document.querySelectorAll('.card').length>0",
                                   timeout=40000)
            last = q.split()[-1]
            page.wait_for_function(
                "w=>{const e=document.querySelector('#resultCount');"
                "return e && e.textContent.toLowerCase().includes(w);}",
                arg=last.lower(), timeout=30000)
            seen = None
            for _ in range(20):
                now = page.inner_text("#resultCount").strip()
                if now == seen:
                    break
                seen = now
                page.wait_for_timeout(1000)
            return int(re.sub(r"[^0-9].*$", "", seen))

        spider = total_for("spider")
        coffee = total_for("coffee")
        either = total_for("spider or coffee")
        check("or widens the search", either > max(spider, coffee),
              [spider, coffee, either])
        check("or is not just concatenation", either <= spider + coffee,
              [spider, coffee, either])
        both = total_for("spider and silk")
        check("and narrows the search", both <= spider, [spider, both])

        print("concept mode")
        page.goto(BASE + "?q=heavy+metal+biosensor&mode=hybrid&page=4",
                  wait_until="domcontentloaded")
        page.wait_for_function("()=>document.querySelectorAll('.card').length>0",
                               timeout=40000)
        page.wait_for_timeout(6000)
        rel = page.locator(".card .needs-sum", has_text="related").count()
        check("related projects are added", rel > 0, rel)
        check("and are labelled as such", "related" in page.inner_text("#sortnote")
              or rel > 0)

        print("browse without a query")
        page.goto(BASE + "?year=2024", wait_until="domcontentloaded")
        page.wait_for_function("()=>document.querySelectorAll('.card').length>0", timeout=40000)
        page.wait_for_timeout(1500)
        check("facet alone returns teams", page.locator(".card").count() > 0)
        check("facet alone shows a count", "team" in page.inner_text("#resultCount"))
        years = page.locator(".card .year").all_inner_texts()
        check("newest first", years == sorted(years, reverse=True), years[:5])

        print("filters")
        page.goto(BASE + "?q=biosensor", wait_until="domcontentloaded")
        page.wait_for_function("()=>document.querySelectorAll('.card').length>0", timeout=40000)
        page.wait_for_selector(".facet-item", timeout=30000)
        page.wait_for_timeout(4000)
        groups = [h.inner_text() for h in page.locator("#facetGroups h3").all()]
        check("facet groups present", len(groups) >= 6, groups)
        shown = [h.inner_text() for h in page.locator("#facetGroups h3").all() if h.is_visible()]
        check("main filters first, in order",
              shown == ["Team section", "Year", "Village", "Chassis organism"], shown)
        check("no documented-failures filter", not any("failure" in g.lower() for g in groups), groups)
        page.locator(".facet-toggle").click()
        page.wait_for_timeout(300)
        check("More filters shows the rest",
              sum(1 for h in page.locator("#facetGroups h3").all() if h.is_visible()) > 4)
        page.locator(".facet-toggle").click()
        yr = page.locator(".facet-group", has=page.locator("h3", has_text="Year"))
        yr.locator(".facet-item").nth(0).click()
        page.wait_for_timeout(1500)
        yr.locator(".facet-item:not(.on)").nth(0).click()
        page.wait_for_timeout(1500)
        check("two options in one section", yr.locator(".facet-item.on").count() == 2)
        page.locator("#facetsToggle").click()
        page.wait_for_timeout(300)
        check("menu button folds the filters", not page.is_visible("#facetGroups") and page.is_visible("#facetsToggle"))
        page.locator("#facetsToggle").click()
        page.wait_for_timeout(300)
        check("menu button brings them back", page.is_visible("#facetGroups"))
        page.locator("#clearFilters").click()
        page.wait_for_timeout(900)
        before = page.inner_text("#resultCount")
        page.locator(".facet-item").first.click()
        page.wait_for_timeout(1200)
        check("clicking a filter narrows the results", page.inner_text("#resultCount") != before)
        check("active chip shown", page.locator("#activeChips .chip").count() > 0)
        page.locator("#clearFilters").click()
        page.wait_for_timeout(900)
        check("clear all removes the chips", page.locator("#activeChips .chip").count() == 0)

        print("concept mode")
        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_selector("#heroStats:not(:empty)", timeout=40000)
        page.fill("#q", "spider silk")
        page.keyboard.press("Enter")
        page.wait_for_selector("#modeToggle:not([hidden]) button >> nth=1", timeout=60000)
        page.wait_for_selector("#resultCount:not(:empty)", timeout=40000)
        kw = int(page.inner_text("#resultCount").split()[0])
        page.locator("#modeToggle button").nth(1).click()
        page.wait_for_timeout(8000)
        check("Concept stays picked", "Concept" in page.locator("#modeToggle button.on").inner_text())
        check("Concept adds related projects", int(page.inner_text("#resultCount").split()[0]) > kw)
        page.locator("#modeToggle button").nth(0).click()
        page.wait_for_timeout(1500)
        box = page.locator("#modeToggle button").nth(1).bounding_box()
        page.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
        page.mouse.down()
        page.evaluate("()=>run(false)")
        page.wait_for_timeout(150)
        page.mouse.up()
        page.wait_for_timeout(3000)
        check("Concept click survives a background search",
              "Concept" in page.locator("#modeToggle button.on").inner_text()
              and "mode=hybrid" in page.url, page.url)

        print("team drawer")
        page.goto(BASE + "?q=biosensor", wait_until="domcontentloaded")
        page.wait_for_function("()=>document.querySelectorAll('.card').length>0", timeout=40000)
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

        watching[0] = False
        page.locator(".dtab").nth(1).click()
        page.wait_for_timeout(2500)
        check("wiki column", page.locator(".wiki-col").count() == 1)
        check("ai column", page.locator(".ai-col").count() == 1)
        modes = [x.inner_text() for x in page.locator(".wiki-mode").all()]
        check("wiki / saved toggle",
              len(modes) == 2 and modes[0] in ("Live wiki", "Archived wiki")
              and modes[1] == "Saved text", modes)
        check("ask-ai controls",
              page.locator(".ai-key").count() == 1 and page.locator(".ai-send").count() == 1)
        page.locator(".ai-q").fill("test")
        page.locator(".ai-send").click()
        page.wait_for_timeout(1200)
        check("chat answers without a key instead of failing",
              page.locator(".ai-msg").count() >= 2)
        wiki_w = page.evaluate("()=>document.querySelector('.wiki-col').getBoundingClientRect().width")
        page.locator(".ai-toggle").click()
        page.wait_for_timeout(300)
        check("menu button folds the AI chat", not page.is_visible(".ai-body"))
        check("the wiki takes the room",
              page.evaluate("()=>document.querySelector('.wiki-col').getBoundingClientRect().width") > wiki_w + 150)
        page.locator(".ai-toggle").click()
        page.wait_for_timeout(300)
        check("and brings it back", page.is_visible(".ai-body"))
        check("wiki address is a link",
              page.evaluate("()=>document.querySelector('.wiki-url').tagName") == "A")
        page.locator(".wiki-mode").nth(1).click()
        page.wait_for_selector(".find-q", timeout=20000)
        page.locator(".find-q").fill("the")
        page.locator(".find-q").press("Enter")
        page.locator(".find-q").press("Enter")
        page.wait_for_timeout(300)
        check("find in saved text highlights matches",
              page.locator("mark.find-hit").count() > 1 and page.locator("mark.cur").count() >= 1)
        check("find steps to the next match",
              page.inner_text(".find-count").startswith("2 / "), page.inner_text(".find-count"))
        page.locator(".find-q").press("Escape")
        check("Esc clears the search before closing anything",
              page.locator("mark.find-hit").count() == 0 and not page.locator("#drawer").is_hidden())

        print("blog")
        page.keyboard.press("Escape")
        page.wait_for_timeout(600)
        watching[0] = True
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

        print("navigation")
        page.keyboard.press("Escape")
        page.wait_for_timeout(400)
        page.click("#brandHome")
        page.wait_for_timeout(1200)
        check("home clears the results", page.locator("#results .card").count() == 0)
        page.fill("#q", "biosensor")
        page.keyboard.press("Enter")
        page.wait_for_selector("#customBtn:not([hidden])", timeout=20000)
        page.click("#customBtn")
        page.wait_for_timeout(1200)
        page.fill("#q", "spider silk")
        page.click("#searchBtn")
        page.wait_for_timeout(2000)
        check("a search leaves the Database page",
              page.is_hidden("#customView") and page.is_visible("#results"))

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
        page.locator(".facet-item").first.click()
        page.wait_for_timeout(1800)
        page.locator(".facets-close").click()
        page.wait_for_timeout(500)
        check("active filters shown above the results",
              page.locator("#activeChipsTop .chip").count() > 0)
        page.locator("#activeChipsTop .chip").first.click()
        page.wait_for_timeout(1500)
        check("tapping one clears it", page.locator("#activeChipsTop .chip").count() == 0)
        check("nav button offered on a phone", page.locator("#customBtn").is_visible())
        page.locator("#customBtn").click()
        page.wait_for_timeout(2500)
        check("nav page opens on a phone", page.locator("#customView").is_visible())
        body = page.frame_locator("#customFrame").locator("body")
        try:
            page.wait_for_function(
                "()=>!document.querySelector('#customFrame').srcdoc.includes('Loading…</p>')",
                timeout=20000)
            text = body.inner_text(timeout=5000).strip()
        except Exception as e:
            text = "error: " + str(e)[:80]
        check("nav page is not empty", len(text) > 100 and "not available" not in text,
              text[:60])

        page.goto(BASE, wait_until="domcontentloaded")
        page.wait_for_selector("#heroStats:not(:empty)", timeout=40000)
        page.wait_for_selector(".post-title", timeout=20000)
        page.wait_for_timeout(1200)
        sizes = page.evaluate(
            "()=>[...document.querySelectorAll('.post-title')].map(t=>getComputedStyle(t).fontSize)")
        check("every article title the same size", len(set(sizes)) == 1, sizes)
        rows = page.evaluate("()=>{const ys=[...document.querySelectorAll('.hero-stats .seg')]"
                             ".map(s=>Math.round(s.getBoundingClientRect().top));"
                             "return [...new Set(ys)].length;}")
        check("figures fit on two lines", rows <= 2, rows)
        lefts = page.evaluate("()=>[...document.querySelectorAll('.hero-stats .seg')]"
                              ".map(s=>Math.round(s.getBoundingClientRect().left))")
        check("figures start at the left margin", len(lefts) > 1 and lefts[0] == min(lefts), lefts)
        box = page.evaluate("()=>{const b=document.querySelector('.brand').getBoundingClientRect(),"
                            "t=document.querySelector('#topbar').getBoundingClientRect();"
                            "return [Math.round(b.top-t.top),Math.round(t.bottom-b.bottom)];}")
        check("the name sits in the middle of the bar", abs(box[0] - box[1]) <= 2, box)
        note = page.evaluate("()=>[...document.querySelectorAll('#footerNote .fsent')]"
                             ".map(s=>Math.round(s.getBoundingClientRect().top))")
        check("footer note on its own lines", len(note) == 2 and note[0] != note[1], note)
        pairs = page.evaluate("()=>[...document.querySelectorAll('#footerLinks .footer-pair')]"
                              ".map(s=>Math.round(s.getBoundingClientRect().top))")
        check("each credit on its own line", len(pairs) == 2 and pairs[0] != pairs[1], pairs)

        print("settings from the database repo")
        ctx = browser.new_context(viewport={"width": 1400, "height": 900})
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        asked = []

        def site_json(route):
            d = route.fetch().json()
            d["hero"] = {"title": "Test title {{projects}}",
                         "text": "Across <b>{{year_range}}</b><img src=x onerror=\"window.__x=1\">",
                         "placeholder": "Search {{projects}} projects"}
            d["footer"] = dict(d.get("footer") or {}, note="From {{first_year}} to {{last_year}}. Second line.")
            d["ai"] = {"default": "t", "instructions": "Test instructions for {{projects}}.",
                       "providers": [{"id": "t", "label": "Test", "format": "openai",
                                      "base": "https://ai.example.test/v1", "models": ["m1"]}]}
            route.fulfill(status=200, content_type="application/json", body=json.dumps(d))

        def posts_json(route):
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"posts": [
                {"title": "Post about {{projects}} projects", "author": "t", "date": "2026-01-01",
                 "abstract": "{{years}} years", "body": "<p>{{projects}} in total</p>"}]}))

        def custom_page(route):
            route.fulfill(status=200, content_type="text/html",
                          body="<p>Page with {{projects}} projects from {{year_range}}, plus {{unknown}}.</p>")

        def ai_api(route):
            cors = {"Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*",
                    "Access-Control-Allow-Methods": "POST, OPTIONS"}
            if route.request.method == "OPTIONS":
                route.fulfill(status=204, headers=cors)
                return
            asked.append((route.request.post_data or "", route.request.headers.get("authorization", "")))
            route.fulfill(status=200, headers=dict(cors, **{"Content-Type": "text/event-stream"}),
                          body='data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n'
                               'data: {"choices":[{"delta":{"content":"there"}}]}\n\ndata: [DONE]\n\n')

        pg.route("**/site.json", site_json)
        pg.route("**/posts.json", posts_json)
        pg.route("**/pages/custom.html", custom_page)
        pg.route("https://ai.example.test/**", ai_api)
        pg.route(re.compile(r"https://(web\.archive\.org|[0-9]{4}\.igem\.wiki)/.*"),
                 lambda r: r.fulfill(status=200, content_type="text/html", body="<p>wiki</p>"))
        pg.goto(BASE, wait_until="domcontentloaded")
        pg.wait_for_function("()=>document.querySelector('#hero h1').textContent.startsWith('Test title')",
                             timeout=40000)
        count = pg.evaluate("()=>state.meta.record_count.toLocaleString('en-US')")
        check("hero title from site.json", pg.inner_text("#hero h1") == "Test title " + count,
              pg.inner_text("#hero h1"))
        check("hero text from site.json", "Across" in pg.inner_text("#hero > p")
              and "{{" not in pg.inner_text("#hero > p"), pg.inner_text("#hero > p"))
        check("hero text is sanitized",
              pg.evaluate("()=>!window.__x && !document.querySelector('#hero > p img[onerror]')"))
        check("search placeholder from site.json",
              pg.get_attribute("#q", "placeholder") == "Search %s projects" % count)
        check("footer note fills in the years", "{{" not in pg.inner_text("#footerNote")
              and pg.locator("#footerNote .fsent").count() == 2, pg.inner_text("#footerNote"))
        pg.wait_for_selector(".post-title", timeout=20000)
        check("post title fills in the count", pg.inner_text(".post-title") == "Post about %s projects" % count,
              pg.inner_text(".post-title"))
        pg.locator(".post-card").first.click()
        pg.wait_for_selector("#blogReader:not([hidden])", timeout=5000)
        check("post body fills in the count", pg.inner_text(".reader-content").strip() == count + " in total",
              pg.inner_text(".reader-content"))
        pg.keyboard.press("Escape")
        pg.wait_for_selector("#customBtn:not([hidden])", timeout=20000)
        pg.click("#customBtn")
        pg.wait_for_function("()=>document.querySelector('#customFrame').srcdoc.includes('Page with')",
                             timeout=20000)
        text = pg.frame_locator("#customFrame").locator("body").inner_text(timeout=5000)
        check("database page fills in the count, keeps unknown names",
              ("%s projects" % count) in text and "{{unknown}}" in text, text)
        pg.goto(BASE + "?q=biosensor", wait_until="domcontentloaded")
        pg.wait_for_function("()=>document.querySelectorAll('.card').length>0", timeout=40000)
        pg.wait_for_function("()=>state.site && state.site.ai && state.site.ai.default==='t'", timeout=30000)
        pg.locator(".card").first.click()
        pg.wait_for_selector(".dh h2", timeout=30000)
        pg.locator(".dtab").nth(1).click()
        pg.wait_for_selector(".ai-key", timeout=10000)
        check("provider list from site.json",
              pg.evaluate("()=>[...document.querySelectorAll('.ai-prov option')].map(o=>o.value).join(',')")
              == "t,custom")
        pg.fill(".ai-key", "test-key")
        pg.fill(".ai-q", "What chassis?")
        pg.click(".ai-send")
        pg.wait_for_function("()=>[...document.querySelectorAll('.ai-msg.ai')].some(m=>m.textContent==='Hello there')",
                             timeout=30000)
        check("chat streams an answer", True)
        body = json.loads(asked[-1][0]) if asked else {}
        sys_msg = ((body.get("messages") or [{}])[0]).get("content", "")
        check("chat uses the instructions from site.json",
              sys_msg.startswith("Test instructions for %s." % count), sys_msg[:80])
        check("chat sends the question, the model and the key",
              (body.get("messages") or [{}])[-1].get("content") == "What chassis?" and body.get("model") == "m1"
              and bool(asked) and asked[-1][1] == "Bearer test-key")
        ctx.close()

        check("no javascript errors in our own code", not errors, errors[:3])
        browser.close()

    print("\n%d checks, %d failed" % (checks, len(failures)))
    if failures:
        for f in failures:
            print("  - " + f)
        sys.exit(1)
    print("all good")


if __name__ == "__main__":
    main()
