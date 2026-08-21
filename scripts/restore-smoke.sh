#!/bin/sh
set -eu

: "${POSTGRES_CONTAINER_ID:?POSTGRES_CONTAINER_ID is required}"
: "${POSTGRES_USER:=postgres}"
: "${POSTGRES_SOURCE_DB:=umm}"
: "${RESTORE_TEST_DB:?RESTORE_TEST_DB is required}"

case "$POSTGRES_CONTAINER_ID" in
  ''|*[!a-fA-F0-9]*) echo "POSTGRES_CONTAINER_ID must be a container ID" >&2; exit 2 ;;
esac
case "$POSTGRES_SOURCE_DB" in
  ''|*[!a-zA-Z0-9_]*) echo "POSTGRES_SOURCE_DB must be a simple database name" >&2; exit 2 ;;
esac
case "$POSTGRES_USER" in
  ''|*[!a-zA-Z0-9_]*) echo "POSTGRES_USER must be a simple role name" >&2; exit 2 ;;
esac
case "$RESTORE_TEST_DB" in
  umm_restore_*) ;;
  *) echo "RESTORE_TEST_DB must begin with umm_restore_" >&2; exit 2 ;;
esac
case "$RESTORE_TEST_DB" in
  ''|*[!a-zA-Z0-9_]*) echo "RESTORE_TEST_DB must be a simple database name" >&2; exit 2 ;;
esac

dump_path="/tmp/${RESTORE_TEST_DB}.dump"

cleanup() {
  docker exec "$POSTGRES_CONTAINER_ID" dropdb --if-exists --force --username="$POSTGRES_USER" "$RESTORE_TEST_DB" >/dev/null 2>&1 || true
  docker exec "$POSTGRES_CONTAINER_ID" rm -f "$dump_path" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker exec "$POSTGRES_CONTAINER_ID" pg_dump \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_SOURCE_DB" \
  --format=custom \
  --file="$dump_path"
docker exec "$POSTGRES_CONTAINER_ID" dropdb --if-exists --force --username="$POSTGRES_USER" "$RESTORE_TEST_DB"
docker exec "$POSTGRES_CONTAINER_ID" createdb --username="$POSTGRES_USER" "$RESTORE_TEST_DB"
docker exec "$POSTGRES_CONTAINER_ID" pg_restore \
  --username="$POSTGRES_USER" \
  --dbname="$RESTORE_TEST_DB" \
  --exit-on-error \
  "$dump_path"

source_migrations="$(docker exec "$POSTGRES_CONTAINER_ID" psql --username="$POSTGRES_USER" --dbname="$POSTGRES_SOURCE_DB" --tuples-only --no-align --command='SELECT count(*) FROM schema_migrations')"
restored_migrations="$(docker exec "$POSTGRES_CONTAINER_ID" psql --username="$POSTGRES_USER" --dbname="$RESTORE_TEST_DB" --tuples-only --no-align --command='SELECT count(*) FROM schema_migrations')"
source_users="$(docker exec "$POSTGRES_CONTAINER_ID" psql --username="$POSTGRES_USER" --dbname="$POSTGRES_SOURCE_DB" --tuples-only --no-align --command='SELECT count(*) FROM users')"
restored_users="$(docker exec "$POSTGRES_CONTAINER_ID" psql --username="$POSTGRES_USER" --dbname="$RESTORE_TEST_DB" --tuples-only --no-align --command='SELECT count(*) FROM users')"

test "$source_migrations" = "$restored_migrations"
test "$source_users" = "$restored_users"
test "$restored_migrations" -ge 1
test "$restored_users" -ge 1

echo "umm backup restore drill passed (${restored_migrations} migrations, ${restored_users} users)"
