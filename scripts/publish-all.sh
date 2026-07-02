#!/bin/bash
set -e

DRY_RUN=""
if [ "$1" = "--dry-run" ]; then
  DRY_RUN="--dry-run"
  echo "Dry run mode — nothing will actually be published."
fi

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

for pkg_dir in packages/*; do
  [ -d "$pkg_dir" ] || continue
  pkg_json="$pkg_dir/package.json"
  [ -f "$pkg_json" ] || continue

  name=$(node -p "require('./$pkg_json').name")
  version=$(node -p "require('./$pkg_json').version")
  private=$(node -p "require('./$pkg_json').private || false")

  if [ "$private" = "true" ]; then
    echo "[skip] $name@$version is private"
    continue
  fi

  echo "[check] $name@$version ..."
  if npm view "$name@$version" version >/dev/null 2>&1; then
    echo "[skip] $name@$version already published"
    continue
  fi

  echo "[publish] $name@$version ..."
  if [ -n "$DRY_RUN" ]; then
    npm publish "$pkg_dir" --access public --dry-run
  else
    npm publish "$pkg_dir" --access public
  fi
  echo "[done] $name@$version"
done
