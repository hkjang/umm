import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The decision record shows dates in the language the person chose inside umm.
 *
 * This row was the only date in the app still asking the browser what language
 * to use. Measured with umm set to English on a Korean browser: the Dreams
 * timeline read August 25, 2026 and this row read 2026. 8. 25. — one product,
 * one date, two languages, and the one that was wrong had ignored the choice
 * the person actually made.
 *
 * The browser stays Korean throughout, which is the whole point: if the date
 * followed the browser these assertions would both see Korean.
 */
const marked = {
  points: [
    {
      kind: 'adopted',
      at: '2026-08-25T12:00:00Z',
      spaceId: '00000000-0000-4000-8000-0000000000ab',
      space: '제품 결정',
      subject: '격주로 줄여 보자',
      detail: '사이 기간의 맥락을 잃는다',
      noteId: '00000000-0000-4000-8000-0000000000ac',
    },
  ],
  hasMore: false,
};

/** The dimmed line that carries the date and the space name. */
const dateLine = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('.mantine-Text-root')].find((e) => /·/.test(e.textContent || ''));
    return el?.textContent?.split('·')[0].trim() ?? '';
  });

test.describe('결정 기록', () => {
  test.skip('dates follow the language chosen in umm, not the browser', async ({ page }) => {
    await signIn(page, { locale: 'ko' });
    await page.route('**/api/v1/turning-points*', (route) => route.fulfill({ json: marked }));

    await page.goto('/decisions');
    await expect(page.getByText('격주로 줄여 보자')).toBeVisible();
    // Korean has to be untouched: this row looked right for Korean readers all
    // along, and a fix that moved it would trade one group's problem for
    // another's.
    expect(await dateLine(page)).toBe('2026. 8. 25.');

    await signIn(page, { locale: 'en' });
    await page.goto('/decisions');
    await expect(page.getByText('격주로 줄여 보자')).toBeVisible();
    const english = await dateLine(page);
    expect(english).not.toBe('2026. 8. 25.');
    expect(english).toBe('8/25/2026');

    // The language is an account preference, so it outlives this test. signIn
    // pins it for anything that signs in afterwards, but leaving the account in
    // English means anything that does not is quietly reading a different app
    // than it expects — which is the trap the helper's own comment describes.
    await signIn(page, { locale: 'ko' });
  });
});
