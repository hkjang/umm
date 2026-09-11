// Takes the screenshots docs/USER_GUIDE.md and docs/ADMIN_GUIDE.md embed.
//
// Every picture is a real screen of a running umm at 1440x900 — nothing is
// mocked or routed. The script seeds a throwaway space with fake data so list
// screens are not empty, so it must only ever point at a disposable
// deployment: the target and the account come from capture-only environment
// variables and the script refuses to run without them.
//
//   UMM_CAPTURE_BASE_URL        e.g. http://127.0.0.1:18090 (required)
//   UMM_CAPTURE_ADMIN           bootstrap admin login (required)
//   UMM_CAPTURE_ADMIN_PASSWORD  its password (required)
//   UMM_CAPTURE_ALLOW_REMOTE=1  only if the target is not loopback and you
//                               are sure it is disposable
//
// It changes no global setting: admin screens are only opened, never saved.
const fs = require('fs');
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'web', 'node_modules', '@playwright', 'test'));

const SCREENSHOT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

function required(name) {
  const value = (process.env[name] || '').trim();
  if (!value) {
    console.error(`❌ ${name} is not set. This script seeds data into the target; set it to a disposable umm only.`);
    process.exit(2);
  }
  return value;
}

const BASE_URL = required('UMM_CAPTURE_BASE_URL').replace(/\/+$/, '');
const ADMIN = required('UMM_CAPTURE_ADMIN');
const ADMIN_PASSWORD = required('UMM_CAPTURE_ADMIN_PASSWORD');

