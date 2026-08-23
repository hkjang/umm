#!/bin/sh
set -eu

: "${POSTGRES_DSN:?POSTGRES_DSN is required}"
: "${BOOTSTRAP_ADMIN:?BOOTSTRAP_ADMIN is required}"
: "${BOOTSTRAP_ADMIN_PASSWORD:?BOOTSTRAP_ADMIN_PASSWORD is required}"
: "${ENCRYPTION_KEY:?ENCRYPTION_KEY is required}"

binary="${UMM_SMOKE_BINARY:-/tmp/umm-ci}"
smoke_port="${UMM_SMOKE_PORT:-8080}"
case "$smoke_port" in
  ''|*[!0-9]*) echo "UMM_SMOKE_PORT must be numeric" >&2; exit 2 ;;
esac
base="http://127.0.0.1:${smoke_port}/api/v1"
smoke_dir="$(mktemp -d)"
cookie="$smoke_dir/cookie"

cleanup() {
	status=$?
  if [ -n "${app_pid:-}" ]; then
    kill "$app_pid" 2>/dev/null || true
    wait "$app_pid" 2>/dev/null || true
  fi
	if [ "$status" -ne 0 ] && [ -f "$smoke_dir/server.log" ]; then
		cat "$smoke_dir/server.log" >&2
	fi
  rm -rf "$smoke_dir"
}
trap cleanup EXIT INT TERM

UMM_HTTP_ADDR="127.0.0.1:${smoke_port}" "$binary" >"$smoke_dir/server.log" 2>&1 &
app_pid=$!
ready=0
for _ in $(seq 1 80); do
  if curl -fsS "http://127.0.0.1:${smoke_port}/readyz" >/dev/null 2>&1; then
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
second_note="$(printf '%s' "$notes" | jq -r '.notes[1].id')"
note_payload="$(printf '%s' "$notes" | jq '.notes[0] | .aiExcluded=true')"
updated_note="$(printf '%s' "$note_payload" | curl -fsS -b "$cookie" -H 'Content-Type: application/json' -X PUT --data-binary @- "$base/notes/$note")"
test "$(printf '%s' "$updated_note" | jq -r '.aiExcluded')" = true
legacy_note="$(printf '%s' "$updated_note" | jq 'del(.aiExcluded)' | curl -fsS -b "$cookie" -H 'Content-Type: application/json' -X PUT --data-binary @- "$base/notes/$note")"
test "$(printf '%s' "$legacy_note" | jq -r '.aiExcluded')" = true
printf '%s' "$legacy_note" | jq '.aiExcluded=false' | curl -fsS -b "$cookie" -H 'Content-Type: application/json' -X PUT --data-binary @- "$base/notes/$note" >/dev/null

deleted_note="$(curl -fsS -b "$cookie" -H 'Content-Type: application/json' \
  -d '{"content":"삭제 뒤 오프라인 재시도 분류","x":0,"y":0}' "$base/spaces/$space/notes")"
deleted_note_id="$(printf '%s' "$deleted_note" | jq -r '.id')"
curl -fsS -b "$cookie" -X DELETE "$base/notes/$deleted_note_id" >/dev/null
deleted_update_status="$(printf '%s' "$deleted_note" | curl -sS -o "$smoke_dir/deleted-note-update.json" -w '%{http_code}' -b "$cookie" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: deleted-note-update-12345678' \
  -X PUT --data-binary @- "$base/notes/$deleted_note_id")"
test "$deleted_update_status" = "404"
test "$(jq -r '.type | endswith("/note-not-found")' "$smoke_dir/deleted-note-update.json")" = true

space_payload="$(curl -fsS -b "$cookie" "$base/spaces" | jq '.spaces[0] | {name,aiExcluded:true}')"
updated_space="$(printf '%s' "$space_payload" | curl -fsS -b "$cookie" -H 'Content-Type: application/json' -X PUT --data-binary @- "$base/spaces/$space")"
test "$(printf '%s' "$updated_space" | jq -r '.aiExcluded')" = true
printf '%s' "$updated_space" | jq '{name,aiExcluded:false}' | curl -fsS -b "$cookie" -H 'Content-Type: application/json' -X PUT --data-binary @- "$base/spaces/$space" >/dev/null

