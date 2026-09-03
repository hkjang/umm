import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { signIn, unique } from './helpers';

/**
 * Taking the canvas away as a PDF.
 *
 * This exists because the feature shipped without a browser ever walking it,
 * and the thing that broke was invisible to every other check. jsPDF imports
 * html2canvas for a method umm never calls; html2canvas is an optional
 * dependency, so it was on a developer's disk and absent from the image built
 * by `npm ci`. The bundle built on a laptop and failed in Docker — the release
 * path — while the unit tests, the type checker and the linter all passed,
 * because none of them load the library.
 *
 * So what is checked here is the part only a browser can answer: the module
 * loads, the export runs end to end, and what lands on disk is a PDF rather
 * than an empty file or a stack trace.
 */
test('exports the canvas as a PDF a reader could open', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  const marker = unique('PDF');
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
    await post(`/api/v1/spaces/${created.id}/notes`, { content: `${name} 첫 생각`, x: 0, y: 0 });
    await post(`/api/v1/spaces/${created.id}/notes`, { content: `${name} 둘째 생각`, x: 400, y: 200 });
    return created.id as string;
  }, marker);

  await page.goto(`/space/${space}`);
  await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);
  // The image is rendered from the nodes on screen, so they have to be there.
  await expect(page.getByRole('group', { name: new RegExp(`${marker} 첫 생각`) })).toBeVisible();

  await page.getByRole('button', { name: '내보내기' }).click();
  const started = page.getByRole('menuitem', { name: 'PDF 다운로드' }).click();

  // A failure here is reported on screen rather than thrown, so the two
  // outcomes race: whichever arrives first is the answer. Checking for the
  // error message on its own would pass before the message could appear, and
  // then wait out the download timeout with nothing to say about why.
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
  expect(file.suggestedFilename()).toMatch(/\.pdf$/);

  const path = await file.path();
  const bytes = readFileSync(path);
  // The header a PDF reader looks for. An empty file, an HTML error page or a
  // PNG would all arrive as a download just the same.
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  // Big enough to hold the rendered canvas: a jsPDF document with no image in
  // it is a couple of kilobytes.
  expect(bytes.length).toBeGreaterThan(20_000);

  await expect(page.getByText('내보내기 완료')).toBeVisible();
});

/**
 * The same canvas as a PNG.
 *
 * It shares the rendering step with the PDF but not the delivery: the image is
 * handed over as a data: URL on an anchor rather than written by a library.
 * That is its own way to fail, and it was untested for the same reason — the
 * export menu had never been walked in a browser.
 */
test('exports the canvas as a PNG a viewer could open', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  const marker = unique('PNG');
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
    await post(`/api/v1/spaces/${created.id}/notes`, { content: `${name} 첫 생각`, x: 0, y: 0 });
    return created.id as string;
  }, marker);

  await page.goto(`/space/${space}`);
  await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);
  await expect(page.getByRole('group', { name: new RegExp(`${marker} 첫 생각`) })).toBeVisible();

  await page.getByRole('button', { name: '내보내기' }).click();
  const started = page.getByRole('menuitem', { name: 'Image (PNG)' }).click();

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
  expect(file.suggestedFilename()).toMatch(/\.png$/);

  const bytes = readFileSync(await file.path());
  // The eight bytes every PNG starts with. A truncated data: URL, an HTML
  // error page or an empty file would all arrive as a download just the same.
  expect([...bytes.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.length).toBeGreaterThan(20_000);

  await expect(page.getByText('내보내기 완료')).toBeVisible();
});
