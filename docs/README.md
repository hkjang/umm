# umm 공식 문서 허브 (Documentation Hub)

`umm`은 생각을 문서나 폴더로 정리하기 전에 공간에 먼저 붙이고, 연결하고, 밤사이 **Dream**으로 다시 발견하는 **Spatial Thought Memory** 플랫폼입니다.

현재 문서 기준은 **v0.8.0**입니다. v0.7.0의 Today 리뷰, 하이브리드 검색·백링크, 댓글·멘션, 오프라인 동기화와 충돌 병합, 서명 웹훅, AI 평가, Prometheus/OpenTelemetry, master-key 회전과 공급망 증명에 더해, 푸시 기반 실시간 협업(LISTEN/NOTIFY), 인덱스를 타는 검색, 선택적 게이트웨이 임베딩, 로그인 잠금·요청 한도·AI 사용 한도, 응답별 CSP nonce와 로그인 기기 관리, English·다크 모드·마크다운 가져오기를 포함합니다.

---

## 📚 공식 기술 문서 (PDF 다운로드 & 바로보기)

> [!TIP]
> 모든 문서는 인쇄 및 가독성에 최적화된 **고품질 A4 PDF 문서**로 제공됩니다.

### 🌟 종합 완본
- 📕 **[umm 종합 기술 매뉴얼 완본 (Complete Manual PDF)](umm_complete_manual.pdf)**: 아키텍처, 전체 기능, 사용자 실무, 관리자 운영, API & MCP 가이드가 통합된 종합 기술 완본 (A4 인쇄용)
- 🎬 **[3분 서비스 소개 및 전체 기능 시연 영상 (MP4)](umm_overview.mp4)**: 3분 동안 전 메뉴 기능과 실무 동작을 설명하는 1080p FHD 시연 영상

### 1. 사용자 및 기능 가이드
- 📄 **[기능 및 화면 가이드 (PDF)](umm_features_guide.pdf)** (`docs/umm_features_guide.pdf`) · [MD](features.md)
  - 20여 개 전체 메뉴별 실제 구동 화면 캡처 및 세부 CRU 기능 명세
- 📄 **[사용자 실무 가이드 (PDF)](umm_user_guide.pdf)** (`docs/umm_user_guide.pdf`) · [MD](user-guide.md)
  - 무한 캔버스 조작, 포스트잇 단축키, 연관 생각, 인력(Gravity), 내보내기 가이드

### 2. 아키텍처 및 시스템 설계
- 📄 **[실행 아키텍처 및 불변 조건 (PDF)](umm_architecture.pdf)** (`docs/umm_architecture.pdf`) · [MD](ARCHITECTURE.md)
  - 단일 이미지 오프라인 구조, PostgreSQL 이벤트 스트림, n-gram 의미 분석, Dream 파이프라인
- 📄 **[보안 및 키 체계 (Markdown)](SECURITY.md)**
  - AES-256-GCM 봉투 암호화 및 Scoped Key 권한 모델

### 3. 관리자 및 운영 가이드
- 📄 **[관리자 운영 가이드 (PDF)](umm_admin_guide.pdf)** (`docs/umm_admin_guide.pdf`) · [MD](admin-guide.md)
  - 4대 환경변수 부트스트랩, Keycloak OIDC SSO 연동, Dream 스케줄러 & 256K 토큰, AI Gateway, 불변 감사 로그
- 📄 **[오프라인 배포 및 운영 가이드 (Markdown)](OPERATIONS.md)**
  - 단일 Docker 이미지 반입 및 패키지 릴리스 가이드

### 4. API & AI / MCP 연동
- 📄 **[API & MCP 연동 가이드 (PDF)](umm_api_guide.pdf)** (`docs/umm_api_guide.pdf`) · [MD](api-guide.md)
  - REST API 명세, SSE 실시간 동기화, Model Context Protocol(MCP) JSON-RPC 스펙
- 📄 **[OpenAPI 3.1 명세 (YAML)](openapi.yaml)**
  - REST API 공식 계약 스키마. CI가 라우터와 대조해 문서와 실제 API가 어긋나면 빌드를 실패시킵니다

### 5. 릴리스 노트
- 📄 **[v0.8.0 — 많아져도 버티는 umm](releases/v0.8.0.md)**
- 📄 **[v0.7.0 — 생각을 다시 만나고, 안전하게 협업하기](releases/v0.7.0.md)**

---

## 🚀 빠른 시작 (Quick Start)

```bash
# 1. 패키지 이미지 로드
gzip -dc umm-v0.8.0.tar.gz | docker load

# 2. 필수 환경변수 4개로 컨테이너 실행
docker run -d --name umm --restart unless-stopped \
  -p 8080:8080 \
  -e POSTGRES_DSN='postgres://umm:password@postgres.internal:5432/umm?sslmode=require' \
  -e BOOTSTRAP_ADMIN='admin' \
  -e BOOTSTRAP_ADMIN_PASSWORD='your-strong-admin-password' \
  -e ENCRYPTION_KEY='your-32-char-random-encryption-key' \
  umm:v0.8.0
```

- **접속 주소**: `http://localhost:8080` (초기 관리자 계정: `admin`)
- 선택 환경변수는 `ENCRYPTION_KEY_PREVIOUS`, `UMM_HTTP_ADDR`, 표준 `OTEL_EXPORTER_OTLP_*`입니다. 필수 환경변수는 네 개로 유지됩니다.
