#!/bin/sh
set -eu

ARCHIVE="${1:?usage: ./scripts/load-offline.sh umm-vX.Y.Z.tar.gz}"
test -f "$ARCHIVE"
gzip -dc "$ARCHIVE" | docker load
echo "Image loaded. Configure only POSTGRES_DSN, BOOTSTRAP_ADMIN, BOOTSTRAP_ADMIN_PASSWORD and ENCRYPTION_KEY when starting umm."
