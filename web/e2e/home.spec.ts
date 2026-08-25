import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The home screen counts and the home screen lists have to agree.
 *
 * The tiles report true totals; every list under them is capped — eight for the
 * review queue, six for unconnected thoughts, five for dreams, eight for
 * activity. Measured on a worked-in account the tile read 12 beside 다시 볼
 * 생각 and eight cards followed it, with nothing on the page to reconcile the
 * two. A person who counts the cards concludes the number is wrong, or worse,
 * that a queue they have not cleared is clear.
 *
 * The payload is stubbed because the review queue only fills with thoughts
 * older than fourteen days, and a browser cannot age them. What is being tested
 * is the page's own arithmetic, in a real browser, against a response shaped
 * like the one the server sends.
 */
const item = (n: number) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  spaceId: '00000000-0000-4000-8000-00000000000a',
  spaceName: '제품 결정',
  title: `생각 ${n}`,
  content: `본문 ${n}`,
  pinned: false,
  updatedAt: '2026-08-01T00:00:00Z',
  reason: '오랫동안 열지 않음',
});

const payload = (counts: { review: number; orphans: number; dreams: number; activity: number }) => ({
  review: Array.from({ length: 8 }, (_, i) => item(i + 1)),
  orphans: [item(90)],
  dreams: [],
  activity: [],
  onboarding: { completedAt: '2026-08-01T00:00:00Z', percent: 100, steps: [] },
  counts,
});

/** What the page sends back for someone who has only just arrived. */
const fresh = {
  review: [],
  orphans: [],
  dreams: [],
  activity: [],
  onboarding: {
    percent: 25,
    steps: [
      {
        key: 'space',
        label: '생각 공간 확인',
        description: '내 공간을 열어 구조를 살펴보세요.',
        done: true,
        target: '/',
      },
      { key: 'note', label: '첫 생각 붙이기', description: '짧은 문장 하나면 충분합니다.', done: false, target: '/' },
      {
        key: 'connect',
        label: '생각 연결하기',
        description: '관련 있는 두 생각을 선으로 연결하세요.',
        done: false,
        target: '/',
      },
      {
        key: 'collaborate',
        label: '대화 또는 Dream 반응',
        description: '댓글을 남기거나 Dream에 반응하세요.',
        done: false,
        target: '/dreams',
      },
    ],
  },
  counts: { review: 0, orphans: 0, dreams: 0, activity: 0 },
};

test.describe('오늘의 리뷰', () => {
  test('says how many it is holding back, and only when it is', async ({ page }) => {
    await signIn(page);
    await page.route('**/api/v1/today', (route) =>
      route.fulfill({ json: payload({ review: 12, orphans: 1, dreams: 0, activity: 0 }) }),
    );
    await page.goto('/today');

    // Twelve counted, eight shown: the page has to say so rather than leave the
    // person to notice the gap.
    await expect(page.getByText('12개 중 8개를 보여드립니다.')).toBeVisible();
    // And say what closes it, because the four left out are reachable — they
    // arrive as the visible ones are cleared.
    await expect(page.getByText('검토하거나 미루면 다음 생각이 올라옵니다.')).toBeVisible();

    // The unconnected section shows everything it counted, so it must stay
    // quiet. A rule that announced a gap that was not there would be its own
    // defect.
    await expect(page.getByText('1개 중 1개를 보여드립니다.')).toHaveCount(0);
  });

  test('stays quiet when every list is complete', async ({ page }) => {
    await signIn(page);
    await page.route('**/api/v1/today', (route) =>
      route.fulfill({ json: payload({ review: 8, orphans: 1, dreams: 0, activity: 0 }) }),
    );
    await page.goto('/today');

    await expect(page.getByRole('heading', { name: '다시 볼 생각', exact: true })).toBeVisible();
    await expect(page.getByText(/개 중 .*개를 보여드립니다\./)).toHaveCount(0);
  });

  // Asking a memory that holds nothing can only answer that it found nothing,
  // so it must not be the first thing offered to someone who has not written
  // anything yet. The guide goes first until it is finished — and it finishes
  // itself, so nobody is left looking at a checklist with nothing left on it.
  test('leads with the guide until it is finished', async ({ page }) => {
    await signIn(page);
    await page.route('**/api/v1/today', (route) => route.fulfill({ json: fresh }));
    await page.goto('/today');

    const guide = page.getByRole('heading', { name: 'umm을 내 생각 습관에 연결하기' });
    const ask = page.getByRole('heading', { name: '내 기억에 물어보기' });
    await expect(guide).toBeVisible();
    await expect(ask).toBeVisible();

    const order = await page.evaluate(() => {
      const heading = (text: string) =>
        [...document.querySelectorAll('main h1,main h2,main h3')].find((h) => h.textContent?.trim() === text);
      const guideEl = heading('umm을 내 생각 습관에 연결하기');
      const askEl = heading('내 기억에 물어보기');
      if (!guideEl || !askEl) return 'missing';
      return guideEl.compareDocumentPosition(askEl) & Node.DOCUMENT_POSITION_FOLLOWING ? 'guide-first' : 'ask-first';
    });
    expect(order).toBe('guide-first');
  });
});
