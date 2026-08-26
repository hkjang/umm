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
    // Held back on purpose, so the permission always lands after the notes.
    //
    // That is the order that broke: the cards were built while the answer was
    // unknown — and therefore editable — and nothing rebuilt them when it
    // arrived. Which request wins is otherwise down to the machine, so this
    // failed on CI perhaps one run in ten and passed everywhere else, which is
    // indistinguishable from a flake until you make the order the test's own
    // decision rather than the network's.
    await new Promise((resolve) => setTimeout(resolve, 400));
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

/**
 * Opens a note's menu and returns the dropdown itself.
 *
 * Scoped to the open dropdown rather than searching the page: a menu left in
 * the DOM by an earlier test matches the same roles, which passed alone and
 * failed inside the full suite. The button is only shown on hover, so the hover
 * is waited for rather than assumed.
 */
async function openNoteMenu(page: import('@playwright/test').Page) {
  const card = page.locator('.postit').first();
  await card.hover();
  const trigger = card.getByRole('button', { name: '메모 메뉴' });
  await expect(trigger).toBeVisible();
  await trigger.click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

test.describe('read-only space', () => {
  test('says so instead of offering an editor that cannot save', async ({ page }) => {
    await signIn(page);
    await openSpaceWithPermission(page, 'view');

    // Waited for before anything is asserted about the card.
    //
    // The permission arrives with the space list, which is a separate request
    // from the notes, so for a moment the canvas has thoughts and does not yet
    // know whether they can be edited — and treats them as editable, which is
    // the right default for a space whose permission never arrives at all. This
    // notice is the first thing that changes when the answer lands, and it is
    // what a person sees too.
    await expect(page.getByText('읽기 전용으로 공유된 공간입니다. 댓글은 남길 수 있습니다.')).toBeVisible();

    // The thought is readable and plainly not editable.
    const editor = page.locator('.postit').first().getByRole('textbox', { name: '생각 내용' });
    await expect(editor).toBeVisible();
    // The DOM property rather than the attribute: an attribute whose value is
    // the empty string compares badly, and what matters is whether the browser
    // considers the field editable.
    await expect(editor).toHaveJSProperty('readOnly', true);

    // And the reason is on screen, where the capture bar would have been.
    await expect(page.getByText('읽기 전용으로 공유된 공간입니다. 댓글은 남길 수 있습니다.')).toBeVisible();
    await expect(page.getByPlaceholder('생각을 입력하고 Enter로 붙이세요')).toHaveCount(0);
  });

  test('leaves a space you can write to alone', async ({ page }) => {
    await signIn(page);
    await openSpaceWithPermission(page, 'manage');

    const editor = page.locator('.postit').first().getByRole('textbox', { name: '생각 내용' });
    await expect(editor).toHaveJSProperty('readOnly', false);
    await expect(page.getByPlaceholder('생각을 입력하고 Enter로 붙이세요')).toBeVisible();
    await expect(page.getByText('읽기 전용으로 공유된 공간입니다. 댓글은 남길 수 있습니다.')).toHaveCount(0);
  });

  /**
   * The note menu offers what works and nothing else.
   *
   * Every write in it is refused by the API for a read-only member — colour,
   * naming, marking as a question, holding back from Dream, restoring an
   * earlier version, deleting. Listing actions that cannot happen is a worse
   * answer than a shorter menu.
   *
   * Connections and comments stay, because both genuinely work: a read-only
   * member may comment, and not being able to change something should not stop
   * you talking about it.
   */
  test('the note menu drops what a reader cannot do', async ({ page }) => {
    await signIn(page);
    await openSpaceWithPermission(page, 'view');

    const menu = await openNoteMenu(page);

    await expect(menu.getByRole('menuitem', { name: '연결과 갈래' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: '댓글과 멘션' })).toBeVisible();
    for (const gone of ['색상', '제목 붙이기', '질문으로 표시', '이전 버전 복원', '지우기']) {
      await expect(menu.getByRole('menuitem', { name: gone }), `${gone} is still offered`).toHaveCount(0);
    }
  });

  test('the owner keeps the whole menu', async ({ page }) => {
    await signIn(page);
    await openSpaceWithPermission(page, 'manage');

    const menu = await openNoteMenu(page);

    for (const item of ['색상', '제목 붙이기', '질문으로 표시', '연결과 갈래', '댓글과 멘션', '지우기']) {
      await expect(menu.getByRole('menuitem', { name: item }), `${item} went missing`).toBeVisible();
    }
  });

  /**
   * Suggesting connections writes them, so it is not offered here.
   *
   * The server refused it as well — a read-only member was able to insert four
   * edges into a space they may only read, because reading the notes is allowed
   * and nothing after that asked whether they could be written. This is the
   * half that means the refusal never has to happen.
   */
  test('does not offer to add connections to a space it cannot write to', async ({ page }) => {
    await signIn(page);
    await openSpaceWithPermission(page, 'view');
    await expect(page.getByRole('button', { name: '연결 추천 받기' })).toHaveCount(0);
  });

  test('still offers it where connections can be added', async ({ page }) => {
    await signIn(page);
    await openSpaceWithPermission(page, 'manage');
    await expect(page.getByRole('button', { name: '연결 추천 받기' })).toBeVisible();
  });

  // The comment menu offered everything to everybody.
  //
  // Resolving a discussion needs edit or better, and deleting someone else's
  // comment needs manage — but the menu showed both to a member shared in to
  // read, who found out by being refused. This is the same thing the capture
  // bar and the note menu were fixed for; the comments panel had been missed.
  test('the comment menu drops what a reader cannot do', async ({ page }) => {
    await signIn(page);
    const spaceId = await openSpaceWithPermission(page, 'view');
    // A comment written by someone else — here, the owner, before the
    // permission is stubbed down to view for this browser.
    await page.evaluate(async (id) => {
      const notes = await (await fetch(`/api/v1/spaces/${id}/notes`)).json();
      await fetch(`/api/v1/notes/${notes.notes[0].id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: '주인이 남긴 의견' }),
      });
    }, spaceId);
    await page.reload();
    await expect(page.getByText('읽기 전용으로 공유된 공간입니다. 댓글은 남길 수 있습니다.')).toBeVisible();

    const menu = await openNoteMenu(page);
    await menu.getByRole('menuitem', { name: '댓글' }).click();
    await expect(page.getByText('주인이 남긴 의견')).toBeVisible();

    // The comment is this person's own, so deleting it is theirs to do — that
    // is true at any permission. Resolving the discussion is not: it needs edit
    // or better, and used to be offered anyway.
    await page.getByRole('button', { name: '댓글 메뉴' }).click();
    const commentMenu = page.getByRole('menu');
    await expect(commentMenu).toBeVisible();
    await expect(commentMenu.getByRole('menuitem', { name: '삭제' })).toBeVisible();
    await expect(commentMenu.getByRole('menuitem', { name: '해결 표시' })).toHaveCount(0);
    await expect(commentMenu.getByRole('menuitem', { name: '다시 열기' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // And still able to say something, which is the whole point of view.
    await expect(page.getByRole('textbox', { name: '댓글' })).toBeVisible();
  });

  // The other side of the same rule: edit may resolve.
  //
  // The read-only case above proves resolve is hidden. On its own that would
  // also pass if resolve were hidden from everyone, which would be a different
  // bug in the other direction.
  test('a member who may edit can still resolve a discussion', async ({ page }) => {
    await signIn(page);
    const spaceId = await openSpaceWithPermission(page, 'edit');
    await page.evaluate(async (id) => {
      const notes = await (await fetch(`/api/v1/spaces/${id}/notes`)).json();
      await fetch(`/api/v1/notes/${notes.notes[0].id}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: '편집자가 볼 의견' }),
      });
    }, spaceId);
    await page.reload();

    const menu = await openNoteMenu(page);
    await menu.getByRole('menuitem', { name: '댓글' }).click();
    await expect(page.getByText('편집자가 볼 의견')).toBeVisible();

    await page.getByRole('button', { name: '댓글 메뉴' }).click();
    const commentMenu = page.getByRole('menu');
    await expect(commentMenu.getByRole('menuitem', { name: '해결 표시' })).toBeVisible();
  });
});
