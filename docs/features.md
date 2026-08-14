# umm 기능 및 화면 가이드 (Features & UI Guide)

`umm`은 생각을 문서나 폴더로 정리하기 전에 공간에 먼저 붙이고, 연결하고, 밤사이 **Dream**으로 다시 발견하는 **Spatial Thought Memory** 플랫폼입니다.

---

## 📸 전체 메뉴별 주요 화면 및 기능 명세

### 1. 인증 및 로그인 (`/login`)
![로그인 화면](./screenshots/01_login.png)
- **로컬 부트스트랩 관리자**: 초기 환경변수(`BOOTSTRAP_ADMIN`, `BOOTSTRAP_ADMIN_PASSWORD`) 기반 보안 로그인
- **Keycloak OIDC SSO**: 설정 시 `Keycloak SSO로 계속` 버튼을 통한 엔터프라이즈 통합 로그인 지원
- **버전 및 서비스명**: 하단에 현재 릴리스 버전(`v0.5.0`)과 서비스명 실시간 표시

---

### 2. 무한 생각 캔버스 (`/space/:spaceId`)
![캔버스 전경](./screenshots/02_canvas_overview.png)
- **Spatial Infinite Canvas**: React Flow 기반의 자유로운 줌(Zoom), 팬(Pan), 미니맵 및 도트 그리드 배경
- **포스트잇 노드 배치**: 더블클릭, `N`, `/` 또는 하단 Quick Capture 바를 통해 공간 어디든 즉시 메모 생성
- **생각 연결선 (Edges)**: 노드 핸들을 드래그하여 생각 간의 관계(관련, Dreamed 등)를 직관적으로 연결
- **실시간 자동 저장**: 저장 버튼 없이 모든 입력, 위치 이동, 크기 변경이 PostgreSQL에 실시간 커밋

---

### 3. 포스트잇 상세 편집 및 컬러 테마
![포스트잇 편집](./screenshots/03_note_editing.png)
- **7종 Semantic Pastel Palette**: 노랑(Yellow), 파랑(Blue), 보라(Purple), 라벤더(Lavender), 초록(Green), 빨강(Red), 회색(Gray)
- **리사이즈 & 드래그**: 노드 경계면 리사이저로 크기를 자유롭게 조정하고 드래그하여 배치
- **위치 Undo / Redo**: `Cmd+Z` / `Shift+Cmd+Z` 단축키로 이전 위치 및 이동 이력 복원

---

### 4. 포스트잇 버전 이력 및 복원 (Revisions & Restore)
![버전 복원 모달](./screenshots/04_note_history_modal.png)
- **버전 스냅샷 자동 생성**: 메모 내용 변경 시마다 백그라운드에서 버전 스냅샷 기록
- **이전 버전 롤백**: 실수로 변경하거나 삭제된 내용을 특정 시점의 버전으로 안전하게 복원

---

### 5. Thought Gravity (생각 인력)
![Thought Gravity](./screenshots/05_thought_gravity.png)
- **원형 궤도 자동 정렬**: 중심 생각을 선택하고 `Thought Gravity` 버튼을 누르면 연결된 모든 관련 생각들이 중심 노드 주위 궤도로 자연스럽게 모임
- **복잡한 캔버스 정리**: 흩어진 아이디어들을 한 번의 클릭으로 주제별로 집결

---

### 6. 공간 관리자 (Space Manager)
![공간 관리자 모달](./screenshots/08_space_manager_modal.png)
- **공간 생성 (Create Space)**: 새로운 프로젝트 및 생각 주제별 독립 캔버스 생성
- **공간 검색 및 전환**: 등록된 모든 공간을 실시간 검색하고 빠르게 이동
- **공간 이름 변경 및 삭제**: 소유한 공간의 이름을 인라인으로 변경하거나 안전 확인 후 영구 삭제

---

### 7. 공간 협업 및 공유 (Space Collaboration)
![공간 공유 모달](./screenshots/09_space_share_modal.png)
- **팀원 초대**: 사내 사용자를 검색하여 공동 작업 공간으로 초대
- **세분화된 권한 제어**:
  - `보기 (View)`: 메모 조회 및 내보내기만 가능
  - `편집 (Edit)`: 메모 생성, 수정, 연결선 조작 가능
  - `관리 (Manage)`: 멤버 관리 및 공간 설정 제어
- **팀장 승인 연동**: 관리자 검토 정책이 켜져 있을 경우 공간 공유 시 팀장 승인 단계 자동 삽입

---

### 8. Dreams 타임라인 (`/dreams`)
![Dreams 타임라인](./screenshots/12_dreams_timeline.png)
- **밤사이 자라난 생각 메모**: Dream Scheduler가 야간에 캔버스의 생각들을 분석하여 새로운 관점, 질문, 연결점을 제시
- **품질 점수 및 유형 표시**: AI 생성 유형(연결/질문/확장)과 품질 점수(Quality Score %)를 투명하게 제공
- **캔버스 안착**: 마음에 드는 Dream 카드를 클릭하여 내 캔버스에 라벤더 포스트잇으로 즉시 추가

---

### 9. 개인화 설정 (`/settings`)
![개인 설정](./screenshots/13_personal_settings.png)
- **Dream 개인화 옵션**:
  - Dream 생성 빈도 (매일, 주 3회, 주 1회)
  - 스타일 선호 (자동, 연결 중심, 질문 중심, 확장 중심, 자유)
  - 오래된 생각 활용 여부 및 Dream 일시 중지 (오늘 / 3일 / 일주일)
