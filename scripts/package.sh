#!/usr/bin/env bash
#
# Builds the Chrome Web Store upload zip from the tracked extension sources.
#
# The package is "everything git tracks, minus the excludes below", so a new
# source file added to the extension ships automatically -- no list to update.
#
#   ./scripts/package.sh                    build zip into repo root
#   ./scripts/package.sh dist               build zip into dist/
#   ./scripts/package.sh --list             print the files that would ship
#   ./scripts/package.sh --changed-since R  print shipped files changed since ref R
#
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# Repo files that are NOT part of the shipped extension.
EXCLUDES=(
  ':!:.github/**'
  ':!:scripts/**'
  ':!:store-assets/**'
  ':!:*.md'
  ':!:.gitignore'
  ':!:LICENSE'
  ':!:*.zip'
)

shipped_files() {
  git ls-files -z -- . "${EXCLUDES[@]}"
}

if [[ "${1:-}" == "--list" ]]; then
  shipped_files | tr '\0' '\n'
  exit 0
fi

# Which shipped files changed since a ref? Used by CI to decide whether a merge
# actually touched the extension or only docs/metadata.
if [[ "${1:-}" == "--changed-since" ]]; then
  BASE="${2:-}"
  if [[ -z "$BASE" ]] || ! git rev-parse --verify --quiet "$BASE^{commit}" >/dev/null; then
    # No usable baseline (first run): treat everything as changed.
    shipped_files | tr '\0' '\n'
    exit 0
  fi
  git diff --name-only "$BASE" HEAD -- . "${EXCLUDES[@]}"
  exit 0
fi

OUT_DIR="${1:-$REPO_ROOT}"
mkdir -p "$OUT_DIR"
OUT_DIR="$(cd "$OUT_DIR" && pwd)"

VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' manifest.json | head -1)"
if [[ -z "$VERSION" ]]; then
  echo "error: could not read version from manifest.json" >&2
  exit 1
fi

ZIP_PATH="$OUT_DIR/fullpage-screenshot-$VERSION.zip"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT

# Stage tracked sources so no OS cruft, git metadata or stale build can leak in.
COUNT=0
while IFS= read -r -d '' f; do
  mkdir -p "$STAGE/$(dirname "$f")"
  cp "$f" "$STAGE/$f"
  COUNT=$((COUNT + 1))
done < <(shipped_files)

if [[ "$COUNT" -eq 0 ]]; then
  echo "error: no files matched -- refusing to build an empty package" >&2
  exit 1
fi

# Sanity checks before we hand anything to the Web Store.
if ! python3 -c 'import json,sys; json.load(open(sys.argv[1]))' "$STAGE/manifest.json"; then
  echo "error: manifest.json is not valid JSON" >&2
  exit 1
fi
for required in manifest.json background.js popup.html; do
  [[ -f "$STAGE/$required" ]] || { echo "error: $required missing from package" >&2; exit 1; }
done
# Every local file the HTML pulls in must actually be in the package.
MISSING=0
while IFS= read -r ref; do
  [[ -f "$STAGE/$ref" ]] || { echo "error: referenced file not packaged: $ref" >&2; MISSING=1; }
done < <(grep -ohE '(src|href)="[^"]+"' "$STAGE"/*.html 2>/dev/null \
           | sed -E 's/.*"(.*)"/\1/' | grep -vE '^(https?:|data:|#|/)' | sort -u)
[[ "$MISSING" -eq 0 ]] || exit 1

find "$STAGE" -name '.DS_Store' -delete
rm -f "$ZIP_PATH"
( cd "$STAGE" && zip -r -X -q "$ZIP_PATH" . -x '.*' )

echo "$ZIP_PATH"
