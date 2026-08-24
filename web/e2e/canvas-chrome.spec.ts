import { expect, test } from '@playwright/test';
import { openCanvas, signIn } from './helpers';

/**
 * The furniture around the canvas has to stay out of its own way.
 *
 * Every fault guarded here was invisible to reading the stylesheet and only
 * showed up in a measurement: the toolbar was capped at 650px on every screen,
 * so the space name — the one thing on the bar that says where you are — was
 * cut to "My S" on a 1440px display; the collapse breakpoint measured the
 * window rather than the canvas, so a 900px desktop was more cramped than a
 * 390px phone and the space name disappeared into a bare chevron; and the
 * minimap sat on top of the capture bar at 1180px.
 *
 * Widths are chosen either side of the breakpoint rather than at it, because
 * the sidebar means the window width and the canvas width are not the same
 * number.
 */

const boxes = async (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const box = (selector: string) => {
      const el = document.querySelector(selector);
      if (!el) return null;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return null;
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    return {
      controls: box('.react-flow__controls'),
      capture: box('.quick-capture'),
      minimap: box('.react-flow__minimap'),
      toolbar: box('.canvas-toolbar'),
    };
  });

type Box = { left: number; right: number; top: number; bottom: number };
const intersects = (a: Box | null, b: Box | null) =>
  !!a && !!b && a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

test.describe('canvas chrome', () => {
  for (const [name, width, height] of [
    ['a wide desktop', 1440, 900],
    ['a laptop', 1180, 820],
    ['a narrow window', 900, 800],
    ['a phone', 390, 780],
  ] as const) {
    test(`nothing sits on the capture bar at ${name}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await signIn(page);
      await openCanvas(page);
      await page.waitForTimeout(600);

      const seen = await boxes(page);
      expect(seen.capture, 'the capture bar is always present').not.toBeNull();
      // Typing a thought is the primary action on this page; anything laid over
      // it takes clicks meant for it.
      expect(intersects(seen.controls, seen.capture)).toBe(false);
      expect(intersects(seen.minimap, seen.capture)).toBe(false);
      // And the bar itself has to be reachable within the window.
      expect(seen.toolbar!.left).toBeGreaterThanOrEqual(0);
      expect(seen.toolbar!.right).toBeLessThanOrEqual(width + 1);
    });
  }

  // The bar grew to fit the window; before that it stayed at 650px and cut the
  // name off while the room to show it sat unused on either side.
  test('the space name is readable rather than clipped', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
    await openCanvas(page);

    const label = page.locator('.space-switcher .mantine-Button-label').first();
    await expect(label).toBeVisible();
    // scrollWidth exceeding clientWidth is what "…" actually means here; the
    // rendered text reads the same either way, so asserting on it proves
    // nothing.
    const clipped = await label.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(clipped).toBe(false);
  });

  // A window narrower than the breakpoint hands the actions to the overflow
  // menu, which is only an improvement if they are still reachable there.
  test('the actions stay reachable once the bar collapses', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 800 });
    await signIn(page);
    await openCanvas(page);

    await expect(page.locator('.canvas-toolbar-actions')).toBeHidden();
    const overflow = page.locator('.canvas-mobile-tools').first();
    await expect(overflow).toBeVisible();
    await overflow.click();
    await expect(page.getByRole('menu')).toBeVisible();
  });
});