search="$(curl -fsS -b "$cookie" --get --data-urlencode 'q=사용자별 권한' --data-urlencode 'limit=5' "$base/search")"
test "$(printf '%s' "$search" | jq '.notes | length')" -ge 1
test "$(printf '%s' "$search" | jq -r '.notes[0].spaceId')" = "$space"
search_page="$(curl -fsS -b "$cookie" --get --data-urlencode 'q=권한' --data-urlencode 'limit=1' "$base/search")"
test "$(printf '%s' "$search_page" | jq '.notes | length')" -eq 1
test "$(printf '%s' "$search_page" | jq -r '.nextCursor | length > 0')" = true
test "$(curl -fsS -b "$cookie" "$base/notes/$note/related" | jq '.related | length')" -ge 1
test "$(curl -fsS -b "$cookie" "$base/spaces/$space/clusters" | jq '.clusters | length')" -ge 1

curl -fsS -b "$cookie" -H 'Content-Type: application/json' \
  -d "{\"source\":\"$note\",\"target\":\"$second_note\",\"relation\":\"supports\"}" \
  "$base/spaces/$space/edges" >/dev/null
test "$(curl -fsS -b "$cookie" "$base/notes/$note/backlinks" | jq '.backlinks | length')" -eq 1

comment_key="ci-comment-12345678"
curl -fsS -D "$smoke_dir/comment-first.headers" -o "$smoke_dir/comment-first.json" -b "$cookie" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $comment_key" \
  -d '{"body":"@admin 통합 시험 댓글입니다."}' "$base/notes/$note/comments"
curl -fsS -D "$smoke_dir/comment-replay.headers" -o "$smoke_dir/comment-replay.json" -b "$cookie" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $comment_key" \
  -d '{"body":"@admin 통합 시험 댓글입니다."}' "$base/notes/$note/comments"
test "$(jq -r '.id' "$smoke_dir/comment-first.json")" = "$(jq -r '.id' "$smoke_dir/comment-replay.json")"
grep -qi '^Idempotency-Replayed: true' "$smoke_dir/comment-replay.headers"
test "$(curl -fsS -b "$cookie" "$base/notes/$note/comments" | jq '.comments | length')" -eq 1
reuse_status="$(curl -sS -o "$smoke_dir/comment-reuse.json" -w '%{http_code}' -b "$cookie" \
  -H 'Content-Type: application/json' -H "Idempotency-Key: $comment_key" \
  -d '{"body":"같은 키의 다른 요청은 거부되어야 합니다."}' "$base/notes/$note/comments")"
test "$reuse_status" = "409"
test "$(jq -r '.type | endswith("/idempotency-key-reused")' "$smoke_dir/comment-reuse.json")" = true

today="$(curl -fsS -b "$cookie" "$base/today")"
test "$(printf '%s' "$today" | jq '.onboarding.steps | length')" -ge 3
test "$(printf '%s' "$today" | jq '.orphans | length')" -ge 1
curl -fsS -b "$cookie" -X POST "$base/onboarding/complete" >/dev/null
test "$(curl -fsS -b "$cookie" "$base/onboarding" | jq -r '.completedAt != null')" = true
reviewed="$(curl -fsS -b "$cookie" -H 'Content-Type: application/json' -d '{"snoozeDays":2,"pinned":true}' "$base/notes/$note/review")"
test "$(printf '%s' "$reviewed" | jq -r '.pinned')" = true
test "$(curl -fsS -b "$cookie" "$base/today" | jq --arg id "$note" '.review | any(.id == $id and .pinned == true)')" = true
pinned_only="$(curl -fsS -b "$cookie" -H 'Content-Type: application/json' -d '{"pinned":false,"complete":false}' "$base/notes/$note/review")"
test "$(printf '%s' "$pinned_only" | jq -r '.pinned')" = false
test "$(curl -fsS -b "$cookie" "$base/today" | jq --arg id "$note" '.review | any(.id == $id)')" = false

preferences="$(curl -fsS -b "$cookie" "$base/preferences")"
test "$(printf '%s' "$preferences" | jq -r '.edge_style')" = "bezier"
updated_preferences="$(printf '%s' "$preferences" | jq '.edge_style="smoothstep"' | curl -fsS -b "$cookie" -H 'Content-Type: application/json' -X PUT --data-binary @- "$base/preferences")"
test "$(printf '%s' "$updated_preferences" | jq -r '.edge_style')" = "smoothstep"

sensitive_idempotency_status="$(curl -sS -o "$smoke_dir/sensitive-idempotency.json" -w '%{http_code}' -b "$cookie" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: credential-secret-12345678' \
  -d '{"name":"must-not-be-cached","scopes":["notes:read"],"expiresDays":1}' "$base/api-keys")"
