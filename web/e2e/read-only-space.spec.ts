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

  // Lines of thinking are the same story again.
  //
  // Everything the panel offers writes — filing a thought into a line,
  // adopting, setting aside, reopening, deleting, starting a new one — and it
  // offered all of them to a reader, who is refused every one by the server.
  // What they keep is what is worth keeping: which line a thought is in and
  // what became of it.
  test('the lines panel shows the lines without offering to change them', async ({ page }) => {
    await signIn(page);
    const spaceId = await openSpaceWithPermission(page, 'view');
    await page.evaluate(async (id) => {
      const notes = await (await fetch(`/api/v1/spaces/${id}/notes`)).json();
      const branch = await (
        await fetch(`/api/v1/spaces/${id}/branches`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: '주인의 갈래' }),
        })
      ).json();
      await fetch(`/api/v1/notes/${notes.notes[0].id}/branch`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branchId: branch.id }),
      });
    }, spaceId);
    await page.reload();
    await expect(page.getByText('읽기 전용으로 공유된 공간입니다. 댓글은 남길 수 있습니다.')).toBeVisible();

    // The lines live in the connections panel, which a reader may open.
    const menu = await openNoteMenu(page);
    await menu.getByRole('menuitem', { name: '연결과 갈래' }).click();

    // The line is visible — that is the half a reader needs.
    await expect(page.getByText('주인의 갈래')).toBeVisible();
    // And nothing on offer to change it.
    await expect(page.getByRole('button', { name: '갈래 메뉴' })).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '새 갈래 이름' })).toHaveCount(0);
  });

  // Arranging is a write, and it used to report success at doing it.
  //
  // Tidying the canvas moves notes and saves each one. A reader was offered
  // every arrangement — the three in the toolbar, two more in the menu, and the
  // related chip on a card — and clicking one moved the notes on screen, said
  // how many had been moved, and then had every save refused. A success message
  // for something that did not happen is worse than a refusal.
  test('does not offer to rearrange a space it cannot write to', async ({ page }) => {
    await signIn(page);
    await openSpaceWithPermission(page, 'view');
    await expect(page.getByText('읽기 전용으로 공유된 공간입니다. 댓글은 남길 수 있습니다.')).toBeVisible();

    for (const label of ['생각 군집', '겹침 정리', 'Thought Gravity']) {
      await expect(page.getByRole('button', { name: label })).toHaveCount(0);
    }
  });

  test('still offers the arrangements where the layout can be saved', async ({ page }) => {
    await signIn(page);
    await openSpaceWithPermission(page, 'manage');
    for (const label of ['생각 군집', '겹침 정리', 'Thought Gravity']) {
      await expect(page.getByRole('button', { name: label })).toBeVisible();
    }
  });

  // A key press is an offer too.
  //
  // Delete has no button to hide, so the confirmation was the offer: a reader
  // selecting a thought and pressing Delete was asked whether to delete it, and
  // the server refused afterwards. The question itself was the false promise.
  test('pressing Delete does not offer to delete a thought a reader cannot delete', async ({ page }) => {
    await signIn(page);
    const spaceId = await openSpaceWithPermission(page, 'view');
    await expect(page.getByText('읽기 전용으로 공유된 공간입니다. 댓글은 남길 수 있습니다.')).toBeVisible();

    let asked = false;
    page.on('dialog', (dialog) => {
      asked = true;
      void dialog.dismiss();
    });

    // Selected for real. Clicking the card lands on its textarea and selects
    // nothing, so the handler returned before it ever reached the guard — the
    // first version of this test passed with the guard removed.
    await page.locator('.react-flow__pane').click({ position: { x: 12, y: 12 } });
    await page.keyboard.press('Control+a');
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);

    await page.keyboard.press('Delete');
    await page.waitForTimeout(500);

    expect(asked).toBe(false);
    // And the thought is still there, on the server as well as the screen.
    const left = await page.evaluate(
      async (id) => (await (await fetch(`/api/v1/spaces/${id}/notes`)).json()).notes.length,
      spaceId,
    );
    expect(left).toBe(1);
  });

  // Everything above found one control at a time: the capture bar, the note
  // menu, connections, the comment menu, the lines panel, the arrangements, the
  // Delete key. Each was found by someone thinking of it.
  //
  // This one does not need to be thought of. It watches the wire: a reader
  // opening menus and panels and pressing keys must not cause a single write.
  // A control added tomorrow that saves something fails here without anyone
  // remembering to check it.
  //
  // Writing a comment is deliberately not exercised — it is the one thing a
  // reader may do, and it has its own test.
  test('browsing a read-only space sends no writes at all', async ({ page }) => {
    await signIn(page);

    // Say yes to anything it asks. A confirmation that is dismissed would stop
    // an unguarded action before it wrote, and the watch would see nothing —
    // the test has to follow through to catch anything.
    page.on('dialog', (dialog) => void dialog.accept());

    const writes: string[] = [];
    await page.route('**/api/v1/**', async (route) => {
      const request = route.request();
      const method = request.method();
      const path = new URL(request.url()).pathname;
      // Preferences and locale are the person's own, not the space's.
      const personal = /\/(preferences|me|auth|sessions|dreams)\b/.test(path);
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method) && !personal) {
        writes.push(`${method} ${path}`);
      }
      await route.continue();
    });

    const spaceId = await openSpaceWithPermission(page, 'view');
    await expect(page.getByText('읽기 전용으로 공유된 공간입니다. 댓글은 남길 수 있습니다.')).toBeVisible();
    // The space and its thought were created before the watch mattered; only
    // what browsing does from here counts.
    writes.length = 0;

    // The keys first, while the canvas is still clear: an open side panel
    // covers the pane and the click cannot land.
    await page.locator('.react-flow__pane').click({ position: { x: 12, y: 12 } });
    await page.keyboard.press('Control+a');
    await expect(page.locator('.react-flow__node.selected')).toHaveCount(1);
    await page.keyboard.press('Delete');
    await page.keyboard.press('Control+z');
    await page.keyboard.press('Control+Shift+z');
    await page.waitForTimeout(400);
    // Checked here as well as at the end: an unguarded Delete removes the card,
    // and every later step then fails on a missing element instead of saying
    // what actually went wrong.
    expect(writes, `a reader's keys wrote to the space: ${writes.join(', ')}`).toEqual([]);

    // Then look at everything a reader can open.
    const menu = await openNoteMenu(page);
    await menu.getByRole('menuitem', { name: '연결과 갈래' }).click();
    await expect(page.getByText('생각의 갈래')).toBeVisible();
    const again = await openNoteMenu(page);
    await again.getByRole('menuitem', { name: '댓글과 멘션' }).click();
    await expect(page.getByRole('textbox', { name: '댓글' })).toBeVisible();
    await page.waitForTimeout(700);

    expect(writes, `a reader's browsing wrote to the space: ${writes.join(', ')}`).toEqual([]);
    void spaceId;
  });
});
