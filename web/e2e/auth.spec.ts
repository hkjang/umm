import { expect, test } from '@playwright/test';
import { credentials, signIn } from './helpers';

test.describe('sign in', () => {
  test('rejects a wrong password without revealing which field was wrong', async ({ page }) => {
    await page.goto('/');
    await page.getByLabel('아이디').fill(credentials.username);
    await page.getByLabel('비밀번호').fill('definitely-not-the-password');
    await page.getByRole('button', { name: '로그인' }).click();
    await expect(page.getByRole('alert')).toContainText('아이디 또는 비밀번호');
    await expect(page.getByLabel('비밀번호')).toBeVisible();
  });

  test('signs in and lands on today’s review', async ({ page }) => {
    await signIn(page);
    await expect(page).toHaveURL(/\/today$/);
    await expect(page.getByRole('heading', { name: '오늘, 이어볼 생각' })).toBeVisible();
  });

  test('lists this browser among the active sessions', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: '로그인한 기기' })).toBeVisible();
  });
});
