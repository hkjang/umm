# umm MCP

`umm`은 별도 프로세스 없이 서비스의 `/mcp` 경로에서 stateless Streamable HTTP 방식의 JSON-RPC를 제공합니다. 현재 프로토콜 `2026-07-28`과 전환기 클라이언트를 위한 `2025-11-25 initialize` 요청을 함께 처리합니다.

## 인증

개인 설정 → 개인 API · MCP 키에서 키를 만들고 필요한 scope만 선택합니다. 브라우저 세션은 MCP 인증으로 허용하지 않습니다.

```http
Authorization: Bearer umm_key_<prefix>_<secret>
Content-Type: application/json
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/list
```

2026-07-28 요청은 `Mcp-Method`를 JSON-RPC method와 동일하게 보내야 합니다. `tools/call`은 `Mcp-Name`도 도구 이름과 일치해야 합니다. `Origin`이 있다면 관리자 설정의 공개 URL과 동일한 origin이어야 합니다.

## 도구

| 도구 | 필요한 scope | 용도 |
| --- | --- | --- |
| `list_spaces` | `spaces:read` | 접근 가능한 공간 목록 |
| `list_notes` | `notes:read` | 공간의 메모와 연결 목록. `note_lines`로 각 생각이 어느 갈래에 속하는지 함께 옵니다 |
| `search_notes` | `notes:read` | 공간 안의 생각 검색. `note_lines` 동일 |
| `list_lines` | `notes:read` | 생각의 갈래 목록과 각 갈래의 상태·이유 |
| `create_note` | `notes:write` | 캔버스에 생각 붙이기 |
| `connect_notes` | `notes:write` | 두 생각 연결 |
| `get_related_notes` | `notes:read` | 로컬 의미 벡터로 연관 생각 발견 |
| `list_clusters` | `notes:read` | 공간의 의미 기반 생각 군집 조회 |
| `list_dreams` | `dreams:read` | 개인 Dream 기록 조회 |

도구는 캐시 안정성을 위해 이름순으로 고정되어 있습니다. 쓰기 도구 호출은 감사 로그에 기록됩니다.

### 접어 둔 갈래

`note_lines[note_id].status`가 `abandoned`이면 그 생각은 **사람이 검토한 뒤 채택하지 않기로 한
갈래**에 속합니다. `resolution`에 그 이유가 함께 옵니다. 현재 방침처럼 다루면 안 됩니다 — 사람이
이미 거절한 선택지를 에이전트가 다시 집어드는 것이 이 표시가 막으려는 일입니다.

갈래는 **사람이 표시합니다.** umm은 조용한 갈래를 접힌 것으로 추론하지 않으므로, 빈 결과는 표시된
것이 없다는 뜻이지 아무것도 결정되지 않았다는 뜻이 아닙니다. `find_contradictions`·
`find_open_questions`와 같은 규칙입니다.

## 예제

```bash
curl https://umm.internal/mcp \
  -H "Authorization: Bearer $UMM_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/call' \
  -H 'Mcp-Name: create_note' \
  -d '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"tools/call",
    "params":{"name":"create_note","arguments":{
      "space_id":"00000000-0000-0000-0000-000000000000",
      "content":"배포 승인 기준을 더 단순하게 만들 수 있을까?",
      "x":120,
      "y":180
    }}
  }'
```

키를 회전하면 관리자 설정의 중첩 시간 동안 이전 키가 함께 유효합니다. 새 secret은 생성 직후 한 번만 표시됩니다.

연관 검색과 군집화는 외부 임베딩 API를 호출하지 않는 내장 feature-hashing 벡터를 사용하므로 폐쇄망에서도 기본 동작합니다. Dream과 인라인 AI 도구만 관리자가 설정한 망 내부 AI Gateway를 사용합니다.
