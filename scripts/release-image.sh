#!/bin/sh
set -eu

VERSION_INPUT="${1:-$(tr -d '[:space:]' < VERSION)}"
VERSION_NUMBER="${VERSION_INPUT#v}"
case "$VERSION_NUMBER" in
  ''|*[!0-9.]*) echo "version must contain only digits and dots" >&2; exit 2 ;;
esac

IMAGE="umm:v${VERSION_NUMBER}"
ARCHIVE="dist/umm-v${VERSION_NUMBER}.tar.gz"
mkdir -p dist
docker build --build-arg "VERSION=${VERSION_NUMBER}" --label "org.opencontainers.image.revision=$(git rev-parse --verify HEAD 2>/dev/null || true)" -t "$IMAGE" .
docker save "$IMAGE" | gzip -9 -n > "$ARCHIVE"
docker image inspect "$IMAGE" --format 'Built {{.RepoTags}} ({{.Id}})'
echo "Offline image archive: $ARCHIVE"
