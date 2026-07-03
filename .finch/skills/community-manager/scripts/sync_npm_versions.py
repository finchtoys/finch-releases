#!/usr/bin/env python3
"""
sync_npm_versions.py — Fetch latest npm versions for extensions with an npm field.

Reads community/extensions.json, queries the npm registry for each entry that
has an "npm" field, and writes the latest version into a "version" field.

Usage:
  python3 scripts/sync_npm_versions.py          # normal run
  python3 scripts/sync_npm_versions.py --dry-run # preview only, no writes
"""
import json
import os
import sys
import urllib.request
import urllib.error

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..", ".."))
EXTENSIONS_PATH = os.path.join(REPO_ROOT, "community", "extensions.json")
NPM_REGISTRY = "https://registry.npmjs.org"

DRY_RUN = "--dry-run" in sys.argv


def fetch_latest_version(package_name):
    """Fetch the latest version of an npm package from the registry."""
    url = f"{NPM_REGISTRY}/{package_name}/latest"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            return data.get("version")
    except urllib.error.HTTPError as e:
        print(f"  ⚠ HTTP {e.code} for {package_name}", file=sys.stderr)
        return None
    except Exception as e:
        print(f"  ⚠ Error fetching {package_name}: {e}", file=sys.stderr)
        return None


def main():
    if not os.path.exists(EXTENSIONS_PATH):
        print(f"ERROR: {EXTENSIONS_PATH} not found", file=sys.stderr)
        sys.exit(1)

    with open(EXTENSIONS_PATH) as f:
        extensions = json.load(f)

    updated_count = 0
    error_count = 0

    for entry in extensions:
        pkg = entry.get("npm")
        if not pkg:
            continue

        eid = entry["id"]
        print(f"  Checking {eid} ({pkg})...", end=" ", flush=True)

        version = fetch_latest_version(pkg)
        if version is None:
            print("FAILED")
            error_count += 1
            continue

        old_version = entry.get("version")
        if old_version != version:
            print(f"{old_version or '—'} → {version}")
            entry["version"] = version
            updated_count += 1
        else:
            print(f"already {version} (no change)")

    if DRY_RUN:
        print(f"\n[Dry run] {updated_count} would be updated, {error_count} errors")
    else:
        # Sort and write back
        extensions.sort(key=lambda x: x["id"])
        with open(EXTENSIONS_PATH, "w") as f:
            json.dump(extensions, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"\nDone: {updated_count} updated, {error_count} errors")

    # Summary
    print("\nCurrent versions:")
    for entry in extensions:
        if entry.get("npm"):
            ver = entry.get("version", "—")
            print(f"  {entry['id']:30s} {entry['npm']:40s} v{ver}")


if __name__ == "__main__":
    main()