test "$sensitive_idempotency_status" = "400"
test "$(jq -r '.type | endswith("/idempotency-not-supported")' "$smoke_dir/sensitive-idempotency.json")" = true

admin_settings="$(curl -fsS -b "$cookie" "$base/admin/settings")"
test "$(printf '%s' "$admin_settings" | jq -r '.ai_gateway.log_retention_days')" = "90"
dream_settings="$(printf '%s' "$admin_settings" | jq '.dream.token_limit=262144 | .dream')"
curl -fsS -b "$cookie" -H 'Content-Type: application/json' -X PUT --data-binary "$dream_settings" "$base/admin/settings/dream" >/dev/null
test "$(curl -fsS -b "$cookie" "$base/admin/settings" | jq -r '.dream.token_limit')" = "262144"
invalid_status="$(printf '%s' "$dream_settings" | jq '.token_limit=262145' | curl -sS -o "$smoke_dir/invalid-token.json" -w '%{http_code}' -b "$cookie" -H 'Content-Type: application/json' -X PUT --data-binary @- "$base/admin/settings/dream")"
test "$invalid_status" = "400"

created="$(curl -fsS -b "$cookie" -H 'Content-Type: application/json' \
  -d '{"name":"ci-mcp","scopes":["notes:read","spaces:read"],"expiresDays":1}' "$base/api-keys")"
secret="$(printf '%s' "$created" | jq -r '.secret')"
readonly_status="$(curl -sS -o "$smoke_dir/readonly-denied.json" -w '%{http_code}' \
  -H "Authorization: Bearer $secret" -H 'Content-Type: application/json' \
  -d '{"content":"권한이 없어야 하는 생각","x":0,"y":0}' "$base/spaces/$space/notes")"
test "$readonly_status" = "403"
test "$(jq -r '.status' "$smoke_dir/readonly-denied.json")" = "403"
credential_status="$(curl -sS -o "$smoke_dir/credential-denied.json" -w '%{http_code}' \
  -H "Authorization: Bearer $secret" -H 'Content-Type: application/json' \
  -d '{"name":"privilege-escalation","scopes":["notes:write"],"expiresDays":1}' "$base/api-keys")"
test "$credential_status" = "403"
test "$(jq -r '.type | endswith("/interactive-session-required")' "$smoke_dir/credential-denied.json")" = true
admin_key_status="$(curl -sS -o "$smoke_dir/admin-key-denied.json" -w '%{http_code}' \
  -H "Authorization: Bearer $secret" "$base/admin/settings")"
test "$admin_key_status" = "403"
tools="$(curl -fsS "http://127.0.0.1:${smoke_port}/mcp" \
  -H "Authorization: Bearer $secret" \
  -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/list' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}')"
# Name the surface rather than count it: a count only says something changed,
# and a tool removed by accident would pass by adding another.
test "$(printf '%s' "$tools" | jq -r '[.result.tools[].name] | join(",")')" \
  = "capture_thought,connect_notes,create_note,find_contradictions,find_open_questions,get_connections,get_related_notes,list_clusters,list_dreams,list_lines,list_notes,list_spaces,search_notes"

approval="$(curl -fsS -b "$cookie" -H 'Content-Type: application/json' \
  -d "{\"resourceType\":\"space\",\"resourceId\":\"$space\",\"action\":\"export\",\"comment\":\"CI\"}" \
  "$base/approvals")"
test "$(printf '%s' "$approval" | jq -r '.required')" = false

test "$(curl -fsS -b "$cookie" "$base/admin/security/encryption" | jq -r '.keyId | length > 0')" = true
eval_case="$(curl -fsS -b "$cookie" -H 'Content-Type: application/json' \
  -d '{"name":"CI grounding","dreamType":"connection","inputNotes":["권한 정책을 정리한다","API 키를 주기적으로 회전한다"],"expectedTerms":["권한"],"forbiddenTerms":["비밀번호"],"active":true}' \
  "$base/admin/ai-evals")"
eval_id="$(printf '%s' "$eval_case" | jq -r '.id')"
test "$(curl -fsS -b "$cookie" "$base/admin/ai-evals" | jq --arg id "$eval_id" '.cases | any(.id == $id)')" = true
curl -fsS -b "$cookie" -X DELETE "$base/admin/ai-evals/$eval_id" >/dev/null
metrics="$(curl -fsS -b "$cookie" "$base/metrics")"
case "$metrics" in
  *umm_build_info*) ;;
  *) echo "Prometheus build metric was not returned" >&2; exit 1 ;;
esac

echo "umm integration smoke passed"
