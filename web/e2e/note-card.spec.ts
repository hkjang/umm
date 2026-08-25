import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * A note card must not misreport what the thought says.
 *
 * The textarea has always scrolled, so a long thought was readable — but
 * nothing on the card admitted there was more of it. Measured on a default
 * note: 179 characters, a 168px card, and 169px of text below the fold. More
 * of the thought was hidden than shown, and it stopped mid-syllable with no
 * ellipsis and no indicator. On a canvas whose purpose is remembering what you
 * wrote, that is the worst thing a card can do.
 *
 * The same fault in a different shape: the note menu could mark a thought as a
 * question, or hold it back from Dream analysis, and neither mark left any
 * trace on the card. A mark only its author could remember making is not a
 * mark.
 */

const LONG =
  '온보딩 문서를 다시 쓸지 아직 모르겠다. 지금 문서는 설치 절차만 있고 왜 이렇게 만들었는지가 없다. ' +
  '새로 온 사람이 사흘째 같은 질문을 반복하는 걸 보면 절차가 아니라 배경이 빠진 것 같다. ' +
  '그런데 배경을 쓰기 시작하면 분량이 세 배가 되고, 세 배가 되면 아무도 안 읽는다.';
const SHORT = '회고 주기를 격주로';

/** Creates a space holding exactly the given notes and opens it. */
async function spaceWith(page: import('@playwright/test').Page, notes: Record<string, unknown>[]) {
  const id = await page.evaluate(
    async ({ name, notes }) => {
      const post = async (path: string, body: unknown) =>
        (
          await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).json();
      const space = await post('/api/v1/spaces', { name });
      for (const note of notes) await post(`/api/v1/spaces/${space.id}/notes`, note);
      return space.id as string;
    },
    { name: unique('메모'), notes },
  );
  await page.goto(`/space/${id}`);
  await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);
  await expect(page.locator('.postit').first()).toBeVisible();
  return id;
}

/**
 * The card for the note containing the given words.
 *
 * Matched on the card's accessible name rather than on `textarea[value^=…]`:
 * React never reflects a controlled value to the DOM attribute, so the
 * attribute selector matched nothing at all and the assertion passed vacuously.
 */
const cardFor = (page: import('@playwright/test').Page, words: string) =>
  page.locator(`.postit[aria-label*="${words}"]`);

