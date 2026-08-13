# Security and key hierarchy

## 키 계층

```text
ENCRYPTION_KEY (container secret, 32 bytes)
  └─ AES-256-GCM: OIDC client secret / AI Gateway API key

User API/MCP key (one-time plaintext display)
  └─ SHA-256 digest only in PostgreSQL
       ├─ user ownership
       ├─ administrator-defined allowed scopes
       ├─ user-selected effective scopes
       ├─ expiry / revoke
       └─ rotation overlap window
```

`ENCRYPTION_KEY`와 PostgreSQL backup을 같은 저장소에 보관하지 마세요. 키를 잃으면 암호화된 관리자 secret은 복구할 수 없지만 Canvas 데이터는 영향을 받지 않습니다. 이 버전은 master key의 자동 회전을 제공하지 않으므로 master key 변경은 먼저 OIDC/AI secret을 안전하게 별도 보관하고 새 키로 재입력하는 운영 절차로 수행합니다.

개인 키 secret은 생성·회전 응답에서 한 번만 보이며 DB에는 digest만 남습니다. 키 회전 시 기존 키는 `overlap` 상태가 되고 관리자 설정 시간이 지나면 인증에서 자동 거부됩니다. 즉시 차단이 필요하면 사용자가 폐기할 수 있습니다.

## 인증과 권한

- Browser session: random 256-bit token의 digest만 DB 저장, HttpOnly, SameSite=Lax, HTTPS 인지 시 Secure cookie
- OIDC: Authorization Code flow, state 일회 사용/10분 만료, provider Discovery, ID token 서명·issuer·audience 검증
- Roles: `user`, `team_lead`, `admin`
- API/MCP: Bearer key와 세부 scope. MCP는 browser cookie를 허용하지 않음
- Workflow: 팀장은 자신의 team 요청만 결정, 관리자는 전체 결정
- Admin secret: API 응답에서 항상 마스킹, 감사 로그에 원문 미기록

TLS는 서비스 앞의 reverse proxy에서 종료하는 구성을 권장하며 `X-Forwarded-Proto: https`를 전달해야 합니다. Keycloak redirect URI는 wildcard가 아니라 callback 전체 경로로 제한하세요.

## AI 개인정보 보호

- Dream은 기본 OFF, 자동 생성도 별도 OFF
- 필요한 최근 메모만 최대 개수/기간 내에서 전송
- 알려진 password/API key/token 패턴 사전 redaction
- 원문 prompt 저장 기본 OFF
- AI call 로그는 상태, token, 비용, latency와 짧은 error만 기록
- 관리자 원문 접근 API 없음
- 사용자는 Dream OFF/Pause 가능

운영 환경에서는 외부 SaaS보다 망 내부 OpenAI 호환 Gateway를 사용하고, Gateway에서도 별도의 DLP/egress 정책을 적용하세요.

## 보안 헤더와 제한

응답에는 CSP, frame deny, nosniff, same-origin referrer, device permission 제한이 기본 적용됩니다. JSON body는 1 MiB, MCP body도 1 MiB로 제한합니다. HTTP server는 header/read/write/idle timeout을 둡니다. MCP는 Origin 검증과 현재 프로토콜 routing header 일치를 확인합니다.

취약점은 공개 issue에 secret 또는 실제 사용자 내용을 포함하지 말고 저장소 관리자의 비공개 보안 채널로 전달하세요.
