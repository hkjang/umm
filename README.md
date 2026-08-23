<div align="center">

# umm (Spatial Thought Memory)

<p>
  <img src="https://img.shields.io/badge/Go-1.26-00ADD8?style=flat-square&logo=go&logoColor=white" alt="Go 1.26" />
  <img src="https://img.shields.io/badge/React-19-61DAFB?style=flat-square&logo=react&logoColor=black" alt="React 19" />
  <img src="https://img.shields.io/badge/PostgreSQL-17-4169E1?style=flat-square&logo=postgresql&logoColor=white" alt="PostgreSQL" />
  <img src="https://img.shields.io/badge/Mantine-9-339AF0?style=flat-square&logo=mantine&logoColor=white" alt="Mantine 9" />
  <img src="https://img.shields.io/badge/Docker-Ready-2496ED?style=flat-square&logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/MCP-JSON--RPC%202.0-8A2BE2?style=flat-square" alt="MCP" />
  <img src="https://img.shields.io/badge/Release-v0.22.0-success?style=flat-square" alt="v0.22.0" />
</p>

<h3>정리는 나중에. 생각부터 붙인다.</h3>

<p align="center">
  <b>umm</b>은 생각을 문서나 폴더로 정리하기 전에 공간에 먼저 붙이고, 연결하고,<br>
  밤사이 <b>Dream</b>으로 다시 발견하는 <b>Spatial Thought Memory</b> 서비스입니다.
</p>

[**🎬 3분 서비스 소개 영상 (MP4)**](docs/umm_overview.mp4) · [**📕 종합 기술 매뉴얼 완본 (PDF)**](docs/umm_complete_manual.pdf) · [**🌐 인터랙티브 웹 쇼케이스**](docs/index.html) · [**📚 문서 허브**](docs/README.md)

</div>

---

## v0.32.0 — 캔버스가 1MB씩 그대로 나가고 있었습니다

- **압축이 걸려 있지 않았습니다**: `Accept-Encoding: gzip`을 보내도 1,017,041 바이트가 그대로 왔습니다.
- **기본 설치는 umm을 직접 노출합니다**: 앞에 프록시가 없으니 압축해 줄 것도 없습니다.
- **1,017,041 → 65,424 바이트 (15.5배)**: 요청하지 않은 클라이언트는 그대로 받습니다.
- **첫 시도는 스크립트를 놓쳤습니다**: `.js`의 실제 타입은 `text/javascript`인데 목록에는 `application/javascript`만 있었습니다. 첫 화면 자산 **916,624 → 252,884 바이트**.
- **갓 만든 비밀이 담긴 네 경로는 압축하지 않습니다**: 길이를 관찰하며 반영 내용을 바꿀 수 있으면 압축은 BREACH의 형태가 됩니다.

이전 릴리스: [v0.31.2](docs/releases/v0.31.2.md) · [v0.31.1](docs/releases/v0.31.1.md) · [v0.31.0](docs/releases/v0.31.0.md) · [v0.30.1](docs/releases/v0.30.1.md) · [v0.30.0](docs/releases/v0.30.0.md) · [v0.29.1](docs/releases/v0.29.1.md) · [v0.29.0](docs/releases/v0.29.0.md) · [v0.28.1](docs/releases/v0.28.1.md) · [v0.28.0](docs/releases/v0.28.0.md) · [v0.27.1](docs/releases/v0.27.1.md) · [v0.27.0](docs/releases/v0.27.0.md) · [v0.26.0](docs/releases/v0.26.0.md) · [v0.25.0](docs/releases/v0.25.0.md) · [v0.24.0](docs/releases/v0.24.0.md) · [v0.23.0](docs/releases/v0.23.0.md) · [v0.22.0](docs/releases/v0.22.0.md) · [v0.21.0](docs/releases/v0.21.0.md) · [v0.20.0](docs/releases/v0.20.0.md) · [v0.19.0](docs/releases/v0.19.0.md) · [v0.18.0](docs/releases/v0.18.0.md) · [v0.17.0](docs/releases/v0.17.0.md) · [v0.16.0](docs/releases/v0.16.0.md) · [v0.15.0](docs/releases/v0.15.0.md) · [v0.14.0](docs/releases/v0.14.0.md) · [v0.13.0](docs/releases/v0.13.0.md) · [v0.12.0](docs/releases/v0.12.0.md) · [v0.11.0](docs/releases/v0.11.0.md) · [v0.10.0](docs/releases/v0.10.0.md) · [v0.9.0](docs/releases/v0.9.0.md) · [v0.8.1](docs/releases/v0.8.1.md)

