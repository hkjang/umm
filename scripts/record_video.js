const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { chromium } = require(path.join(__dirname, '..', 'web', 'node_modules', '@playwright', 'test'));

const VIDEO_TMP_DIR = path.join(__dirname, '..', 'tmp_video_record');
const OUTPUT_MP4 = path.join(__dirname, '..', 'docs', 'umm_overview.mp4');
const FFMPEG_BIN = path.join(__dirname, '..', 'bin', 'ffmpeg');

if (!fs.existsSync(VIDEO_TMP_DIR)) {
  fs.mkdirSync(VIDEO_TMP_DIR, { recursive: true });
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function setSubtitle(page, stepNum, title, desc) {
  await page.evaluate(({ stepNum, title, desc }) => {
    let el = document.getElementById('umm-video-subtitle');
    if (!el) {
      el = document.createElement('div');
      el.id = 'umm-video-subtitle';
      el.style.position = 'fixed';
      el.style.bottom = '28px';
      el.style.left = '50%';
      el.style.transform = 'translateX(-50%)';
      el.style.background = 'rgba(26, 18, 36, 0.94)';
      el.style.backdropFilter = 'blur(16px)';
      el.style.border = '2px solid #705391';
      el.style.borderRadius = '16px';
      el.style.padding = '14px 32px';
      el.style.color = '#ffffff';
      el.style.boxShadow = '0 16px 48px rgba(0, 0, 0, 0.6)';
      el.style.zIndex = '999999';
      el.style.maxWidth = '960px';
      el.style.width = '85%';
      el.style.textAlign = 'center';
      el.style.fontFamily = "'Pretendard', sans-serif";
      el.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
      document.body.appendChild(el);
    }
    el.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:4px;">
        <span style="background:#ffaa54;color:#1e142b;font-weight:900;font-size:12px;padding:2px 8px;border-radius:6px;">${stepNum}</span>
        <span style="font-size:19px;font-weight:850;color:#ffaa54;letter-spacing:-0.3px;">${title}</span>
      </div>
      <div style="font-size:15px;color:#f3ecfa;font-weight:550;line-height:1.5;">${desc}</div>
    `;
  }, { stepNum, title, desc });
}

async function smoothScroll(page, distance, steps = 10) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate((d) => window.scrollBy(0, d), distance / steps);
    await sleep(60);
  }
}

async function main() {
  console.log('🎬 Starting umm Playwright High-Definition 3-Minute Video Recording...');
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    recordVideo: {
      dir: VIDEO_TMP_DIR,
      size: { width: 1920, height: 1080 },
    },
    locale: 'ko-KR',
  });

  const page = await context.newPage();
  const BASE_URL = 'http://127.0.0.1:8080';

  // SCENE 1: Intro Slide (12s)
  console.log('🎥 Scene 1: Intro Slide...');
  const introPath = 'file://' + path.join(__dirname, 'video_slides', 'intro.html');
  await page.goto(introPath);
  await sleep(12000);

  // SCENE 2: Login Page (10s)
  console.log('🎥 Scene 2: Login Page...');
  await page.goto(`${BASE_URL}/login`);
  await setSubtitle(
    page,
    '01 / 08',
    '인증 및 엔터프라이즈 SSO (Authentication & OIDC)',
    '부트스트랩 관리자 인증 및 Keycloak OIDC Discovery 기반 SSO를 지원합니다.'
  );
  await sleep(3500);
  await page.locator('input[autocomplete="username"], input:not([type="password"])').first().fill('admin');
  await sleep(1200);
  await page.locator('input[type="password"]').fill('admin12345678');
  await sleep(1200);
  await page.click('button[type="submit"]');
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 10000 });
  await sleep(1500);

  // Find active space
  const cookies = await context.cookies();
  const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const authHeaders = { Cookie: cookieHeader, 'Content-Type': 'application/json' };
  const spacesRes = await (await fetch(`${BASE_URL}/api/v1/spaces`, { headers: authHeaders })).json();
  const targetSpaceId = spacesRes.spaces?.[0]?.id || spacesRes[0]?.id;

  // SCENE 3: Spatial Infinite Canvas (35s)
  console.log('🎥 Scene 3: Infinite Thought Canvas...');
  await page.goto(`${BASE_URL}/space/${targetSpaceId}`);
  await page.waitForSelector('.react-flow__node');
  await setSubtitle(
    page,
    '02 / 08',
    'React Flow 기반 무한 생각 캔버스 (Spatial Thought Memory)',
    '더블클릭, N, /, 하단 캡처 바로 즉시 포스트잇을 붙이고, 저장 버튼 없이 실시간 자동 저장됩니다.'
  );
  await sleep(8000);

  // Hover and select a note
  const postit = page.locator('.react-flow__node').first();
  await postit.hover();
  await setSubtitle(
    page,
    '02 / 08',
    '7가지 시맨틱 파스텔 컬러 & 자유로운 크기 조절',
    '노랑, 파랑, 보라, 라벤더, 초록, 빨강, 회색 팔레트로 맥락을 분류하고 크기를 자유롭게 변경합니다.'
  );
  await sleep(8000);

  // Open note action menu
  const noteMenuBtn = postit.locator('button[aria-label="메모 메뉴"]').first();
  if (await noteMenuBtn.count() > 0) {
    await noteMenuBtn.click();
    await setSubtitle(
      page,
      '02 / 08',
      '메모 버전 히스토리 스냅샷 & 안전한 이전 버전 복원',
      '수정 이력을 언제든 확인하고 과거 시점의 스냅샷으로 안전하게 롤백할 수 있습니다.'
    );
    await sleep(7000);
    await page.keyboard.press('Escape');
    await sleep(1500);
  }

  // SCENE 4: Thought Gravity & Offline Semantics (28s)
  console.log('🎥 Scene 4: Thought Gravity & Semantics...');
  const gravityBtn = page.locator('button[aria-label="Thought Gravity"]').first();
  if (await gravityBtn.count() > 0) {
    await postit.click();
    await sleep(1000);
    await gravityBtn.click();
    await setSubtitle(
      page,
      '03 / 08',
      'Thought Gravity: 연결된 생각의 원형 궤도 정렬',
      '중심 생각을 기준으로 연결된 모든 관련 메모들이 아름다운 원형 궤도를 그리며 한곳에 모입니다.'
    );
    await sleep(8000);
  }

  // AI tools
  const aiBtn = page.locator('button[aria-label="AI 생각 도구"]').first();
  if (await aiBtn.count() > 0) {
    await aiBtn.click();
    await setSubtitle(
      page,
      '03 / 08',
      '5대 생각 발전 도구 (AI Thought Expander)',
      '요약, 질문 만들기, 확장, 반대 관점, 실행 항목 도구로 아이디어를 발전시킵니다.'
    );
    await sleep(7000);
    await page.keyboard.press('Escape');
    await sleep(1500);
  }

  // SCENE 5: Space Collaboration & Export (25s)
  console.log('🎥 Scene 5: Space Collaboration & Export...');
  const shareBtn = page.locator('button[aria-label="공간 공유"]').first();
  if (await shareBtn.count() > 0) {
    await shareBtn.click();
    await page.waitForSelector('.mantine-Modal-content');
    await setSubtitle(
      page,
      '04 / 08',
      '공간 협업 & 세분화된 멤버 권한 제어',
      '팀원을 초대하여 보기/편집/관리 권한을 부여하고 팀장 승인 절차를 연동할 수 있습니다.'
    );
    await sleep(7000);
    await page.keyboard.press('Escape');
    await sleep(1500);
  }

  const exportBtn = page.locator('button[aria-label="내보내기"]').first();
  if (await exportBtn.count() > 0) {
    await exportBtn.click();
    await setSubtitle(
      page,
      '04 / 08',
      '1클릭 다중 포맷 내보내기 (Markdown, PNG, A4 PDF)',
      '캔버스 전체 전경을 정리된 Markdown 문서, 고해상도 투명 PNG, 또는 A4 PDF로 내보냅니다.'
    );
    await sleep(6000);
    await page.keyboard.press('Escape');
    await sleep(1500);
  }

  // SCENE 6: Dreams Timeline (20s)
  console.log('🎥 Scene 6: Dreams Timeline...');
  await page.goto(`${BASE_URL}/dreams`);
  await page.waitForSelector('text=Dreams');
  await setSubtitle(
    page,
    '05 / 08',
    '밤사이 자라난 생각, Dreams 타임라인',
    '야간 스케줄러가 축적된 생각들을 연결하여 새로운 관점과 질문을 담은 Dream 카드를 생성합니다.'
  );
  await sleep(8000);
  await smoothScroll(page, 200, 8);
  await sleep(6000);

  // SCENE 7: Personal Preferences & Scoped API/MCP Keys (22s)
  console.log('🎥 Scene 7: Personal Preferences & API Keys...');
  await page.goto(`${BASE_URL}/settings`);
  await page.waitForSelector('text=나에게 맞는 umm');
  await setSubtitle(
    page,
    '06 / 08',
    '개인화 설정 & 최소 권한 Scoped API / MCP 키',
    'Dream 빈도·스타일과 연결선 형태를 설정하고, 최소 권한 Bearer API 키를 발급합니다.'
  );
  await sleep(8000);
  await smoothScroll(page, 250, 8);
  await sleep(6000);

  // SCENE 8: Admin Console, 256K Dream Layer & Observability (35s)
  console.log('🎥 Scene 8: Admin Console...');
  await page.goto(`${BASE_URL}/admin/overview`);
  await page.waitForSelector('text=운영 현황');
  await setSubtitle(
    page,
    '07 / 08',
    '운영 관측성 대시보드 & Dream 비용 분석',
    '전체 사용자, 생각 수, 월 예상 비용($) 및 Dream 유지율/발전율 지표를 실시간 모니터링합니다.'
  );
  await sleep(7000);

  await page.goto(`${BASE_URL}/admin/dream`);
  await page.waitForSelector('text=Dream Settings');
  await setSubtitle(
    page,
    '07 / 08',
    'Dream Layer: 256K Context Window & Quiet Mode',
    '초거대 모델을 위한 256K 토큰 한도 제어와 가치 있는 생각만 선별하는 Quiet Mode를 구성합니다.'
  );
  await sleep(8000);

  await page.goto(`${BASE_URL}/admin/audit`);
  await page.waitForSelector('text=감사 로그');
  await setSubtitle(
    page,
    '07 / 08',
    '추가 전용(Append-only) 불변 감사 로그',
    '모든 관리자 행위와 설정 변경, 권한 수정을 위변조 없이 영구 보존 및 추적합니다.'
  );
  await sleep(7000);

  // SCENE 9: Outro Slide (14s)
  console.log('🎥 Scene 9: Outro Slide...');
  const outroPath = 'file://' + path.join(__dirname, 'video_slides', 'outro.html');
  await page.goto(outroPath);
  await sleep(14000);

  // Close browser to flush video
  console.log('💾 Closing browser and finalizing video stream...');
  const video = page.video();
  await browser.close();

  if (video) {
    const videoPath = await video.path();
    console.log(`Original video saved to: ${videoPath}`);

    // Transcode to clean MP4 using ffmpeg
    console.log(`Transcoding to 1080p MP4: ${OUTPUT_MP4}...`);
    const ffmpegCmd = `"${FFMPEG_BIN}" -y -i "${videoPath}" -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p -r 30 "${OUTPUT_MP4}"`;
    execSync(ffmpegCmd, { stdio: 'inherit' });
    console.log(`✅ MP4 Video generated successfully: ${OUTPUT_MP4}`);

    // Clean up temporary video dir
    fs.rmSync(VIDEO_TMP_DIR, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error('❌ Video generation failed:', err);
  process.exit(1);
});
