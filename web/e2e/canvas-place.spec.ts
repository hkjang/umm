import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * Keeping your place inside a space, and lining thoughts up when you want to.
 *
 * The canvas fitted every note into view on every open, so leaving a space and
 * coming back put you at arm's length from the whole thing again — you lost
 * your place inside the space the same way the navigation lost the space
 * itself. And nothing ever caught a note on a grid, so two notes could not be
 * lined up except by eye.
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
    const space = await post('/api/v1/spaces', { name: `${name}-공간` });
    for (let i = 0; i < 4; i++) {
      await post(`/api/v1/spaces/${space.id}/notes`, { content: `${name} 생각 ${i}`, x: i * 700, y: i * 400 });
    }
    return space.id as string;
  }, marker);

/** The viewport as three numbers, read off what the canvas actually painted. */
const viewport = (page: import('@playwright/test').Page) =>
  page.evaluate(() => {
    const transform = (document.querySelector('.react-flow__viewport') as HTMLElement).style.transform;
    const [x, y] = [...transform.matchAll(/(-?[\d.]+)px/g)].map((m) => Number(m[1]));
    const zoom = Number(/scale\(([\d.]+)\)/.exec(transform)?.[1] ?? '0');
    return { x, y, zoom };
  });

test('coming back to a space comes back to where you were looking', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const marker = unique('시야');
  const space = await seed(page, marker);

  await page.goto(`/space/${space}`);
  await expect(page.getByRole('group', { name: new RegExp(`${marker} 생각 0`) })).toBeVisible();
  const fitted = await viewport(page);

  // Moved deliberately, the way somebody working on one corner would. Driven
  // through the canvas's own control rather than a synthetic wheel event,
  // because only a real move tells the canvas it has moved — and a test that
  // quietly never moved would compare a fit against a fit and pass.
  await page.locator('.react-flow__controls-zoomin').click();
  await page.waitForTimeout(600);
  const moved = await viewport(page);
  expect(moved.zoom).toBeGreaterThan(fitted.zoom);

  // What was written down is what was on screen.
  const stored = await page.evaluate((id) => localStorage.getItem(`umm:view:${id}`), space);
  expect(stored).toBeTruthy();
  const remembered = JSON.parse(stored!) as { x: number; y: number; zoom: number };
  expect(remembered.zoom).toBeCloseTo(moved.zoom, 3);

  await page.goto('/today');
  await page.goto(`/space/${space}`);
  await expect(page.getByRole('group', { name: new RegExp(`${marker} 생각 0`) })).toBeVisible();

  // Back where they were, not fitted to everything all over again.
  const restored = await viewport(page);
  expect(restored.zoom).toBeCloseTo(remembered.zoom, 3);
  expect(restored.zoom).not.toBeCloseTo(fitted.zoom, 3);
});

test('thoughts are only caught by the grid once it is turned on', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const marker = unique('격자');
  const space = await seed(page, marker);
  await page.goto(`/space/${space}`);
  await expect(page.getByRole('group', { name: new RegExp(`${marker} 생각 0`) })).toBeVisible();

  const toggle = page.getByRole('button', { name: '격자에 맞추기' });
  // Off to begin with: sticking the thought down comes before tidying it.
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  // Read off what the background is actually told to paint with. The colour
  // reaches the pattern as a custom property on the SVG, so neither computed
  // style nor a fill attribute reports it.
  const dotFill = () =>
    page.evaluate(
      () =>
        (document.querySelector('.react-flow__background') as HTMLElement | null)?.style.getPropertyValue(
          '--xy-background-pattern-color-props',
        ) ?? '',
    );
  expect(await dotFill()).toBe('transparent');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const shown = await dotFill();
  expect(shown).toBeTruthy();
  expect(shown).not.toBe('transparent');

  // Remembered, because tidying is a mode somebody is in for a while.
  await page.reload();
  await expect(page.getByRole('button', { name: '격자에 맞추기' })).toHaveAttribute('aria-pressed', 'true');
});

// The first time anybody opens a space there is nothing remembered, and the
// canvas has to find the notes by itself. React Flow's own fitView was taken
// off so that it could not overwrite a restored view, which makes this the only
// thing standing between a new space and a canvas pointed at empty ground.
test('a space nobody has opened still opens on its thoughts', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const marker = unique('첫열기');
  // Far from the origin, so a canvas that simply did not move would show
  // nothing and the assertion could not pass by luck.
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
    for (let i = 0; i < 3; i++) {
      await post(`/api/v1/spaces/${created.id}/notes`, {
        content: `${name} 멀리 있는 생각 ${i}`,
        x: 9000 + i * 320,
        y: 7000,
      });
    }
    return created.id as string;
  }, marker);

  await page.goto(`/space/${space}`);
  await expect(page.getByRole('group', { name: new RegExp(`${marker} 멀리 있는 생각 0`) })).toBeVisible({
    timeout: 20000,
  });
  // Actually within the window, not merely mounted somewhere off to the side.
  const box = await page.getByRole('group', { name: new RegExp(`${marker} 멀리 있는 생각 0`) }).boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThan(0);
  expect(box!.x).toBeLessThan(1440);
  expect(box!.y).toBeGreaterThan(0);
  expect(box!.y).toBeLessThan(900);
});

// Whether the grid actually catches anything, rather than whether its button
// looks pressed.
test('the grid only moves thoughts onto it when it is on', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);
  const marker = unique('스냅');
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
    // Deliberately off the grid to begin with.
    await post(`/api/v1/spaces/${created.id}/notes`, { content: `${name} 끌어 볼 생각`, x: 7, y: 13 });
    return created.id as string;
  }, marker);

  const positionOf = async (id: string) =>
    page.evaluate(async (spaceId) => {
      const body = await (await fetch(`/api/v1/spaces/${spaceId}/notes`)).json();
      return { x: body.notes[0].x as number, y: body.notes[0].y as number };
    }, id);

  const drag = async (dx: number, dy: number) => {
    const card = page.getByRole('group', { name: new RegExp(`${marker} 끌어 볼 생각`) }).first();
    const box = (await card.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 8);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + dx, box.y + 8 + dy, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(700);
  };

  await page.goto(`/space/${space}`);
  await expect(page.getByRole('group', { name: new RegExp(`${marker} 끌어 볼 생각`) })).toBeVisible();

  await drag(97, 43);
  const loose = await positionOf(space);
  // Landed wherever it was dropped: at least one axis is not on the grid.
  expect(loose.x % 20 !== 0 || loose.y % 20 !== 0).toBe(true);

  await page.getByRole('button', { name: '격자에 맞추기' }).click();
  await drag(53, 37);
  const caught = await positionOf(space);
  expect(caught.x % 20).toBe(0);
  expect(caught.y % 20).toBe(0);
});
