# -*- coding: utf-8 -*-
"""Serve the site locally and open it in a browser.

    python run.py            # http://127.0.0.1:8899/
    python run.py 9000       # pick another port

Nothing is built or downloaded: the whole 2008-2025 archive is already in
baseline/, so this works with no network at all. Standard library only.
"""
import http.server
import os
import socketserver
import sys
import threading
import webbrowser

HERE = os.path.dirname(os.path.abspath(__file__))
PORT = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("IGEM_PORT", 8899))


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=HERE, **kw)

    def end_headers(self):
        # the bundles are content-hashed in the manifest, so never cache them here
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass   # a quiet console is nicer than a wall of GETs


def main():
    if not os.path.exists(os.path.join(HERE, "baseline", "cards.json.gz")):
        print("baseline/ is missing - run: python pipeline/build.py")
        return 1
    url = "http://127.0.0.1:%d/" % PORT
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("127.0.0.1", PORT), Handler) as httpd:
        print("iGEM Intelligence Machine -> %s   (ctrl-c to stop)" % url)
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