---

## 📸 주요 화면 둘러보기

<div align="center">

### 🌌 무한 생각 캔버스 & 포스트잇 연결
![무한 생각 캔버스](docs/screenshots/02_canvas_overview.png)

### 🪐 Thought Gravity & 원형 궤도 정렬
![Thought Gravity](docs/screenshots/05_thought_gravity.png)

<details>
<summary><b>👉 더 많은 기능 화면 스크린샷 접기/펼치기</b></summary>
<br/>

| 화면명 | 캡처 이미지 | 설명 |
| :--- | :--- | :--- |
| **로그인 & OIDC SSO** | ![로그인](docs/screenshots/01_login.png) | 부트스트랩 관리자 및 Keycloak SSO 인증 |
| **포스트잇 편집** | ![메모 편집](docs/screenshots/03_note_editing.png) | 7가지 파스텔 컬러, 크기 조절, 자동 저장 |
| **버전 복원 모달** | ![버전 복원](docs/screenshots/04_note_history_modal.png) | 과거 시점 스냅샷 안전 복원 |
| **공간 관리자** | ![공간 관리](docs/screenshots/08_space_manager_modal.png) | 공간 생성, 검색, 이름 변경, 삭제 |
| **공간 협업 공유** | ![공간 공유](docs/screenshots/09_space_share_modal.png) | 팀원 초대 및 세분화된 권한 제어 |
| **Dream 검토함** | ![Dreams](docs/screenshots/12_dreams_timeline.png) | 출처를 확인하고 채택·재생성·발전시키는 AI 인사이트 |
| **개인화 설정** | ![개인 설정](docs/screenshots/13_personal_settings.png) | Dream 주기 설정 및 연결선 스타일 |
| **개인 API/MCP 키** | ![API 키](docs/screenshots/15_api_keys_list.png) | 최소 권한 Scoped 키 발급 및 무중단 회전 |
| **검토 및 승인** | ![승인](docs/screenshots/16_approvals_list.png) | 공간 공유/내보내기 팀장 결재 대기열 |
| **관리자: 운영 현황** | ![운영 현황](docs/screenshots/17_admin_overview.png) | 실시간 KPI 및 Dream 비용 분석 |
| **관리자: 256K Dream** | ![Dream 설정](docs/screenshots/20_admin_dream.png) | 256K 토큰 한도 제어 & 품질 기준선 |
| **관리자: 감사 로그** | ![감사 로그](docs/screenshots/25_admin_audit.png) | 불변 추가 전용(Append-only) 추적 |

</details>

</div>

---

## 🏗️ 시스템 아키텍처

```
      ┌─────────────────────────────────────────────────────────────┐
      │               Browser (React 19 + Mantine 9)                │
      │        - Today Review + Spatial Canvas + PWA Offline Queue  │
      │        - Korean/English, Light/Dark, Markdown Import        │
      │        - Comments, Mentions & Visual Conflict Resolution    │
      │        - Real-time Space SSE Event Synchronization          │
      └──────────────┬──────────────────────────────▲───────────────┘
                     │ REST API (/api/v1)           │ Server-Sent Events
                     │ JSON-RPC 2.0 (/mcp)          │ (/spaces/:id/events)
      ┌──────────────▼──────────────────────────────┴───────────────┐
      │                    Go Application Daemon                    │
      │  - HTTP Router (chi) & Embedded Static Bundle               │
      │  - Realtime Hub (LISTEN/NOTIFY fan-out, no per-user polls)  │
      │  - Indexed Hybrid Search (pg_trgm) & Pluggable Embeddings   │
      │  - Rate Limits, Shared Login Lockout & Per-Response CSP     │
      │  - Dream Scheduler & Distributed Worker (SKIP LOCKED)       │
      │  - Signed Webhooks, Metrics, Traces & AES-GCM Keyring       │
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
      │  - comments / mentions / events (실시간 협업)               │
      │  - dream_jobs / ai_eval_runs (생성·평가·피드백)             │
      │  - webhooks / audit_logs (자동화·불변 거버넌스)             │
      │  - sessions / login_attempts (기기 관리·공유 잠금)          │
      └─────────────────────────────────────────────────────────────┘
```

