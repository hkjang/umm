import { expect, test } from '@playwright/test';
import { signIn, unique } from './helpers';

/**
 * Seeing what a band change does before everyone else does.
 *
 * The two bands decide how much of the graph a person sees. They are standard
 * deviations above the mean of a space's own scores, so their effect depends on
 * the corpus — and the screen offered two spin buttons whose only documentation
 * was to save them and go and look. Saving them changes every canvas in the
 * installation at once, and the person who changed it finds out last.
 */
test.describe('밴드 미리보기', () => {
  test.setTimeout(120_000);

  test('measures the typed bands against the thoughts already here, and saves nothing', async ({ page }) => {
    await signIn(page);

    // Two subjects that share no vocabulary, so the scores really do form two
    // populations for a band to separate.
    await page.evaluate(async (marker) => {
      const post = async (path: string, body: unknown) =>
        (
          await fetch(path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).json();
      const space = await post('/api/v1/spaces', { name: marker });
      const subjects = ['고양이 사료 급여 간격과 사료 보관 방법', '쿠버네티스 배포 롤백 절차와 헬름 차트 버전'];
      for (let i = 0; i < 24; i++) {
        await post(`/api/v1/spaces/${space.id}/notes`, {
          content: `${subjects[i % 2]} ${i}번 메모`,
          x: (i % 6) * 300,
          y: Math.floor(i / 6) * 220,
        });
      }
    }, unique('밴드'));

    await page.goto('/admin/intelligence');
    const measure = page.getByRole('button', { name: '지금 값으로 재보기' });
    await expect(measure).toBeVisible();

    // Nothing is claimed before it has been measured.
    await expect(page.getByRole('cell', { name: '연관 생각이 하나도 없는 카드' })).toHaveCount(0);

    const related = page.getByLabel('연관 생각 기준');
    const saved = await related.inputValue();

    // A band far above the current one admits almost nothing, so almost every
    // card comes back empty. That is the number this panel exists to show
    // before it is everyone's.
    await related.fill('3.5');
    await measure.click();
    const emptyCards = page.getByRole('row').filter({ hasText: '연관 생각이 하나도 없는 카드' });
    await expect(emptyCards).toHaveCount(1);
    const high = Number((await emptyCards.getByRole('cell').nth(2).innerText()).replace(/[^0-9]/g, ''));
    expect(high).toBeGreaterThan(0);

    // And the other end, so the panel is answering the field rather than
    // reporting the settings whatever it is asked.
    await related.fill('0.2');
    await measure.click();
    await expect
      .poll(async () => Number((await emptyCards.getByRole('cell').nth(2).innerText()).replace(/[^0-9]/g, '')))
      .toBeLessThan(high);

    // Measuring is not deciding: the setting on the server has not moved.
    const stored = await page.evaluate(async () => {
      const all = await (await fetch('/api/v1/admin/settings')).json();
      return String(all.intelligence.related_band);
    });
    expect(stored).toBe(saved);
  });
});
