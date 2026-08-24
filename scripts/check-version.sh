#!/usr/bin/env bash
# The version lives in more than one file, so they have to be checked against
# each other. VERSION is the one the release workflow compares the tag to; the
# rest are what a person reads or runs.
#
# Written after v0.36.0 was tagged with VERSION still at 0.35.0: the release
# workflow caught it, but only at tag time — after the pull request had already
# merged. This runs on the pull request instead, where the fix is one commit.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
version="$(tr -d '[:space:]' < "$root/VERSION")"
status=0

check() {
  local label="$1" found="$2"
  if [ "$found" != "$version" ]; then
    printf 'version mismatch: %s is %s, VERSION is %s\n' "$label" "${found:-missing}" "$version" >&2
    status=1
  fi
}

check "web/package.json" \
  "$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$root/web/package.json" | head -1)"
check "web/package-lock.json" \
  "$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$root/web/package-lock.json" | head -1)"
check "compose.yaml (build arg)" \
  "$(sed -n 's/.*VERSION: *\([0-9][^ ]*\).*/\1/p' "$root/compose.yaml" | head -1)"
check "compose.yaml (image tag)" \
  "$(sed -n 's/.*image: *umm:v\([0-9][^ ]*\).*/\1/p' "$root/compose.yaml" | head -1)"

# A release without its notes is a release nobody can read.
if [ ! -f "$root/docs/releases/v$version.md" ]; then
  printf 'missing release notes: docs/releases/v%s.md\n' "$version" >&2
  status=1
fi

[ "$status" -eq 0 ] && printf 'version %s is consistent across every file that carries it\n' "$version"
exit "$status"