test.describe('note card', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await signIn(page);
  });

  test('says how much of a thought it is not showing', async ({ page }) => {
    await spaceWith(page, [
      { content: LONG, x: 0, y: 0 },
      { content: SHORT, x: 360, y: 0 },
    ]);

    // Exactly one card is clipped, and it is the long one.
    const chips = page.locator('.more-chip');
    await expect(chips).toHaveCount(1);
    // The count is the point: "there is more" without "how much" still leaves
    // you guessing whether it is a word or a paragraph.
    await expect(chips.first()).toHaveText(/^\+\d+줄$/);

    const clipped = await page.locator('.postit.postit-clipped').count();
    expect(clipped).toBe(1);
  });

  test('a thought that fits says nothing', async ({ page }) => {
    await spaceWith(page, [{ content: SHORT, x: 0, y: 0 }]);
    await expect(page.locator('.more-chip')).toHaveCount(0);
    await expect(page.locator('.postit.postit-clipped')).toHaveCount(0);
  });

  test('grows the card until the whole thought fits, and keeps it', async ({ page }) => {
    const space = await spaceWith(page, [{ content: LONG, x: 0, y: 0 }]);

    const card = page.locator('.postit').first();
    // The stored height, not the rendered one. A bounding box is in screen
    // pixels and the canvas re-fits its zoom on every load, so the same note
    // measured 1091px before a reload and 642px after while its stored height
    // had not moved — comparing those would have failed for no reason.
    const storedHeight = async () =>
      page.evaluate(async (id) => {
        const { notes } = await (await fetch(`/api/v1/spaces/${id}/notes`)).json();
        return notes[0].height as number;
      }, space);
    const before = await storedHeight();
    await page.locator('.more-chip').first().click();

    // Nothing hidden is the assertion; the chip disappearing is how the card
    // says so, and both are checked because either alone could pass while the
    // other is wrong.
    await expect(page.locator('.more-chip')).toHaveCount(0);
    const hidden = await card.locator('textarea').evaluate((el) => el.scrollHeight - el.clientHeight);
    expect(hidden).toBeLessThanOrEqual(2);
    const grown = await storedHeight();
    expect(grown).toBeGreaterThan(before);

    // A size the person now depends on has to survive the round trip.
    await page.reload();
    await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);
    await expect(page.locator('.more-chip')).toHaveCount(0);
    expect(await storedHeight()).toBe(grown);
  });

  test('shows the marks a person put on a thought', async ({ page }) => {
    await spaceWith(page, [
      { content: '격주 회고가 정말 더 나은가?', x: 0, y: 0, kind: 'question' },
      { content: '개인적인 메모라 분석에서 빼 둔다', x: 360, y: 0, aiExcluded: true },
      { content: SHORT, x: 720, y: 0 },
    ]);

    await expect(page.locator('.note-badge-question')).toHaveCount(1);
    await expect(page.locator('.note-badge-excluded')).toHaveCount(1);
    // On the marked card, not merely somewhere on the canvas.
    await expect(cardFor(page, '격주').locator('.note-badge-question')).toBeVisible();
    await expect(cardFor(page, '개인적인').locator('.note-badge-excluded')).toBeVisible();
    // And an unmarked thought stays unmarked.
    await expect(cardFor(page, '회고 주기').locator('.note-badge')).toHaveCount(0);
  });

  test('marking a thought as a question shows on the card straight away', async ({ page }) => {
    await spaceWith(page, [{ content: SHORT, x: 0, y: 0 }]);
    await expect(page.locator('.note-badge-question')).toHaveCount(0);

    const card = page.locator('.postit').first();
    await card.hover();
    await card.getByRole('button', { name: '메모 메뉴' }).click();
    await page.getByRole('menuitem', { name: '질문으로 표시' }).click();

    // The round trip that was missing: mark it, and the card says so without
    // reopening the menu to find out.
    await expect(page.locator('.note-badge-question')).toHaveCount(1);
  });

  /*
   * Every mark at once, on the smallest note a person can make, in the longer
   * language.
   *
   * The badges started out positioned over the card and unable to wrap. In
   * English at 190px the three of them measured 207px inside a 138px box and
   * the last one hung 68px past the card, across the note menu. Korean fitted
   * at 139px against 138px — one pixel inside — so nothing looked wrong in the
   * language the app is developed in. Only the combination shows it, which is
   * why this test insists on all of it.
   */
  test('fits every mark inside the smallest note, in English too', async ({ page }) => {
    await signIn(page, { locale: 'en' });
    const made = await page.evaluate(async () => {
      const post = async (path: string, body: unknown) =>
        (
          await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).json();
      const space = await post('/api/v1/spaces', { name: 'every-mark' });
      // The narrowest a note goes, so the row has the least room it ever gets.
      const note = await post(`/api/v1/spaces/${space.id}/notes`, {
        content: 'A question I am also keeping out of the analysis',
        x: 0,
        y: 0,
        width: 190,
        height: 120,
        kind: 'question',
        aiExcluded: true,
      });
      const branch = await post(`/api/v1/spaces/${space.id}/branches`, { name: 'a line I stopped' });
      await fetch(`/api/v1/notes/${note.id}/branch`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branchId: branch.id }),
      });
      await post(`/api/v1/branches/${branch.id}/resolve`, { status: 'abandoned', resolution: 'not worth it' });
      return { space: space.id, note: note.id };
    });

    await page.goto(`/space/${made.space}`);
    await expect(page.getByRole('status', { name: /생각 불러오는 중|Loading thoughts/ })).toHaveCount(0);
    const card = page.locator(`.react-flow__node[data-id="${made.note}"] .postit`);
    await expect(card.locator('.note-badge')).toHaveCount(3);

    const fit = await card.evaluate((el) => {
      const row = el.querySelector('.note-badges')!;
      const menu = el.querySelector('.note-actions')!.getBoundingClientRect();
      const badges = [...row.querySelectorAll('.note-badge')].map((b) => b.getBoundingClientRect());
      const box = el.getBoundingClientRect();
      return {
        // Not the row's own box: it is capped by max-width, so a badge can sit
        // outside it while the row still measures as though it fits. What
        // matters is where the badges actually are.
        widest: Math.max(...badges.map((b) => b.right)),
        cardRight: box.right,
        menuLeft: menu.left,
        lowest: Math.max(...badges.map((b) => b.bottom)),
        cardBottom: box.bottom,
      };
    });
    expect(fit.widest).toBeLessThanOrEqual(fit.cardRight);
    expect(fit.widest).toBeLessThanOrEqual(fit.menuLeft);
    expect(fit.lowest).toBeLessThanOrEqual(fit.cardBottom);

    // Wrapping must not push the marks over the thought either.
    const textTop = await card.locator('textarea').evaluate((el) => el.getBoundingClientRect().top);
    expect(fit.lowest).toBeLessThanOrEqual(textTop + 1);
  });
});

