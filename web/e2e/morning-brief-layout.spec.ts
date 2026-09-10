import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * The counts read as a row, and the lists sit under them.
 *
 * They were siblings in one wrapping Group, so a tall list stood in the row
 * beside the short stat blocks and pushed the next count out to its right. On
 * screen, "기록해 둔 상충" ended up stranded to the right of a list of questions
 * it had nothing to do with, and the whole block read as a jumble. Checked by
 * geometry rather than by text, because the text is identical either way.
 */
test('the brief summarises in a row and details underneath', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  const marker = unique('브리핑');
  await page.evaluate(async (name) => {
    const post = async (path: string, body: unknown) =>
      (
        await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json();
    const space = await post('/api/v1/spaces', { name: `${name}-공간` });
    // A question and a recorded disagreement, so both a count and a list exist.
    await post(`/api/v1/spaces/${space.id}/notes`, { content: `${name} 이게 맞나?`, kind: 'question', x: 0, y: 0 });
    const claim = await post(`/api/v1/spaces/${space.id}/notes`, { content: `${name} 격주로 줄이자`, x: 300, y: 0 });
    const counter = await post(`/api/v1/spaces/${space.id}/notes`, {
      content: `${name} 논의가 얕아진다`,
      x: 600,
      y: 0,
    });
    await post(`/api/v1/spaces/${space.id}/edges`, {
      source: counter.id,
      target: claim.id,
      relation: 'contradicts',
    });
  }, marker);

  await page.goto('/today');
  const heading = page.getByText('질문으로 표시해 둔 것');
  await expect(heading).toBeVisible({ timeout: 20000 });

  const listTop = (await heading.boundingBox())!.y;
  const questionLabel = await page.getByText('답을 못 찾은 질문').boundingBox();
  const contradictionLabel = await page.getByText('기록해 둔 상충').boundingBox();
  expect(questionLabel).not.toBeNull();
  expect(contradictionLabel).not.toBeNull();

  // The counts share a row: same vertical band, within a line's height.
  expect(Math.abs(questionLabel!.y - contradictionLabel!.y)).toBeLessThan(12);
  // And the list starts below every one of them, rather than beside one.
  expect(listTop).toBeGreaterThan(questionLabel!.y + questionLabel!.height);
  expect(listTop).toBeGreaterThan(contradictionLabel!.y + contradictionLabel!.height);
});
