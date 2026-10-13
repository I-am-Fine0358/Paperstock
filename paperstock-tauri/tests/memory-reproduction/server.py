#!/usr/bin/env python3
"""Serve actual UI/PDF.js with isolated IPC, plus HTTP Range fixture access."""
import argparse
import http.server
import pathlib
import json
import threading
import urllib.parse

parser = argparse.ArgumentParser()
parser.add_argument("--source", type=pathlib.Path, required=True)
parser.add_argument("--script", type=pathlib.Path, required=True)
parser.add_argument("--fixture", type=pathlib.Path, required=True)
parser.add_argument("--port", type=int, default=18763)
parser.add_argument("--scenario", choices=("memory", "loading"), default="memory")
parser.add_argument("--pdf-module", type=pathlib.Path)
args = parser.parse_args()
here = pathlib.Path(__file__).resolve().parent
gates = {}
gates_lock = threading.Lock()


def get_gate(token):
    if not token or not token.replace("-", "").isalnum() or len(token) > 64:
        raise ValueError("Invalid test gate")
    with gates_lock:
        return gates.setdefault(token, {"event": threading.Event(), "requests": 0, "timedOut": False})


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        path = urllib.parse.urlsplit(self.path).path
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(self.path).query)
        if path in ("/", "/index.html"):
            body = (args.source / "index.html").read_bytes().replace(
                b'<script src="js/bookshelf.js"></script>',
                b'<script src="/bridge.js"></script><script src="js/bookshelf.js"></script><script src="/scenario.js"></script>')
            self.send_blob(body, "text/html; charset=utf-8")
        elif path == "/js/bookshelf.js":
            self.send_blob(args.script.read_bytes(), "application/javascript")
        elif path == "/libs/pdf.mjs" and args.pdf_module:
            self.send_blob(args.pdf_module.read_bytes(), "application/javascript")
        elif path in ("/bridge.js", "/scenario.js"):
            filename = "loading-scenario.js" if path == "/scenario.js" and args.scenario == "loading" else path[1:]
            self.send_blob((here / filename).read_bytes(), "application/javascript")
        elif path == "/test-gate" and args.scenario == "loading":
            gate = get_gate(query.get("token", [""])[0])
            self.send_blob(json.dumps({"requests": gate["requests"], "released": gate["event"].is_set(),
                                       "timedOut": gate["timedOut"]}).encode(), "application/json")
        elif path == "/fixture.pdf":
            token = query.get("testGate", [None])[0]
            if token and args.scenario == "loading":
                gate = get_gate(token)
                with gates_lock:
                    gate["requests"] += 1
                # A bounded gate lets the scenario switch/hide after a real PDF.js
                # worker has requested data, without depending on machine speed.
                if not gate["event"].wait(timeout=70):
                    gate["timedOut"] = True
            length = args.fixture.stat().st_size
            start, end = 0, length - 1
            range_header = self.headers.get("Range")
            if range_header:
                pieces = range_header.removeprefix("bytes=").split("-")
                start = int(pieces[0])
                end = min(int(pieces[1]) if pieces[1] else end, end)
            self.send_response(206 if range_header else 200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", str(end - start + 1))
            if range_header:
                self.send_header("Content-Range", f"bytes {start}-{end}/{length}")
            self.end_headers()
            with args.fixture.open("rb") as file:
                file.seek(start)
                while start <= end:
                    data = file.read(min(65536, end + 1 - start))
                    if not data:
                        break
                    try:
                        self.wfile.write(data)
                    except (BrokenPipeError, ConnectionResetError):
                        break
                    start += len(data)
        else:
            target = (args.source / path[1:]).resolve()
            if not target.is_relative_to(args.source.resolve()) or not target.is_file():
                self.send_error(404)
                return
            mime = "application/javascript" if target.suffix in (".js", ".mjs") else "text/css" if target.suffix == ".css" else "application/octet-stream"
            self.send_blob(target.read_bytes(), mime)

    def do_POST(self):
        request = urllib.parse.urlsplit(self.path)
        if request.path != "/test-gate" or args.scenario != "loading":
            self.send_error(404)
            return
        token = urllib.parse.parse_qs(request.query).get("token", [""])[0]
        get_gate(token)["event"].set()
        self.send_blob(b'{"released":true}', "application/json")

    def send_blob(self, body, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *_args):
        pass


print(f"http://127.0.0.1:{args.port}", flush=True)
http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
