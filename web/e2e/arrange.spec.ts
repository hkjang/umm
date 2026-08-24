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
    const after = await positionsOf(page, space);

    // The pile came apart.
    expect(after[`${marker}-겹침-1`]).not.toBe(before[`${marker}-겹침-1`]);
    // The thought that had room was not touched — this is the part that keeps a
    // layout rather than replacing it.
    expect(after[`${marker}-멀리`]).toBe(before[`${marker}-멀리`]);

    // One undo takes the whole arrangement back, not one note of it.
    await page.locator('.canvas-page').click({ position: { x: 5, y: 5 } });
    await page.keyboard.press('Control+z');
    await expect
      .poll(async () => (await positionsOf(page, space))[`${marker}-겹침-1`])
      .toBe(before[`${marker}-겹침-1`]);
    expect(await positionsOf(page, space)).toEqual(before);
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
