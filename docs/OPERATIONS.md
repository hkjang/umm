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

인스턴스는 협업 이벤트 수신용 PostgreSQL 연결 하나를 상시 점유합니다. 연결 풀 기본값이 그만큼 여유를 두지만, DSN에 `pool_max_conns`를 직접 지정한다면 인스턴스당 최소 4 이상으로 유지하세요.

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
OTEL_EXPORTER_OTLP_ENDPOINT   # 설정할 때만 OTLP trace exporter 활성화
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
```

## 최초 설정 순서

1. bootstrap 관리자 로그인 후 서비스 관리자 → 일반에서 서비스 이름, 공개 URL, `Asia/Seoul` 같은 IANA 시간대를 저장합니다.
2. 보안 → 허용 API/MCP scope, 기본 만료, 회전 중첩 시간과 **남용 방지**(로그인 실패 허용 횟수·잠금 시간, 분당 API 요청, 분당·하루 AI 한도)를 확인합니다. 기본값은 로그인 8회/15분, API 600/분, AI 6/분, AI 80/일입니다.
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

암호문은 `v2.<key-id>.<payload>` 형식이며 기존 v1 암호문도 fallback key로 읽어 회전할 수 있습니다. 이전 키를 먼저 제거하면 해당 값은 복구할 수 없습니다.

## 관측성과 자동화

- `/api/v1/metrics`는 `metrics:read` scope 또는 관리자 세션으로 Prometheus request count, latency histogram, in-flight, build 정보를 제공합니다.
- 실시간 협업 상태는 `umm_realtime_subscribers`, `umm_realtime_spaces`, `umm_realtime_signals_total`, `umm_realtime_listener_up`으로 노출됩니다. `umm_realtime_listener_up`이 0이면 PostgreSQL `LISTEN` 연결이 끊긴 상태이며 SSE가 폴백 폴링으로 동작 중이라는 뜻입니다 — 협업은 계속되지만 데이터베이스 부하가 올라가므로 알림을 걸어 두세요. 같은 값은 관리자 → 운영 현황에서도 볼 수 있습니다.
- 만료된 세션·OAuth state·재시도 기록·로그인 실패 기록은 15분마다 자동 정리됩니다. 별도 cron이 필요하지 않습니다.
- 표준 `OTEL_EXPORTER_OTLP_ENDPOINT` 또는 `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`가 있을 때만 OTLP HTTP trace exporter가 활성화됩니다.
- 웹훅은 HTTPS 기본 포트만 허용하며 DNS 확인과 연결 시점 모두 사설·loopback·link-local·reserved IP를 거부합니다. 도메인 변경과 SSE/webhook outbox는 같은 PostgreSQL 트랜잭션으로 커밋되고, 재시작 시 대기 항목과 2분 넘게 처리 중인 항목을 워커가 복구합니다. 실패는 세 번 재시도하고 연속 10회 실패 시 subscription을 자동 중지합니다.
- 전달 시도는 at-least-once 방식입니다. 수신 측은 `X-Umm-Timestamp + "." + raw_body`에 대한 `X-Umm-Signature-256: sha256=<hex>` HMAC을 검증하고 오래된 timestamp를 거부하며, `X-Umm-Delivery`를 멱등 키로 저장해 중복을 안전하게 무시해야 합니다.
- terminal delivery의 복사 payload는 즉시 제거되며 상태·HTTP code·오류 metadata는 30일 후 정리됩니다. 더 긴 감사 보존이 필요하면 수신 시스템에서 delivery UUID와 필요한 비민감 metadata를 별도로 보관하세요.

## Dream 장애

AI Gateway 오류는 retry 후 failed job과 `ai_calls`에 기록됩니다. 일반 Canvas는 계속 동작합니다. Timeout은 모든 재시도를 포함해 최대 1800초이고 umm의 HTTP write timeout은 1860초입니다. 동기식 AI 평가·Assist 응답이 먼저 끊기지 않도록 reverse proxy의 upstream response timeout도 관리자 설정값보다 최소 60초 길게 두세요. 장애가 길어지면 관리자에서 자동 생성을 OFF하고, 복구 후 “지금 큐 생성”을 실행합니다. 품질 기준 미달은 failure가 아니라 skip이며 사용자에게 빈 Dream을 억지로 노출하지 않습니다.

vLLM이 최종 본문 없이 추론만 반환한다면 모델에 맞는 `--reasoning-parser` 설정과 Dream 출력 Token 한도를 먼저 확인합니다. `재시도`가 1 이상이면 umm은 추론-only 또는 추론 중 잘린 응답을 감지해 비추론 모드로 한 번 더 요청합니다. 저장·노출되는 값은 최종 `content`뿐이며 분리된 `reasoning`/`reasoning_content`와 `<think>` 블록은 제외됩니다.

## Release 규칙

`VERSION`이 `0.8.1`이면 tag는 `v0.8.1`, image는 `umm:v0.8.1`, GitHub asset은 `umm-v0.8.1.tar.gz`입니다. Release workflow는 세 값이 다르면 중단합니다. Release에는 image tarball, SPDX JSON SBOM, `SHA256SUMS`가 첨부되며 GitHub artifact provenance와 SBOM attestation을 함께 발급합니다.
