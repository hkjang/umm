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

## v0.40.0 — 에이전트도 생각을 발표로 만들 수 있습니다

MCP 도구 세 개가 늘어, `search_notes → get_connections → preview_presentation → make_presentation` 흐름이 umm 안에서 끝납니다.

- **읽을 수 있다고 만들 수 있는 건 아닙니다**: 보는 것은 `notes:read`, 만드는 것은 `notes:write`. 읽기만 되는 키가 주인의 생각을 다른 서비스로 보내 무언가를 만들 수 있으면 안 됩니다. 실제 MCP로 키 두 개를 만들어 확인했습니다.
- **이게 요약기가 아니라는 걸 도구 설명이 말합니다**: 에이전트는 설명을 읽고 도구를 고릅니다. 그 문구가 사라지면 테스트가 실패합니다.
- **지난주 버그를 다시 내지 않았습니다**: MCP 인자도 없는 키가 문자열 `"<nil>"`이 되는 같은 함정이 있습니다.

## v0.39.0 — 발표 자료가 언제 사실이 아니게 되는지 알려 줍니다

생각으로 만든 발표는 그 생각이 바뀌는 순간 사실이 아니게 됩니다. 어느 생각이 어느 슬라이드에 있는지 아는 건 umm뿐입니다.

- **명백해 보이는 신호가 틀린 신호였습니다**: 노트의 `version`은 **메모를 끌어서 옮기기만 해도** 오릅니다(x·y·크기가 같은 문장에 있습니다). 그걸 썼다면 모든 발표 자료가 영구히 "낡음"이 되고, 늘 켜져 있는 경고는 경고가 아닙니다.
- **그래서 문장의 지문을 봅니다**: 옮기면 안 바뀌고 고쳐 쓰면 바뀝니다. 브라우저에서 확인했습니다 — 생각을 고쳐 쓰면 `슬라이드 1장 바뀜`, **공간의 모든 메모를 옮겨도** 변화 없음.
- **고쳐 쓴 것과 지운 것은 다릅니다**: 하나는 슬라이드를 최신으로 만들 수 있고, 다른 하나는 출처 자체를 잃었습니다.
- **모르는 것을 낡았다고 하지 않습니다**: 업그레이드하는 날 모든 발표 자료에 경고가 켜지면 그 경고는 시작하자마자 무의미해집니다.

## v0.38.0 — 생각을 발표 자료로, 내가 쓴 문장 그대로

