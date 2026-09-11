import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * Coming back to the space you were in.
 *
 * The navigation offers "My Space", which points at /canvas — an address that
 * names no space. Arriving there dropped whoever clicked it into whichever
 * space sorted first by name, and left the address still naming none, so the
 * next reload decided again. Somebody working in one space all morning clicked
 * the link and landed somewhere else.
 */
const seed = async (page: import('@playwright/test').Page, marker: string) =>
  page.evaluate(async (name) => {
    const post = async (path: string, body: unknown) =>
      (
        await fetch(path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).json();
    // Named so the one being worked in is not the one that sorts first.
    const first = await post('/api/v1/spaces', { name: `AAA-${name}` });
    const working = await post('/api/v1/spaces', { name: `ZZZ-${name}` });
    await post(`/api/v1/spaces/${first.id}/notes`, { content: `${name} 첫 공간의 생각`, x: 0, y: 0 });
    await post(`/api/v1/spaces/${working.id}/notes`, { content: `${name} 일하던 공간의 생각`, x: 0, y: 0 });
    return { first: first.id as string, working: working.id as string };
  }, marker);

test('the canvas link comes back to the space you were in', async ({ page }) => {
  await signIn(page);
  const marker = unique('기억');
  const made = await seed(page, marker);

  await page.goto(`/space/${made.working}`);
  await expect(page.getByRole('group', { name: new RegExp(`${marker} 일하던 공간의 생각`) })).toBeVisible();

  // Away, and back the way the navigation offers.
  await page.goto('/today');
  await page.goto('/canvas');

  await expect(page.getByRole('group', { name: new RegExp(`${marker} 일하던 공간의 생각`) })).toBeVisible({
    timeout: 15000,
  });
  // And the address names it, so the next reload is not decided all over again.
  await expect(page).toHaveURL(new RegExp(`/space/${made.working}$`));
});

test('reloading stays in the same space', async ({ page }) => {
  await signIn(page);
  const marker = unique('새로고침');
  const made = await seed(page, marker);

  await page.goto('/canvas');
  await expect(page).toHaveURL(/\/space\/[0-9a-f-]+$/);
  // Switch to the one that does not sort first, then reload twice.
  await page.goto(`/space/${made.working}`);
  await expect(page.getByRole('group', { name: new RegExp(`${marker} 일하던 공간의 생각`) })).toBeVisible();
  for (let i = 0; i < 2; i++) {
    await page.reload();
    await expect(page.getByRole('group', { name: new RegExp(`${marker} 일하던 공간의 생각`) })).toBeVisible({
      timeout: 15000,
    });
  }
});

// An address naming a space that is gone must say so rather than quietly
// showing a different one under the same link.
test('says so when the space in the address cannot be opened', async ({ page }) => {
  await signIn(page);
  const marker = unique('사라진');
  const made = await seed(page, marker);

  await page.goto(`/space/${made.working}`);
  await expect(page.getByRole('group', { name: new RegExp(`${marker} 일하던 공간의 생각`) })).toBeVisible();
  await page.evaluate(async (id) => {
    await fetch(`/api/v1/spaces/${id}`, { method: 'DELETE' });
  }, made.working);

  await page.goto(`/space/${made.working}`);
  await expect(page.getByText('공간을 찾지 못했습니다')).toBeVisible({ timeout: 15000 });
  // And it opened something real, rather than leaving an empty canvas that
  // reads as a space with nothing in it. Which space is not asserted — this
  // account has many and the fallback is whichever sorts first — only that the
  // address now names a space, and not the one that is gone.
  await expect(page).toHaveURL(/\/space\/[0-9a-f-]{36}$/);
  expect(page.url()).not.toContain(made.working);
});
