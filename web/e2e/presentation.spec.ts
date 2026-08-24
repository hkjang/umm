import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * Seeing what a space would become before anything is made.
 *
 * The screen exists rather than a "make a deck" button because a deck compiled
 * from someone's thinking is only useful if they can read what it will say
 * first — and correct it in the space, where the thought lives, rather than in
 * the deck. So what is checked here is that the preview shows the person's own
 * sentences, says what it left out, and creates nothing until asked.
 */
test('previews a space as a talk without making anything', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  const marker = unique('회고');
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
    const note = (content: string, x: number, y: number, extra: Record<string, unknown> = {}) =>
      post(`/api/v1/spaces/${created.id}/notes`, { content, x, y, ...extra });

    const question = await note(`${text} 정말 더 나은가?`, 0, 0, { kind: 'question' });
    const answer = await note(`${text} 격주로 줄여 보자`, 700, 0);
    const evidence = await note(`${text} 주기가 짧으면 논의가 얕아진다`, 700, 300);
    const against = await note(`${text} 사이 기간의 맥락을 잊는다`, 1400, 0);
    await note(`${text} 개인적인 메모`, 2100, 0, { aiExcluded: true });

    const edge = (from: { id: string }, to: { id: string }, relation: string) =>
      post(`/api/v1/spaces/${created.id}/edges`, { source: from.id, target: to.id, relation });
    await edge(answer, question, 'answers');
    await edge(evidence, answer, 'supports');
    await edge(answer, against, 'contradicts');
    return created.id as string;
  }, marker);

  await page.goto(`/space/${space}`);
  await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);
  await page.getByLabel('이 공간을 발표 자료로').click();

  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();

  // The sentences are the ones the person wrote, not a paraphrase of them.
  await expect(modal.getByText(`${marker} 격주로 줄여 보자`)).toBeVisible();
  await expect(modal.getByText(`${marker} 주기가 짧으면 논의가 얕아진다`)).toBeVisible();

  // A question they marked opens a part of the talk, and a disagreement they
  // recorded becomes one slide rather than being resolved away.
  await expect(modal.locator('.storyline-section')).toHaveCount(1);
  await expect(modal.locator('.storyline-comparison')).toHaveCount(1);

  // What was left out is counted rather than silently dropped: a thought held
  // back from analysis is held back from the deck too.
  await expect(modal.getByText(/1개 제외/)).toBeVisible();

  // Never checked must not read as checked and clean.
  await expect(modal.getByText('레이아웃 미확인')).toBeVisible();

  // And looking at it created nothing.
  const made = await page.evaluate(async (id) => {
    const body = await (await fetch(`/api/v1/spaces/${id}/presentations`)).json();
    return (body.presentations ?? []).length as number;
  }, space);
  expect(made).toBe(0);
});

/*
 * When making the deck cannot work, the screen says why in terms a person can
 * act on.
 *
 * Which reason it is depends on the deployment — no Ptium configured, or one
 * configured that cannot be reached — and the test does not control that, so it
 * asserts on what both have in common: an alert that names Ptium. Pinning one
 * of the two made this fail the moment a Ptium address was set, which is a
 * property of the database rather than of the code.
 */
test('explains why a deck cannot be made', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page);

  const marker = unique('연결');
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
    await post(`/api/v1/spaces/${created.id}/notes`, { content: `${text} 생각 하나`, x: 0, y: 0 });
    return created.id as string;
  }, marker);

  await page.goto(`/space/${space}`);
  await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);
  await page.getByLabel('이 공간을 발표 자료로').click();

  const modal = page.getByRole('dialog');
  await expect(modal).toBeVisible();
  await modal.getByRole('button', { name: 'Ptium에서 만들기' }).click();

  const alert = modal.getByRole('alert');
  await expect(alert).toBeVisible();
  // Case-insensitive: "Ptium이 연결되어 있지 않습니다" and "ptium is unreachable"
  // are both fine, and both name the thing to go and fix.
  await expect(alert).toContainText(/ptium/i);
  // And it is a sentence, not an empty box or a bare status code.
  expect(((await alert.textContent()) ?? '').trim().length).toBeGreaterThan(10);
});
