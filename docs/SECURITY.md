# Security and key hierarchy

## 키 계층

```text
ENCRYPTION_KEY (container secret, 32 bytes)
  └─ AES-256-GCM keyring (v2 key ID)
       ├─ OIDC client secret / AI Gateway API key
       ├─ optional encrypted AI prompt log
       └─ webhook HMAC signing secret

User API/MCP key (one-time plaintext display)
  └─ SHA-256 digest only in PostgreSQL
       ├─ user ownership
       ├─ administrator-defined allowed scopes
       ├─ user-selected effective scopes
       ├─ expiry / revoke
       └─ rotation overlap window
```

`ENCRYPTION_KEY`와 PostgreSQL backup을 같은 저장소에 보관하지 마세요. 키를 잃으면 암호화된 비밀은 복구할 수 없지만 Canvas 데이터는 영향을 받지 않습니다. 무중단 회전 시 새 값을 `ENCRYPTION_KEY`, 현재 값을 `ENCRYPTION_KEY_PREVIOUS`에 함께 배치하고 관리자 보안 화면에서 트랜잭션 재암호화를 실행합니다. 대기·읽기 실패가 모두 0인 것을 확인하기 전에는 이전 키를 제거하지 마세요.

개인 키 secret은 생성·회전 응답에서 한 번만 보이며 DB에는 digest만 남습니다. 키 회전 시 기존 키는 `overlap` 상태가 되고 관리자 설정 시간이 지나면 인증에서 자동 거부됩니다. 즉시 차단이 필요하면 사용자가 폐기할 수 있습니다.

## 인증과 권한

- Browser session: random 256-bit token의 digest만 DB 저장, HttpOnly, SameSite=Lax, HTTPS 인지 시 Secure cookie
- OIDC: Authorization Code flow, state 일회 사용/10분 만료, provider Discovery, ID token 서명·issuer·audience 검증
- Roles: `user`, `team_lead`, `admin`
- API/MCP: Bearer key와 세부 scope. MCP는 browser cookie를 허용하지 않음
- Session boundary: 관리자 API, 개인 설정, API key 생성·회전·폐기는 브라우저 세션만 허용해 제한 key의 권한 상승을 차단
- Workflow: 팀장은 자신의 team 요청만 결정, 관리자는 전체 결정
- Collaboration: 공간 소유자 또는 `manage` 멤버만 공유 권한 변경, `view`/`edit`/`manage` 분리
- Export: 관리자가 `export` 검토를 켠 경우 승인 후 24시간 동안만 허용
- Admin secret: API 응답에서 항상 마스킹, 감사 로그에 원문 미기록
- Browser write: `Origin`과 `Sec-Fetch-Site`를 확인해 로그인과 인증된 변경 요청의 cross-site 전송 차단
- Offline retry: 사용자·키별 PostgreSQL advisory lock, 요청 fingerprint 기반 24시간 pending 예약과 성공 응답 기록으로 `Idempotency-Key` 중복 생성 방지
- Aggregate scope: `notes:read`만 가진 API key의 Today 응답에서는 `dreams:read` 데이터와 개수를 제거해 집계 endpoint를 통한 scope 우회를 차단
- One-time secrets: API key와 webhook signing key 생성·회전 응답은 멱등 캐시 대상에서 제외해 평문 자격 증명을 PostgreSQL에 남기지 않음

TLS는 서비스 앞의 reverse proxy에서 종료하는 구성을 권장하며 `X-Forwarded-Proto: https`를 전달해야 합니다. Keycloak redirect URI는 wildcard가 아니라 callback 전체 경로로 제한하세요.

## AI 개인정보 보호

- Dream은 기본 OFF, 자동 생성도 별도 OFF
- 필요한 최근 메모만 최대 개수/기간 내에서 전송
- 알려진 password/API key/token 패턴 사전 redaction
- 원문 prompt 저장 기본 OFF. ON이면 redaction 후 `ENCRYPTION_KEY`로 암호화하며 관리자 설정의 보존 기간 후 자동 삭제
- AI call 로그는 상태, token, 비용, latency와 짧은 error만 기록
- 관리자 원문 접근 API 없음
- 사용자는 Dream OFF/Pause 가능

운영 환경에서는 외부 SaaS보다 망 내부 OpenAI 호환 Gateway를 사용하고, Gateway에서도 별도의 DLP/egress 정책을 적용하세요.

## 보안 헤더와 제한

응답에는 CSP, frame deny, nosniff, same-origin referrer, device permission 제한이 기본 적용됩니다. JSON body는 1 MiB, MCP body도 1 MiB로 제한합니다. HTTP server는 header/read/write/idle timeout을 둡니다. 공간 SSE는 인증·공간 조회 권한을 먼저 확인하고 event payload에 관리자 secret을 싣지 않습니다. MCP는 Origin 검증과 현재 프로토콜 routing header 일치를 확인합니다. API 오류는 RFC 9457 Problem Details로 반환하며 기존 `error` 필드는 호환성을 위해 유지합니다.

## 웹훅과 공급망

- 웹훅 URL은 HTTPS 기본 포트만 허용하고 credential·fragment를 거부합니다.
- 등록 시와 실제 연결 시 DNS를 각각 확인해 DNS rebinding을 완화하고, 사설·loopback·link-local·multicast·문서·benchmark·reserved 대역을 차단합니다.
- payload는 일회 공개되는 subscription secret으로 HMAC-SHA256 서명되며 delivery ID와 Unix timestamp를 포함합니다.
- CI는 Go 취약점 검사, npm high 이상 audit, PostgreSQL 17 통합·복구 시험을 수행합니다.
- 태그 릴리스는 SPDX JSON SBOM, SHA-256 checksum, GitHub provenance 및 SBOM attestation을 이미지 archive와 함께 게시합니다.

애플리케이션 권한은 모든 쿼리의 공간 소유자/멤버 조건과 handler scope 검사에서 강제합니다. PostgreSQL RLS는 단일 애플리케이션 DB role이 owner 권한을 갖는 현재 배포 모델에서 잘못된 안전감을 줄 수 있어 이번 버전에는 활성화하지 않았습니다. 별도 제한 DB role과 connection identity를 도입하는 배포에서만 RLS를 추가 방어선으로 검토합니다.

취약점은 공개 issue에 secret 또는 실제 사용자 내용을 포함하지 말고 저장소 관리자의 비공개 보안 채널로 전달하세요.