{
  const host = new URL(BASE_URL).hostname;
  const loopback = host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  if (!loopback && process.env.UMM_CAPTURE_ALLOW_REMOTE !== '1') {
    console.error(`❌ ${BASE_URL} is not loopback. Set UMM_CAPTURE_ALLOW_REMOTE=1 only for a deployment you can throw away.`);
    process.exit(2);
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settle(page) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await sleep(700);
}

async function capture(page, filename) {
  await settle(page);
  await page.screenshot({ path: path.join(SCREENSHOT_DIR, filename), fullPage: false });
  console.log(`📸 ${filename}`);
}

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR' });
  const page = await context.newPage();

  // Login
  await page.goto(`${BASE_URL}/login`);
  await page.waitForSelector('text=생각부터 붙이세요.');
  await capture(page, 'login.png');
  await page.locator('input[autocomplete="username"], input:not([type="password"])').first().fill(ADMIN);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 });
  await settle(page);

  const cookieHeader = (await context.cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const headers = { Cookie: cookieHeader, 'Content-Type': 'application/json' };
  const call = async (method, route, body) => {
    const res = await fetch(`${BASE_URL}/api/v1${route}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${route} -> ${res.status} ${text}`);
    return text ? JSON.parse(text) : {};
  };

  // Seed: one space with a few thoughts and connections. All fake.
  const created = await call('POST', '/spaces', { name: '데모 회사 — 2026 하반기 제품 기획' });
  const spaceId = created.space?.id || created.id;
  await call('POST', '/spaces', { name: '데모 회사 — 온보딩 개선' });

  const note = (body) => call('POST', `/spaces/${spaceId}/notes`, { kind: 'thought', width: 290, height: 200, ...body });
  const n1 = await note({ title: '고객 인터뷰 요약', content: '세 팀 모두 "정리는 나중에, 생각부터 붙이고 싶다"고 답했다. 폴더 구조가 먼저 오면 적기를 미룬다.', color: 'yellow', x: 160, y: 120 });
  const n2 = await note({ kind: 'idea', title: '밤사이 Dream이 이어 주는 것', content: '낮에 붙인 생각 사이의 연결을 밤에 제안받고, 아침에 검토해 채택하거나 접는다.', color: 'purple', x: 640, y: 100 });
  const n3 = await note({ kind: 'question', title: 'SSO 도입 조건', content: '사내 Keycloak 과 연동되어야 하고, 관리자 역할은 그룹으로 매핑한다.', color: 'blue', x: 180, y: 440 });
  const n4 = await note({ title: '발표 자료로 바로 만들기', content: '캔버스의 순서 그대로 슬라이드가 나오면 회의 전에 따로 정리할 필요가 없다.', color: 'green', x: 660, y: 430 });
  const n5 = await note({ title: '이번 분기에 접은 선택', content: '자체 임베딩 모델 학습은 접었다 — 이유: 운영 인력이 없다.', color: 'gray', x: 1120, y: 260 });

  await call('POST', `/spaces/${spaceId}/edges`, { source: n1.id, target: n2.id, relation: 'related' });
  await call('POST', `/spaces/${spaceId}/edges`, { source: n1.id, target: n3.id, relation: 'related' });
  await call('POST', `/spaces/${spaceId}/edges`, { source: n2.id, target: n4.id, relation: 'follows' });
  await call('POST', `/spaces/${spaceId}/edges`, { source: n4.id, target: n5.id, relation: 'contradicts' }).catch(() => {});

  await call('POST', '/approvals', {
    resourceType: 'space',
    action: 'space_share',
    requesterName: '홍길동',
    comment: '제품 기획 캔버스를 마케팅팀과 공유하고 싶습니다.',
  }).catch((err) => console.warn('approval seed skipped:', err.message));

  // Today
  await page.goto(`${BASE_URL}/today`);
  await capture(page, 'today.png');

  // Canvas
  await page.goto(`${BASE_URL}/space/${spaceId}`);
  await page.waitForSelector('.react-flow__node');
  await sleep(1200);
  await capture(page, 'canvas.png');

  const postit = page.locator('.react-flow__node').first();
  const noteMenuBtn = postit.locator('button[aria-label="메모 메뉴"]').first();
  if (await noteMenuBtn.count() > 0) {
    await postit.hover();
    await noteMenuBtn.click();
    await capture(page, 'canvas-note-menu.png');
    await page.keyboard.press('Escape');
    await sleep(300);
  }

  const openToolbar = async (label, filename) => {
    const btn = page.locator(`button[aria-label="${label}"]`).first();
    if ((await btn.count()) === 0) {
      console.warn(`⚠️ toolbar button "${label}" not found; skipped ${filename}`);
      return false;
    }
    await btn.click();
    await capture(page, filename);
    await page.keyboard.press('Escape');
    await sleep(300);
    return true;
  };

  await openToolbar('공간 공유', 'canvas-share.png');
  await openToolbar('내보내기', 'canvas-export-menu.png');
  await openToolbar('AI 생각 도구', 'canvas-ai-tools.png');
  await openToolbar('이 공간을 발표 자료로', 'canvas-presentation.png');
  await openToolbar('되감기', 'canvas-rewind.png');

  // Decisions, Dreams
  await page.goto(`${BASE_URL}/decisions`);
  await capture(page, 'decisions.png');
  await page.goto(`${BASE_URL}/dreams`);
  await capture(page, 'dreams.png');

  // Personal settings and API keys
  await page.goto(`${BASE_URL}/settings`);
  await page.waitForSelector('text=나에게 맞는 umm');
  await capture(page, 'settings.png');
  const newKeyBtn = page.locator('button:has-text("새 키")').first();
  if (await newKeyBtn.count() > 0) {
    await newKeyBtn.scrollIntoViewIfNeeded();
    await newKeyBtn.click();
    await page.waitForSelector('.mantine-Modal-content');
    await capture(page, 'settings-api-key-new.png');
    await page.keyboard.press('Escape');
    await sleep(300);
  }

  // Approvals
  await page.goto(`${BASE_URL}/approvals`);
  await page.waitForSelector('text=검토 · 승인');
  await capture(page, 'approvals.png');

  // Admin — opened only, never saved.
  const admin = async (section, marker, filename) => {
    await page.goto(`${BASE_URL}/admin/${section}`);
    if (marker) await page.waitForSelector(`text=${marker}`);
    await capture(page, filename);
  };
  await admin('overview', '운영 현황', 'admin-overview.png');
  await admin('general', '서비스 기본 정보', 'admin-general.png');
  await admin('oidc', 'Keycloak SSO', 'admin-oidc.png');
  await admin('dream', null, 'admin-dream.png');
  await admin('ai_gateway', null, 'admin-ai-gateway.png');
  await admin('ptium', null, 'admin-ptium.png');
  await admin('intelligence', null, 'admin-intelligence.png');
  await admin('security', null, 'admin-security.png');
  await admin('workflow', null, 'admin-workflow.png');
  await admin('users', null, 'admin-users.png');
  await admin('spaces', null, 'admin-spaces.png');
  await admin('webhooks', null, 'admin-webhooks.png');
  await admin('audit', '감사 로그', 'admin-audit.png');

  await browser.close();
  console.log('🎉 screenshots written to docs/screenshots');
}

main().catch((err) => {
  console.error('❌ capture failed:', err);
  process.exit(1);
});
