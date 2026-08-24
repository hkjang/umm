import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * A space that opens summarised must never build the notes it is not going to
 * show.
 *
 * Which side of the reading-distance line a canvas opens on used to be
 * discovered only after React Flow had mounted every note and measured it, so
 * a large space built every post-it and threw them all away for a handful of
 * cluster boxes. Measured in a browser before this was fixed: 2000 nodes
 * mounted at +5.5s and replaced by 1 at +8.6s, against a request the server
 * answered in 85ms.
 *
 * The guard is a count rather than a stopwatch. A time limit would be flaky on
 * a loaded runner and would not say what went wrong; the number of nodes that
 * ever existed says exactly that.
 */
test('opens a wide space without building the notes it will not show', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);

  const marker = unique('넓은');
  const space = await page.evaluate(async (text) => {
    const post = async (path: string, body: unknown) =>
      (
        await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json();
    const created = await post('/api/v1/spaces', { name: text });
    // Huddles rather than an even spread: the default embedding cannot judge
    // meaning, so the grouping falls back to placement, and evenly scattered
    // notes have no groups to find. Far enough apart that fitting them lands
    // well below reading distance.
    const notes = [];
    for (let group = 0; group < 6; group++) {
      for (let i = 0; i < 20; i++) {
        notes.push(
          post(`/api/v1/spaces/${created.id}/notes`, {
            content: `${text} 생각 ${group}-${i} — 회고 주기와 배포 파이프라인에 대한 메모`,
            x: group * 5200 + (i % 4) * 320,
            y: Math.floor(i / 4) * 230,
          }),
        );
      }
    }
    await Promise.all(notes);
    return created.id as string;
  }, marker);

  await page.goto(`/space/${space}`);
  // Sampled every frame from inside the page rather than polled from the test
  // runner: a mount that happens and is undone between two out-of-process
  // polls would slip through, and this is a claim about work that is done and
  // discarded.
  await page.evaluate(() => {
    const w = window as unknown as { __peakNodes: number };
    w.__peakNodes = 0;
    const watch = () => {
      const count = document.querySelectorAll('.react-flow__node').length;
      if (count > w.__peakNodes) w.__peakNodes = count;
      requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  });
  await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);
  await expect(page.locator('.react-flow__node-cluster').first()).toBeVisible({ timeout: 20000 });

  const peak = await page.evaluate(() => (window as unknown as { __peakNodes: number }).__peakNodes);
  // A handful of cluster boxes, not a hundred and twenty post-its. The bound is
  // generous on purpose: what it rules out is building all of them.
  expect(peak).toBeLessThan(30);
  await expect(page.locator('.postit')).toHaveCount(0);
});

// The prediction decides how the canvas opens and nothing more. Where the notes
// sit does not change when someone zooms, so a prediction that kept overriding
// would mean zooming in never brought them back — which is exactly what
// happened the first time this was written.
test('zooming in still returns the notes themselves', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await signIn(page);

  const marker = unique('확대');
  const space = await page.evaluate(async (text) => {
    const post = async (path: string, body: unknown) =>
      (
        await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json();
    const created = await post('/api/v1/spaces', { name: text });
    const notes = [];
    for (let group = 0; group < 3; group++) {
      for (let i = 0; i < 14; i++) {
        notes.push(
          post(`/api/v1/spaces/${created.id}/notes`, {
            content: `${text} 생각 ${group}-${i}`,
            x: group * 5200 + (i % 4) * 320,
            y: Math.floor(i / 4) * 230,
          }),
        );
      }
    }
    await Promise.all(notes);
    return created.id as string;
  }, marker);

  await page.goto(`/space/${space}`);
  await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);
  await expect(page.locator('.react-flow__node-cluster').first()).toBeVisible({ timeout: 20000 });

  for (let i = 0; i < 12; i++) {
    await page.getByRole('button', { name: 'zoom in' }).click();
    await page.waitForTimeout(110);
  }
  await expect(page.locator('.react-flow__node-postit').first()).toBeVisible({ timeout: 20000 });
  await expect(page.locator('.react-flow__node-cluster')).toHaveCount(0);
});
