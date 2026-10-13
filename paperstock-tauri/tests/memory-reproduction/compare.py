#!/usr/bin/env python3
"""Compare completed runs with the same fixture and page workload."""
import json
import pathlib
import sys

before_path, after_path, output = map(pathlib.Path, sys.argv[1:4])
before = json.loads(before_path.read_text())
after = json.loads(after_path.read_text())
for key in ("fixtureSHA256", "fixtureBytes", "pagesPerDocument"):
    if before[key] != after[key]:
        raise ValueError(f"Cannot compare different workloads: {key}")
if before["failures"] or after["failures"]:
    raise ValueError("Cannot report a successful comparison when either scenario failed")

labels = ("book-3-done", "zoom-300-percent", "resume", "burst-complete", "thumbnails", "hidden-before-return", "after-hidden-20-seconds")
values = {}
for label in labels:
    pair = []
    for summary in (before, after):
        record = next(record for record in summary["checkpoints"] if record.get("label") == label)
        pair.append({key: record[key] for key in (
            "physicalFootprintBytes", "residentBytes", "loadedDocuments", "renderPeak",
            "canvasPixels", "maxSingleCanvasPixels", "displayedPages", "textLayerChars",
        )})
    values[label] = {"before": pair[0], "after": pair[1]}

report = {
    "beforeSummary": str(before_path.resolve()), "afterSummary": str(after_path.resolve()),
    "beforeScriptSHA256": before["scriptSHA256"], "afterScriptSHA256": after["scriptSHA256"],
    "fixtureSHA256": before["fixtureSHA256"], "fixtureBytes": before["fixtureBytes"],
    "pagesPerDocument": before["pagesPerDocument"],
    "peakPhysicalFootprintBytes": {"before": before["maxPhysicalFootprintBytes"], "after": after["maxPhysicalFootprintBytes"]},
    "checkpoints": values, "afterAssertions": after["assertions"],
    "notes": [
        "Physical footprint and RSS are different metrics; do not substitute one for the other.",
        "A single run is affected by WebKit collection/compression timing; this is not a universal memory-reduction percentage.",
        "The standalone WKWebView intentionally does not reload after renderer termination. Tauri recovery requires its own test.",
    ],
}
output.parent.mkdir(parents=True, exist_ok=True)
output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print("checkpoint | before footprint MB | after footprint MB")
for label, pair in values.items():
    print(f"{label} | {pair['before']['physicalFootprintBytes'] / 1e6:.1f} | {pair['after']['physicalFootprintBytes'] / 1e6:.1f}")
print(f"All {len(after['assertions'])} assertions passed: {all(after['assertions'].values())}")
