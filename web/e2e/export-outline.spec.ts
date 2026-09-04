import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { signIn, unique } from './helpers';

/**
 * The space as a document, in the order the graph puts it.
 *
 * The Markdown export answers "give me everything back later" and carries ids,
 * coordinates and connections. This answers a different question — "I want to
 * start writing this up" — so what matters is that a real file arrives, that
 * it holds the person's own sentences, that it follows the order they drew,
 * and that it carries none of the bookkeeping the backup format needs.
 */
test('exports the space as a document in the order it was drawn', async ({ page }) => {
  await signIn(page);

  const marker = unique('차례');
  const space = await page.evaluate(async (name) => {
    const post = async (path: string, body: unknown) =>
      (
        await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json();
    const created = await post('/api/v1/spaces', { name: `${name}-공간` });
    // Placement says one order and the follows chain says another, so the file
    // shows which one umm listened to.
    const third = await post(`/api/v1/spaces/${created.id}/notes`, { content: `${name} 셋째로 정리한다`, x: 0, y: 0 });
    const first = await post(`/api/v1/spaces/${created.id}/notes`, {
      content: `${name} 먼저 문제를 말한다`,
      x: 900,
      y: 0,
    });
    const second = await post(`/api/v1/spaces/${created.id}/notes`, {
      content: `${name} 다음으로 대안을 놓는다`,
      x: 1800,
      y: 0,
    });
    const edge = (from: { id: string }, to: { id: string }) =>
      post(`/api/v1/spaces/${created.id}/edges`, { source: from.id, target: to.id, relation: 'follows' });
    await edge(first, second);
    await edge(second, third);
    return created.id as string;
  }, marker);

  await page.goto(`/space/${space}`);
  await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);

  await page.getByRole('button', { name: '내보내기' }).click();
  const started = page.getByRole('menuitem', { name: '문서 차례 (Markdown)' }).click();

  const failure = page.getByText('내보내기 실패');
  const outcome = await Promise.race([
    page.waitForEvent('download').then((download) => ({ download })),
    failure.waitFor({ state: 'visible' }).then(() => ({ download: undefined })),
  ]);
  if (!outcome.download) {
    throw new Error(`the export failed on screen: ${await failure.locator('..').innerText()}`);
  }
  const file = outcome.download;
  await started;
  expect(file.suggestedFilename()).toMatch(/\.md$/);

  const text = readFileSync(await file.path(), 'utf8');

  // Their own sentences, all three of them.
  for (const sentence of ['먼저 문제를 말한다', '다음으로 대안을 놓는다', '셋째로 정리한다']) {
    expect(text).toContain(`${marker} ${sentence}`);
  }
  // In the order they stated, not the order they happen to sit in.
  const at = (sentence: string) => text.indexOf(`${marker} ${sentence}`);
  expect(at('먼저 문제를 말한다')).toBeLessThan(at('다음으로 대안을 놓는다'));
  expect(at('다음으로 대안을 놓는다')).toBeLessThan(at('셋째로 정리한다'));

  // And none of the backup format's bookkeeping, which is the whole difference
  // between this file and the Markdown export.
  for (const bookkeeping of ['Exported from umm at', '- id: `', '- canvas: `', '## Connections']) {
    expect(text).not.toContain(bookkeeping);
  }
  expect(text).toContain('# ');

  await expect(page.getByText('내보내기 완료')).toBeVisible();
});
