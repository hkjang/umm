import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * Being rid of a key, from the screen.
 *
 * Revoking stopped the key working but left the row on screen for good: the
 * listing returns every key ever issued, and a revoked one had no action left
 * at all — the button was disabled. Pressing 폐기 and watching the row stay
 * reads as deletion not working, which is how this was reported.
 *
 * The store side has its own test. This covers the part a person touches: that
 * the second press exists at all, and that it only exists once the key is
 * already stopped.
 */
async function issueKey(page: import('@playwright/test').Page, name: string) {
  await page.evaluate(async (keyName) => {
    await fetch('/api/v1/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: keyName, scopes: ['notes:read'] }),
    });
  }, name);
}

const rows = (page: import('@playwright/test').Page) =>
  page.evaluate(async () => {
    const { keys } = await (await fetch('/api/v1/api-keys')).json();
    return (keys as { name: string; status: string }[]).map((k) => `${k.name}|${k.status}`);
  });

test.describe('API key', () => {
  test('is revoked first and only then can leave the list', async ({ page }) => {
    await signIn(page);
    const name = unique('키');
    await issueKey(page, name);
    await page.goto('/settings');

    // The card the key lives in, found by the key's own name rather than by
    // climbing parents, which depends on markup this test has no business
    // knowing about.
    // The section is a card too and contains this one, so both match the name.
    // The innermost is the later of the two in document order.
    const card = page.locator('.mantine-Card-root').filter({ hasText: name }).last();
    await expect(card).toBeVisible();

    // While it works, the only destructive action is to stop it. Removing it
    // from the list is not offered, because a key that still works must not go
    // in one press.
    await expect(page.getByRole('button', { name: '목록에서 지우기' })).toHaveCount(0);

    page.once('dialog', (d) => d.accept());
    await card.getByRole('button', { name: '폐기' }).click();
    await expect.poll(() => rows(page)).toContain(`${name}|revoked`);

    // Now, and only now, it can be taken off the list.
    const remove = page.getByRole('button', { name: '목록에서 지우기' });
    await expect(remove).toBeVisible();
    page.once('dialog', (d) => d.accept());
    await remove.click();

    await expect.poll(() => rows(page)).not.toContain(`${name}|revoked`);
    await expect(page.getByText(name)).toHaveCount(0);
  });

  test('will not drop its last permission without saying why', async ({ page }) => {
    await signIn(page);
    const name = unique('키');
    await issueKey(page, name);
    await page.goto('/settings');

    // The section is a card too and contains this one, so both match the name.
    // The innermost is the later of the two in document order.
    const card = page.locator('.mantine-Card-root').filter({ hasText: name }).last();
    await expect(card).toBeVisible();
    // The key was issued with exactly one permission, so turning it off would
    // leave none. That used to do nothing at all and let the box spring back.
    await card.getByRole('checkbox', { name: 'notes:read' }).click();

    await expect(
      page.getByText('키에는 권한이 하나 이상 있어야 합니다. 이 키를 쓰지 않으려면 폐기해 주세요.'),
    ).toBeVisible();
    await expect.poll(() => rows(page)).toContain(`${name}|active`);
  });
});
