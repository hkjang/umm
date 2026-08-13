# umm

`umm`은 생각을 문서나 폴더로 정리하기 전에 공간에 먼저 붙이고, 연결하고, 밤사이 Dream으로 다시 발견하는 **Spatial Thought Memory** 서비스입니다.

> 정리는 나중에. 생각부터 붙인다.

현재 버전은 `v0.1.0`입니다. 버전은 로그인 화면과 프로필 컨텍스트 메뉴에 함께 표시됩니다.

## 핵심 경험

- 빈 Canvas 더블클릭, `N`, `/`, Quick Capture로 즉시 포스트잇 생성
- 저장 버튼 없는 자동 저장, Drag/Resize, Zoom/Pan, 검색, 연결, 위치 Undo/Redo
- 미세한 종이 질감·안착 애니메이션과 Semantic Color
- 연결된 생각을 사용자가 요청할 때만 모으는 Thought Gravity
- Keycloak OIDC Discovery 기반 SSO와 역할/그룹 자동 매핑
- 서비스 관리자와 개인 설정의 명확한 분리
- 개인 API/MCP 키의 세부 scope 변경, 만료, 폐기, 중첩 시간 기반 회전
- 관리자 설정 시에만 나타나는 팀장 검토·승인·반려 흐름
- Dream Feature Toggle, 야간 Scheduler, 내부 AI Gateway, 품질 기준, 피드백, 비용/Token Dashboard
- 최신 stateless MCP와 REST API

## 기술 선택

- Backend: Go 1.26, chi, pgx, PostgreSQL
- Frontend: React 19, TypeScript, Vite, Mantine 9, React Flow
- UI: Mantine은 접근성 있는 폼·관리 화면을 빠르게 일관화하고, React Flow는 노드 선택·연결·Zoom/Pan에 필요한 검증된 상호작용 기반을 제공합니다. 서비스의 캐릭터는 별도의 warm-gray 토큰, Noto Sans KR 가변 폰트, 포스트잇 노드와 micro interaction으로 구현했습니다.
- Distribution: 단일 `umm:vX.Y.Z` Docker 이미지. React, 한글 폰트, 정적 자산을 모두 이미지에 포함하며 CDN을 사용하지 않습니다.

## 로컬 실행

Docker와 Docker Compose가 있다면 다음 명령으로 개발 구성을 실행할 수 있습니다.

```bash
docker compose up --build
```

브라우저에서 `http://localhost:8080`을 열고 `admin` / `change-this-before-production`으로 로그인합니다. 이 값은 개발 전용이므로 운영에 복사하지 마세요.

소스 개발:

```bash
go test ./...
npm --prefix web ci
npm --prefix web run dev
go run ./cmd/umm
```

Go 서버는 `:8080`, Vite는 `:5173`에서 실행되며 Vite가 `/api`와 `/mcp`를 프록시합니다.

## 런타임 환경변수

`umm`이 서비스 설정으로 받는 환경변수는 정확히 다음 네 개뿐입니다.

| 이름 | 용도 |
| --- | --- |
| `POSTGRES_DSN` | PostgreSQL 연결 문자열 |
| `BOOTSTRAP_ADMIN` | 최초 서비스 관리자 아이디 |
| `BOOTSTRAP_ADMIN_PASSWORD` | 최초 관리자 생성 시에만 사용하는 비밀번호 |
| `ENCRYPTION_KEY` | 관리자 비밀 설정을 암호화하는 32-byte 키. raw 32자, 64자 hex, base64 지원 |

그 밖의 OIDC, AI, Dream, workflow, 키 정책, 서비스 이름·URL·시간대 설정은 모두 **서비스 관리자 페이지**에서 관리합니다. 기존 DB에 이미 bootstrap 관리자가 있으면 컨테이너 재시작만으로 비밀번호가 덮어써지지 않습니다.

## 오프라인 배포

릴리스 자산 이름과 이미지 태그는 고정 규칙을 따릅니다.

```text
Docker image: umm:v0.1.0
Release file: umm-v0.1.0.tar.gz
```

연결망에서 GitHub Release의 `umm-vX.Y.Z.tar.gz` 한 파일을 반입한 뒤:

```bash
gzip -dc umm-v0.1.0.tar.gz | docker load
docker run -d --name umm --restart unless-stopped \
  -p 8080:8080 \
  -e POSTGRES_DSN='postgres://umm:...@postgres.internal:5432/umm?sslmode=require' \
  -e BOOTSTRAP_ADMIN='admin' \
  -e BOOTSTRAP_ADMIN_PASSWORD='긴-초기-비밀번호' \
  -e ENCRYPTION_KEY='base64-32-byte-key' \
  umm:v0.1.0
```

PostgreSQL은 운영 조직이 관리하는 기존 인스턴스를 사용합니다. Dream을 켜려면 오프라인망 내부의 OpenAI 호환 LLM Gateway를 관리자 페이지에서 지정합니다. AI와 Keycloak이 없어도 로컬 로그인과 Canvas 기능은 동작합니다.

상세 절차는 [오프라인 운영 가이드](docs/OPERATIONS.md), 보안 모델은 [보안·키 체계](docs/SECURITY.md)를 참고하세요.

## Keycloak 연결

1. Keycloak에서 `OpenID Connect`, Client authentication ON, Standard Flow ON인 confidential client를 만듭니다.
2. Valid redirect URI를 `https://<umm-host>/api/v1/auth/oidc/callback`으로 정확히 제한합니다.
3. umm 서비스 관리자 → 일반에서 공개 URL을 먼저 저장합니다.
4. 서비스 관리자 → Keycloak SSO에서 Issuer URL(`https://keycloak/realms/<realm>`), Client ID, Client Secret을 저장합니다.
5. 관리자/팀장으로 매핑할 Keycloak group 또는 realm role 이름을 입력하고 연결 시험을 실행합니다.

Discovery endpoint와 서명키는 Keycloak에서 자동으로 찾으며 Client Secret은 PostgreSQL에 AES-256-GCM 암호문으로만 저장됩니다.

## API와 MCP

- [OpenAPI 3.1](docs/openapi.yaml)
- [MCP 사용 가이드](docs/MCP.md)
- REST Base: `/api/v1`
- MCP: `/mcp`
- Health: `/healthz`, Readiness: `/readyz`

## 릴리스

로컬 산출물:

```bash
./scripts/release-image.sh 0.1.0
```

Git tag `v0.1.0`을 push하면 CI가 `VERSION` 일치 여부를 확인하고 `umm:v0.1.0`을 빌드한 뒤, Docker image만 담은 `umm-v0.1.0.tar.gz`를 GitHub Release에 첨부합니다.
