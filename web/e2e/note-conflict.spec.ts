import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * Two screens editing one thought must not quietly cost anyone their writing.
 *
 * The server already refuses the second write — the update carries the version
 * it was read at, so a stale one matches no row and comes back as 409 with both
 * the caller's version and the current note. The canvas turns that into a
 * dialog offering the two texts and a merge.
 *
 * None of that was covered from the browser. The server's half has an
 * integration test; the dialog that decides whether a person keeps what they
 * typed had nothing holding it in place.
 *
 * The second screen's event stream is cut on purpose. With it open the note
 * arrives updated and there is no collision to have — which is the right
 * behaviour and the reason a test that skips this step passes for the wrong
 * reason, and only sometimes.
 */
test('two screens editing one thought keep both versions', async ({ page, context }) => {
  await signIn(page);

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
    await post(`/api/v1/spaces/${space.id}/notes`, { content: `${name} 원래 생각`, x: 100, y: 100 });
    return space.id as string;
  }, unique('충돌'));

  await page.goto(`/space/${spaceId}`);
  await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);

  const second = await context.newPage();
  await second.route('**/events', (route) => route.abort());
  await second.goto(`/space/${spaceId}`);
  await expect(second.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);

  const editor = (target: typeof page) => target.locator('.postit').first().getByRole('textbox', { name: '생각 내용' });

  const first = '먼저 저장한 생각';
  await editor(page).click();
  await editor(page).fill(first);
  await editor(page).blur();
  // The first save has to land before the second is attempted, or there is no
  // stale version to collide with.
  await expect
    .poll(async () =>
      page.evaluate(async (id) => {
        const { notes } = await (await fetch(`/api/v1/spaces/${id}/notes`)).json();
        return notes[0]?.content as string;
      }, spaceId),
    )
    .toBe(first);

  const mine = '나중에 저장한 생각';
  await editor(second).click();
  await editor(second).fill(mine);
  await editor(second).blur();

  // Told about it, rather than one of the two simply disappearing.
  const dialog = second.getByRole('dialog').filter({ hasText: '메모 변경이 겹쳤습니다' });
  await expect(dialog).toBeVisible();
  for (const choice of ['서버 내용 사용', '내 변경으로 덮기', '편집한 내용으로 병합']) {
    await expect(dialog.getByRole('button', { name: choice })).toBeVisible();
  }

  // And what the second screen typed is still on screen to choose from.
  await expect(editor(second)).toHaveValue(mine);

  // Nothing was written behind either person's back while they decide.
  const onServer = await page.evaluate(async (id) => {
    const { notes } = await (await fetch(`/api/v1/spaces/${id}/notes`)).json();
    return notes[0]?.content as string;
  }, spaceId);
  expect(onServer).toBe(first);
});
