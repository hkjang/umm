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
      // Not a plain thought: a question is kept apart on purpose.
      const right = await post(`/api/v1/spaces/${space.id}/notes`, {
        content: `${name}-오른쪽`,
        x: 980,
        y: 720,
        kind: 'question',
      });
      await post(`/api/v1/spaces/${space.id}/edges`, { source: left.id, target: right.id, relation: 'related' });
      // A direction that was followed and then set aside, with the reason.
      const branch = await post(`/api/v1/spaces/${space.id}/branches`, { name: `${name}-갈래` });
      await fetch(`/api/v1/notes/${left.id}/branch`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ branchId: branch.id }),
      });
      await post(`/api/v1/branches/${branch.id}/resolve`, {
        status: 'abandoned',
        resolution: `${name}-포기한 이유`,
      });
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
    expect(exported).toContain('## Lines of thinking');

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
    // Two thoughts, not five: the banner and the two describing sections are
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
    const byContent = await page.evaluate(async (id) => {
      const result = await (await fetch(`/api/v1/spaces/${id}/notes`)).json();
      return Object.fromEntries(
        result.notes.map((n: { id: string; content: string; kind: string }) => [n.content, { id: n.id, kind: n.kind }]),
      ) as Record<string, { id: string; kind: string }>;
    }, destination);
    const ids = Object.fromEntries(Object.entries(byContent).map(([content, n]) => [content, n.id]));

    // A question comes back a question. The distinction is the whole reason it
    // was marked one.
    expect(byContent[`${marker}-오른쪽`].kind).toBe('question');
    expect(byContent[`${marker}-왼쪽`].kind).toBe('thought');
    expect(restored.edges[0].source).toBe(ids[`${marker}-왼쪽`]);
    expect(restored.edges[0].target).toBe(ids[`${marker}-오른쪽`]);

    // And the line of thinking, with the thought that belonged to it and — the
    // part people lose first — the reason it was set aside.
    const revived = await page.evaluate(
      async (id) => await (await fetch(`/api/v1/spaces/${id}/branches`)).json(),
      destination,
    );
    expect(revived.branches).toHaveLength(1);
    expect(revived.branches[0].name).toBe(`${marker}-갈래`);
    expect(revived.branches[0].status).toBe('abandoned');
    expect(revived.branches[0].resolution).toBe(`${marker}-포기한 이유`);
    expect(revived.assignments[ids[`${marker}-왼쪽`]]).toBe(revived.branches[0].id);
    // The thought that was never in the line must not be dragged into it.
    expect(revived.assignments[ids[`${marker}-오른쪽`]]).toBeUndefined();
  });
});
