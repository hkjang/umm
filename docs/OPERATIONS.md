# Offline operations

## 준비물

- `umm-vX.Y.Z.tar.gz`
- PostgreSQL 14 이상과 전용 database/user
- Docker Engine 24 이상
- 서비스 TLS reverse proxy
- 선택: 같은 폐쇄망의 Keycloak, OpenAI 호환 AI Gateway

이미지는 애플리케이션 binary, React UI, 한글 webfont, timezone, CA certificate를 모두 포함합니다. 실행 중 package registry나 CDN에 접근하지 않습니다.

## 설치

```bash
./scripts/load-offline.sh umm-v0.2.0.tar.gz
docker image inspect umm:v0.2.0
```

PostgreSQL user는 대상 database에 schema/table/extension을 생성할 권한이 필요합니다. 시작 시 embedded migration이 transaction으로 실행됩니다.

32-byte encryption key는 연결망 밖의 승인된 비밀 관리 절차로 생성합니다. 예: `openssl rand -base64 32`. Shell history, compose file, ticket, Git에 실제 값을 남기지 마세요.

실행에 전달하는 서비스 환경변수는 다음 네 개뿐입니다.

```text
POSTGRES_DSN
BOOTSTRAP_ADMIN
BOOTSTRAP_ADMIN_PASSWORD
ENCRYPTION_KEY
```

컨테이너는 non-root `umm` 사용자, 고정 포트 `8080`으로 실행됩니다. `/healthz`는 프로세스, `/readyz`는 PostgreSQL 연결을 검사합니다.

## 최초 설정 순서

1. bootstrap 관리자 로그인 후 서비스 관리자 → 일반에서 서비스 이름, 공개 URL, `Asia/Seoul` 같은 IANA 시간대를 저장합니다.
2. 보안 → 허용 API/MCP scope, 기본 만료, 회전 중첩 시간을 확인합니다.
3. 필요할 때만 Keycloak SSO를 저장하고 연결 시험 후 활성화합니다.
4. 필요할 때만 AI Gateway를 저장합니다.
5. Dream은 Gateway 확인 뒤 기능과 자동 생성을 각각 활성화합니다.
6. 승인 흐름이 실제로 필요한 작업만 검토 프로세스에서 선택합니다. OFF일 때는 승인 UI/API 단계가 생기지 않습니다.

## Upgrade와 rollback

업그레이드 전에 PostgreSQL snapshot/backup을 만들고 현재 `ENCRYPTION_KEY`를 별도 비밀 저장소에서 확인합니다.

```bash
gzip -dc umm-v0.2.0.tar.gz | docker load
docker stop umm
# 동일한 네 환경변수와 DB로 umm:v0.2.0 실행
```

Schema migration은 forward-only입니다. 새 버전 실행 후 schema가 변경되었다면 image만 이전 버전으로 되돌리는 것으로 충분하지 않을 수 있으므로, rollback은 DB snapshot 복원과 함께 수행합니다.

## Backup

- 매일 PostgreSQL logical/physical backup
- `ENCRYPTION_KEY`는 DB와 분리된 비밀 저장소에 backup
- 복구 훈련에서 로그인, note 수, OIDC secret decrypt, API key digest 인증을 확인
- API/MCP secret은 복호화할 수 없으므로 복구 후 문제가 있으면 회전

## Dream 장애

AI Gateway 오류는 retry 후 failed job과 `ai_calls`에 기록됩니다. 일반 Canvas는 계속 동작합니다. 장애가 길어지면 관리자에서 자동 생성을 OFF하고, 복구 후 “지금 큐 생성”을 실행합니다. 품질 기준 미달은 failure가 아니라 skip이며 사용자에게 빈 Dream을 억지로 노출하지 않습니다.

## Release 규칙

`VERSION`이 `0.2.0`이면 tag는 `v0.2.0`, image는 `umm:v0.2.0`, GitHub asset은 `umm-v0.2.0.tar.gz`입니다. Release workflow는 세 값이 다르면 중단합니다. Release에는 서비스 Docker image tarball만 첨부합니다.
