#!/bin/sh
set -eu

: "${POSTGRES_DSN:?POSTGRES_DSN is required}"
: "${BOOTSTRAP_ADMIN:?BOOTSTRAP_ADMIN is required}"
: "${BOOTSTRAP_ADMIN_PASSWORD:?BOOTSTRAP_ADMIN_PASSWORD is required}"
: "${ENCRYPTION_KEY:?ENCRYPTION_KEY is required}"

binary="${UMM_SMOKE_BINARY:-/tmp/umm-ci}"
base="http://127.0.0.1:8080/api/v1"
smoke_dir="$(mktemp -d)"
cookie="$smoke_dir/cookie"

cleanup() {
  if [ -n "${app_pid:-}" ]; then
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
  rm -rf "$smoke_dir"
}
trap cleanup EXIT INT TERM

"$binary" >"$smoke_dir/server.log" 2>&1 &
app_pid=$!
ready=0
for _ in $(seq 1 80); do
  if curl -fsS http://127.0.0.1:8080/readyz >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.25
done
if [ "$ready" -ne 1 ]; then
  cat "$smoke_dir/server.log"
  exit 1
fi

curl -fsS -c "$cookie" -H 'Content-Type: application/json' \
  -d "{\"username\":\"$BOOTSTRAP_ADMIN\",\"password\":\"$BOOTSTRAP_ADMIN_PASSWORD\"}" \
  "$base/auth/login" >/dev/null
space="$(curl -fsS -b "$cookie" "$base/spaces" | jq -r '.spaces[0].id')"

for content in \
  '사용자별 API Key 권한 정책' \
  'API Key 사용자 회전 권한 모델' \
  '부서별 AI 비용과 사용자 권한 정책'
do
  curl -fsS -b "$cookie" -H 'Content-Type: application/json' \
    -d "{\"content\":\"$content\",\"x\":120,\"y\":160,\"width\":240,\"height\":160,\"color\":\"yellow\",\"kind\":\"thought\"}" \
    "$base/spaces/$space/notes" >/dev/null
done

notes="$(curl -fsS -b "$cookie" "$base/spaces/$space/notes")"
test "$(printf '%s' "$notes" | jq '.notes | length')" -eq 3
note="$(printf '%s' "$notes" | jq -r '.notes[0].id')"
test "$(curl -fsS -b "$cookie" "$base/notes/$note/related" | jq '.related | length')" -ge 1
test "$(curl -fsS -b "$cookie" "$base/spaces/$space/clusters" | jq '.clusters | length')" -ge 1

created="$(curl -fsS -b "$cookie" -H 'Content-Type: application/json' \
  -d '{"name":"ci-mcp","scopes":["notes:read","spaces:read"],"expiresDays":1}' "$base/api-keys")"
secret="$(printf '%s' "$created" | jq -r '.secret')"
tools="$(curl -fsS http://127.0.0.1:8080/mcp \
  -H "Authorization: Bearer $secret" \
  -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')"
test "$(printf '%s' "$tools" | jq '.result.tools | length')" -eq 8

approval="$(curl -fsS -b "$cookie" -H 'Content-Type: application/json' \
  -d "{\"resourceType\":\"space\",\"resourceId\":\"$space\",\"action\":\"export\",\"comment\":\"CI\"}" \
  "$base/approvals")"
test "$(printf '%s' "$approval" | jq -r '.required')" = false

echo "umm integration smoke passed"
