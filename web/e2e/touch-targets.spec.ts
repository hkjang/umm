import { devices, expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The header controls a phone actually has to hit.
 *
 * This project already decided touch targets should be 44px and wrote the rule:
 *
 *   @media (pointer: coarse) {
 *     .mantine-ActionIcon-root, .mantine-Button-root, .related-chip { min-*: 44px }
 *   }
 *
 * Two header controls were never covered by it, because neither is an
 * ActionIcon or a Button — the menu is a Mantine Burger and the bell an
 * UnstyledButton. Measured on a phone they came out at 28x28 and 22x28 while
 * every control the selector did name was already correct.
 *
 * Measured with offsetWidth/offsetHeight rather than a bounding rectangle. Most
 * of what first looked undersized here was canvas chrome under a 0.38 zoom
 * transform, which a rect reports scaled and a layout measurement does not.
 */
// File-level: a device preset carries defaultBrowserType, which Playwright
// will not accept inside a describe group.
test.use({ ...devices['Pixel 7'] });

test.describe('touch targets', () => {
  test('the header controls are big enough to hit on a phone', async ({ page }) => {
    await signIn(page);
    await page.goto('/today');
    await expect(page.getByRole('heading', { name: '오늘, 이어볼 생각' })).toBeVisible();

    const sizes = await page.evaluate(() => {
      const of = (selector: string) => {
        const el = document.querySelector<HTMLElement>(selector);
        return el ? { w: el.offsetWidth, h: el.offsetHeight } : null;
      };
      return {
        coarse: window.matchMedia('(pointer: coarse)').matches,
        menu: of('[aria-label="메뉴 열기"]'),
        bell: of('.header-icon-button'),
      };
    });

    // The rule is keyed on a coarse pointer, so the test is only meaningful
    // where the browser reports one.
    expect(sizes.coarse).toBe(true);
    for (const [name, box] of [
      ['메뉴 열기', sizes.menu],
      ['알림', sizes.bell],
    ] as const) {
      expect(box, `${name} is missing`).not.toBeNull();
      expect(box!.w, `${name} is ${box!.w}px wide`).toBeGreaterThanOrEqual(44);
      expect(box!.h, `${name} is ${box!.h}px tall`).toBeGreaterThanOrEqual(44);
    }
  });

  // The header still has to fit. Growing two boxes inside a flex row
  // redistributes the space around them, and a control pushed off the edge
  // would be worse than a small one.
  test('the header still fits the phone', async ({ page }) => {
    await signIn(page);
    await page.goto('/today');
    await expect(page.getByRole('heading', { name: '오늘, 이어볼 생각' })).toBeVisible();

    const fit = await page.evaluate(() => {
      const width = window.innerWidth;
      const header = document.querySelector('.mantine-AppShell-header') ?? document.querySelector('header');
      const past = [...(header?.querySelectorAll('*') ?? [])].filter(
        (e) => e.getBoundingClientRect().right > width + 1,
      ).length;
      return { past, docWidth: document.documentElement.scrollWidth, width };
    });
    expect(fit.past, 'a header control is past the right edge').toBe(0);
    expect(fit.docWidth).toBeLessThanOrEqual(fit.width);
  });
});
