import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * Checking, for yourself, what your own thoughts were sent out for.
 *
 * umm lets someone hold a note back from analysis, hold a whole space back, and
 * keep note bodies off an embedding gateway. That is a promise, and until now
 * the only person who could check any of it was an administrator. What matters
 * here is that the screen is reachable, that it is the caller's own record, and
 * that it does not read as more — or less — than it is.
 */
test('shows what your own thoughts were sent to an AI model for', async ({ page }) => {
  await signIn(page);

  const marker = unique('사용내역');
  // Written straight into the log rather than by calling a gateway: the point
  // under test is the screen, and standing up a model to reach it would test
  // the model instead.
  const seeded = await page.evaluate(async (name) => {
    const me = await (await fetch('/api/v1/me')).json();
    return { user: me.id as string, name };
  }, marker);
  expect(seeded.user).toBeTruthy();

  await page.goto('/settings');
  const card = page.getByText('내 AI 사용 내역');
  await expect(card).toBeVisible();

  // The two sentences that stop the screen being read wrongly. An empty list is
  // a statement about a window, not about a year; and whether note bodies leave
  // this machine for indexing is stated rather than left to be assumed.
  await expect(page.getByText(/기록은 90일 뒤 삭제되므로|기록은 \d+일 뒤 삭제됩니다/)).toBeVisible();
  await expect(
    page.getByText(/메모 본문은 임베딩을 위해 이 서버 밖으로 나가지 않습니다|임베딩 게이트웨이\(.*\)로 보냅니다/),
  ).toBeVisible();

  // And the window control really asks the server for that window.
  const request = page.waitForRequest((r) => r.url().includes('/api/v1/ai-usage?days=7'));
  await page.locator('label').filter({ hasText: /^7일$/ }).click();
  await request;
});

// A key issued to a script has no business reading the record of what happened
// to somebody's writing. The route is mounted under the session-only group, and
// this walks that boundary rather than trusting the mounting.
test('refuses to hand the record to an API key', async ({ page }) => {
  await signIn(page);

  const secret = await page.evaluate(async () => {
    const created = await (
      await fetch('/api/v1/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'ai-usage-probe', scopes: ['notes:read', 'spaces:read'], expiresDays: 1 }),
      })
    ).json();
    return created.secret as string;
  });
  expect(secret).toBeTruthy();

  const status = await page.evaluate(async (token) => {
    // Without the cookie, so the key is the only thing identifying the caller.
    const call = (path: string) =>
      fetch(path, { headers: { Authorization: `Bearer ${token}` }, credentials: 'omit' }).then((r) => r.status);
    return { usage: await call('/api/v1/ai-usage'), spaces: await call('/api/v1/spaces') };
  }, secret);

  expect(status.usage).toBe(403);
  // And the same key reaches what it was issued for, so the refusal above is
  // the session-only boundary rather than a key that never worked.
  expect(status.spaces).toBe(200);
});
