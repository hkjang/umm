#!/usr/bin/env bash
# Drives migration 010 forwards and backwards over the edge shapes that actually
# carry risk, on a scratch database seeded for the purpose.
#
# migrate-dry-run.sh proves every migration applies, re-applies and rolls back —
# but it runs against an empty schema, so it never touches the parts of 010 that
# move data: recovering provenance out of the old relation text, parking an
# unvalidated relation in legacy_relation, and collapsing typed edges back to one
# per pair when the old unique constraint is restored. Those are the paths where
# a rollback could silently lose someone's connections.
set -euo pipefail

: "${POSTGRES_DSN:?POSTGRES_DSN is required}"
PGUSER_NAME="${POSTGRES_USER:-postgres}"
CONTAINER="${POSTGRES_CONTAINER:-}"
SCRATCH="${GRAPH_DRILL_DB:-umm_graph_drill}"
root="$(cd "$(dirname "$0")/.." && pwd)"

run_sql() {
  local database="$1"
  if [[ -n "$CONTAINER" ]]; then
    docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PGUSER_NAME" -d "$database" "${@:2}"
  else
    psql -v ON_ERROR_STOP=1 -U "$PGUSER_NAME" -d "$database" "${@:2}"
  fi
}

run_file() {
  local database="$1" file="$2"
  if [[ -n "$CONTAINER" ]]; then
    docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PGUSER_NAME" -d "$database" -q < "$file"
  else
    psql -v ON_ERROR_STOP=1 -U "$PGUSER_NAME" -d "$database" -q -f "$file"
  fi
}

value() { run_sql "$SCRATCH" -tAc "$1" | tr -d '[:space:]'; }

expect() {
  local label="$1" want="$2" got="$3"
  if [[ "$want" != "$got" ]]; then
    echo "FAIL ${label}: want ${want}, got ${got}" >&2
    exit 1
  fi
  echo "  ok  ${label} = ${got}"
}

echo "==> preparing scratch database ${SCRATCH}"
run_sql postgres -c "DROP DATABASE IF EXISTS ${SCRATCH}" >/dev/null
run_sql postgres -c "CREATE DATABASE ${SCRATCH}" >/dev/null

# Everything up to but not including 010, so the seed below is written against
# the old schema exactly as a real deployment would hold it.
#
# This stops at 010 rather than skipping it. Skipping was the same thing only
# while 010 was the last migration: once a later one narrowed the same relation
# vocabulary, applying it while 010 was absent made the pre-010 seed below
# impossible to insert.
for file in "$root"/migrations/[0-9]*.sql; do
  number="$(basename "$file")"
  number="${number%%_*}"
  (( 10#$number >= 10 )) && break
  run_file "$SCRATCH" "$file"
done

echo "==> seeding the shapes that matter"
run_sql "$SCRATCH" -q <<'SQL'
INSERT INTO users(id,username,display_name)
VALUES('11111111-1111-1111-1111-111111111111','drill_owner','drill owner');
INSERT INTO spaces(id,owner_id,name)
VALUES('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','drill');
INSERT INTO notes(id,space_id,author_id,content) VALUES
  ('33333333-3333-3333-3333-333333333333','22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','A'),
  ('44444444-4444-4444-4444-444444444444','22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','B'),
  ('55555555-5555-5555-5555-555555555555','22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111','C');

-- A Dream edge, a development edge, and the unvalidated free text the old schema
-- accepted from any request body.
INSERT INTO note_edges(space_id,source_note_id,target_note_id,relation,created_by) VALUES
  ('22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','dreamed','11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','expanded','11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222','44444444-4444-4444-4444-444444444444','55555555-5555-5555-5555-555555555555',repeat('A',5000),'11111111-1111-1111-1111-111111111111');
SQL

echo "==> applying 010"
run_file "$SCRATCH" "$root/migrations/010_memory_graph.sql"

expect "dream provenance recovered" "related|dream" \
  "$(value "SELECT relation||'|'||origin FROM note_edges WHERE target_note_id='44444444-4444-4444-4444-444444444444'")"
expect "development provenance recovered" "expands|development" \
  "$(value "SELECT relation||'|'||origin FROM note_edges WHERE target_note_id='55555555-5555-5555-5555-555555555555' AND source_note_id='33333333-3333-3333-3333-333333333333'")"
expect "unvalidated relation parked, not destroyed" "related|manual|5000" \
  "$(value "SELECT relation||'|'||origin||'|'||length(legacy_relation) FROM note_edges WHERE source_note_id='44444444-4444-4444-4444-444444444444'")"

echo "==> typed edges now coexist on one pair"
run_sql "$SCRATCH" -q -c "
INSERT INTO note_edges(space_id,source_note_id,target_note_id,relation,origin,created_by)
SELECT '22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444',r,'manual','11111111-1111-1111-1111-111111111111'
FROM unnest(ARRAY['supports','refines','follows']) AS r"
expect "four relations on one pair" "4" \
  "$(value "SELECT count(*) FROM note_edges WHERE source_note_id='33333333-3333-3333-3333-333333333333' AND target_note_id='44444444-4444-4444-4444-444444444444'")"

echo "==> rolling 010 back with that data in place"
run_file "$SCRATCH" "$root/migrations/down/010_memory_graph.down.sql"

expect "one edge per pair restored" "1" \
  "$(value "SELECT count(*) FROM note_edges WHERE source_note_id='33333333-3333-3333-3333-333333333333' AND target_note_id='44444444-4444-4444-4444-444444444444'")"
expect "the surviving edge is the original" "dreamed" \
  "$(value "SELECT relation FROM note_edges WHERE source_note_id='33333333-3333-3333-3333-333333333333' AND target_note_id='44444444-4444-4444-4444-444444444444'")"
expect "development relation restored" "expanded" \
  "$(value "SELECT relation FROM note_edges WHERE target_note_id='55555555-5555-5555-5555-555555555555' AND source_note_id='33333333-3333-3333-3333-333333333333'")"
expect "original relation text returned intact" "5000" \
  "$(value "SELECT length(relation) FROM note_edges WHERE source_note_id='44444444-4444-4444-4444-444444444444'")"
expect "graph columns removed" "0" \
  "$(value "SELECT count(*) FROM information_schema.columns WHERE table_name='note_edges' AND column_name IN ('origin','confidence','legacy_relation')")"
expect "pair uniqueness restored" "1" \
  "$(value "SELECT count(*) FROM pg_constraint WHERE conrelid='note_edges'::regclass AND contype='u'")"

echo "==> re-applying 010 on the rolled-back data"
run_file "$SCRATCH" "$root/migrations/010_memory_graph.sql"
expect "provenance recovered again" "related|dream" \
  "$(value "SELECT relation||'|'||origin FROM note_edges WHERE target_note_id='44444444-4444-4444-4444-444444444444'")"

run_sql postgres -c "DROP DATABASE ${SCRATCH}" >/dev/null
echo "memory graph migration drill passed"
