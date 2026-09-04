import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * Looking at the space as it was.
 *
 * The dangerous part is not the reading, it is that a canvas showing a moment
 * that has passed still looks like a canvas: draggable, editable, savable. A
 * change made there would be written against today's space from a state that
 * no longer exists. So what is checked here is that the past really comes
 * back, that it is not today, and that nothing on it can be changed.
 */
test('shows the space as it was, and refuses to let it be changed', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  const marker = unique('지난공간');
  const made = await page.evaluate(async (name) => {
    const call = async (path: string, method: string, body: unknown) =>
      (
        await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      ).json();
    const space = await call('/api/v1/spaces', 'POST', { name: `${name}-공간` });
    const note = await call(`/api/v1/spaces/${space.id}/notes`, 'POST', {
      content: `${name} 처음 쓴 문장`,
      x: 0,
      y: 0,
    });
    // Edited, so today and the past genuinely differ.
    await call(`/api/v1/notes/${note.id}`, 'PUT', { ...note, content: `${name} 고쳐 쓴 문장` });
    return { space: space.id as string };
  }, marker);

  await page.goto(`/space/${made.space}`);
  await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: new RegExp(`${marker} 고쳐 쓴 문장`) })).toBeVisible();

  // The whole space was made seconds ago, so "a day ago" is before it existed
  // and has to come back empty rather than showing today.
  await page.getByRole('button', { name: '되감기' }).click();
  await page.getByRole('menuitem', { name: '하루 전' }).click();

  await expect(page.getByText(/의 공간입니다$/)).toBeVisible();
  await expect(page.getByRole('group', { name: new RegExp(`${marker} 고쳐 쓴 문장`) })).toHaveCount(0);

  // Nothing on a canvas that has passed may be changed. The read-only notice
  // is the same one a view-only space shows, and it is the single switch every
  // write path reads.
  await expect(
    page.getByText('지나간 시점을 보고 있어 바꿀 수 없습니다. 지금으로 돌아오면 다시 씁니다.'),
  ).toBeVisible();
  // And not the sentence a shared read-only space shows: this is the owner's
  // own space, and saying it was shared would be a fact that never happened.
  await expect(page.getByText('읽기 전용으로 공유된 공간입니다.', { exact: false })).toHaveCount(0);

  // And coming back really comes back.
  await page.getByRole('button', { name: '지금으로' }).click();
  await expect(page.getByRole('group', { name: new RegExp(`${marker} 고쳐 쓴 문장`) })).toBeVisible();
  await expect(page.getByText(/의 공간입니다$/)).toHaveCount(0);
});
