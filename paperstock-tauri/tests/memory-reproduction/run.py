#!/usr/bin/env python3
"""Bounded real WKWebView + real production JS/PDF.js integration test (macOS)."""
import argparse
import hashlib
import json
import pathlib
import socket
import subprocess
import sys
import time
import urllib.request

here = pathlib.Path(__file__).resolve().parent
repo = here.parents[2]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--script", type=pathlib.Path, default=repo / "paperstock-tauri/src/js/bookshelf.js")
parser.add_argument("--output", type=pathlib.Path, required=True)
parser.add_argument("--fixture", type=pathlib.Path)
parser.add_argument("--image-size", type=int, default=384)
parser.add_argument("--pages", type=int, default=6)
parser.add_argument("--assert-bounds", action="store_true", help="Require current memory limits and reading-position/text restoration")
args = parser.parse_args()
output = args.output.resolve()
output.mkdir(parents=True, exist_ok=True)
script_snapshot = output / "bookshelf-under-test.js"
script_snapshot.write_bytes(args.script.read_bytes())
fixture = args.fixture.resolve() if args.fixture else output / "fixture.pdf"
if not fixture.exists():
    subprocess.run([sys.executable, str(here / "fixture.py"), str(fixture), str(args.image_size)], check=True)
binary = output / "WebKitHarness"
subprocess.run([
    "xcrun", "swiftc", "-module-cache-path", str(output / "swift-module-cache"),
    "-import-objc-header", str(here / "memory.h"), str(here / "WebKitHarness.swift"), "-o", str(binary),
], check=True)
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
url = f"http://127.0.0.1:{port}/?pages={args.pages}"
with (output / "server.log").open("w") as server_log, (output / "events.jsonl").open("w") as events, (output / "native.log").open("w") as native_log:
    server = subprocess.Popen([
        sys.executable, str(here / "server.py"), "--source", str(repo / "paperstock-tauri/src"),
        "--script", str(script_snapshot), "--fixture", str(fixture), "--port", str(port),
    ], stdout=server_log, stderr=server_log)
    try:
        for attempt in range(100):
            try:
                urllib.request.urlopen(url, timeout=1).close()
                break
            except OSError:
                if server.poll() is not None:
                    raise RuntimeError("Test HTTP server did not start")
                time.sleep(0.05)
        host = subprocess.Popen([str(binary), url, str(output)], stdout=events, stderr=native_log)
        try:
            host.wait(timeout=490)
        finally:
            if host.poll() is None:
                host.terminate()
                host.wait(timeout=5)
    finally:
        server.terminate()
        server.wait(timeout=5)

records = [json.loads(line) for line in (output / "events.jsonl").read_text().splitlines()]
summary = {
    "script": str(args.script.resolve()), "fixtureBytes": fixture.stat().st_size,
    "scriptSHA256": hashlib.sha256(script_snapshot.read_bytes()).hexdigest(),
    "fixtureSHA256": hashlib.sha256(fixture.read_bytes()).hexdigest(),
    "pagesPerDocument": args.pages,
    "maxPhysicalFootprintBytes": max((record.get("physicalFootprintBytes", 0) for record in records), default=0),
    "maxResidentBytes": max((record.get("residentBytes", 0) for record in records), default=0),
    "checkpoints": [record for record in records if record["kind"] in ("checkpoint", "resume-render-count", "text-selection")],
    "failures": [record for record in records if record["kind"] in ("scenario-failed", "safety-stop", "timeout", "error")],
    "hostSurvivedRendererKill": any(record["kind"] == "host-survived-renderer-kill" for record in records),
}
if args.assert_bounds:
    points = {record["label"]: record for record in records if record["kind"] == "checkpoint"}
    checks = {
        "at most two loaded PDF documents": all(point["loadedDocuments"] <= 2 for point in points.values()),
        "at most one simultaneous render": all(point["renderPeak"] <= 1 for point in points.values()),
        "single canvas within 8 Mi pixels": all(point["maxSingleCanvasPixels"] <= 8 * 1024 * 1024 for point in points.values()),
        "latest page wins after render burst": points.get("burst-complete", {}).get("displayedPages") == [15],
        "each document displays its requested page": all(points.get(f"book-{book}-done", {}).get("displayedPages") == [min(24, args.pages)] for book in range(1, 4)),
        "all fixture thumbnails rendered": points.get("thumbnails", {}).get("renderedThumbnails") == 24,
        "hidden documents released": points.get("hidden-before-return", {}).get("loadedDocuments") == 0,
        "hidden canvases released": points.get("hidden-before-return", {}).get("canvasPixels") == 0,
        "reading position restored": points.get("after-hidden-20-seconds", {}).get("displayedPages") == [min(24, args.pages)],
        "text selection restored": any(record["kind"] == "text-selection" and "Paperstock memory fixture" in record.get("text", "") for record in records),
        "renderer termination delivered": summary["hostSurvivedRendererKill"],
    }
    summary["assertions"] = checks
    summary["failures"].extend({"kind": "assertion-failed", "message": key} for key, passed in checks.items() if not passed)
(output / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
print(json.dumps({key: value for key, value in summary.items() if key != "checkpoints"}, ensure_ascii=False, indent=2))
sys.exit(bool(summary["failures"]))