---

## 📖 공식 기술 문서 (PDF)

| 문서명 | 설명 | PDF 다운로드 / 바로보기 |
| :--- | :--- | :--- |
| **📕 종합 기술 매뉴얼 완본** | 모든 아키텍처·기능·운영·API 통합 기술 완본 (A4 인쇄용) | [**docs/umm_complete_manual.pdf**](docs/umm_complete_manual.pdf) |
| **🎬 3분 서비스 시연 영상** | 전 메뉴 기능 및 실무 동작 1080p 시연 영상 | [**docs/umm_overview.mp4**](docs/umm_overview.mp4) |
| **📸 기능 및 화면 가이드** | 20여 개 전체 메뉴별 캡처 스크린샷과 CRU 동작 가이드 | [**PDF 바로보기**](docs/umm_features_guide.pdf) · [MD](docs/features.md) |
| **👤 사용자 실무 가이드** | 무한 캔버스 조작, 포스트잇 단축키, 연관 생각, 내보내기 | [**PDF 바로보기**](docs/umm_user_guide.pdf) · [MD](docs/user-guide.md) |
| **🛠️ 관리자 운영 가이드** | Keycloak OIDC SSO, 256K Dream Layer, AI Gateway, 감사 로그 | [**PDF 바로보기**](docs/umm_admin_guide.pdf) · [MD](docs/admin-guide.md) |
| **🔌 API & MCP 가이드** | REST API 명세, SSE 실시간 스트림, AI MCP JSON-RPC | [**PDF 바로보기**](docs/umm_api_guide.pdf) · [MD](docs/api-guide.md) |
| **🏗️ 실행 아키텍처** | 단일 이미지 오프라인 구조, PostgreSQL 이벤트 스트림 | [**PDF 바로보기**](docs/umm_architecture.pdf) · [MD](docs/ARCHITECTURE.md) |
| **🌐 웹 쇼케이스** | 인터랙티브 깃허브 홍보 및 기능 둘러보기 웹페이지 | [**쇼케이스 열기**](docs/index.html) |
| **📚 문서 허브** | 전체 공식 기술 문서 목차 및 시작 가이드 | [**문서 허브 열기**](docs/README.md) |

---

## 🚀 빠른 시작 (Quick Start)

`umm`이 런타임으로 요구하는 환경변수는 정확히 4개뿐입니다:

```bash
docker run -d --name umm --restart unless-stopped \
  -p 8080:8080 \
  -e POSTGRES_DSN='postgres://umm:password@postgres.internal:5432/umm?sslmode=require' \
  -e BOOTSTRAP_ADMIN='admin' \
  -e BOOTSTRAP_ADMIN_PASSWORD='your-strong-password' \
  -e ENCRYPTION_KEY='your-32-char-random-encryption-key' \
  umm:v0.22.0
```

- 접속 주소: `http://localhost:8080` (초기 관리자 계정: `admin`)
- 선택 환경변수: `ENCRYPTION_KEY_PREVIOUS`(키 회전), `UMM_HTTP_ADDR`(바인드 주소), `UMM_TRUSTED_PROXY_CIDRS`(신뢰할 reverse proxy IP/CIDR), 표준 `OTEL_EXPORTER_OTLP_*`(trace 전송). 필수 입력은 위 네 개로 유지됩니다. 프록시 목록을 비우면 전달 헤더는 모두 무시됩니다.
- 데이터베이스 사용자에게 `CREATE EXTENSION` 권한이 필요합니다 (`pgcrypto`, `citext`, `pg_trgm`).
