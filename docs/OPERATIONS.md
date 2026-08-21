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
sha256sum -c SHA256SUMS
./scripts/load-offline.sh umm-v0.8.1.tar.gz
docker image inspect umm:v0.8.1
```

PostgreSQL user는 대상 database에 schema/table/extension을 생성할 권한이 필요합니다(`pgcrypto`, `citext`, `pg_trgm`). 시작 시 embedded migration이 transaction으로 실행됩니다.

인스턴스는 여유가 있을 때 협업 이벤트 수신용 PostgreSQL 연결 하나를 request pool 안에서 상시 점유합니다. 이 pool의 자동 최대값은 host CPU 수와 무관하게 인스턴스당 16이며 제공 compose도 이를 명시합니다. Replica 수와 PostgreSQL `max_connections`를 함께 계산해 DSN의 `pool_max_conns`를 조정하세요. 외부 호출 동안 권한 행을 잠그는 transaction은 request pool 밖의 별도 연결을 사용하며, AI Assist·자동 Dream·재생성·발전은 인스턴스당 최대 2개, 웹훅 전달은 워커 수와 같은 최대 3개로 각각 제한됩니다. 따라서 PostgreSQL 전역 예산은 replica마다 최악의 경우 `pool_max_conns + 5`로 계산해야 합니다. 이 연결은 호출 중에만 열리고 각 상한을 넘는 lease는 slot이 반환될 때까지 DB 연결 없이 대기하므로, 느린 Gateway나 웹훅 수신기가 readiness·인증·Canvas 요청 pool을 고갈시키지 않습니다.

더 작은 `pool_max_conns`를 명시해도 내부 `pool_min_conns`가 최대값을 넘어 시작에 실패하지 않도록 cap합니다. `pool_max_conns`가 1 또는 2이면 전용 `LISTEN`을 비활성화하고 SSE가 1초 안전 폴링을 사용해 request pool의 모든 연결을 readiness·인증·transaction 요청에 남깁니다. 상한 3부터 listener를 시작하면서 request 연결 두 자리를 보존합니다. 실행 중 listener가 끊기거나 복구되면 상태 전환 신호가 열린 SSE를 즉시 깨워 1초 폴링 또는 30초 safety net으로 타이머를 다시 맞추므로, 단절 직전 설정된 긴 deadline을 기다리지 않습니다. 알림 목록은 한 request 연결에서 unread count와 page를 순차 실행하고 짧은 Dream 채택 transaction도 연결을 중첩 점유하지 않습니다. 동시 처리량과 worker 여유를 위해 request pool은 운영에서 인스턴스당 최소 4 이상을 권장합니다.

정적 파일은 content hash가 붙은 Vite bundle만 `immutable`로 장기 캐시합니다. `/manifest.webmanifest`, `/umm-sw.js`, `/umm-icon.svg`, `/asset-manifest.json`은 `no-cache`로 재검증되므로 배포 뒤 proxy/CDN이 이 고정 URL에 임의의 1년 immutable 정책을 덧씌우지 않도록 구성하세요.

32-byte encryption key는 연결망 밖의 승인된 비밀 관리 절차로 생성합니다. 예: `openssl rand -base64 32`. Shell history, compose file, ticket, Git에 실제 값을 남기지 마세요.

실행에 전달하는 서비스 환경변수는 다음 네 개뿐입니다.

```text
POSTGRES_DSN
BOOTSTRAP_ADMIN
BOOTSTRAP_ADMIN_PASSWORD
ENCRYPTION_KEY
```

컨테이너는 non-root `umm` 사용자로 실행되고 기본 주소는 `:8080`입니다. 선택 환경변수 `UMM_HTTP_ADDR`로 `127.0.0.1:18081` 같은 바인드 주소를 지정할 수 있습니다. `/healthz`는 프로세스, `/readyz`는 PostgreSQL 연결을 검사합니다.

선택 운영 환경변수는 다음과 같습니다.

```text
ENCRYPTION_KEY_PREVIOUS       # 쉼표로 구분한 이전 32-byte 키; 회전 기간에만 사용
UMM_HTTP_ADDR                 # 기본 :8080
UMM_TRUSTED_PROXY_CIDRS       # 쉼표로 구분한 신뢰할 reverse proxy IP/CIDR
OTEL_EXPORTER_OTLP_ENDPOINT   # 설정할 때만 OTLP trace exporter 활성화
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
```

`UMM_TRUSTED_PROXY_CIDRS`의 기본값은 빈 목록입니다. 이때 서비스는 `X-Forwarded-For`, `X-Real-IP`, `X-Forwarded-Proto`를 모두 제거하고 실제 socket peer를 로그인 잠금·요청 제한 주소로 사용합니다. TLS 종료 proxy가 직접 연결될 때만 그 proxy의 실제 네트워크를 지정하세요. 예를 들어 Docker/Kubernetes 내부 proxy 대역이 `10.42.0.0/16`이면 `UMM_TRUSTED_PROXY_CIDRS=10.42.0.0/16`으로 설정합니다. `0.0.0.0/0`과 `::/0`은 클라이언트가 주소와 scheme을 위조하게 만들므로 사용하지 마세요. Proxy도 외부 forwarding header를 제거하고 자신이 확인한 값을 덮어쓰거나 append해야 합니다.

## 최초 설정 순서

1. bootstrap 관리자 로그인 후 서비스 관리자 → 일반에서 서비스 이름, 공개 URL, `Asia/Seoul` 같은 IANA 시간대를 저장합니다.
2. 보안 → 허용 API/MCP scope, 기본 만료, 회전 중첩 시간과 **남용 방지**(로그인 실패 허용 횟수·잠금 시간, 분당 API 요청, 분당·하루 AI 한도)를 확인합니다. 마이그레이션 009가 전용 `ai:assist` scope를 자동 추가하며, `notes:read`만 가진 key는 외부 Gateway 호출과 AI 쿼터 소비를 할 수 없습니다. 기본값은 로그인 8회/15분, API 600/분, AI 6/분, AI 80/일입니다. 롤링 배포 중 구버전 관리 화면이 새 한도 필드를 생략해 저장해도 서버가 최신 확정값을 transaction 안에서 병합하므로 조정값이 기본값으로 되돌아가지 않습니다.
3. 필요할 때만 Keycloak SSO를 저장하고 연결 시험 후 활성화합니다.
4. 필요할 때만 AI Gateway를 저장합니다. 임베딩 모델을 비워 두면 외부 호출 없이 내장 로컬 임베딩을 사용합니다.
5. Dream은 Gateway 확인 뒤 기능과 자동 생성을 각각 활성화합니다.
6. 승인 흐름이 실제로 필요한 작업만 검토 프로세스에서 선택합니다. OFF일 때는 승인 UI/API 단계가 생기지 않습니다.

## Upgrade와 rollback

업그레이드 전에 PostgreSQL snapshot/backup을 만들고 현재 `ENCRYPTION_KEY`를 별도 비밀 저장소에서 확인합니다.

```bash
gzip -dc umm-v0.8.1.tar.gz | docker load
docker stop umm
# 동일한 네 필수 환경변수와 DB로 umm:v0.8.1 실행
```

Schema migration은 기동 시 forward 방향으로만 자동 적용됩니다. 되돌려야 할 때를 위해 `migrations/down/`에 되돌리기 스크립트를 둡니다. 자동으로는 절대 실행되지 않습니다 — 컬럼을 지우는 일은 그 안의 데이터를 지우는 일이므로, 백업을 확보한 운영자가 의도적으로 실행해야 합니다.

```bash
psql "$POSTGRES_DSN" -v ON_ERROR_STOP=1 -f migrations/down/009_ai_assist_scope.down.sql
psql "$POSTGRES_DSN" -v ON_ERROR_STOP=1 -f migrations/down/008_atomic_ai_quota.down.sql
psql "$POSTGRES_DSN" -v ON_ERROR_STOP=1 -f migrations/down/007_scale_and_security.down.sql
```

CI는 릴리스 전에 `scripts/migrate-dry-run.sh`로 모든 마이그레이션을 임시 database에 적용하고, **다시 적용해도 안전한지** 확인한 뒤, 되돌리기 스크립트가 있는 것들을 역순으로 되돌립니다. 배포가 중단돼 마이그레이션이 재시도되는 상황이 장애가 되지 않도록 하기 위한 검사입니다.

## Backup

- 매일 PostgreSQL logical/physical backup
- `ENCRYPTION_KEY`는 DB와 분리된 비밀 저장소에 backup
- 복구 훈련에서 로그인, note 수, OIDC secret decrypt, API key digest 인증을 확인
- API/MCP secret은 복호화할 수 없으므로 복구 후 문제가 있으면 회전

CI는 `scripts/restore-smoke.sh`로 PostgreSQL custom-format dump를 별도 `umm_restore_*` DB에 복원하고 migration ledger와 사용자 수를 원본과 비교합니다. 운영에서도 분기별로 격리된 복구 환경에서 같은 검증과 로그인·캔버스 조회를 수행하세요. 복구 시험 DB 이름은 실제 운영 DB와 겹치지 않도록 고정 규칙으로 관리합니다.

## Master encryption key 회전

1. 새 32-byte 값을 `ENCRYPTION_KEY`에, 현재 값을 `ENCRYPTION_KEY_PREVIOUS`에 넣고 재시작합니다.
2. 관리자 → 보안에서 fallback key 수, 회전 대기 값, 읽기 실패 값이 예상과 일치하는지 확인합니다.
3. **현재 키로 회전**을 실행합니다. OIDC/AI 설정 비밀, AI prompt 로그, 웹훅 HMAC 비밀이 한 트랜잭션에서 다시 암호화됩니다.
4. `pendingRotation=0`, `unreadable=0`을 확인하고 백업을 새로 만든 뒤 `ENCRYPTION_KEY_PREVIOUS`를 제거해 재시작합니다.

암호문은 `v2.<key-id>.<payload>` 형식이며 기존 v1 암호문도 fallback key로 읽어 회전할 수 있습니다. `enc:` wrapper 도입 전에 저장된 AI prompt의 raw v1 암호문도 회전 작업이 자동으로 `enc:v2.<key-id>.<payload>`로 정규화합니다. OIDC·AI Gateway의 마스킹 설정 저장과 회전은 같은 설정별 transaction lock으로 직렬화되고 저장 요청은 잠금 뒤 최신 secret을 병합하므로, 회전 전에 열어 둔 관리 화면이 이전 암호문을 복원하지 않습니다. 이전 키를 먼저 제거하면 해당 값은 복구할 수 없습니다.

## 관측성과 자동화

- `/api/v1/metrics`는 관리자 브라우저 세션 또는 명시적인 `metrics:read` API 키로만 Prometheus request count, latency histogram, in-flight, build 정보를 제공합니다. 일반 사용자 세션의 내부 wildcard와 관리자가 발급한 다른 scope의 키는 허용되지 않습니다.
- 실시간 협업 상태는 `umm_realtime_subscribers`, `umm_realtime_spaces`, `umm_realtime_signals_total`, `umm_realtime_listener_up`으로 노출됩니다. `umm_realtime_listener_up`이 0이면 PostgreSQL `LISTEN` 연결이 끊긴 상태이며 SSE가 상태 전환 즉시 1초 폴백 폴링으로 동작 중이라는 뜻입니다 — 협업은 계속되지만 데이터베이스 부하가 올라가므로 알림을 걸어 두세요. 같은 값은 관리자 → 운영 현황에서도 볼 수 있습니다.
- 만료된 세션·OAuth state·재시도 기록·로그인 실패 기록·AI 쿼터 예약은 15분마다 자동 정리됩니다. 별도 cron이 필요하지 않습니다.
- 표준 `OTEL_EXPORTER_OTLP_ENDPOINT` 또는 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`가 있을 때만 OTLP HTTP trace exporter가 활성화됩니다.
- 웹훅은 HTTPS 기본 포트만 허용하며 DNS 확인과 연결 시점 모두 사설·loopback·link-local·reserved IP를 거부합니다. 도메인 변경과 SSE/webhook outbox는 같은 PostgreSQL 트랜잭션으로 커밋되고, 재시작 시 대기 항목과 2분 넘게 처리 중인 항목을 워커가 복구합니다. 워커는 정확한 `claimed_at` 세대와 delivery·subscription·owner·space·membership 행을 실제 HTTP 응답까지 잠급니다. 권한 회수·사용자 비활성화·subscription 중지가 먼저 확정되면 외부 전송을 시작하지 않고, 전송이 먼저 시작되면 정책 변경은 terminal 상태·payload 삭제·구독 성공/실패 counter가 같은 transaction으로 확정된 뒤 재개됩니다. 실패는 세 번 재시도하고 연속 10회 실패 시 subscription을 자동 중지합니다. 외부 오류는 잘못된 UTF-8을 제거하고 rune 경계 안에서 500 byte로 제한하므로 다국어 오류도 delivery 종료와 실패 횟수 갱신을 막지 않습니다.
- 전달 시도는 at-least-once 방식입니다. 수신 측은 `X-Umm-Timestamp + "." + raw_body`에 대한 `X-Umm-Signature-256: sha256=<hex>` HMAC을 검증하고 오래된 timestamp를 거부하며, `X-Umm-Delivery`를 멱등 키로 저장해 중복을 안전하게 무시해야 합니다.
- terminal delivery의 복사 payload는 즉시 제거되며 상태·HTTP code·오류 metadata는 30일 후 정리됩니다. 더 긴 감사 보존이 필요하면 수신 시스템에서 delivery UUID와 필요한 비민감 metadata를 별도로 보관하세요.

