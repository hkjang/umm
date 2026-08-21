import { expect, type Page } from '@playwright/test';

export const credentials = {
  username: process.env.BOOTSTRAP_ADMIN ?? 'admin',
  password: process.env.BOOTSTRAP_ADMIN_PASSWORD ?? 'CI-Admin-Password-2026!',
};

/**
 * Signs in through the real form and waits for the app shell to take over.
 *
 * The language is pinned to Korean afterwards because it is an account
 * preference that follows the user to any browser — without this, a test that
 * switches languages would silently change the language of every test that
 * signs in after it.
 */
export async function signIn(page: Page, { locale = 'ko' }: { locale?: 'ko' | 'en' } = {}) {
  await page.goto('/');
  // A fresh context has no stored choice, and the config pins the browser to
  // ko-KR, so the sign-in screen is always Korean here. The labels are matched
  // loosely because Mantine appends a required marker to each one.
  const username = page.getByLabel('아이디');
  const shell = page.getByRole('navigation', { name: /^(주 메뉴|Main menu)$/ });
  // The bundle is lazy loaded, so the decision has to wait for one of the two
  // screens to actually render rather than sampling an empty document.
  await expect(username.or(shell).first()).toBeVisible();
  if (await username.isVisible().catch(() => false)) {
    await username.fill(credentials.username);
    await page.getByLabel('비밀번호').fill(credentials.password);
    await page.getByRole('button', { name: '로그인', exact: true }).click();
  }
  await expect(shell).toBeVisible();
  await page.request.put('/api/v1/preferences', { data: { locale } });
  await page.evaluate((value) => localStorage.setItem('umm:locale', value), locale);
  await page.reload();
  await expect(shell).toBeVisible();
}

/**
 * Opens the canvas and waits until it has finished loading.
 *
 * The toolbar renders before the space and its notes arrive, and a capture made
 * in that window is silently dropped because there is no active space yet, so
 * the wait is on the loading indicator clearing rather than on the toolbar.
 */
export async function openCanvas(page: Page) {
  await page.goto('/canvas');
  await expect(page.getByRole('textbox', { name: '생각 검색' })).toBeVisible();
  await expect(page.getByRole('status', { name: '생각 불러오는 중' })).toHaveCount(0);
  await expect(page).toHaveURL(/\/space\/[0-9a-f-]{36}/);
}

/** A value unique to this run, so assertions never match leftover data. */
export const unique = (prefix: string) => `${prefix}-${Date.now().toString(36)}`;
