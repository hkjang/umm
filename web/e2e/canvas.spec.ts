import { expect, test } from '@playwright/test';
import { openCanvas, signIn, unique } from './helpers';

test.describe('canvas', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await openCanvas(page);
  });

  test('captures a thought and shows it on the canvas', async ({ page }) => {
    const thought = unique('생각');
    await page.getByRole('textbox', { name: '새 생각' }).fill(thought);
    await page.getByRole('textbox', { name: '새 생각' }).press('Enter');
    await expect(page.getByRole('group', { name: new RegExp(thought) })).toBeVisible();

    // A reload proves the note was persisted rather than only added to local state.
    await page.reload();
    await expect(page.getByRole('group', { name: new RegExp(thought) })).toBeVisible();
  });

  test('imports Markdown as one thought per section', async ({ page }) => {
    const marker = unique('가져오기');
    await page.getByRole('button', { name: '내보내기' }).click();
    await page.getByRole('menuitem', { name: '마크다운 가져오기' }).click();
    await page
      .getByRole('textbox', { name: '가져올 내용' })
      .fill(`# ${marker} 하나\n첫 번째 본문\n\n# ${marker} 둘\n두 번째 본문`);
    await expect(page.getByText('2개의 생각을 가져옵니다.')).toBeVisible();
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect(page.getByRole('group', { name: new RegExp(`${marker} 하나`) })).toBeVisible();
    await expect(page.getByRole('group', { name: new RegExp(`${marker} 둘`) })).toBeVisible();
  });

  test('queues a thought while offline and syncs it on reconnect', async ({ page, context }) => {
    const thought = unique('오프라인');
    await context.setOffline(true);
    await page.getByRole('textbox', { name: '새 생각' }).fill(thought);
    await page.getByRole('textbox', { name: '새 생각' }).press('Enter');
    // The banner appears the moment the browser reports being offline, so the
    // wait is on the queued count instead — reconnecting before the change is
    // actually stored would leave nothing for the sync to send.
    await expect(page.getByRole('status').filter({ hasText: '오프라인' })).toContainText('1개');

    await context.setOffline(false);
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect(page.getByRole('status').filter({ hasText: '오프라인' })).toBeHidden({ timeout: 30_000 });
    await page.reload();
    await expect(page.getByRole('group', { name: new RegExp(thought) })).toBeVisible();
  });

  test('opens a thought for editing from the keyboard', async ({ page }) => {
    const thought = unique('키보드');
    await page.getByRole('textbox', { name: '새 생각' }).fill(thought);
    await page.getByRole('textbox', { name: '새 생각' }).press('Enter');
    const card = page.getByRole('group', { name: new RegExp(thought) });
    await card.focus();
    await card.press('Enter');
    await expect(card.getByRole('textbox', { name: '생각 내용' })).toBeFocused();
  });
});
