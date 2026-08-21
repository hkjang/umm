#!/usr/bin/env bash
# Runs two instances against one database and checks the behaviour that only
# breaks when umm is scaled horizontally: collaboration events reaching a
# reader connected to a different instance, idempotent retries recognised
# across instances, and the login lockout being shared rather than per-process.
set -euo pipefail

: "${POSTGRES_DSN:?POSTGRES_DSN is required}"
: "${BOOTSTRAP_ADMIN:?BOOTSTRAP_ADMIN is required}"
: "${BOOTSTRAP_ADMIN_PASSWORD:?BOOTSTRAP_ADMIN_PASSWORD is required}"
: "${ENCRYPTION_KEY:?ENCRYPTION_KEY is required}"

binary="${UMM_SMOKE_BINARY:-/tmp/umm-ci}"
port_a="${UMM_SMOKE_PORT_A:-8081}"
port_b="${UMM_SMOKE_PORT_B:-8082}"
work="$(mktemp -d)"
pids=()

cleanup() {
  local status=$?
  for pid in "${pids[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
  if (( status != 0 )); then
    for log in "$work"/*.log; do [[ -f "$log" ]] && { echo "--- $log"; cat "$log"; } >&2; done
  fi
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

start_instance() {
  local name="$1" port="$2"
  UMM_HTTP_ADDR="127.0.0.1:${port}" "$binary" >"$work/$name.log" 2>&1 &
  pids+=("$!")
  for _ in $(seq 1 80); do
    curl -fsS "http://127.0.0.1:${port}/readyz" >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  echo "instance $name did not become ready" >&2
  return 1
}

# Starting them in sequence keeps the migration advisory lock uncontended,
# which is how a rolling deploy behaves.
start_instance a "$port_a"
start_instance b "$port_b"
echo "==> both instances are ready"

api_a="http://127.0.0.1:${port_a}/api/v1"
api_b="http://127.0.0.1:${port_b}/api/v1"
cookie="$work/cookie"

curl -fsS -c "$cookie" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$BOOTSTRAP_ADMIN\",\"password\":\"$BOOTSTRAP_ADMIN_PASSWORD\"}" \
  "$api_a/auth/login" >/dev/null
space="$(curl -fsS -b "$cookie" "$api_a/spaces" | jq -r '.spaces[0].id')"
[[ -n "$space" && "$space" != "null" ]] || { echo "no space to test with" >&2; exit 1; }

# A session created on instance A must authenticate on instance B.
curl -fsS -b "$cookie" "$api_b/me" >/dev/null
echo "==> session created on A is accepted by B"

# 1. Collaboration events must cross instances. The reader is attached to B and
#    the writer talks to A, so the event can only arrive through PostgreSQL.
marker="multi-instance-$(date +%s)"
curl -fsS -N -b "$cookie" --max-time 20 "$api_b/spaces/$space/events" >"$work/stream.log" 2>&1 &
stream_pid=$!
pids+=("$stream_pid")
sleep 2
curl -fsS -b "$cookie" -H 'Content-Type: application/json' \
  -d "{\"content\":\"$marker\",\"x\":10,\"y\":10,\"width\":240,\"height\":160,\"color\":\"yellow\",\"kind\":\"thought\"}" \
  "$api_a/spaces/$space/notes" >/dev/null

received=0
for _ in $(seq 1 40); do
  if grep -q "note.created" "$work/stream.log" 2>/dev/null; then received=1; break; fi
  sleep 0.5
done
kill "$stream_pid" 2>/dev/null || true
if (( received != 1 )); then
  echo "a note created on A never reached the event stream on B" >&2
  cat "$work/stream.log" >&2
  exit 1
fi
echo "==> a write on A reached the collaboration stream on B"

# 2. A retry that lands on the other instance must replay the first response
#    rather than creating a second note.
key="multi-instance-$(date +%s)-retry"
body="{\"content\":\"$marker-retry\",\"x\":20,\"y\":20,\"width\":240,\"height\":160,\"color\":\"yellow\",\"kind\":\"thought\"}"
first="$(curl -fsS -b "$cookie" -H 'Content-Type: application/json' -H "Idempotency-Key: $key" -d "$body" "$api_a/spaces/$space/notes")"
second="$(curl -fsS -b "$cookie" -H 'Content-Type: application/json' -H "Idempotency-Key: $key" -d "$body" "$api_b/spaces/$space/notes")"
if [[ "$(jq -r '.id' <<<"$first")" != "$(jq -r '.id' <<<"$second")" ]]; then
  echo "a retry on B created a second note instead of replaying A's response" >&2
  exit 1
fi
echo "==> an idempotent retry on B replayed the response recorded on A"

# 3. Failed sign-ins must accumulate in the database, not in one process.
locked=0
for _ in $(seq 1 12); do
  target="$api_a"; (( RANDOM % 2 )) && target="$api_b"
  status="$(curl -s -o "$work/login.json" -w '%{http_code}' -H 'Content-Type: application/json' \
    -d "{\"username\":\"$BOOTSTRAP_ADMIN\",\"password\":\"wrong-password\"}" "$target/auth/login")"
  if [[ "$status" == "429" ]]; then locked=1; break; fi
done
if (( locked != 1 )); then
  echo "repeated failures spread across both instances never triggered the shared lockout" >&2
  exit 1
fi
echo "==> the login lockout is shared across instances"

# Leave the account usable for anything that runs after this script.
if [[ -n "${POSTGRES_CONTAINER:-}" ]]; then
  docker exec -i "$POSTGRES_CONTAINER" psql -q -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_SOURCE_DB:-umm}" \
    -c "DELETE FROM login_attempts" >/dev/null
fi

echo "multi-instance smoke passed"