/*
 * A note's name.
 *
 * Notes have carried a title for as long as importing a document has existed —
 * a markdown heading becomes one — and the canvas showed none of it. The
 * heading was in the database, in what search matched, on the slide a
 * presentation compiled it into and in what a screen reader read out, and
 * invisible in the one place its author actually looks. There was also no way
 * to give a note a name, or to take one off.
 */
test('shows the name an imported document gave a thought', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  const marker = unique('가져온');
  const space = await page.evaluate(async (text) => {
    const created = await (
      await fetch('/api/v1/spaces', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: text }),
      })
    ).json();
    // Exactly the shape importing a markdown document produces.
    await fetch(`/api/v1/spaces/${created.id}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: `${text} 배포 파이프라인`, content: '젠킨스로 옮기는 실험', x: 0, y: 0 }),
    });
    return created.id as string;
  }, marker);

  await page.goto(`/space/${space}`);
  await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);
  await expect(page.locator('.note-title')).toHaveValue(`${marker} 배포 파이프라인`);
});

// A thought nobody named stays as it was. An empty field above every note would
// be a form where there was a piece of paper.
test('a thought with no name shows no field for one', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await spaceWith(page, [{ content: SHORT, x: 0, y: 0 }]);
  await expect(page.locator('.note-title')).toHaveCount(0);
});

/**
 * Changing a note must not make the canvas hide it.
 *
 * The nodes are rebuilt from scratch whenever a note changes, and a rebuilt
 * node carries no measurements, so React Flow hides it — `visibility: hidden` —
 * until it has measured it again. Hiding an element blurs whatever inside it
 * held the cursor, which is why naming a thought and pressing Enter could drop
 * you out of the thought you were sent to. Recorded from the page:
 *
 *   focusin  textarea[생각 내용]      the cursor arrives
 *   ATTR     visibility: hidden       the rebuild is measured
 *   focusout textarea -> null         and the cursor is dropped
 *
 * The test watches for the hiding rather than for the lost cursor, because the
 * hiding happens on every save while whether it beats the cursor there depends
 * on how loaded the machine is. Under CPU contention the cursor was lost five
 * times in six; asserting on the cause is what makes this reliable.
 */
/**
 * The chips must not be drawn over the thought.
 *
 * Both sit in the card's bottom corners and both are absolutely positioned, so
 * they were painted on top of the text rather than beside it. Measured in
 * layout pixels on a note whose text fills the card: the text area reached to
 * 16px above the card's bottom edge while the chips occupied from 10px to 33px,
 * leaving seventeen pixels of the last line underneath them.
 *
 * The +N줄 chip made it plainest — a chip whose entire job is to say part of
 * the thought is hidden was itself hiding part of the thought.
 *
 * Measured in layout pixels rather than from bounding rectangles, because the
 * canvas is under a zoom transform: a rect comparison mixes scaled and unscaled
 * numbers and reports an overlap that is not there.
 */
test('never draws a chip over the thought', async ({ page }) => {
  await signIn(page);
  // Long enough that the text fills the card and the +N줄 chip appears.
  await spaceWith(page, [{ content: LONG, x: 0, y: 0 }]);

  const card = page.locator('.postit').first();
  await expect(card.locator('.more-chip')).toBeVisible();

  const room = await card.evaluate((el) => {
    const ta = el.querySelector('textarea[aria-label="생각 내용"]')!;
    const chip = el.querySelector('.more-chip')!;
    const px = (v: string) => parseFloat(v) || 0;
    // Distances up from the card's bottom edge, all in layout pixels.
    return {
      textFloor: px(getComputedStyle(el).paddingBottom) + px(getComputedStyle(ta).paddingBottom),
      chipTop: px(getComputedStyle(chip).bottom) + (chip as HTMLElement).offsetHeight,
    };
  });

  // The lowest a glyph can reach has to be above the highest the chip reaches.
  expect(room.textFloor).toBeGreaterThanOrEqual(room.chipTop);
});

test('does not hide a thought on the canvas when it changes', async ({ page }) => {
  await signIn(page);
  await spaceWith(page, [{ content: SHORT, x: 0, y: 0 }]);

  await page.evaluate(() => {
    const hidden: string[] = [];
    (window as unknown as { __hidden: string[] }).__hidden = hidden;
    new MutationObserver((records) => {
      for (const record of records) {
        const el = record.target as HTMLElement;
        if (el.classList?.contains('react-flow__node') && el.style.visibility === 'hidden') {
          hidden.push(el.getAttribute('data-id') ?? 'node');
        }
      }
    }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['style'] });
  });

  // Any edit will do; this is the one a person makes most.
  const editor = page.locator('.postit').first().getByRole('textbox', { name: '생각 내용' });
  await editor.click();
  await editor.fill('회고 주기를 격주로 줄이자');
  await editor.blur();
  await expect
    .poll(async () => page.evaluate(() => (window as unknown as { __hidden: string[] }).__hidden.length), {
      timeout: 4000,
      intervals: [200, 300, 500, 1000],
    })
    .toBe(0);
});

test('names a thought and keeps the name', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const space = await spaceWith(page, [{ content: SHORT, x: 0, y: 0 }]);

  const card = page.locator('.postit').first();
  await card.hover();
  await card.getByRole('button', { name: '메모 메뉴' }).click();
  await page.getByRole('menuitem', { name: '제목 붙이기' }).click();

  // Naming is one action: the field exists and has the cursor, rather than
  // appearing and leaving someone to find it.
  const field = page.locator('.note-title');
  await expect(field).toBeFocused();
  await field.fill('회고 주기');
  await field.press('Enter');
  // Enter moves on to the thought, which is where someone naming a note was
  // heading anyway.
  await expect(card.getByRole('textbox', { name: '생각 내용' })).toBeFocused();

  // A name that lives only in the tab is not a name.
  await page.reload();
  await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);
  await expect(page.locator('.note-title')).toHaveValue('회고 주기');

  const stored = await page.evaluate(async (id) => {
    const { notes } = await (await fetch(`/api/v1/spaces/${id}/notes`)).json();
    return notes[0].title as string;
  }, space);
  expect(stored).toBe('회고 주기');
});

test('takes a name back off', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await spaceWith(page, [{ content: SHORT, x: 0, y: 0, title: '지울 이름' }]);

  await expect(page.locator('.note-title')).toHaveValue('지울 이름');
  const card = page.locator('.postit').first();
  await card.hover();
  await card.getByRole('button', { name: '메모 메뉴' }).click();
  await page.getByRole('menuitem', { name: '제목 지우기' }).click();
  await expect(page.locator('.note-title')).toHaveCount(0);
});

// The name takes room from the thought, so what the card says is out of view
// has to account for it — or the count is describing a card that no longer
// exists.
test('counts the hidden lines with the name taking its room', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await spaceWith(page, [
    { content: LONG, x: 0, y: 0 },
    { content: LONG, x: 500, y: 0, title: '온보딩 문서' },
  ]);

  await expect(page.locator('.more-chip')).toHaveCount(2);
  const hidden = await page.evaluate(() =>
    [...document.querySelectorAll('.postit')].map((card) => {
      const editor = card.querySelector('textarea')!;
      return { named: !!card.querySelector('.note-title'), hidden: editor.scrollHeight - editor.clientHeight };
    }),
  );
  const named = hidden.find((h) => h.named)!;
  const plain = hidden.find((h) => !h.named)!;
  expect(named.hidden).toBeGreaterThan(plain.hidden);
});

/*
 * The addresses a thought refers to.
 *
 * A note saying "참고 자료: https://…" had its most useful part unreachable: the
 * body is a textarea so it can be edited, and text in a textarea is text.
 * Copying the address out by hand was the workaround.
 */
test('offers the addresses a thought refers to', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await spaceWith(page, [
    {
      content: '참고 자료: https://github.com/hkjang/umm 와 https://github.com/hkjang/ptium 를 보면 된다.',
      x: 0,
      y: 0,
    },
  ]);

  const card = page.locator('.postit').first();
  await card.hover();
  await card.getByRole('button', { name: '메모 메뉴' }).click();
  await page.getByRole('menuitem', { name: '링크 열기' }).click();

  const links = page.locator('a[role=menuitem]');
  await expect(links).toHaveCount(2);
  // Both are openable, and each is told apart from the other rather than both
  // reading as the host they share.
  await expect(links.first()).toHaveAttribute('href', 'https://github.com/hkjang/umm');
  // The full stop ends the sentence; it is not part of the address.
  await expect(links.last()).toHaveAttribute('href', 'https://github.com/hkjang/ptium');
  // The page being opened has no business knowing which thought opened it.
  await expect(links.first()).toHaveAttribute('rel', /noreferrer/);
});

// A thought that refers to nothing offers nothing, rather than an entry that
// opens an empty list.
test('a thought that refers to nothing offers no links', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  await spaceWith(page, [{ content: SHORT, x: 0, y: 0 }]);

  const card = page.locator('.postit').first();
  await card.hover();
  await card.getByRole('button', { name: '메모 메뉴' }).click();
  await expect(page.getByRole('menuitem', { name: '링크 열기' })).toHaveCount(0);
});
