import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * Which webhook is failing, whose it is, and why.
 *
 * The metrics screen carried one number — deliveries failed in the last day.
 * Which webhook it was, who owned it and what the endpoint said back were all
 * recorded and none of them shown, so the number reported that something was
 * broken and nothing about where to look.
 */
test.describe('웹훅 상태', () => {
  test.setTimeout(120_000);

  test('names the failing webhook, and stops it without revealing its address', async ({ page }) => {
    await signIn(page);
    const name = unique('전송실패');

    // A webhook whose address carries its own credential, as Slack's and
    // Discord's do. The server resolves the hostname before accepting it, so
    // this has to be a name that really resolves; the reply is reported in full
    // if it does not, because a refusal here would otherwise look like a
    // missing row further down.
    const created = await page.evaluate(async (webhookName) => {
      const response = await fetch('/api/v1/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: webhookName,
          url: 'https://example.com/services/T0/B0/PLAINTEXT-TOKEN-IN-PATH',
          events: ['note.created'],
        }),
      });
      return { status: response.status, body: await response.text() };
    }, name);
    expect(created.status, created.body).toBe(201);
    const id = JSON.parse(created.body).id as string;

    await page.goto('/admin/webhooks');
    await expect(page.getByRole('button', { name: '새로 고침' })).toBeVisible();
    await expect(page.getByText(name, { exact: true })).toBeVisible();

    // Everything below is read from this webhook's own row. The table holds
    // every webhook in the installation, so an assertion made against the page
    // would be answered by somebody else's.
    const row = page.getByRole('row').filter({ hasText: name });
    await expect(row).toHaveCount(1);

    // The host, never the path: an administrator needs to know where deliveries
    // go, not how to make one.
    await expect(row.getByText('https://example.com/…')).toBeVisible();
    await expect(page.getByText(/PLAINTEXT-TOKEN-IN-PATH/)).toHaveCount(0);

    // Nothing has failed yet, so narrowing to failures must leave this out —
    // otherwise the filter would be decoration.
    await page.getByLabel('실패한 것만').check();
    await expect(page.getByText(name, { exact: true })).toHaveCount(0);
    await page.getByLabel('실패한 것만').uncheck();
    await expect(page.getByText(name, { exact: true })).toBeVisible();

    await expect(row.getByRole('button', { name: '멈추기' })).toBeVisible();
    page.once('dialog', (dialog) => void dialog.accept());
    await row.getByRole('button', { name: '멈추기' }).click();

    // Paused, and still there: the configuration survives so its owner can turn
    // it back on.
    await expect(row.getByText('멈춤')).toBeVisible();
    await expect(row.getByRole('button', { name: '멈추기' })).toHaveCount(0);

    // And the owner's own screen agrees — the pause is a fact about the
    // webhook, not a badge on the admin table.
    const active = await page.evaluate(async (webhookID) => {
      const list = await (await fetch('/api/v1/webhooks')).json();
      const found = (list.webhooks as { id: string; active: boolean }[]).find((w) => w.id === webhookID);
      return found?.active;
    }, id);
    expect(active).toBe(false);
  });
});
