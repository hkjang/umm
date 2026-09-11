import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The frame stays put while a page loads.
 *
 * Suspense used to sit around the whole route tree, so fetching a page's code
 * unmounted the header and the navigation with it: moving between pages blacked
 * the application out, put a spinner in the middle of the window, and then drew
 * everything back. Nothing about the frame had changed. It reads as the app
 * restarting, which is a large part of why umm felt slow even when every
 * request answered in ten milliseconds.
 */
test('moving between pages does not black out the application', async ({ page }) => {
  await signIn(page);
  await page.goto('/today');
  await expect(page.getByText('THOUGHT SPACE').first()).toBeVisible();

  // Held long enough to observe the moment between pages, which is otherwise
  // too brief to catch and is exactly the moment being fixed.
  await page.route('**/assets/*.js', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });

  const navigation = page.getByRole('link', { name: 'My Space' }).click();
  // Mid-flight: the frame is still there, and the place being navigated to is
  // already marked, so the person can see where they are going.
  await expect(page.getByText('THOUGHT SPACE').first()).toBeVisible();
  await expect(page.getByRole('status', { name: '화면 불러오는 중' })).toBeVisible();
  await navigation.catch(() => undefined);

  await expect(page.getByRole('status', { name: '화면 불러오는 중' })).toHaveCount(0, { timeout: 20000 });
  await expect(page.getByText('THOUGHT SPACE').first()).toBeVisible();
});
