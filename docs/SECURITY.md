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

- Browser session: random 256-bit token의 digest만 DB 저장, HttpOnly, SameSite=Lax, HTTPS 인지 시 Secure cookie. 사용자는 개인 설정에서 활성 세션 목록을 확인하고 개별 또는 일괄 종료할 수 있음
- Login throttling: 실패 횟수를 PostgreSQL에 기록해 인스턴스 간에 공유. 주소별 임계값을 넘으면 잠금, 계정별 임계값은 그 3배로 두어 아이디를 아는 사람이 남의 계정을 잠그는 것을 방지. 로그인 성공은 계정 key만 초기화하고 주소 key는 유지해 다른 정상 계정으로 IP 제한을 지우는 우회를 차단
- Rate limits: 호출자별 API 요청 한도와 AI 생성 전용 분당·일일 한도. 일일 한도는 대화형 요청·자동 Dream·관리자 AI 평가의 실제 Gateway 호출 직전에 PostgreSQL advisory lock으로 원자 선점하고 24시간 소비 원장으로 먼저 영속화하므로, 요청 취소·`ai_calls` 로그 실패·동시 요청·재시작·여러 인스턴스를 넘어 유지됨. 초과 시 `429`와 `Retry-After` 반환
- OIDC: Authorization Code flow, state 일회 사용/10분 만료, provider Discovery, ID token 서명·issuer·audience 검증
- Roles: `user`, `team_lead`, `admin`
- API/MCP: Bearer key와 세부 scope. MCP는 browser cookie를 허용하지 않음
- Session boundary: 관리자 API, 개인 설정, API key 생성·회전·폐기는 브라우저 세션만 허용해 제한 key의 권한 상승을 차단
- Workflow: 팀장은 자신의 team 요청만 결정, 관리자는 전체 결정
- Collaboration: 공간 소유자 또는 `manage` 멤버만 공유 권한 변경, `view`/`edit`/`manage` 분리
- Export: 관리자가 `export` 검토를 켠 경우 승인 후 24시간 동안만 허용
- Admin secret: API 응답에서 항상 마스킹, 감사 로그에 원문 미기록
- Browser write: `Origin`의 scheme·hostname·effective port와 `Sec-Fetch-Site`를 확인해 로그인과 인증된 변경 요청의 cross-site·cross-scheme 전송 차단. 신뢰 proxy가 정규화한 scheme 또는 관리자 공개 URL origin과 정확히 일치해야 함
- AI exclusion: 메모 또는 공간의 AI 제외 flag를 원격 임베딩 batch 구성 전에 확인하며, 제외 콘텐츠는 외부 Gateway 대신 서버 내부 로컬 vector만 사용
- Offline retry: atomic Canvas mutation에 한정한 `Idempotency-Key`, 사용자·키별 advisory lock, 실행 중 갱신되는 2분 pending lease, 도메인/SSE/outbox/응답 원자 커밋과 24시간 성공 replay로 동시 중복·post-commit 기록 유실·crash 고착 방지
- Aggregate scope: `notes:read`만 가진 API key의 Today 응답에서는 `dreams:read` 데이터와 개수를 제거해 집계 endpoint를 통한 scope 우회를 차단
- One-time secrets: API key와 webhook signing key 생성·회전 응답은 멱등 캐시 대상에서 제외해 평문 자격 증명을 PostgreSQL에 남기지 않음
- Dream materialization: 채택·발전 transaction이 공간과 현재 편집 membership을 같은 연결에서 잠가, 권한 강등·회수와 메모·연결선·이벤트 생성이 엇갈리거나 작은 pool에서 중첩 연결을 기다리지 않도록 함
- Security-setting compatibility: 구버전 관리 payload가 생략한 로그인·API·AI guard는 설정별 advisory transaction lock 아래 최신 확정값에서 병합하고, 명시한 `0`과 omission을 구분하며 `null`은 거부해 롤링 배포 중 보호 수준 초기화를 차단

TLS는 서비스 앞의 reverse proxy에서 종료하는 구성을 권장합니다. 이 경우 직접 연결되는 proxy IP/CIDR만 `UMM_TRUSTED_PROXY_CIDRS`에 지정하고 proxy가 `X-Forwarded-For`와 `X-Forwarded-Proto: https`를 정규화해 전달하도록 구성하세요. 목록이 비어 있거나 socket peer가 목록 밖이면 umm은 모든 forwarding header를 제거합니다. Keycloak redirect URI는 wildcard가 아니라 callback 전체 경로로 제한하세요.

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

응답에는 CSP, HSTS(TLS 요청에 한함), frame deny, nosniff, same-origin referrer, COOP/CORP, device permission 제한이 기본 적용됩니다.

`script-src`는 **응답마다 새로 생성되는 nonce와 `strict-dynamic`** 을 사용합니다. 서버가 shell 문서의 script 태그에 그 nonce를 새겨 넣으므로, 주입된 `<script src=…>`는 같은 출처를 가리켜도 실행되지 않습니다. `object-src`와 `frame-src`는 `'none'`입니다.

