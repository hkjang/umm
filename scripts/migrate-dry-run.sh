#!/usr/bin/env bash
# Applies every migration to a scratch database, then rolls back the ones that
# ship a down script, so a release never discovers a broken migration in
# production. Requires a running PostgreSQL reachable through POSTGRES_CONTAINER
# (docker exec) or psql on PATH.
set -euo pipefail

SCRATCH_DB="${MIGRATE_DRY_RUN_DB:-umm_migrate_dry_run}"
PGUSER_NAME="${POSTGRES_USER:-postgres}"
CONTAINER="${POSTGRES_CONTAINER:-}"

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
    docker exec -i "$CONTAINER" psql -v ON_ERROR_STOP=1 -U "$PGUSER_NAME" -d "$database" < "$file"
  else
    psql -v ON_ERROR_STOP=1 -U "$PGUSER_NAME" -d "$database" -f "$file"
  fi
}

echo "==> preparing scratch database $SCRATCH_DB"
run_sql postgres -c "DROP DATABASE IF EXISTS $SCRATCH_DB" >/dev/null
run_sql postgres -c "CREATE DATABASE $SCRATCH_DB" >/dev/null
trap 'run_sql postgres -c "DROP DATABASE IF EXISTS $SCRATCH_DB" >/dev/null 2>&1 || true' EXIT

applied=()
for migration in migrations/*.sql; do
  echo "==> up   $(basename "$migration")"
  run_file "$SCRATCH_DB" "$migration" >/dev/null
  applied+=("$migration")
done

# Applying the same file twice must be a no-op: the migrator is interrupted by
# deploys and restarts, and a migration that is not re-runnable turns a retry
# into an outage.
for migration in "${applied[@]}"; do
  echo "==> re-apply $(basename "$migration")"
  run_file "$SCRATCH_DB" "$migration" >/dev/null
done

for (( index=${#applied[@]}-1 ; index>=0 ; index-- )); do
  version="$(basename "${applied[$index]}" .sql)"
  down="migrations/down/${version}.down.sql"
  [[ -f "$down" ]] || continue
  echo "==> down $(basename "$down")"
  run_file "$SCRATCH_DB" "$down" >/dev/null
done

echo "migration dry run passed: every migration applies, re-applies and rolls back"