## Dream 장애

AI Gateway 오류는 retry 후 failed job과 `ai_calls`에 기록됩니다. 일반 Canvas는 계속 동작합니다. Timeout은 모든 재시도를 포함해 최대 1800초이고 umm의 HTTP write timeout은 1860초입니다. 동기식 AI 평가·Assist 응답이 먼저 끊기지 않도록 reverse proxy의 upstream response timeout도 관리자 설정값보다 최소 60초 길게 두세요. 장애가 길어지면 관리자에서 자동 생성을 OFF하고, 복구 후 “지금 큐 생성”을 실행합니다. 품질 기준 미달은 failure가 아니라 skip이며 사용자에게 빈 Dream을 억지로 노출하지 않습니다.

vLLM이 최종 본문 없이 추론만 반환한다면 모델에 맞는 `--reasoning-parser` 설정과 Dream 출력 Token 한도를 먼저 확인합니다. `재시도`가 1 이상이면 umm은 추론-only 또는 추론 중 잘린 응답을 감지해 비추론 모드로 한 번 더 요청합니다. 저장·노출되는 값은 최종 `content`뿐이며 분리된 `reasoning`/`reasoning_content`와 `<think>` 블록은 제외됩니다.

## Release 규칙

`VERSION`이 `0.8.1`이면 tag는 `v0.8.1`, image는 `umm:v0.8.1`, GitHub asset은 `umm-v0.8.1.tar.gz`입니다. Release workflow는 세 값이 다르면 중단합니다. Release에는 image tarball, SPDX JSON SBOM, `SHA256SUMS`가 첨부되며 GitHub artifact provenance와 SBOM attestation을 함께 발급합니다.
