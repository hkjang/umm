import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * The audit log has to answer a question.
 *
 * It recorded everything worth recording — a space unshared, a key rotated, a
 * thought restored — and could only be read newest first, all of it. Finding
 * who took someone out of a space meant scrolling a log that only grows.
 */
test.describe('감사 로그', () => {
  // Signing in and the admin screen's six requests come first, before anything
  // here is even reachable.
  test.setTimeout(120_000);

  const openAudit = async (page: import('@playwright/test').Page) => {
    await signIn(page);
    await page.goto('/admin/audit');
    await expect(page.getByRole('button', { name: '찾기' })).toBeVisible();
  };

  test('narrows to one action, offering the ones the log holds', async ({ page }) => {
    await openAudit(page);

    // The screen offers what is actually in the log, so nobody has to type
    // "space.unshare" exactly.
    await page.getByPlaceholder('전체').click();
    await expect(page.getByRole('listbox')).toBeVisible();
    const option = page.getByRole('option').first();
    const chosen = (await option.textContent())?.trim() ?? '';
    expect(chosen).not.toBe('');
    await option.click();
    await page.getByRole('button', { name: '찾기' }).click();

    const rows = page.locator('table tbody tr');
    await expect(rows.first()).toBeVisible();
    const actions = await rows.locator('td:nth-child(3)').allTextContents();
    expect(actions.length).toBeGreaterThan(0);
    for (const action of actions) {
      expect(action.trim()).toBe(chosen);
    }
  });

  // An empty result is an answer, and has to read like one rather than like a
  // search that failed.
  test('says an empty result means no such record', async ({ page }) => {
    await openAudit(page);

    await page.getByPlaceholder('아이디 또는 system').fill('nobody_at_all_here');
    await page.getByRole('button', { name: '찾기' }).click();

    await expect(
      page.getByText('이 조건에 맞는 기록이 없습니다. 기록이 없다는 뜻이지, 찾지 못했다는 뜻이 아닙니다.'),
    ).toBeVisible();
    await expect(page.locator('table tbody tr')).toHaveCount(0);
  });

  // Clearing has to actually clear: it sets the filters and searches in one
  // go, and state set a moment ago is not readable yet — so this used to
  // search again with the conditions it had just removed.
  test('clearing the filters brings everything back', async ({ page }) => {
    await openAudit(page);

    await page.getByPlaceholder('아이디 또는 system').fill('nobody_at_all_here');
    await page.getByRole('button', { name: '찾기' }).click();
    await expect(page.locator('table tbody tr')).toHaveCount(0);

    await page.getByRole('button', { name: '조건 지우기' }).click();
    await expect(page.locator('table tbody tr').first()).toBeVisible();
  });
});
