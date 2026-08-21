# umm API & MCP 연동 가이드 (API & MCP Guide)

`umm`은 시스템 통합 및 자동화를 위한 **REST API**와 AI 에이전트(Claude Desktop, Cursor, Custom Agent 등) 연동을 위한 **Model Context Protocol (MCP)** 엔드포인트를 제공합니다.

---

## 1. 인증 체계 (Authentication)

모든 API 및 MCP 호출은 개인 설정(`/settings`)에서 발급받은 **Bearer API Key** 또는 세션 쿠키를 사용합니다:

```http
Authorization: Bearer umm_key_a1b2c3d4_xxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

---

## 2. REST API 주요 엔드포인트 (`/api/v1`)

### 🗂️ 공간 (Spaces)
| 메서드 | 경로 | 설명 | 권한 스코프 |
| :--- | :--- | :--- | :--- |
| `GET` | `/spaces` | 사용자가 접근 가능한 공간 목록 조회 | `spaces:read` |
| `POST` | `/spaces` | 새 공간 생성 (`{"name": "새 프로젝트"}`) | `spaces:write` |
| `PUT` | `/spaces/{id}` | 공간 이름 변경 (`{"name": "수정된 이름"}`) | `spaces:write` |
| `DELETE` | `/spaces/{id}` | 공간 및 내부 메모 영구 삭제 | `spaces:write` |
| `GET` | `/spaces/{id}/members` | 공간 참여 멤버 및 권한 목록 조회 | `spaces:read` |
| `POST` | `/spaces/{id}/members` | 공간에 사용자 초대 | `spaces:share` |

### 📝 생각 포스트잇 (Notes & Edges)
| 메서드 | 경로 | 설명 | 권한 스코프 |
| :--- | :--- | :--- | :--- |
| `GET` | `/spaces/{id}/notes` | 공간 내 모든 포스트잇과 연결선 조회 | `notes:read` |
| `POST` | `/spaces/{id}/notes` | 새 포스트잇 생성 (`title`, `content`, `color`, `x`, `y`, `width`, `height`) | `notes:write` |
| `PUT` | `/notes/{id}` | 포스트잇 내용/위치/크기 수정 | `notes:write` |
| `DELETE` | `/notes/{id}` | 포스트잇 삭제 | `notes:write` |
| `GET` | `/notes/{id}/history` | 포스트잇 과거 수정 이력 스냅샷 조회 | `notes:read` |
| `POST` | `/notes/{id}/restore/{version}` | 특정 버전으로 포스트잇 복원 | `notes:write` |
| `GET` | `/notes/{id}/related` | 의미 유사도 기반 연관 생각 목록 추천 | `notes:read` |
| `POST` | `/spaces/{id}/edges` | 두 포스트잇 간 연결선 생성 (`source`, `target`, `relation`) | `notes:write` |

### 🌙 Dream 검토함
| 메서드 | 경로 | 설명 | 권한 스코프 |
| :--- | :--- | :--- | :--- |
| `GET` | `/dreams` | 출처와 상태를 포함한 개인 Dream 검토함 조회 | `dreams:read` |
| `POST` | `/dreams/{id}/feedback` | 노출·채택·숨김 등의 무중복 피드백 기록 | `dreams:read` |
| `POST` | `/dreams/{id}/accept` | 후보를 Dream 메모와 출처 연결선으로 확정 | `dreams:read`, `notes:write` |
| `POST` | `/dreams/{id}/regenerate` | 같은 출처에서 중복되지 않는 다른 관점 생성 | `dreams:read` |
| `POST` | `/dreams/{id}/develop` | 확장·반대 관점·실행 항목으로 발전 | `dreams:read` |
| `POST` | `/dreams/{id}/developed-note` | 발전 결과를 새 메모와 `expanded` 연결선으로 원자 저장(동일 재시도 무중복) | `dreams:read`, `notes:write` |

`GET /notifications`의 각 항목에는 `resourceType`과 `resourceId`가 포함됩니다. Dream 알림은 `/dreams?focus={resourceId}`, 공간 공유 알림은 `/space/{resourceId}`로 연결할 수 있습니다.

### ⚡ 실시간 이벤트 스트림 (SSE)
- **경로**: `GET /api/v1/spaces/{spaceID}/events`
- **프로토콜**: Server-Sent Events (SSE)
- **이벤트 타입**: `space-change`
- **용도**: 타 사용자가 캔버스에서 포스트잇을 추가/수정/이동할 때 실시간 브로드캐스트 수신

---

## 3. Model Context Protocol (MCP) 엔드포인트

- **엔드포인트**: `POST /mcp`
- **인증**: `Authorization: Bearer <API_KEY>`
- **프로토콜**: JSON-RPC 2.0 (Stateless HTTP POST)

### 🛠️ 제공 도구 목록 (Tools)
1. `list_spaces`: 접근 가능한 공간 목록 조회
2. `list_notes`: 지정된 공간의 생각 포스트잇 및 연결선 조회
3. `create_note`: 캔버스에 새로운 생각 포스트잇 생성
4. `connect_notes`: 두 생각 간의 연결선 생성
5. `search_notes`: 지정 공간의 생각 검색
6. `get_related_notes`: 오프라인 유사도 기반 연관 생각 조회
7. `list_clusters`: 생각 군집 조회
8. `list_dreams`: 출처와 검토 상태를 포함한 최근 Dream 조회

### 💬 MCP 호출 예시 (JSON-RPC 2.0)

#### 요청: 생각 포스트잇 생성
```json
{
  "jsonrpc": "2.0",
  "id": "req-101",
  "method": "tools/call",
  "params": {
    "name": "create_note",
    "arguments": {
      "space_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "content": "MCP 엔드포인트를 통해 Cursor나 Claude에서 직접 생각을 붙이고 연결할 수 있습니다.",
      "color": "lavender",
      "x": 400,
      "y": 250
    }
  }
}
```

#### 응답
```json
{
  "jsonrpc": "2.0",
  "id": "req-101",
  "result": {
    "content": [
      {
        "type": "text",
        "text": "생각 포스트잇이 성공적으로 생성되었습니다. (ID: 9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d)"
      }
    ]
  }
}
```
