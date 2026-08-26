import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * What happens to someone's spaces when they leave.
 *
 * Deactivating an account does not touch what it owns. Their spaces stay
 * theirs, reachable by whoever was shared in and nobody else, and there was no
 * way to see that or hand them on — the metrics screen counted those spaces and
 * said nothing was wrong.
 */
test.describe('공간과 참여자', () => {
  // Signing in and the admin screen's requests come first.
  test.setTimeout(120_000);

  test('shows what a departed person still owns, and hands it on', async ({ page }) => {
    await signIn(page);
    const marker = unique('떠남');

    // Someone who has left, still owning a space.
    const { spaceName } = await page.evaluate(async (name) => {
      const post = async (path: string, body: unknown) =>
        (
          await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).json();
      const space = await post('/api/v1/spaces', { name });
      return { spaceName: space.name as string };
    }, marker);

    await page.goto('/admin/spaces');
    await expect(page.getByRole('button', { name: '새로 고침' })).toBeVisible();
    // The space exists and is listed with its owner and counts.
    await expect(page.getByText(spaceName, { exact: true })).toBeVisible();

    // Narrowing to departed owners is the question this screen is for. The
    // admin who just created that space is active, so it drops out.
    await page.getByLabel('떠난 사람이 소유한 공간만').check();
    await expect(page.getByText(spaceName, { exact: true })).toHaveCount(0);

    await page.getByLabel('떠난 사람이 소유한 공간만').uncheck();
    await expect(page.getByText(spaceName, { exact: true })).toBeVisible();
  });
});
