# umm 실행 아키텍처 및 불변 조건 (Architecture)

`umm`은 단일 Go 바이너리와 단일 PostgreSQL 인스턴스만으로 오프라인 폐쇄망에서 무중단 운영이 가능하도록 설계된 **Spatial Thought Memory** 엔진입니다.

---

## 1. 시스템 아키텍처 다이어그램

```
      ┌─────────────────────────────────────────────────────────────┐
      │               Browser (React 19 + Mantine 9)                │
      │        - Spatial Infinite Canvas (React Flow)               │
      │        - Optimistic Concurrency & Drag/Resize Undo/Redo     │
      │        - Real-time Space SSE Event Synchronization          │
      └──────────────┬──────────────────────────────▲───────────────┘
                     │ REST API (/api/v1)           │ Server-Sent Events
                     │ JSON-RPC 2.0 (/mcp)          │ (/spaces/:id/events)
      ┌──────────────▼──────────────────────────────┴───────────────┐
      │                    Go Application Daemon                    │
      │  - HTTP Router (chi) & Embedded Static Bundle               │
      │  - Optimistic Concurrency & N-gram Semantic Clustering      │
      │  - Dream Scheduler & Distributed Worker (SKIP LOCKED)       │
      │  - AES-256-GCM Envelope Encryption (Key Rotation)          │
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
- **Collaboration Domain**: `space_members`, `space_events`, `notifications`
- **Identity & Access**: `users`, `sessions`, `oauth_states`, `teams`
- **Personalization**: `user_preferences`, `api_keys`
- **Governance & Security**: `approval_requests`, `audit_logs`, `app_settings`
- **Dream & LLM Domain**: `dream_jobs`, `dream_notes`, `dream_sources`, `dream_feedback`, `ai_calls`

---

## 3. 핵심 아키텍처 원칙

### 1. 외부 의존성 없는 의미 연관성 분석 (Offline Semantic Engine)
- 연관 생각(Related Thoughts)과 클러스터링은 **192차원 문자 n-gram feature hashing과 cosine similarity**를 통해 데이터베이스 내부에서 고속 연산됩니다.
- 외부 임베딩 모델 다운로드나 API 호출이 전혀 필요 없어 오프라인 폐쇄망에서도 100% 정상 작동합니다.

### 2. 낙관적 동시성 제어 (Optimistic Concurrency Control)
- 각 생각 노드는 단조 증가하는 `version` 번호를 가집니다.
- 다중 사용자가 동시에 작업하더라도 버전 충돌을 안전하게 감지하고 유실을 방지합니다.

### 3. 분산 큐 & DB 트랜잭션 (SKIP LOCKED)
- 외부 메시지 브로커(RabbitMQ, Redis 등) 없이 PostgreSQL의 `FOR UPDATE SKIP LOCKED`를 활용하여 Dream 백그라운드 작업을 분산 워커 간 중복 없이 안전하게 임대(Lease) 처리합니다.
