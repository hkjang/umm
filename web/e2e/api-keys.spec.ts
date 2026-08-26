import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * A key list has to say when the key stops working.
 *
 * This row showed `umm_key_… · 2026. 8. 26.` — the date the key was created,
 * unlabelled — while the response carried an expiry three months out that
 * appeared nowhere. The key you have forgotten about is exactly the one whose
 * expiry you need, and the page was showing the one date you can least act on.
 *
 * During a rotation it matters more. The old key keeps working for a day and
 * then stops; the badge said `overlap` and nothing said until when, so the
 * deadline the whole rotation exists for was the missing part.
 *
 * The state was written as stored, too — `active`, `overlap`, `revoked` — while
 * the webhook list on the same screen already said 활성 and 중지.
 */
const keys = {
  availableScopes: ['notes:read', 'notes:write'],
  keys: [
    {
      id: '00000000-0000-4000-8000-00000000001a',
      name: '노트북 스크립트',
      prefix: 'zq8bvraz',
      scopes: ['notes:read'],
      status: 'active',
      expiresAt: '2026-11-24T12:00:00Z',
      createdAt: '2026-08-26T12:00:00Z',
      lastUsedAt: '2026-08-25T12:00:00Z',
    },
    {
      id: '00000000-0000-4000-8000-00000000001b',
      name: '회사 자동화',
      prefix: 'gc2qyxhs',
      scopes: ['notes:read'],
      status: 'overlap',
      expiresAt: '2026-11-24T12:00:00Z',
      overlapUntil: '2026-08-27T12:00:00Z',
      createdAt: '2026-08-26T12:00:00Z',
    },
  ],
};

test.describe('개인 API 키', () => {
  test('says when a key stops working, in the reader’s language', async ({ page }) => {
    await signIn(page);
    await page.route('**/api/v1/api-keys', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({ json: keys });
    });
    await page.goto('/settings');
    await expect(page.getByText('노트북 스크립트')).toBeVisible();

    // The state, said rather than stored.
    await expect(page.getByText('사용 중').first()).toBeVisible();
    await expect(page.getByText('교체 중')).toBeVisible();

    // The date a key stops working — expiry while it is in use, and the
    // rotation deadline while it is being replaced.
    await expect(page.getByText(/만료 2026\. 11\. 24\./)).toBeVisible();
    await expect(page.getByText(/2026\. 8\. 27\..*까지만 동작합니다/)).toBeVisible();

    // Whether anything is still using it.
    await expect(page.getByText(/마지막 사용 2026\. 8\. 25\./)).toBeVisible();
    await expect(page.getByText('아직 사용된 적 없음')).toBeVisible();

    // And none of the values the state is stored as.
    const body = (await page.locator('.settings-page').textContent()) ?? '';
    for (const raw of ['active', 'overlap', 'revoked']) {
      expect(body, `the stored value ${raw} reached the screen`).not.toContain(raw);
    }
  });

  // An empty key list reads as "you have not made any keys". On a screen about
  // credentials, saying that when the request merely failed is the wrong way to
  // be wrong — and one failing request used to empty the others too, because
  // all three were fetched with Promise.all and the failure swallowed.
  test('does not say there are no keys when it could not look', async ({ page }) => {
    await signIn(page);
    await page.route('**/api/v1/api-keys', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ status: 500, json: { detail: 'nope' } }) : route.continue(),
    );
    await page.goto('/settings');

    await expect(page.getByText('키 목록을 불러오지 못했습니다. 키가 없는 것인지 알 수 없습니다.')).toBeVisible();
    await expect(page.getByText('아직 만든 키가 없습니다.')).toHaveCount(0);
    // The webhook section loaded fine and says so rather than being blanked too.
    await expect(page.getByText('웹훅 목록을 불러오지 못했습니다. 웹훅이 없는 것인지 알 수 없습니다.')).toHaveCount(0);
  });
});
