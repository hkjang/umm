import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * Reloading with no network must not look like being signed out.
 *
 * The app precaches its shell and queues what you write while offline, so a
 * reload without a network serves the app — and it then asked you to sign in,
 * which is the one thing you cannot do without a network. Thoughts already
 * queued were safe in storage, but the screen in front of you was a login form
 * with no way past it.
 *
 * A network failure arrives from the API layer as status 0 and a real rejection
 * as 401. Both used to collapse to "no user".
 */

/** Playwright blocks the network without changing navigator.onLine; a real
 *  offline browser reports false on load, so both are set. */
async function goOffline(page: import('@playwright/test').Page) {
  await page
    .context()
    .addInitScript(() => Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true }));
  await page.context().setOffline(true);
}

test.describe('offline session', () => {
  test('a reload with no network keeps you in the app', async ({ page }) => {
    await signIn(page);
    await page.goto('/today');
    await expect(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible();
    // The shell has to be cached before pulling the plug, the way it is for
    // someone who has used the app before.
    await page.evaluate(async () => {
      if ('serviceWorker' in navigator) await navigator.serviceWorker.ready;
    });

    await goOffline(page);
    await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => undefined);

    // Still the app, not the sign-in form.
    await expect(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible();
    await expect(page.locator('input[type=password]')).toHaveCount(0);
    // And it says why things are not loading, rather than leaving an empty
    // screen that reads as lost work.
    await expect(page.locator('.network-status')).toBeVisible();
  });

  test('a server that says you are signed out still signs you out', async ({ page }) => {
    await signIn(page);
    await page.goto('/today');
    await expect(page.getByRole('navigation', { name: '주 메뉴' })).toBeVisible();

    // A real rejection, with the network working. The remembered session must
    // not paper over this — it exists only for the unreachable case.
    await page.route('**/api/v1/me', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: '{"error":"unauthorized"}' }),
    );
    await page.reload();

    await expect(page.locator('input[type=password]')).toBeVisible();
  });
});
