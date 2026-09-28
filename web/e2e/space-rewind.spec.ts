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

/**
 * Leaving the past behind when you leave the space.
 *
 * Rewinding belongs to one space at one moment, and the switcher is client
 * routing — React keeps its state across it. So the thing worth pinning is that
 * the next space arrives as itself: today's thoughts, today's date, and writable.
 * Carried over, the rewind would put an old timestamp on a banner above current
 * data, lock the canvas for a reason that no longer applies, and shut the event
 * stream so a collaborator's change never arrives.
 *
 * The move has to go through the switcher rather than page.goto: a full reload
 * throws the state away and the leak cannot happen.
 */
test('drops the rewind when the switcher opens another space', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  const marker = unique('옮긴공간');
  const made = await page.evaluate(async (name) => {
    const call = async (path: string, method: string, body: unknown) =>
      (
        await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      ).json();
    const spaceOf = async (suffix: string) => {
      const space = await call('/api/v1/spaces', 'POST', { name: `${name}-${suffix}` });
      await call(`/api/v1/spaces/${space.id}/notes`, 'POST', { content: `${name} ${suffix} 문장`, x: 0, y: 0 });
      return { id: space.id as string, name: space.name as string };
    };
    // Written through the API before either is opened, so neither space depends
    // on the live stream having delivered anything by assertion time.
    return { first: await spaceOf('먼저'), second: await spaceOf('나중') };
  }, marker);

  await page.goto(`/space/${made.first.id}`);
  await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: new RegExp(`${marker} 먼저 문장`) })).toBeVisible();

  await page.getByRole('button', { name: '되감기' }).click();
  await page.getByRole('menuitem', { name: '하루 전' }).click();
  await expect(page.getByText(/의 공간입니다$/)).toBeVisible();

  // Client routing, the way a person actually changes space.
  await page.locator('.space-switcher').click();
  await page.getByRole('menuitem', { name: made.second.name }).click();

  await expect(page.getByRole('group', { name: new RegExp(`${marker} 나중 문장`) })).toBeVisible();
  // No banner claiming this is some earlier moment, and the button no longer
  // reads as pressed — the two places a person could learn they are rewound.
  await expect(page.getByText(/의 공간입니다$/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: '되감기' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.getByText('지나간 시점을 보고 있어 바꿀 수 없습니다. 지금으로 돌아오면 다시 씁니다.')).toHaveCount(
    0,
  );

  // And writable for real, not merely lacking the notice: the capture bar is
  // the same one readOnly replaces, and the thought it writes comes back from
  // the server onto the canvas.
  const added = `${marker} 옮겨서 쓴 문장`;
  const capture = page.getByRole('textbox', { name: '새 생각' });
  await expect(capture).toBeVisible();
  await capture.fill(added);
  await capture.press('Enter');
  await expect(page.getByRole('group', { name: new RegExp(added) })).toBeVisible();
});