umm이 [Ptium](https://github.com/hkjang/ptium)으로 발표 자료를 만듭니다. "PPT 만들기" 버튼이 아니라 **생각 그래프를 발표 구성으로 컴파일**하는 것입니다.

- **모델이 다시 쓰지 않습니다**: Ptium의 `prompt`(12000자, 모델이 새로 씀) 대신 **덱 소스**로 컴파일합니다. 내 문장이 한 글자도 안 바뀌고 슬라이드에 올라가고, 같은 공간은 항상 같은 덱이 됩니다. umm은 Ptium에 prompt를 **한 번도 보내지 않습니다.**
- **기록해 둔 관계가 그대로 구조**입니다: `follows`→순서, `supports`→근거, `answers`→질문 내용, **`contradicts`→비교 슬라이드**. 의견 충돌을 지우지 않고 기록해 두는 umm이라야 나오는 슬라이드입니다.
- **만들기 전에 봅니다**: 순서·묶음·문장을 읽고, 덱이 아니라 생각이 사는 공간에서 고칩니다. `레이아웃 미확인`을 숨기지 않습니다.
- **슬라이드가 출처를 말합니다**: 어느 생각에서 왔는지, 이 생각이 어느 발표에 쓰였는지 양방향으로.
- **테스트가 못 잡은 결함 넷을 실제로 해 보고 찾았습니다**: 덱 순서가 엉망이었고, 미리보기가 덱에 없을 줄을 보여 줬고, 관리자가 Ptium 주소를 저장할 수 없었고, 진짜 Ptium에 붙였더니 암호문을 토큰으로 보내 401이었습니다.

## v0.37.1 — 한국어에서 1px 차이로 안 보이던 것

- **영어에서 배지가 카드 밖으로 68px 나갔습니다**: 가장 작은 메모에 표시 세 개가 붙으면 배지 줄이 207px인데 들어갈 자리는 138px이었습니다. 한국어는 139 대 138, **1px 차이로 맞아서** 개발하는 언어에서는 멀쩡해 보였습니다.
- **카드를 세로 흐름으로 바꿨습니다**: 글 위에 있는 것이 글을 덮는 대신 밀어내고, 배지는 자리가 없으면 다음 줄로 접힙니다.
- **바꾸고 나니 DOM 순서가 드러났습니다**: 배지 블록이 `textarea` 뒤에 있어 글 아래로 내려갔습니다. 숫자만 봤다면 "카드 안에 있음"으로 통과했을 것을 화면을 보고 잡았습니다.
- **이 조합만 드러냅니다**: 영어 + 최소 크기 + 표시 세 개가 동시에 있어야 보입니다. 새 테스트는 그 조합을 고집하고, 줄의 상자가 아니라 배지 자체 좌표를 잽니다.

## v0.37.0 — 보이는 것보다 안 보이는 것이 더 많았습니다

- **179자를 적었는데 169px이 화면 밖에 있었습니다**: 카드 높이는 168px. 보이는 것보다 안 보이는 쪽이 더 컸고, 글자 중간에 끊긴 채 더 있다는 표시가 없었습니다. 이제 `+7줄`처럼 남은 분량을 말하고, 누르면 생각 전체가 들어갈 때까지 넓어집니다.
- **누를 때만 넓어집니다**: 메모 크기는 그 사람이 정한 것이라, 넘치는 순간 제멋대로 커지지 않고 더 있다고 말하고 기다립니다.
- **표시했는데 표시가 안 보였습니다**: `질문으로 표시`·`Dream 분석에서 제외`가 카드에 흔적을 남기지 않아, 표시한 사람만 기억하는 표시였습니다. 이제 배지로 보입니다.
- **색상 스와치는 멀쩡했습니다**: 전부 회색일 거라 의심했지만 확인해 보니 변수가 실제로 있었습니다 — 멀쩡한 코드를 건드리지 않았습니다.
- **테스트의 결함 둘을 되돌리기가 잡았습니다**: `textarea[value^=…]`는 React 제어 값을 못 찾아 공허하게 통과하고 있었고, 카드 높이를 화면 픽셀로 비교하니 배율 때문에 `1091px` vs `642px`가 나왔습니다.

이전 릴리스: [v0.39.0](docs/releases/v0.39.0.md) · [v0.38.0](docs/releases/v0.38.0.md) · [v0.37.1](docs/releases/v0.37.1.md) · [v0.37.0](docs/releases/v0.37.0.md) · [v0.36.0](docs/releases/v0.36.0.md) · [v0.35.0](docs/releases/v0.35.0.md) · [v0.34.4](docs/releases/v0.34.4.md) · [v0.34.3](docs/releases/v0.34.3.md) · [v0.34.2](docs/releases/v0.34.2.md) · [v0.34.1](docs/releases/v0.34.1.md) · [v0.34.0](docs/releases/v0.34.0.md) · [v0.33.2](docs/releases/v0.33.2.md) · [v0.33.1](docs/releases/v0.33.1.md) · [v0.33.0](docs/releases/v0.33.0.md) · [v0.32.2](docs/releases/v0.32.2.md) · [v0.32.1](docs/releases/v0.32.1.md) · [v0.32.0](docs/releases/v0.32.0.md) · [v0.31.2](docs/releases/v0.31.2.md) · [v0.31.1](docs/releases/v0.31.1.md) · [v0.31.0](docs/releases/v0.31.0.md) · [v0.30.1](docs/releases/v0.30.1.md) · [v0.30.0](docs/releases/v0.30.0.md) · [v0.29.1](docs/releases/v0.29.1.md) · [v0.29.0](docs/releases/v0.29.0.md) · [v0.28.1](docs/releases/v0.28.1.md) · [v0.28.0](docs/releases/v0.28.0.md) · [v0.27.1](docs/releases/v0.27.1.md) · [v0.27.0](docs/releases/v0.27.0.md) · [v0.26.0](docs/releases/v0.26.0.md) · [v0.25.0](docs/releases/v0.25.0.md) · [v0.24.0](docs/releases/v0.24.0.md) · [v0.23.0](docs/releases/v0.23.0.md) · [v0.22.0](docs/releases/v0.22.0.md) · [v0.21.0](docs/releases/v0.21.0.md) · [v0.20.0](docs/releases/v0.20.0.md) · [v0.19.0](docs/releases/v0.19.0.md) · [v0.18.0](docs/releases/v0.18.0.md) · [v0.17.0](docs/releases/v0.17.0.md) · [v0.16.0](docs/releases/v0.16.0.md) · [v0.15.0](docs/releases/v0.15.0.md) · [v0.14.0](docs/releases/v0.14.0.md) · [v0.13.0](docs/releases/v0.13.0.md) · [v0.12.0](docs/releases/v0.12.0.md) · [v0.11.0](docs/releases/v0.11.0.md) · [v0.10.0](docs/releases/v0.10.0.md) · [v0.9.0](docs/releases/v0.9.0.md) · [v0.8.1](docs/releases/v0.8.1.md)

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
