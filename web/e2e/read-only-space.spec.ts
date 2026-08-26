import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * A space you may only read has to look like one.
 *
 * A member shared into a space read-only was given the owner's canvas: an
 * editable thought and a capture bar. The first sign that the space could not
 * be written to arrived after typing — the text reverted to the server's copy
 * and a notice explained the write had failed. Telling someone their writing
 * could not be kept is the wrong moment to mention it.
 *
 * The listing now carries what the person asking may do, because the screen
 * cannot work it out: the owner is obvious, but a member who may edit and one
 * who may only read look identical from here.
 *
 * The permission is stubbed rather than acted out with a second account: the
 * suite signs in as one person, and what is under test is what the canvas does
 * with the answer, not how membership is stored. The store side is covered by
 * its own integration tests.
 */
async function openSpaceWithPermission(page: import('@playwright/test').Page, permission: string) {
  const spaceId = await page.evaluate(async (name) => {
    const post = async (path: string, body: unknown) =>
      (
        await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json();
    const space = await post('/api/v1/spaces', { name });
    await post(`/api/v1/spaces/${space.id}/notes`, { content: `${name} 공유된 생각`, x: 100, y: 100 });
    return space.id as string;
  }, unique('읽기'));

  await page.route('**/api/v1/spaces', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      json: {
        spaces: (body.spaces ?? []).map((s: { id: string }) => (s.id === spaceId ? { ...s, permission } : s)),
      },
    });
  });

  await page.goto(`/space/${spaceId}`);
  await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);
  return spaceId;
}

test.describe('read-only space', () => {
  test('says so instead of offering an editor that cannot save', async ({ page }) => {
    await signIn(page);
    await openSpaceWithPermission(page, 'view');

    // The thought is readable and plainly not editable.
    const editor = page.locator('.postit').first().getByRole('textbox', { name: '생각 내용' });
    await expect(editor).toBeVisible();
    await expect(editor).toHaveAttribute('readonly', '');

    // And the reason is on screen, where the capture bar would have been.
    await expect(page.getByText('읽기 전용으로 공유된 공간입니다. 댓글은 남길 수 있습니다.')).toBeVisible();
    await expect(page.getByPlaceholder('생각을 입력하고 Enter로 붙이세요')).toHaveCount(0);
  });

  test('leaves a space you can write to alone', async ({ page }) => {
    await signIn(page);
    await openSpaceWithPermission(page, 'manage');

    const editor = page.locator('.postit').first().getByRole('textbox', { name: '생각 내용' });
    await expect(editor).not.toHaveAttribute('readonly', '');
    await expect(page.getByPlaceholder('생각을 입력하고 Enter로 붙이세요')).toBeVisible();
    await expect(page.getByText('읽기 전용으로 공유된 공간입니다. 댓글은 남길 수 있습니다.')).toHaveCount(0);
  });
});
