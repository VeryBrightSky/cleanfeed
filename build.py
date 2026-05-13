#!/usr/bin/env python3
"""Build dist/cleanfeed-v<version>.zip from the current source tree.

Includes only the files Chrome actually needs (the runtime). Excludes
repo-only files like README.md, SUBMISSION.md, tests/, store-assets/,
dist/, dotfiles, and the build script itself.

Validates:
* manifest.json parses as JSON
* every icon referenced in the manifest exists on disk
* required runtime files are present
"""
from __future__ import annotations
import json
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))

# Files / directories to include verbatim in the zip
INCLUDE_PATHS = [
    "manifest.json",
    "background.js",
    "content",
    "popup",
    "options",
    "onboarding",
    "lib",
    "icons",
    "PRIVACY.md",
    "LICENSE",
]

EXCLUDE_NAMES = {"__pycache__", "node_modules", ".DS_Store"}


def read_manifest() -> dict:
    with open(os.path.join(HERE, "manifest.json"), "r", encoding="utf-8") as f:
        return json.load(f)


def collect_files(root: str) -> list[tuple[str, str]]:
    """Return list of (absolute_path, archive_path)."""
    pairs: list[tuple[str, str]] = []
    for inc in INCLUDE_PATHS:
        full = os.path.join(root, inc)
        if not os.path.exists(full):
            print(f"  warn: missing path {inc}")
            continue
        if os.path.isfile(full):
            pairs.append((full, inc))
        else:
            for dirpath, dirnames, filenames in os.walk(full):
                # prune unwanted dirs in-place
                dirnames[:] = [d for d in dirnames if d not in EXCLUDE_NAMES and not d.startswith(".")]
                for fn in filenames:
                    if fn in EXCLUDE_NAMES or fn.startswith("."):
                        continue
                    abs_path = os.path.join(dirpath, fn)
                    arc = os.path.relpath(abs_path, root)
                    pairs.append((abs_path, arc))
    return pairs


def validate(manifest: dict, files: list[tuple[str, str]]) -> None:
    arcs = {a for _, a in files}
    # Background SW must be in the zip
    sw = manifest.get("background", {}).get("service_worker")
    if sw and sw not in arcs:
        raise SystemExit(f"manifest references missing service worker {sw}")
    # icons
    for size, path in manifest.get("icons", {}).items():
        if path not in arcs:
            raise SystemExit(f"manifest references missing icon {path}")
    # content scripts
    for cs in manifest.get("content_scripts", []):
        for f in cs.get("js", []) + cs.get("css", []):
            if f not in arcs:
                raise SystemExit(f"manifest references missing content script {f}")
    # popup html
    pp = manifest.get("action", {}).get("default_popup")
    if pp and pp not in arcs:
        raise SystemExit(f"manifest references missing popup {pp}")
    # options
    op = manifest.get("options_page")
    if op and op not in arcs:
        raise SystemExit(f"manifest references missing options page {op}")


def main() -> int:
    manifest = read_manifest()
    version = manifest.get("version", "0.0.0")
    print(f"Building CleanFeed v{version}")
    files = collect_files(HERE)
    validate(manifest, files)
    out_dir = os.path.join(HERE, "dist")
    os.makedirs(out_dir, exist_ok=True)
    out = os.path.join(out_dir, f"cleanfeed-v{version}.zip")
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for abs_path, arc in sorted(files, key=lambda p: p[1]):
            z.write(abs_path, arc)
    size_kb = os.path.getsize(out) / 1024
    print(f"  wrote {out}  ({size_kb:.1f} KB, {len(files)} files)")
    print("Done.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
