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

  test('keeps only failed import sections in the draft for retry', async ({ page }) => {
    const marker = unique('부분-가져오기');
    const noteRoute = '**/api/v1/spaces/*/notes';
    let posts = 0;
    await page.route(noteRoute, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      posts += 1;
      if (posts === 2) {
        await route.fulfill({
          status: 503,
          contentType: 'application/problem+json',
          body: JSON.stringify({ title: 'temporary failure', status: 503 }),
        });
        return;
      }
      await route.continue();
    });

    await page.getByRole('button', { name: '내보내기' }).click();
    await page.getByRole('menuitem', { name: '마크다운 가져오기' }).click();
    const editor = page.getByRole('textbox', { name: '가져올 내용' });
    await editor.fill(`# ${marker} 성공\n첫 본문\n\n# ${marker} 재시도\n남길 본문`);
    await page.getByRole('button', { name: '가져오기', exact: true }).click();

    await expect(page.getByRole('group', { name: new RegExp(`${marker} 성공`) })).toBeVisible();
    await expect(editor).toHaveValue(`# ${marker} 재시도\n\n남길 본문`);
    await expect(
      page.getByText('1개의 생각을 가져오지 못했습니다. 입력란에 남겨 두었으니 다시 시도해 주세요.'),
    ).toBeVisible();

    await page.unroute(noteRoute);
    await page.getByRole('button', { name: '가져오기', exact: true }).click();
    await expect(page.getByRole('group', { name: new RegExp(`${marker} 재시도`) })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '마크다운 가져오기' })).toHaveCount(0);
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
  // The connection vocabulary is only worth having if a person can reach it. The
  // server accepts typed relations over the API either way, so this covers the
  // part that could silently regress: the toolbar choice reaching the request.
  test('records what a drawn connection means', async ({ page }) => {
    // Mantine puts the same aria-label on the input and its listbox, so the
    // locator has to name the role rather than the label alone.
    const selector = page.getByRole('combobox', { name: '새로 그리는 연결의 종류' });
    await expect(selector).toBeVisible();

    await selector.click();
    await page.getByRole('option', { name: '상충함' }).click();
    await expect(selector).toHaveValue('상충함');

    // The choice is for a run of connections, not one line, so it has to survive
    // a reload rather than resetting to the generic relation each visit.
    await page.reload();
    await expect(page.getByRole('combobox', { name: '새로 그리는 연결의 종류' })).toHaveValue('상충함');
  });
  // Capture exists to remove the "choose a space first" step, so the test that
  // matters is that it works from a page which is not that space.
  test('captures a thought from anywhere without choosing a space', async ({ page }) => {
    const thought = unique('수집');
    await page.goto('/today');
    const box = page.getByLabel('무슨 생각을 하고 있나요?');
    await expect(box).toBeVisible();
    await box.fill(thought);
    await box.press('Enter');

    // The box clears only after the write lands, so an empty box is the signal
    // that the thought was actually kept rather than dropped.
    await expect(box).toHaveValue('');

    // And it has to be somewhere real. The inbox is an ordinary space, so it
    // appears in the switcher — which is also how a person gets back to what
    // they captured.
    await openCanvas(page);
    await page
      .getByRole('button', { name: /^(?!.*생각 검색).*$/ })
      .first()
      .waitFor();
    await page.locator('.space-switcher').click();
    await page.getByRole('menuitem', { name: /생각 수집함/ }).click();
    await expect(page.getByRole('group', { name: new RegExp(thought) })).toBeVisible({ timeout: 15000 });
  });
  // Semantic zoom replaces notes with what they add up to once the text is too
  // small to read. The part worth pinning is the switch itself and the honesty
  // of the label: umm groups by placement when it cannot judge meaning, and the
  // shape says so rather than implying it read the notes.
  test('summarises the canvas when zoomed out past reading distance', async ({ page }) => {
    const topic = unique('묶음');
    /*
     * Its own space. This test needs twenty-eight notes, and it used to put
     * them in the shared canvas that beforeEach opens — where they stayed. One
     * run of the suite left that space over the twenty-five note threshold, so
     * the next run against the same database opened it already summarised and
     * three card-based tests found cluster boxes instead of their note. It
     * passed in CI only because CI always starts from an empty database.
     */
    const space = await page.evaluate(async (name) => {
      const created = await (
        await fetch('/api/v1/spaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
      ).json();
      return created.id as string;
    }, `${topic}-공간`);
    await page.goto(`/space/${space}`);
    await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);

    // Two huddles, and enough notes that summarising is worth doing at all.
    for (let group = 0; group < 2; group++) {
      for (let i = 0; i < 14; i++) {
        await page.evaluate(
          async ({ text, x, y, space }) => {
            await fetch(`/api/v1/spaces/${space}/notes`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ content: text, x, y }),
            });
          },
          {
            text: `${topic}-${group}-${i}`,
            x: group * 2600 + (i % 4) * 320,
            y: Math.floor(i / 4) * 230,
            space: page.url().split('/space/')[1],
          },
        );
      }
    }
    await page.reload();
    await expect(page.getByRole('textbox', { name: '생각 검색' })).toBeVisible();
    await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);

    // Fitting a canvas this wide into the viewport already lands below reading
    // distance, so the summary is what a person sees on arrival — which is the
    // behaviour worth having and worth pinning.
    const clusters = page.locator('.react-flow__node-cluster');
    await expect(clusters.first()).toBeVisible({ timeout: 15000 });
    await expect(page.locator('.react-flow__node-postit')).toHaveCount(0);

    // The grouping has to say what it rests on. The default embedding cannot
    // judge meaning, so this must read as placement rather than content.
    await expect(clusters.first()).toContainText('가까이 둔 것으로 묶임');

    // Zooming back in returns the notes themselves: the summary is a view of the
    // canvas, not a replacement for it.
    for (let i = 0; i < 10; i++) {
      await page.getByRole('button', { name: 'zoom in' }).click();
      await page.waitForTimeout(120);
    }
    await expect(page.locator('.react-flow__node-postit').first()).toBeVisible({ timeout: 15000 });
    await expect(clusters).toHaveCount(0);
  });

  // Everything built on lines of thinking depends on being able to make one, and
  // for three releases you could not. The only way into the panel that holds
  // them was the "related N" chip, which a thought with no related thoughts does
  // not have — so on a fresh canvas, with the first thought someone writes,
  // there was no way in at all.
  test('reaches lines of thinking from the first thought on a canvas', async ({ page }) => {
    const marker = unique('첫생각');
    const space = await page.evaluate(async (name) => {
      const created = await (
        await fetch('/api/v1/spaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        })
      ).json();
      await fetch(`/api/v1/spaces/${created.id}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: name, x: 0, y: 0 }),
      });
      return created.id;
    }, marker);

    await page.goto(`/space/${space}`);
    await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);

    // One thought, so nothing is related to it and no chip exists. That is the
    // state the entry point has to survive.
    await expect(page.locator('.related-chip')).toHaveCount(0);

    const card = page.getByRole('group', { name: new RegExp(marker) }).first();
    await card.getByRole('button', { name: '메모 메뉴' }).click();
    await page.getByRole('menuitem', { name: '연결과 갈래' }).click();

    await expect(page.getByText('생각의 갈래')).toBeVisible();
    await page.getByLabel('새 갈래 이름').fill(`${marker}-갈래`);
    await page.getByRole('button', { name: '만들기' }).click();
    await expect(page.getByText(`${marker}-갈래`)).toBeVisible();
  });

  // Resolving a line is where the reason gets recorded, and the decision record
  // is where it comes back. Checked in a browser because that is the only thing
  // that can say a feature is reachable — the API answered correctly for three
  // releases while the interface had no way in.
  test('records why a line was set aside and shows it in the decision record', async ({ page }) => {
    const marker = unique('결정');
    const made = await page.evaluate(async (name) => {
      const post = async (path: string, body: unknown) =>
        (
          await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).json();
      const space = await post('/api/v1/spaces', { name: `${name}-공간` });
      await post(`/api/v1/spaces/${space.id}/notes`, { content: name, x: 0, y: 0 });
      return { space: space.id };
    }, marker);

    await page.goto(`/space/${made.space}`);
    await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);

    const card = page.getByRole('group', { name: new RegExp(marker) }).first();
    await card.getByRole('button', { name: '메모 메뉴' }).click();
    await page.getByRole('menuitem', { name: '연결과 갈래' }).click();
    await page.getByLabel('새 갈래 이름').fill(`${marker}-갈래`);
    await page.getByRole('button', { name: '만들기' }).click();
    await expect(page.getByText(`${marker}-갈래`)).toBeVisible();

    await page.getByRole('button', { name: '갈래 메뉴' }).first().click();
    await page.getByRole('menuitem', { name: '접어 두기' }).click();

    // The reason is required, and the interface has to hold that line too: with
    // the field empty there is nothing to press.
    await expect(page.getByRole('button', { name: '남기기' })).toBeDisabled();
    const reason = `${marker}-비용이 더 컸습니다`;
    await page.getByLabel('갈래를 정리하는 이유').fill(reason);
    await page.getByRole('button', { name: '남기기' }).click();
    await expect(page.getByText('접어 둠').first()).toBeVisible();

    // And it comes back where someone would look for it months later.
    await page.goto('/decisions');
    await expect(page.getByText(`${marker}-갈래`)).toBeVisible();
    await expect(page.getByText(reason)).toBeVisible();
  });

  // A line of thinking that was set aside has to look different from a current
  // one on the canvas, and looking at one line must fade the rest rather than
  // hide it — a thought that disappears reads as a thought that was deleted.
  test('marks a set-aside line and fades everything outside the one in focus', async ({ page }) => {
    const marker = unique('갈래');
    // Its own space, because the shared one collects notes from every test that
    // ran before: past twenty-five the canvas summarises instead of showing
    // cards, and this test would be asserting against a view of clusters.
    const made = await page.evaluate(
      async ({ text }) => {
        const post = async (path: string, body: unknown) => {
          const response = await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          return response.json();
        };
        const space = await post('/api/v1/spaces', { name: `${text}-공간` });
        const spaceID = space.id;
        const inside = await post(`/api/v1/spaces/${spaceID}/notes`, { content: `${text}-안`, x: 0, y: 0 });
        const outside = await post(`/api/v1/spaces/${spaceID}/notes`, { content: `${text}-밖`, x: 420, y: 0 });
        const branch = await post(`/api/v1/spaces/${spaceID}/branches`, { name: `${text}-선` });
        await fetch(`/api/v1/notes/${inside.id}/branch`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ branchId: branch.id }),
        });
        await post(`/api/v1/branches/${branch.id}/resolve`, {
          status: 'abandoned',
          resolution: '해 보니 얻는 것보다 드는 품이 컸습니다',
        });
        return { space: spaceID, inside: inside.id, outside: outside.id, branch: `${text}-선` };
      },
      { text: marker },
    );

    await page.goto(`/space/${made.space}`);
    await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);

    // The mark is on the canvas, not only in what the assistant says about it.
    const insideCard = page.locator(`.react-flow__node[data-id="${made.inside}"]`);
    await expect(insideCard.locator('.note-badge-set-aside')).toBeVisible({ timeout: 15000 });
    // And in the card's name, because a badge is a span whose tooltip needs a
    // hover: read aloud, the thought would otherwise sound current.
    await expect(insideCard.getByRole('group')).toHaveAccessibleName(new RegExp(made.branch));
    await expect(page.locator(`.react-flow__node[data-id="${made.outside}"] .note-badge-set-aside`)).toHaveCount(0);

    await page.getByLabel('한 갈래만 보기').click();
    await page.getByRole('menuitem', { name: made.branch }).click();

    // Faded, not gone — and the banner says how much was set aside, so the
    // canvas cannot look emptier than it is.
    await expect(page.getByText('1개에 집중')).toBeVisible();
    // Computed style, deliberately: the card carries an animation whose final
    // keyframe outranks an inline opacity, so reading the attribute would pass
    // on a fade the browser never draws. It did, once.
    const outsideNode = page.locator(`.react-flow__node[data-id="${made.outside}"]`);
    await expect(outsideNode).toBeVisible();
    await expect(outsideNode).toHaveCSS('opacity', '0.22');
    await expect(insideCard).toHaveCSS('opacity', '1');

    await page.getByRole('button', { name: '전체 보기' }).click();
    await expect(outsideNode).toHaveCSS('opacity', '1');
  });
});
