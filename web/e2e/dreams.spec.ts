import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The Dreams tabs count states; the list under them arrives thirty at a time.
 *
 * Measured with thirty-seven waiting: the tab read 검토함 30, and pressing
 * 이전 Dream 더 불러오기 — a button about older history, not about the queue —
 * changed it to 37. Meanwhile the home screen tile had 37 the whole time, so
 * two pages of the same product disagreed about the same number, and the one
 * that was wrong moved when you touched something unrelated.
 *
 * The response is stubbed because dreams are generated rather than written, so
 * a browser cannot make thirty-seven of them. What is under test is that the
 * label comes from the count the server sends and not from the rows on screen.
 */
const dream = (n: number, generatedAt = '2026-08-25T12:00:00Z') => ({
  dreamId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  type: 'connection',
  generatedAt,
  qualityScore: 0.7,
  qualityLabel: '보통',
  status: 'created',
  spaceId: '00000000-0000-4000-8000-0000000000aa',
  spaceName: '제품 결정',
  content: `검토를 기다리는 관점 ${n}번입니다.`,
  rationale: '두 메모가 같은 비용을 이야기합니다.',
  suggestedAction: '두 메모를 연결해 보세요.',
  generation: 1,
  sources: [],
});

const tabLabels = (page: import('@playwright/test').Page) =>
  page.evaluate(() =>
    [...(document.querySelector('.mantine-SegmentedControl-root')?.querySelectorAll('label') ?? [])].map((l) =>
      l.textContent?.trim(),
    ),
  );

test.describe('Dreams', () => {
  test('counts the queue, not the page it happens to have loaded', async ({ page }) => {
    await signIn(page);
    // One page of thirty, with more behind it, and a true total of thirty-seven.
    await page.route('**/api/v1/dreams?*', (route) =>
      route.fulfill({
        json: {
          dreams: Array.from({ length: 30 }, (_, i) => dream(i + 1)),
          nextCursor: 'next',
          counts: { inbox: 37, kept: 3, hidden: 4, all: 44 },
        },
      }),
    );
    await page.goto('/dreams');
    await expect(page.getByText('검토를 기다리는 관점 1번입니다.')).toBeVisible();

    // The label is the queue. Thirty rows are on screen; the tab must not say 30.
    expect(await tabLabels(page)).toEqual(['검토함 37', '채택됨 3', '숨김 4', '전체 44']);
  });

  test('the number does not move when more of the list is loaded', async ({ page }) => {
    await signIn(page);
    let call = 0;
    await page.route('**/api/v1/dreams?*', (route) => {
      call += 1;
      route.fulfill({
        json: {
          dreams: Array.from({ length: 30 }, (_, i) => dream(i + 30 * (call - 1) + 1)),
          nextCursor: call === 1 ? 'next' : '',
          counts: { inbox: 37, kept: 3, hidden: 4, all: 44 },
        },
      });
    });
    await page.goto('/dreams');
    await expect(page.getByText('검토를 기다리는 관점 1번입니다.')).toBeVisible();
    const before = await tabLabels(page);

    const more = page.getByRole('button', { name: /더 불러오기/ });
    await more.click();
    await expect(page.getByText('검토를 기다리는 관점 31번입니다.')).toBeVisible();

    // Loading older history tells you nothing new about how many are waiting.
    expect(await tabLabels(page)).toEqual(before);
  });

  // A timeline exists to show where one day ends and the next begins. Every
  // item used to carry its own date: measured with a full page loaded, that was
  // twenty-nine headings for two distinct days.
  test('dates the first dream of each day and not the ones after it', async ({ page }) => {
    await signIn(page);
    // Midday UTC on each side, so a runner's timezone offset cannot slide one
    // of these across midnight and make the test about something else.
    await page.route('**/api/v1/dreams?*', (route) =>
      route.fulfill({
        json: {
          dreams: [
            ...Array.from({ length: 5 }, (_, i) => dream(i + 1, '2026-08-25T12:00:00Z')),
            ...Array.from({ length: 4 }, (_, i) => dream(i + 6, '2026-08-24T12:00:00Z')),
          ],
          nextCursor: '',
          counts: { inbox: 9, kept: 0, hidden: 0, all: 9 },
        },
      }),
    );
    await page.goto('/dreams');
    await expect(page.getByText('검토를 기다리는 관점 9번입니다.')).toBeVisible();

    const headings = await page.evaluate(() =>
      [...document.querySelectorAll('.mantine-Timeline-itemTitle')].map((h) => h.textContent?.trim()),
    );
    // Nine dreams, two days, two dates.
    expect(headings).toHaveLength(2);
    expect(new Set(headings).size).toBe(2);
  });
});
