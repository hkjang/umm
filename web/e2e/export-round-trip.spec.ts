import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * Taking a space out of umm and putting it back.
 *
 * The export was umm's answer to "what if I want to leave", and the importer
 * arrived later without the two ever being introduced. Reading its own file
 * back is what makes the export a backup rather than a printout, and a space is
 * not only its sentences: where a thought sits and what it is joined to are
 * most of what someone built.
 *
 * Driven through the screen rather than the parser, because the parser has its
 * own tests and what is unproven is the whole way through — export, textarea,
 * import, canvas, server.
 */
test.describe('exporting a space and importing it back', () => {
  test('restores the thoughts, where they sat, and what joined them', async ({ page }) => {
    await signIn(page);
    const marker = unique('왕복');

    // A space with two thoughts a long way apart, and a connection between them.
    const source = await page.evaluate(async (name) => {
      const post = async (path: string, body: unknown) =>
        (
          await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).json();
      const space = await post('/api/v1/spaces', { name });
      const left = await post(`/api/v1/spaces/${space.id}/notes`, { content: `${name}-왼쪽`, x: 40, y: 60 });
      const right = await post(`/api/v1/spaces/${space.id}/notes`, { content: `${name}-오른쪽`, x: 980, y: 720 });
      await post(`/api/v1/spaces/${space.id}/edges`, { source: left.id, target: right.id, relation: 'related' });
      return space.id as string;
    }, marker);

    const exported = await page.evaluate(
      async (id) => (await fetch(`/api/v1/spaces/${id}/export/markdown`)).text(),
      source,
    );
    // The export is umm's own file; if it stopped announcing itself the importer
    // would read it as anyone's Markdown and this test would quietly weaken.
    expect(exported).toContain('Exported from umm at ');
    expect(exported).toContain('## Connections');

    // A different space, so nothing here can be the original showing through.
    const destination = await page.evaluate(async (name) => {
      const created = await (
        await fetch('/api/v1/spaces', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: `${name}-되살린` }),
        })
      ).json();
      return created.id as string;
    }, marker);

    await page.goto(`/space/${destination}`);
    await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);

    await page.getByRole('button', { name: '내보내기' }).click();
    await page.getByRole('menuitem', { name: '마크다운 가져오기' }).click();
    await page.getByRole('textbox', { name: '가져올 내용' }).fill(exported);
    // Two thoughts, not four: the banner and the two describing sections are
    // umm writing about the space, not thoughts in it.
    await expect(page.getByText('2개의 생각을 가져옵니다.')).toBeVisible();
    await page.getByRole('button', { name: '가져오기', exact: true }).click();

    await expect(page.getByRole('group', { name: new RegExp(`${marker}-왼쪽`) })).toBeVisible();
    await expect(page.getByRole('group', { name: new RegExp(`${marker}-오른쪽`) })).toBeVisible();

    // Read from the server, not the screen: what matters is that the restored
    // space was written down, not that it was drawn once.
    const restored = await expect
      .poll(
        async () =>
          await page.evaluate(async (id) => {
            const result = await (await fetch(`/api/v1/spaces/${id}/notes`)).json();
            return {
              notes: Object.fromEntries(
                result.notes.map((n: { content: string; x: number; y: number }) => [
                  n.content,
                  `${Math.round(n.x)},${Math.round(n.y)}`,
                ]),
              ) as Record<string, string>,
              edges: result.edges.length as number,
            };
          }, destination),
        { timeout: 15_000 },
      )
      .toMatchObject({ edges: 1 })
      .then(async () =>
        page.evaluate(async (id) => {
          const result = await (await fetch(`/api/v1/spaces/${id}/notes`)).json();
          return {
            notes: Object.fromEntries(
              result.notes.map((n: { content: string; x: number; y: number }) => [
                n.content,
                `${Math.round(n.x)},${Math.round(n.y)}`,
              ]),
            ) as Record<string, string>,
            edges: result.edges as { source: string; target: string }[],
          };
        }, destination),
      );

    // Where they sat, not a fresh grid.
    expect(restored.notes[`${marker}-왼쪽`]).toBe('40,60');
    expect(restored.notes[`${marker}-오른쪽`]).toBe('980,720');

    // And the connection, pointing the same way, between the restored copies.
    expect(restored.edges).toHaveLength(1);
    const ids = await page.evaluate(async (id) => {
      const result = await (await fetch(`/api/v1/spaces/${id}/notes`)).json();
      return Object.fromEntries(result.notes.map((n: { id: string; content: string }) => [n.content, n.id])) as Record<
        string,
        string
      >;
    }, destination);
    expect(restored.edges[0].source).toBe(ids[`${marker}-왼쪽`]);
    expect(restored.edges[0].target).toBe(ids[`${marker}-오른쪽`]);
  });
});
