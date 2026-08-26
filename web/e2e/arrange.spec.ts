import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * Arranging must be reversible, and must not cost someone the layout they built.
 *
 * On this canvas a position is what a thought is remembered by. Undo used to
 * record only manual drags, so an arrangement — which moves many notes at once —
 * could not be taken back at all.
 */
test.describe('arranging thoughts', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  const positionsOf = (page: import('@playwright/test').Page, space: string) =>
    page.evaluate(async (id) => {
      const result = await (await fetch(`/api/v1/spaces/${id}/notes`)).json();
      return Object.fromEntries(
        result.notes.map((n: { content: string; x: number; y: number }) => [
          n.content,
          `${Math.round(n.x)},${Math.round(n.y)}`,
        ]),
      ) as Record<string, string>;
    }, space);

  test('separates only the overlapping thoughts, and undo puts them back', async ({ page }) => {
    const marker = unique('겹침');
    const space = await page.evaluate(async (name) => {
      const post = async (path: string, body: unknown) =>
        (
          await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).json();
      const created = await post('/api/v1/spaces', { name });
      // A pile, and one thought far away that nothing should touch.
      for (let i = 0; i < 5; i += 1) {
        await post(`/api/v1/spaces/${created.id}/notes`, {
          content: `${name}-겹침-${i}`,
          x: 100 + i * 12,
          y: 100 + i * 9,
        });
      }
      await post(`/api/v1/spaces/${created.id}/notes`, { content: `${name}-멀리`, x: 2400, y: 1600 });
      return created.id as string;
    }, marker);

    await page.goto(`/space/${space}`);
    await expect(page.locator('.canvas-page')).toBeVisible();
    await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);

    const before = await positionsOf(page, space);

    await page.getByLabel('겹침 정리').click();
    await expect(page.getByText(/겹친 생각 \d+개만 옮겼습니다/)).toBeVisible();

    // The pile came apart.
    //
    // Waited for rather than read once. The notice is raised as soon as the
    // canvas has worked out the new positions; storing them is a separate
    // request per note that is still in flight at that moment. Reading the
    // server straight after the notice caught the old positions now and then,
    // and the test failed saying a thought had not moved when it had — on
    // screen it already had.
    // Every thought in the pile, not just one of them.
    //
    // Waiting for a single note said nothing about the rest, and the assertion
    // below is that a thought was *not* moved — which a write still in flight
    // would also satisfy, so the test could pass while arranging was quietly
    // shifting something it had no business touching.
    // Every thought the arrangement moves, not just one of them.
    //
    // The pile is separated by holding the first one still and moving the four
    // behind it, and each move is its own request. Waiting for one of the four
    // said nothing about the other three — and the assertion below is that a
    // thought was *not* moved, which a write still in flight would also
    // satisfy. So the test could pass while arranging quietly shifted something
    // it had no business touching.
    await expect
      .poll(async () => {
        const now = await positionsOf(page, space);
        return [1, 2, 3, 4].every((i) => now[`${marker}-겹침-${i}`] !== before[`${marker}-겹침-${i}`]);
      })
      .toBe(true);
    const after = await positionsOf(page, space);
    // The one at the front of the pile is the anchor and is meant to stay.
    expect(after[`${marker}-겹침-0`]).toBe(before[`${marker}-겹침-0`]);
    // The thought that had room was not touched — this is the part that keeps a
    // layout rather than replacing it.
    expect(after[`${marker}-멀리`]).toBe(before[`${marker}-멀리`]);

    // One undo takes the whole arrangement back, not one note of it.
    await page.locator('.canvas-page').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+z');
    // The whole layout, polled as one.
    //
    // Undo restores every note it moved, and each restore is its own request.
    // Waiting for one note and then reading the rest in a single shot caught
    // notes whose writes had not landed yet — the arrangement was already back
    // on screen, and two of five were still on their way to the server. That is
    // the failure this suite reported for weeks and I could not summon; holding
    // the saves back on purpose reproduces it every time.
    await expect.poll(async () => await positionsOf(page, space), { timeout: 15_000 }).toEqual(before);
  });

  test('says so rather than moving anything when nothing overlaps', async ({ page }) => {
    const marker = unique('여유');
    const space = await page.evaluate(async (name) => {
      const post = async (path: string, body: unknown) =>
        (
          await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).json();
      const created = await post('/api/v1/spaces', { name });
      await post(`/api/v1/spaces/${created.id}/notes`, { content: `${name}-a`, x: 0, y: 0 });
      await post(`/api/v1/spaces/${created.id}/notes`, { content: `${name}-b`, x: 900, y: 0 });
      return created.id as string;
    }, marker);

    await page.goto(`/space/${space}`);
    await expect(page.locator('.canvas-page')).toBeVisible();
    await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);

    const before = await positionsOf(page, space);
    await page.getByLabel('겹침 정리').click();
    await expect(page.getByText(/겹친 생각이 없습니다/)).toBeVisible();
    expect(await positionsOf(page, space)).toEqual(before);
  });
});
