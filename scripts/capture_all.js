const fs = require('fs');
const path = require('path');
const { chromium } = require(path.join(__dirname, '..', 'web', 'node_modules', '@playwright', 'test'));

const SCREENSHOT_DIR = path.join(__dirname, '..', 'docs', 'screenshots');
if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capture(page, filename, options = {}) {
  const filepath = path.join(SCREENSHOT_DIR, filename);
  await sleep(600);
  await page.screenshot({ path: filepath, fullPage: options.fullPage ?? false });
  console.log(`📸 Captured: ${filename}`);
}

async function main() {
  console.log('🚀 Starting umm Automated E2E CRU Testing & Screenshot Pipeline...');

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'ko-KR',
  });

  const page = await context.newPage();
  const BASE_URL = 'http://127.0.0.1:8080';

  // 1. Login Page
  console.log('--- 1. Login Page ---');
  await page.goto(`${BASE_URL}/login`);
  await page.waitForSelector('text=생각부터 붙이세요.');
  await capture(page, '01_login.png');

  // Perform Login
  await page.locator('input[autocomplete="username"], input:not([type="password"])').first().fill('admin');
  await page.locator('input[type="password"]').fill('admin12345678');
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 });
  await sleep(1500);

  // Setup rich initial seed data via API
  console.log('--- Setting up Seed Data via API ---');
  const cookies = await context.cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const authHeaders = { Cookie: cookieHeader, 'Content-Type': 'application/json' };

  // 1. Create Spaces
  const space1Res = await (await fetch(`${BASE_URL}/api/v1/spaces`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: 'AI 제품 기획 & UX 아키텍처' }),
  })).json();
  const spaceId = space1Res.space?.id || space1Res.id;

  await fetch(`${BASE_URL}/api/v1/spaces`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ name: '엔터프라이즈 인프라 및 보안 체계' }),
  });

  // Create Notes in Space 1
  const note1 = await (await fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/notes`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      title: 'Spatial Thought Memory',
      content: '정리는 나중에, 생각부터 붙인다.\n무한 캔버스 공간 위에 직관적인 포스트잇 메모를 자유롭게 배치하고 연결합니다.',
      color: 'yellow',
      kind: 'postit',
      x: 160,
      y: 120,
      width: 290,
      height: 200,
    }),
  })).json();

  const note2 = await (await fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/notes`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      title: 'Dream Layer & Scheduler',
      content: '밤사이 축적된 생각들을 연결하고 새로운 관점을 제시하는 AI Dream 생성 엔진.\n최대 256K 토큰 지원.',
      color: 'purple',
      kind: 'postit',
      x: 640,
      y: 100,
      width: 290,
      height: 210,
    }),
  })).json();

  const note3 = await (await fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/notes`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      title: 'Keycloak SSO & 보안 격리',
      content: 'OIDC Discovery 기반 SSO 및 역할 매핑.\n32바이트 AES-256-GCM 봉투 암호화와 무중단 키 회전.',
      color: 'blue',
      kind: 'postit',
      x: 180,
      y: 440,
      width: 290,
      height: 200,
    }),
  })).json();

  const note4 = await (await fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/notes`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      title: '실시간 이벤트 & 협업',
      content: 'PostgreSQL LISTEN/NOTIFY 기반 실시간 캔버스 변경 동기화 및 멤버별 권한 제어.',
      color: 'green',
      kind: 'postit',
      x: 660,
      y: 430,
      width: 290,
      height: 200,
    }),
  })).json();

  // Create Edges
  if (note1.id && note2.id) {
    await fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/edges`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ source: note1.id, target: note2.id, relation: 'dreamed' }),
    });
  }
  if (note1.id && note3.id) {
    await fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/edges`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ source: note1.id, target: note3.id, relation: 'related' }),
    });
  }
  if (note2.id && note4.id) {
    await fetch(`${BASE_URL}/api/v1/spaces/${spaceId}/edges`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ source: note2.id, target: note4.id, relation: 'related' }),
    });
  }

  // Create approval request
  await fetch(`${BASE_URL}/api/v1/approvals`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      resourceType: 'space',
      action: 'space_share',
      requesterName: '홍길동 수석연구원',
      comment: '2026 하반기 신규 AI 제품 기획 캔버스 전사 공유 승인 요청',
    }),
  });

  // Reload Canvas with rich seed data
  console.log('--- 2. Canvas Overview ---');
  await page.goto(`${BASE_URL}/space/${spaceId}`);
  await page.waitForSelector('.react-flow__node');
  await sleep(1500);
  await capture(page, '02_canvas_overview.png');

  // 3. Post-it Note Hover & Editing
  console.log('--- 3. Note Editing & Palette ---');
  const postit = page.locator('.react-flow__node').first();
  await postit.hover();
  await sleep(400);
  await capture(page, '03_note_editing.png');

  // 4. Note Actions Menu
  console.log('--- 4. Note Action Dropdown ---');
  const noteMenuBtn = postit.locator('button[aria-label="메모 메뉴"]').first();
  if (await noteMenuBtn.count() > 0) {
    await noteMenuBtn.click();
    await sleep(400);
    await capture(page, '04_note_history_modal.png');
    await page.keyboard.press('Escape');
    await sleep(400);
  }

  // 5. Thought Gravity Trigger
  console.log('--- 5. Thought Gravity ---');
  const gravityBtn = page.locator('button[aria-label="Thought Gravity"]').first();
  if (await gravityBtn.count() > 0) {
    await postit.click();
    await sleep(300);
    await gravityBtn.click();
    await sleep(800);
    await capture(page, '05_thought_gravity.png');
  }

  // 6. Space Manager Modal
  console.log('--- 6. Space Manager Modal ---');
  const spaceSwitcher = page.locator('button.space-switcher').first();
  if (await spaceSwitcher.count() > 0) {
    await spaceSwitcher.click();
    await sleep(400);
    const manageSpaceItem = page.locator('div[role="menuitem"]:has-text("공간 관리"), button:has-text("공간 관리")').first();
    if (await manageSpaceItem.count() > 0) {
      await manageSpaceItem.click();
      await page.waitForSelector('.mantine-Modal-content');
      await capture(page, '08_space_manager_modal.png');
      await page.keyboard.press('Escape');
      await sleep(500);
    }
  }

  // 7. Space Share Modal
  console.log('--- 7. Space Share Modal ---');
  const shareBtn = page.locator('button[aria-label="공간 공유"]').first();
  if (await shareBtn.count() > 0) {
    await shareBtn.click();
    await page.waitForSelector('.mantine-Modal-content');
    await capture(page, '09_space_share_modal.png');
    await page.keyboard.press('Escape');
    await sleep(500);
  }

  // 8. Export Menu
  console.log('--- 8. Export Menu ---');
  const exportBtn = page.locator('button[aria-label="내보내기"]').first();
  if (await exportBtn.count() > 0) {
    await exportBtn.click();
    await sleep(400);
    await capture(page, '10_export_menu.png');
    await page.keyboard.press('Escape');
    await sleep(400);
  }

  // 9. AI Tools Menu
  console.log('--- 9. AI Assist Menu ---');
  const aiBtn = page.locator('button[aria-label="AI 생각 도구"]').first();
  if (await aiBtn.count() > 0) {
    await aiBtn.click();
    await sleep(400);
    await capture(page, '07_ai_assist_modal.png');
    await page.keyboard.press('Escape');
    await sleep(400);
  }

  // 10. Dreams Page (/dreams)
  console.log('--- 10. Dreams Timeline Page ---');
  await page.goto(`${BASE_URL}/dreams`);
  await page.waitForSelector('text=Dreams');
  await capture(page, '12_dreams_timeline.png');

  // 11. Personal Settings (/settings)
  console.log('--- 11. Personal Settings ---');
  await page.goto(`${BASE_URL}/settings`);
  await page.waitForSelector('text=나에게 맞는 umm');
  await capture(page, '13_personal_settings.png');

  // 12. API Key Create Modal
  console.log('--- 12. API Key Create Modal ---');
  const newKeyBtn = page.locator('button:has-text("새 키")').first();
  if (await newKeyBtn.count() > 0) {
    await newKeyBtn.click();
    await page.waitForSelector('.mantine-Modal-content');
    await capture(page, '14_api_keys_create_modal.png');
    // Issue a sample API key
    await page.click('button:has-text("키 만들기")');
    await sleep(800);
    await capture(page, '15_api_keys_list.png');
    await page.keyboard.press('Escape');
    await sleep(400);
  }

  // 13. Approvals Page (/approvals)
  console.log('--- 13. Approvals Page ---');
  await page.goto(`${BASE_URL}/approvals`);
  await page.waitForSelector('text=검토 · 승인');
  await capture(page, '16_approvals_list.png');

  // 14. Admin Pages (/admin/*)
  console.log('--- 14. Admin Overview ---');
  await page.goto(`${BASE_URL}/admin/overview`);
  await page.waitForSelector('text=운영 현황');
  await capture(page, '17_admin_overview.png');

  console.log('--- 15. Admin General ---');
  await page.goto(`${BASE_URL}/admin/general`);
  await page.waitForSelector('text=서비스 기본 정보');
  await capture(page, '18_admin_general.png');

  console.log('--- 16. Admin Keycloak SSO ---');
  await page.goto(`${BASE_URL}/admin/oidc`);
  await page.waitForSelector('text=Keycloak SSO');
  await capture(page, '19_admin_oidc.png');

  console.log('--- 17. Admin Dream Settings (256K tokens) ---');
  await page.goto(`${BASE_URL}/admin/dream`);
  await page.waitForSelector('text=Dream Settings');
  const btn256k = page.locator('button:has-text("256K")').first();
  if (await btn256k.count() > 0) {
    await btn256k.click();
    await sleep(300);
  }
  await capture(page, '20_admin_dream.png');

  console.log('--- 18. Admin AI Gateway ---');
  await page.goto(`${BASE_URL}/admin/ai_gateway`);
  await page.waitForSelector('text=내부 AI Gateway');
  await capture(page, '21_admin_ai_gateway.png');

  console.log('--- 19. Admin Security ---');
  await page.goto(`${BASE_URL}/admin/security`);
  await page.waitForSelector('text=개인 키 권한 체계');
  await capture(page, '22_admin_security.png');

  console.log('--- 20. Admin Workflow ---');
  await page.goto(`${BASE_URL}/admin/workflow`);
  await page.waitForSelector('text=팀장 검토 · 승인');
  await capture(page, '23_admin_workflow.png');

  console.log('--- 21. Admin Users ---');
  await page.goto(`${BASE_URL}/admin/users`);
  await page.waitForSelector('text=사용자');
  await capture(page, '24_admin_users.png');

  console.log('--- 22. Admin Audit ---');
  await page.goto(`${BASE_URL}/admin/audit`);
  await page.waitForSelector('text=감사 로그');
  await capture(page, '25_admin_audit.png');

  await browser.close();
  console.log('🎉 umm Full Screenshot Pipeline Completed Successfully!');
}

main().catch((err) => {
  console.error('❌ Automation script failed:', err);
  process.exit(1);
});
