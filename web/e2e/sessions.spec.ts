import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * Ending a login on another device has to actually end it.
 *
 * This is the same shape as the API keys someone reported: a screen that lists
 * something and offers to revoke it, where the listing is the only evidence the
 * revoke worked. A button that removes a row and leaves the credential alive is
 * worse than no button, because it is believed.
 *
 * So the check is not that the row disappears — it is that the other browser is
 * actually signed out afterwards.
 */
test.describe('logged-in devices', () => {
  test('ending another login signs that browser out', async ({ page, browser }) => {
    await signIn(page);

    // A second browser, signed in as the same person: this is the "other
    // device" the settings screen is about.
    const other = await browser.newContext();
    const otherPage = await other.newPage();
    await signIn(otherPage);
    // It can read its own account, which is what being signed in means.
    expect(await otherPage.evaluate(async () => (await fetch('/api/v1/me')).status)).toBe(200);

    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: '로그인한 기기' })).toBeVisible();
    // This browser is marked as the one you are using, and at least one other
    // login is listed. The exact count is not asserted: a shared database
    // carries logins from every earlier run, and what is under test is what
    // ending them does, not how many there are.
    await expect(page.getByText('현재 기기')).toBeVisible();
    await expect(page.getByRole('button', { name: '로그인 종료' }).first()).toBeVisible();

    // Ending other logins asks first, which is right — and means the test has
    // to answer.
    page.on('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: '다른 기기 모두 로그아웃' }).click();
    await expect(page.getByText(/개의 다른 로그인을 종료했습니다/)).toBeVisible();

    // The part the listing cannot prove, checked first: the other browser is
    // actually out. Asserting the listing before this would let a revoke that
    // only empties the list pass, which is precisely the failure worth
    // catching.
    await expect
      .poll(async () => await otherPage.evaluate(async () => (await fetch('/api/v1/me')).status), { timeout: 15_000 })
      .toBe(401);

    // And the listing agrees with what happened.
    await expect(page.getByText('로그인 기기가 이 브라우저뿐입니다.')).toBeVisible();

    // This browser is still signed in: revoking others must not sign you out.
    expect(await page.evaluate(async () => (await fetch('/api/v1/me')).status)).toBe(200);
    await other.close();
  });

  // Not knowing and knowing there is nobody are different answers.
  //
  // A failed load was shown as an empty list, and an empty list on this screen
  // reads as "no one else is signed in" — asked quietly, so nothing said
  // otherwise. Someone checking whether anybody else has their account would
  // have been told no.
  test('says it could not look rather than that nobody is there', async ({ page }) => {
    await signIn(page);
    await page.route('**/api/v1/sessions', (route) =>
      route.request().method() === 'GET' ? route.fulfill({ status: 500, json: { detail: 'nope' } }) : route.continue(),
    );
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: '로그인한 기기' })).toBeVisible();

    await expect(
      page.getByText('로그인한 기기를 불러오지 못했습니다. 다른 기기가 있는지 확인할 수 없습니다.'),
    ).toBeVisible();
    await expect(page.getByText('로그인 기기가 이 브라우저뿐입니다.')).toHaveCount(0);
    // And it does not offer to end logins it could not see.
    await expect(page.getByRole('button', { name: '다른 기기 모두 로그아웃' })).toBeDisabled();
  });
});
