import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * Reaching the page without a mouse.
 *
 * Counted from a fresh page before this existed: five header controls and seven
 * sidebar links stood between the start of the document and the page's own
 * content. Someone working from the keyboard walked all twelve on every page
 * they opened, before arriving at what they came for.
 *
 * The link is moved off-screen rather than hidden, because display:none and
 * visibility:hidden both take an element out of the tab order — which would
 * remove the only thing it is for.
 */
test.describe('keyboard', () => {
  test('the first tab stop skips the chrome and lands on the content', async ({ page }) => {
    await signIn(page);
    await page.goto('/today');
    await expect(page.getByRole('heading', { name: '오늘, 이어볼 생각' })).toBeVisible();

    await page.evaluate(() => document.body.focus());
    await page.keyboard.press('Tab');

    const skip = page.getByRole('link', { name: '본문으로 건너뛰기' });
    await expect(skip).toBeFocused();
    // Focus must be somewhere the person can see. A focused control parked
    // off-screen is worse than no shortcut at all.
    await expect(skip).toBeInViewport();

    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();

    // And the keyboard carries on from the content rather than starting the
    // header over again.
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: '생각 붙이기', exact: true })).toBeFocused();
  });

  test('it stays out of the way until it is reached', async ({ page }) => {
    await signIn(page);
    await page.goto('/today');
    await expect(page.getByRole('heading', { name: '오늘, 이어볼 생각' })).toBeVisible();

    // Present in the tab order, but not on screen while nothing is focused.
    const skip = page.getByRole('link', { name: '본문으로 건너뛰기' });
    await expect(skip).toHaveCount(1);
    await expect(skip).not.toBeInViewport();
  });

  test('every page offers it, not just the first one', async ({ page }) => {
    await signIn(page);
    for (const path of ['/dreams', '/decisions', '/settings']) {
      await page.goto(path);
      // The shell renders before the route's own content; tabbing into a page
      // that is still arriving measures the wrong document.
      await expect(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible();
      await page.evaluate(() => document.body.focus());
      await page.keyboard.press('Tab');
      await expect(page.getByRole('link', { name: '본문으로 건너뛰기' }), `no skip link on ${path}`).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(page.locator('main'), `${path} did not move focus to its content`).toBeFocused();
    }
  });

  /**
   * One main landmark per page.
   *
   * Mantine's AppShell renders the page's main region, and every screen was
   * rendering a second <main> inside it. Nested main elements are invalid, and
   * a reader navigating by landmark met "main" twice with nothing to say which
   * held the content. The skip link made it concrete: there were two candidates
   * to send focus to.
   */
  test('each page has exactly one main landmark', async ({ page }) => {
    await signIn(page);
    for (const path of ['/today', '/canvas', '/dreams', '/decisions', '/approvals', '/settings']) {
      await page.goto(path);
      await expect(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible();
      const count = await page.evaluate(() => document.querySelectorAll('main').length);
      expect(count, `${path} has ${count} main landmarks`).toBe(1);
    }
  });
});