`style-src`의 `'unsafe-inline'`은 **의도적으로 남겨 두었습니다.** Mantine이 테마 변수를 런타임 `<style>` 요소로 주입하고 React Flow가 모든 노드를 style 속성으로 배치하기 때문에, 제거하면 캔버스가 동작하지 않습니다. style 주입은 script 주입보다 현저히 낮은 심각도이므로, 제품을 깨뜨리면서 얻는 방어보다 이 상태를 문서화하는 편이 정직하다고 판단했습니다. 서비스 워커가 오프라인에 대비해 캐시하는 shell 응답은 헤더와 문서를 함께 저장하므로 캐시된 nonce와 헤더가 어긋나지 않습니다.

HSTS는 TLS로 도착한 요청 또는 명시적으로 신뢰한 proxy가 전달한 `X-Forwarded-Proto: https`에만 붙입니다. 평문 HTTP로 평가 중인 배포가 자기 브라우저에서 스스로 잠기거나, 외부 요청이 spoofed header로 쿠키·요청 제한 판단을 바꾸는 것을 막기 위해서입니다. JSON body는 1 MiB, MCP body도 1 MiB로 제한합니다. HTTP server는 header/read/write/idle timeout을 둡니다. 공간 SSE는 인증·공간 조회 권한을 먼저 확인하고 event payload에 관리자 secret을 싣지 않습니다. MCP는 Origin 검증과 현재 프로토콜 routing header 일치를 확인합니다. API 오류는 RFC 9457 Problem Details로 반환하며 기존 `error` 필드는 호환성을 위해 유지합니다.

## 웹훅과 공급망

- 웹훅 URL은 HTTPS 기본 포트만 허용하고 credential·fragment를 거부합니다.
- 등록 시와 실제 연결 시 DNS를 각각 확인해 DNS rebinding을 완화하고, 사설·loopback·link-local·multicast·문서·benchmark·reserved 대역을 차단합니다.
- payload는 일회 공개되는 subscription secret으로 HMAC-SHA256 서명되며 delivery ID와 Unix timestamp를 포함합니다.
- 도메인 변경, SSE log, 구독별 delivery payload는 하나의 PostgreSQL 트랜잭션에 영속화되고 lease 기반 워커가 재시작 후 이어서 처리합니다. 구독 소유자의 활성 상태와 현재 공간 접근 권한을 실제 전송 직전에 다시 확인합니다. 중단 경계에서 같은 delivery가 다시 전송될 수 있으므로 수신 측은 delivery ID를 멱등 키로 사용합니다.
- terminal delivery의 복사 payload는 즉시 `{}`로 비우고 상태·응답·오류 metadata는 30일 뒤 삭제해 원본 리소스보다 오래 민감 본문을 보존하지 않습니다.
- 외부 오류 metadata는 잘못된 UTF-8을 제거하고 byte 상한 안의 완전한 rune 경계에서만 잘라 PostgreSQL 기록 실패가 delivery lease 회수 반복이나 subscription 자동 중지 누락으로 이어지지 않게 합니다. 같은 경계 처리를 AI 임베딩·Dream Gateway의 오류 응답 일부에도 적용하고 Dream 작업·AI 호출 로그로 이어지는 문자열도 유효한 UTF-8로 정규화합니다.
- 댓글 알림 대상, 알림 목록·unread count와 Today 활동은 현재 공간 접근 권한 및 생각 삭제 상태를 다시 확인해 탈퇴 사용자나 삭제된 리소스로 정보가 새지 않도록 합니다. note 알림은 이전 행에 `resource_space_id`가 없어도 현재 생각의 실제 공간에서 권한을 계산합니다. 댓글 작성 transaction은 호출자의 멤버십 행을 `FOR KEY SHARE`로 잠가 권한 회수와 생성이 겹칠 때 댓글·알림·공간 이벤트·webhook outbox가 이전 확인 결과로 커밋되지 않게 합니다. 생각 삭제 또는 권한 회수 뒤에는 보관한 댓글 ID를 이용한 해결·재개·삭제도 mutation statement에서 거부하고 `comment-mutation-forbidden` terminal 403으로 구분해 숨겨진 리소스의 이벤트와 오프라인 큐 고착을 함께 막습니다.
- CI는 Go 취약점 검사, npm high 이상 audit, PostgreSQL 17 통합·복구 시험, 다중 인스턴스 스모크, 마이그레이션 dry-run, 실제 바이너리를 대상으로 한 브라우저 end-to-end 시험을 수행합니다.
- 태그 릴리스는 SPDX JSON SBOM, SHA-256 checksum, GitHub provenance 및 SBOM attestation을 이미지 archive와 함께 게시합니다.
- 로그인 세션의 User-Agent는 잘못된 UTF-8을 제거하고 300 byte 안의 완전한 rune 경계로 제한해 다국어 header 절단이 세션 INSERT 실패와 잘못된 로그인 잠금 누적으로 이어지지 않게 합니다.

애플리케이션 권한은 모든 쿼리의 공간 소유자/멤버 조건과 handler scope 검사에서 강제합니다. PostgreSQL RLS는 단일 애플리케이션 DB role이 owner 권한을 갖는 현재 배포 모델에서 잘못된 안전감을 줄 수 있어 이번 버전에는 활성화하지 않았습니다. 별도 제한 DB role과 connection identity를 도입하는 배포에서만 RLS를 추가 방어선으로 검토합니다.

취약점은 공개 issue에 secret 또는 실제 사용자 내용을 포함하지 말고 저장소 관리자의 비공개 보안 채널로 전달하세요.
