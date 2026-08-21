import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test.describe('language and theme', () => {
  test.beforeEach(async ({ page }) => await signIn(page));

  test('switches to English and keeps it across a reload', async ({ page }) => {
    await page.getByRole('button', { name: '프로필 메뉴' }).click();
    await page.getByRole('menuitem', { name: 'English' }).click();
    await expect(page.getByRole('heading', { name: 'Thoughts to pick up today' })).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Thoughts to pick up today' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  });

  test('switches to the dark theme and keeps it across a reload', async ({ page }) => {
    await page.getByRole('button', { name: '프로필 메뉴' }).click();
    await page.getByRole('menuitem', { name: '어둡게' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-mantine-color-scheme', 'dark');
  });
});
