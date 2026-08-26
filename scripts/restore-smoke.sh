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
  docker exec "$POSTGRES_CONTAINER_ID" psql --username="$POSTGRES_USER" --dbname="$POSTGRES_SOURCE_DB" \
    --command="DELETE FROM users WHERE username LIKE 'restore_canary_%'" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# A thought put in on purpose, so the drill proves the thing the product is
# for rather than the thing that happens to be lying around.
#
# It compared migrations and users. Both survive a dump that lost every note,
# and by the time this runs the integration tests have dropped their isolated
# schemas, so the source database usually holds no notes at all — there was
# nothing for a count to be right about.
#
# Written before the dump and removed from the source straight after, so the
# database is left as it was found.
canary_user="restore_canary_$$"
canary_text="restore canary $$ this thought must survive"
psql_source() {
  docker exec "$POSTGRES_CONTAINER_ID" psql --username="$POSTGRES_USER" --dbname="$POSTGRES_SOURCE_DB" \
    --tuples-only --no-align "$@"
}
psql_source --command="
  WITH person AS (
    INSERT INTO users(username,display_name) VALUES ('${canary_user}','${canary_user}') RETURNING id
  ), place AS (
    INSERT INTO spaces(owner_id,name) SELECT id,'restore drill' FROM person RETURNING id,owner_id
  )
  INSERT INTO notes(space_id,author_id,content)
  SELECT place.id, place.owner_id, '${canary_text}' FROM place" >/dev/null

docker exec "$POSTGRES_CONTAINER_ID" pg_dump \
  --username="$POSTGRES_USER" \
  --dbname="$POSTGRES_SOURCE_DB" \
  --format=custom \
  --file="$dump_path"

# The canary stays in the source until the comparisons are done — removing it
# first made the row counts differ by exactly one and the drill fail on its own
# canary. The trap takes it out on the way past, whether this passes or not.
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

# The thought itself, read back out of the restored copy. A count would not
# notice a note restored empty or with its text mangled.
restored_note="$(docker exec "$POSTGRES_CONTAINER_ID" psql --username="$POSTGRES_USER" --dbname="$RESTORE_TEST_DB" --tuples-only --no-align --command="SELECT content FROM notes WHERE content='${canary_text}'")"
test "$restored_note" = "$canary_text"

# And what it hangs off: a thought whose space or author did not come back is a
# thought nobody can reach.
reachable="$(docker exec "$POSTGRES_CONTAINER_ID" psql --username="$POSTGRES_USER" --dbname="$RESTORE_TEST_DB" --tuples-only --no-align --command="SELECT count(*) FROM notes n JOIN spaces sp ON sp.id=n.space_id JOIN users u ON u.id=n.author_id WHERE n.content='${canary_text}' AND u.username='${canary_user}'")"
test "$reachable" = "1"

echo "umm backup restore drill passed (${restored_migrations} migrations, ${restored_users} users, thought restored intact)"
