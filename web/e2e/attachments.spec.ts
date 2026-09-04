import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * A picture on a thought.
 *
 * Two things are worth driving through a browser. That the whole path works —
 * pick a file, it uploads, it is on the card, it survives a reload — and that
 * the bytes come back as a picture and nothing else. The second is the one that
 * matters: these bytes came from a person and are served from the application's
 * own origin, so a response a browser could treat as a document is stored
 * cross-site scripting.
 */

/** A real 1×1 PNG, as bytes rather than as a claim about bytes. */
const onePixelPNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

test('puts a picture on a thought and serves it as a picture', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  const marker = unique('사진');
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
    await post(`/api/v1/spaces/${created.id}/notes`, { content: `${name} 화이트보드를 찍어 두자`, x: 0, y: 0 });
    return created.id as string;
  }, marker);

  await page.goto(`/space/${space}`);
  await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);

  const card = page.getByRole('group', { name: new RegExp(marker) }).first();
  await card.getByRole('button', { name: '메모 메뉴' }).click();

  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('menuitem', { name: '그림 붙이기' }).click();
  await (await chooser).setFiles({ name: '화이트보드.png', mimeType: 'image/png', buffer: onePixelPNG });

  const picture = card.locator('.note-picture img');
  await expect(picture).toBeVisible();

  // It is on the thought, not on the screen: reload and it is still there.
  await page.reload();
  await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);
  const again = page.getByRole('group', { name: new RegExp(marker) }).first();
  await expect(again.locator('.note-picture img')).toBeVisible();

  // What the server says the bytes are, and what a browser is allowed to do
  // with them. Fetched through the page so the session cookie applies.
  const source = await again.locator('.note-picture img').getAttribute('src');
  expect(source).toBeTruthy();
  const served = await page.evaluate(async (url) => {
    const response = await fetch(url, { credentials: 'same-origin' });
    return {
      status: response.status,
      type: response.headers.get('content-type'),
      nosniff: response.headers.get('x-content-type-options'),
      policy: response.headers.get('content-security-policy'),
      bytes: (await response.arrayBuffer()).byteLength,
    };
  }, source!);

  expect(served.status).toBe(200);
  expect(served.type).toBe('image/png');
  expect(served.nosniff).toBe('nosniff');
  expect(served.policy).toContain("default-src 'none'");
  expect(served.bytes).toBe(onePixelPNG.byteLength);
});

// The upload's word about itself is worth nothing, and the person is told which
// rule they met rather than that something went wrong.
test('refuses a file that is not a picture, whatever it is called', async ({ page }) => {
  await signIn(page);

  const marker = unique('가짜');
  const noteID = await page.evaluate(async (name) => {
    const post = async (path: string, body: unknown) =>
      (
        await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json();
    const space = await post('/api/v1/spaces', { name: `${name}-공간` });
    const note = await post(`/api/v1/spaces/${space.id}/notes`, { content: name, x: 0, y: 0 });
    return note.id as string;
  }, marker);

  const refusal = await page.evaluate(async (id) => {
    const form = new FormData();
    // HTML named as a picture. Served from this origin as a document it would
    // run; the server decides on the bytes.
    form.append('file', new File(['<script>alert(1)</script>'], 'innocent.png', { type: 'image/png' }));
    const response = await fetch(`/api/v1/notes/${id}/attachments`, { method: 'POST', body: form });
    return { status: response.status, body: await response.text() };
  }, noteID);

  expect(refusal.status).toBe(415);
  // And it says what is allowed, so somebody with a HEIC photo knows what to do.
  expect(refusal.body).toContain('image/png');
});
