# umm 실행 아키텍처 및 불변 조건 (Architecture)

`umm`은 단일 Go 바이너리와 단일 PostgreSQL 인스턴스만으로 오프라인 폐쇄망에서 무중단 운영이 가능하도록 설계된 **Spatial Thought Memory** 엔진입니다.

---

## 1. 시스템 아키텍처 다이어그램

```
      ┌─────────────────────────────────────────────────────────────┐
      │               Browser (React 19 + Mantine 9)                │
      │        - Today Review + Spatial Infinite Canvas + PWA      │
      │        - Offline Queue, Comments & Conflict Merge           │
      │        - Real-time Space SSE Event Synchronization          │
      └──────────────┬──────────────────────────────▲───────────────┘
                     │ REST API (/api/v1)           │ Server-Sent Events
                     │ JSON-RPC 2.0 (/mcp)          │ (/spaces/:id/events)
      ┌──────────────▼──────────────────────────────┴───────────────┐
      │                    Go Application Daemon                    │
      │  - HTTP Router (chi) & Embedded Static Bundle               │
      │  - Hybrid Search, Backlinks & N-gram Semantic Clustering    │
      │  - Dream Scheduler & Distributed Worker (SKIP LOCKED)       │
      │  - Signed Webhooks, OTel, Metrics & AES-GCM Keyring         │
      └──────────────┬──────────────────────────────┬───────────────┘
                     │                              │ OpenAI Compatible
                     │                              ▼
                     │                 ┌────────────────────────────┐
                     │                 │     Internal AI Gateway    │
                     │                 │   (vLLM / Ollama / TGI)    │
                     │                 └────────────────────────────┘
      ┌──────────────▼──────────────────────────────────────────────┐
      │                     PostgreSQL Database                     │
      │  - spaces / notes / note_edges (캔버스 데이터)              │
      │  - note_revisions / note_embeddings (버전 & 연관 분석)       │
      │  - space_members / space_events (실시간 협업)               │
      │  - dream_jobs / dream_notes (야간 비동기 큐 & 피드백)        │
      │  - approval_requests / audit_logs (불변 거버넌스)           │
      └─────────────────────────────────────────────────────────────┘
```

---

## 2. 데이터 경계 및 도메인 분리

- **Canvas Domain**: `spaces`, `notes`, `note_edges`
- **Intelligence Domain**: `note_revisions`, `note_embeddings`
- **Collaboration Domain**: `space_members`, `space_events`, `notifications`, `note_comments`, `comment_mentions`
- **Identity & Access**: `users`, `sessions`, `oauth_states`, `teams`
- **Personalization & Review**: `user_preferences`, `note_reviews`, `api_keys`
- **Governance & Security**: `approval_requests`, `audit_logs`, `app_settings`
- **Dream & LLM Domain**: `dream_jobs`, `dream_notes`, `dream_sources`, `dream_feedback`, `ai_calls`, `ai_eval_cases`, `ai_eval_runs`
- **Automation & Reliability**: `webhook_subscriptions`, `webhook_deliveries`, `idempotency_records`, `product_events`

---

## 3. 핵심 아키텍처 원칙

### 1. 외부 의존성 없는 의미 연관성 분석 (Offline Semantic Engine)
- 연관 생각(Related Thoughts)과 클러스터링은 **192차원 문자 n-gram feature hashing과 cosine similarity**를 통해 데이터베이스 내부에서 고속 연산됩니다.
- 외부 임베딩 모델 다운로드나 API 호출이 전혀 필요 없어 오프라인 폐쇄망에서도 100% 정상 작동합니다.

### 2. 낙관적 동시성 제어 (Optimistic Concurrency Control)
- 각 생각 노드는 단조 증가하는 `version` 번호를 가집니다.
- 다중 사용자가 동시에 작업하더라도 버전 충돌을 감지하고 409 Problem Details에 최신 서버 메모를 포함합니다. 브라우저는 내 변경과 서버 변경을 나란히 보여 주고 선택·병합한 뒤 새 버전으로 저장합니다.
- 오프라인 변경은 PWA local queue에 멱등 키와 함께 보관됩니다. 재연결 시 안전한 순서로 replay하고 같은 메모의 연속 PUT은 마지막 상태로 합칩니다.

### 3. 분산 큐 & DB 트랜잭션 (SKIP LOCKED)
- 외부 메시지 브로커(RabbitMQ, Redis 등) 없이 PostgreSQL의 `FOR UPDATE SKIP LOCKED`를 활용하여 Dream 백그라운드 작업을 분산 워커 간 중복 없이 안전하게 임대(Lease) 처리합니다.
- 생성된 Dream은 `dream_notes.note_id IS NULL`인 검토 후보로 먼저 저장됩니다. 채택 요청은 행 잠금 트랜잭션 안에서 메모와 `dreamed` 연결선을 한 번만 생성하므로 네트워크 재시도에도 중복되지 않습니다. 채택 후 발전 결과도 같은 Dream 행 잠금 아래 새 메모와 `expanded` 연결선을 원자적으로 만들며, 동일 본문 재시도는 기존 결과를 반환합니다.
- Dream 노출 피드백은 목록 응답 시점이 아니라 브라우저 `IntersectionObserver`에서 카드가 50% 이상 보인 시점에 기록됩니다. 알림의 `resourceType/resourceId`는 Dream 카드 또는 공유 공간 딥링크로 해석됩니다.
- 공간·메모의 `ai_excluded` 정책은 Scheduler 자격 계산과 AI 호출 직전에 모두 적용되어, 설정 변경 이후의 신규 AI 처리에서 제외됩니다.

### 4. Daily review와 하이브리드 탐색

- `/today`는 14일 이상 검토하지 않은 생각, 사용자가 지정한 다시 보기, 연결선이 없는 생각, 대기 Dream, 최근 댓글을 권한 범위 안에서 집계합니다. `note_reviews`가 공유 메모의 검토·고정 상태를 사용자별로 분리합니다.
- 검색은 완전 로컬 192차원 feature-hash cosine 점수와 제목·본문·공간 키워드 점수를 결합합니다. 공간·종류·수정 시각 필터와 opaque cursor를 지원합니다.
- 백링크는 실제 `note_edges`의 incoming/outgoing 방향을 반환하며 연관 생각은 의미 유사성을 보완합니다.

### 5. 자동화·관측성·공급망

- 공간 이벤트는 PostgreSQL SSE log에 먼저 저장된 뒤 bounded in-memory webhook queue로 전달됩니다. 웹훅은 HMAC 서명, SSRF 재검증, 제한 재시도와 자동 중지를 적용합니다.
- HTTP 계층은 low-cardinality route pattern으로 Prometheus count·latency를 기록합니다. 표준 OTLP 환경변수가 있을 때만 OpenTelemetry exporter를 초기화합니다.
- 태그 파이프라인은 offline image archive와 SPDX SBOM을 만들고 checksum 및 GitHub artifact attestation을 발급합니다.
