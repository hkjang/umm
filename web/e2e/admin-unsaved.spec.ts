import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/*
 * Walking away from settings that were typed but not saved.
 *
 * Measured before this existed: typing into an admin field and clicking
 * anything that leaves the page discarded it silently — no warning on the way
 * out, and no trace on the way back, the field simply read what it had before.
 * Not being told is the worse half, because the card had shown the new value
 * the whole time it was being typed.
 *
 * Moving between admin sections is not leaving. Those edits are kept and stay
 * marked, so interrupting there would be a dialog for nothing.
 */

const openGeneral = async (page: import('@playwright/test').Page) => {
  await page.goto('/admin');
  // /admin opens on the overview; the section is reached from the menu.
  await expect(page.getByText('일반', { exact: true }).first()).toBeVisible({ timeout: 20000 });
  await page.getByText('일반', { exact: true }).first().click();
  await expect(page.getByText('서비스 기본 정보')).toBeVisible({ timeout: 20000 });
};

const serviceName = (page: import('@playwright/test').Page) => page.getByLabel(/서비스 이름/).first();

/**
 * The warning, named rather than "the dialog".
 *
 * The quick navigator is itself a dialog and stays mounted behind the warning,
 * so an unnamed locator matches two and the test fails on ambiguity while the
 * thing it is checking is working perfectly.
 */
const warning = (page: import('@playwright/test').Page) =>
  page.getByRole('dialog', { name: '저장하지 않은 변경사항이 있습니다' });

test.describe('unsaved admin settings', () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 960 });
    await signIn(page);
  });

  test('moving between sections keeps the edit and does not interrupt', async ({ page }) => {
    await openGeneral(page);
    await serviceName(page).fill('바꾼 이름');

    await page.getByText('Dream Layer', { exact: true }).first().click();
    await expect(warning(page)).toHaveCount(0);

    await page.getByText('일반', { exact: true }).first().click();
    await expect(serviceName(page)).toHaveValue('바꾼 이름');
  });

  test('asks before leaving the page, and staying keeps the work', async ({ page }) => {
    await openGeneral(page);
    await serviceName(page).fill('바꾼 이름');

    await page.getByRole('button', { name: '내 공간' }).click();
    const dialog = warning(page);
    await expect(dialog).toBeVisible();
    // Naming the section is what makes the warning actionable: an administrator
    // with several sections open needs to know which one is at stake.
    await expect(dialog).toContainText('일반');

    await page.getByRole('button', { name: '여기 남기' }).click();
    await expect(page).toHaveURL(/\/admin/);
    await page.getByText('일반', { exact: true }).first().click();
    await expect(serviceName(page)).toHaveValue('바꾼 이름');
  });

  test('leaving on purpose still leaves', async ({ page }) => {
    await openGeneral(page);
    await serviceName(page).fill('바꾼 이름');

    await page.getByRole('button', { name: '내 공간' }).click();
    await page.getByRole('button', { name: '버리고 나가기' }).click();
    await expect(page).not.toHaveURL(/\/admin/);
  });

  // The quick navigator is the fastest way off a page. Guarding only the
  // sidebar would leave the fastest way out as the one that loses the work.
  test('the quick navigator asks too', async ({ page }) => {
    await openGeneral(page);
    await serviceName(page).fill('바꾼 이름');

    await page.keyboard.press('Control+k');
    await page.keyboard.type('오늘');
    // Waited for rather than timed: pressing Enter before the list has narrowed
    // would select whatever was highlighted first, which is a different test.
    await expect(page.getByRole('option')).toHaveCount(1, { timeout: 15000 });
    await page.keyboard.press('Enter');

    await expect(warning(page)).toBeVisible();
    await expect(page).toHaveURL(/\/admin/);
  });

  // With nothing unsaved there is nothing to ask about, and a dialog on every
  // exit would teach people to dismiss it without reading.
  test('says nothing when there is nothing to lose', async ({ page }) => {
    await openGeneral(page);
    await page.getByRole('button', { name: '내 공간' }).click();
    await expect(page).not.toHaveURL(/\/admin/);
  });

  // Saving clears it: the warning has to follow the work, not the fact that
  // something was once typed.
  test('stops asking once the work is saved', async ({ page }) => {
    await openGeneral(page);
    const original = await serviceName(page).inputValue();
    await serviceName(page).fill('저장할 이름');
    await page.getByRole('button', { name: '저장', exact: true }).first().click();
    await expect(page.getByText('저장되지 않은 변경사항이 있습니다.')).toHaveCount(0);

    await page.getByRole('button', { name: '내 공간' }).click();
    await expect(page).not.toHaveURL(/\/admin/);

    // Put it back, so a shared database is left as it was found.
    await openGeneral(page);
    await serviceName(page).fill(original);
    await page.getByRole('button', { name: '저장', exact: true }).first().click();
    await expect(page.getByText('저장되지 않은 변경사항이 있습니다.')).toHaveCount(0);
  });
});
