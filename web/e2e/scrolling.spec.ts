import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * Long pages have to be reachable to the end.
 *
 * html, body and #root are held at overflow:hidden so the canvas can be a fixed
 * pan-and-zoom surface. That clipped every other page too: the review page
 * rendered over two thousand pixels of content inside a short window with no way
 * to reach the rest of it. Scrolling now belongs to the shell's main region, so
 * any page rendered inside it — including ones added later — can be scrolled.
 */
test.describe('page scrolling', () => {
  test.beforeEach(async ({ page }) => {
    // Short on purpose, so ordinary pages certainly overflow.
    await page.setViewportSize({ width: 1100, height: 520 });
    await signIn(page);
  });

  for (const [name, path] of [
    ['오늘의 리뷰', '/today'],
    ['결정 기록', '/decisions'],
    ['Dreams', '/dreams'],
    ['개인 설정', '/settings'],
  ] as const) {
    test(`reaches the end of ${name}`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole('navigation', { name: /^(주 메뉴|Main menu)$/ })).toBeVisible();
      await page.waitForTimeout(500);

      const reach = await page.evaluate(async () => {
        const main = document.querySelector('main');
        if (!main) return { overflowing: false, reachedEnd: false };
        const overflowing = main.scrollHeight > main.clientHeight + 2;
        main.scrollTop = main.scrollHeight;
        await new Promise((resolve) => requestAnimationFrame(resolve));
        return {
          overflowing,
          reachedEnd: main.scrollTop + main.clientHeight >= main.scrollHeight - 2,
        };
      });

      // A page that fits needs no scrolling; one that does not must scroll.
      expect(reach.reachedEnd).toBe(true);
      if (reach.overflowing) expect(reach.reachedEnd).toBe(true);
    });
  }

  // The canvas is the reason the document does not scroll, so it must not start.
  test('the canvas fills its space without scrolling', async ({ page }) => {
    const marker = unique('스크롤');
    const space = await page.evaluate(async (name) => {
      const created = await (
        await fetch('/api/v1/spaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
      ).json();
      return created.id;
    }, marker);

    await page.goto(`/space/${space}`);
    // Wait for the element being measured rather than a proxy for it: the
    // loading status assertion passes before the canvas has mounted at all,
    // which measured a height of zero.
    await expect(page.locator('.canvas-page')).toBeVisible();
    await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);

    const shape = await page.evaluate(() => {
      const main = document.querySelector('main');
      const canvas = document.querySelector('.canvas-page');
      return {
        mainOverflows: !!main && main.scrollHeight > main.clientHeight + 2,
        canvasHeight: canvas ? Math.round(canvas.getBoundingClientRect().height) : 0,
        mainClient: main ? main.clientHeight : 0,
      };
    });
    expect(shape.mainOverflows).toBe(false);
    // It fills what the shell gives it rather than guessing at the viewport.
    expect(shape.canvasHeight).toBeGreaterThan(0);
    expect(shape.canvasHeight).toBeLessThanOrEqual(shape.mainClient);
  });

  // On a phone the tab bar is fixed over the bottom, so the end of a long page
  // has to sit above it rather than underneath.
  test('the end of a long page clears the mobile tab bar', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 700 });
    await page.goto('/today');
    await expect(page.getByRole('navigation', { name: /^(주 메뉴|Main menu)$/ })).toBeVisible();
    await page.waitForTimeout(800);

    const clearance = await page.evaluate(async () => {
      const main = document.querySelector('main');
      const tabs = document.querySelector('.mobile-tabs');
      if (!main || !tabs || getComputedStyle(tabs).display === 'none') return null;
      main.scrollTop = main.scrollHeight;
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => setTimeout(resolve, 200));
      const cards = [...main.querySelectorAll('.mantine-Card-root')];
      const last = cards.at(-1);
      return last
        ? { lastBottom: last.getBoundingClientRect().bottom, tabTop: tabs.getBoundingClientRect().top }
        : null;
    });

    test.skip(clearance === null, 'the tab bar is not shown at this size');
    expect(clearance!.lastBottom).toBeLessThanOrEqual(clearance!.tabTop);
  });
});