- **연결선 형태 선택**: 부드러운 곡선(Bezier), 둥근 꺾은선(Smoothstep), 직선(Straight) 실시간 미리보기 및 변경

---

### 10. 개인 API · MCP 키 관리
![API 키 발급 모달](./screenshots/14_api_keys_create_modal.png)
![API 키 목록](./screenshots/15_api_keys_list.png)
- **최소 권한 Scoped API Key**: 필요한 권한(`spaces:read`, `notes:read`, `notes:write`, `ai:assist` 등)만 선택하여 발급
- **일회성 Secret 표시**: 발급 시 1회만 노출되는 보안 토큰
- **무중단 키 회전 (Zero-Downtime Rotation)**: 설정된 중첩 시간(예: 24시간) 동안 기존 키와 신규 키를 동시 지원하여 서비스 중단 없는 안전한 키 교체

---

### 11. 검토 및 승인 대기열 (`/approvals`)
![승인 대기열](./screenshots/16_approvals_list.png)
- **작업별 조건부 승인**: 공간 공유 및 외부 내보내기 요청 목록 조회
- **팀장/관리자 결정**: 요청 사유 확인 후 의견(Comment)과 함께 승인(Approve) 또는 반려(Reject) 처리

---

### 12. 서비스 관리자: 운영 현황 (`/admin/overview`)
![관리자 운영 현황](./screenshots/17_admin_overview.png)
- **KPI 지표 요약**: 전체 사용자, 활성 사용자, 생각 수, 공간 수, Dream 생성 수, AI 호출 수
- **Dream 운영 예측 및 비용 분석**: 예상 월 호출량, 예상 비용($), 실제 노출량, 평균 품질, 유지율/발전율/삭제율
- **즉시 큐 생성 (Manual Trigger)**: 야간 스케줄러 대기 없이 즉시 Dream 분석 작업 큐 실행

---

### 13. 서비스 관리자: 일반 설정 (`/admin/general`)
![관리자 일반 설정](./screenshots/18_admin_general.png)
- **서비스 기본 정보**: 서비스 명칭, 공개 URL(Public URL), 세션 유지 시간(1~720시간), 서비스 시간대(IANA Timezone) 구성
- **무중단 즉시 반영**: 서버 재시작 없이 저장 즉시 전체 서비스에 적용

---

### 14. 서비스 관리자: Keycloak SSO (`/admin/oidc`)
![관리자 Keycloak SSO](./screenshots/19_admin_oidc.png)
- **OIDC Discovery 자동 연동**: Issuer URL 입력만으로 엔드포인트 자동 탐색
- **암호화 자격증명 보관**: Client Secret을 AES-256-GCM으로 암호화 저장
- **그룹 및 역할 매핑**: 사내 Keycloak 그룹/역할을 umm의 `admin`, `team_lead`, `user`로 자동 매핑
- **원클릭 연결 시험**: 실시간으로 Keycloak 서버와의 OIDC 핸드셰이크 검증

---

### 15. 서비스 관리자: Dream Layer (`/admin/dream`)
![관리자 Dream 설정](./screenshots/20_admin_dream.png)
- **스케줄 및 빈도 제어**: 자동 생성 시간(기본 02:00), 주기(매일/평일/주말/요일별/N일 간격)
- **256K Context Window 토큰 한도 제어**: 모델 사양에 맞춰 4K부터 256K까지 토큰 슬라이더 설정
- **품질 기준선(Quality Threshold) & Quiet Mode**: 가치가 높은 경우에만 선별적으로 Dream을 생성하는 Quiet Mode 및 노출 최소 점수 제어

---

### 16. 서비스 관리자: AI Gateway (`/admin/ai_gateway`)
![관리자 AI Gateway](./screenshots/21_admin_ai_gateway.png)
- **내부 OpenAI 호환 Gateway 연동**: Base URL, API Key, Timeout(5~1800초), 재시도 횟수 지정
- **비용 산정 및 데이터 보존**: 토큰당 단가($/1M tokens), AI 로그 보존 주기(기본 90일), 원문 프롬프트 암호화 저장 옵션

---

### 17. 서비스 관리자: 키 · 권한 체계 (`/admin/security`)
![관리자 보안 설정](./screenshots/22_admin_security.png)
- **허용 API/MCP Scopes 제어**: 일반 사용자가 발급 가능한 권한 태그 화이트리스트 관리
- **키 수명 주기 정책**: 기본 키 유효기간(일) 및 회전 시 중첩 시간(시간) 설정

---

### 18. 서비스 관리자: 검토 프로세스 (`/admin/workflow`)
![관리자 워크플로 설정](./screenshots/23_admin_workflow.png)
- **작업별 승인 프로세스 On/Off**: 팀 공간 공유, 외부 내보내기 중 승인이 필요한 작업 선택

---

### 19. 서비스 관리자: 사용자 관리 (`/admin/users`)
![관리자 사용자 목록](./screenshots/24_admin_users.png)
- **사내 계정 통합 관리**: 사용자별 역할(`user`, `team_lead`, `admin`), 소속 팀명, 계정 활성/비활성 스위치 제어

---

### 20. 서비스 관리자: 불변 감사 로그 (`/admin/audit`)
![관리자 감사 로그](./screenshots/25_admin_audit.png)
- **추가 전용(Append-only) 감사 추적**: 시각, 행위자, 작업 구분(Action), 대상 리소스(Resource ID)를 위변조 없이 기록
