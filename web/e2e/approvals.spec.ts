import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * A review screen has to say what is being reviewed, in the reader's language.
 *
 * This page rendered the values it stores: `pending`, and `export · space`.
 * English identifiers on a Korean screen, and a resource named only by its
 * type — so a reviewer was asked to allow an export without being told what
 * was being exported, which is the one fact the decision turns on. The product
 * already had the words: the admin screen that switches this workflow on calls
 * them 팀 공간 공유 and 외부 내보내기.
 */
const requests = {
  requests: [
    {
      id: '00000000-0000-4000-8000-00000000000a',
      requesterId: '00000000-0000-4000-8000-00000000000b',
      requesterName: '한지우',
      teamId: null,
      resourceType: 'space',
      resourceId: '00000000-0000-4000-8000-00000000000c',
      resourceName: '제품 결정',
      action: 'export',
      status: 'pending',
      comment: '분기 회고를 팀 외부와 공유하려 합니다.',
      reviewerId: null,
      reviewedAt: null,
      createdAt: '2026-08-25T12:00:00Z',
    },
    {
      id: '00000000-0000-4000-8000-00000000000d',
      requesterId: '00000000-0000-4000-8000-00000000000b',
      requesterName: '한지우',
      teamId: null,
      resourceType: 'space',
      resourceId: '00000000-0000-4000-8000-00000000000e',
      resourceName: '',
      action: 'space_share',
      status: 'approved',
      comment: '',
      reviewerId: null,
      reviewedAt: null,
      createdAt: '2026-08-24T12:00:00Z',
    },
  ],
};

test.describe('검토 · 승인', () => {
  test('names the action, the state and what is being reviewed', async ({ page }) => {
    await signIn(page);
    await page.route('**/api/v1/approvals', (route) => route.fulfill({ json: requests }));
    await page.goto('/approvals');

    await expect(page.getByText('외부 내보내기')).toBeVisible();
    await expect(page.getByText('검토 대기')).toBeVisible();
    await expect(page.getByText('팀 공간 공유')).toBeVisible();
    await expect(page.getByText('승인됨')).toBeVisible();

    // Which space, not just that it is a space.
    await expect(page.getByText('제품 결정')).toBeVisible();

    // And none of the values it is stored as.
    const body = (await page.locator('.settings-page').textContent()) ?? '';
    for (const raw of ['pending', 'approved', 'export', 'space_share']) {
      expect(body, `the stored value ${raw} reached the screen`).not.toContain(raw);
    }
  });

  test('says so when the thing being reviewed no longer has a name', async ({ page }) => {
    await signIn(page);
    await page.route('**/api/v1/approvals', (route) => route.fulfill({ json: requests }));
    await page.goto('/approvals');

    // A request outlives its space. Showing a blank line there would read as a
    // rendering fault; saying it plainly is the honest option.
    await expect(page.getByText('이름을 확인할 수 없는 대상')).toBeVisible();
  });

  // A team lead sees their own requests here on purpose — they asked for
  // something and want to watch it. The buttons were on those too, and the
  // server refuses: a lead cannot review their own request, or another team's.
  //
  // Being offered the approval of your own request is the worst place for a
  // button that fails.
  test('does not offer a team lead the approval of their own request', async ({ page }) => {
    await signIn(page);
    const lead = '00000000-0000-4000-8000-0000000000f1';
    const team = '00000000-0000-4000-8000-0000000000f2';
    await page.route('**/api/v1/me', async (route) => {
      const response = await route.fetch();
      const me = await response.json();
      await route.fulfill({ json: { ...me, id: lead, role: 'team_lead', teamId: team } });
    });
    await page.route('**/api/v1/approvals', (route) =>
      route.fulfill({
        json: {
          requests: [
            { ...requests.requests[0], id: 'a1', requesterId: lead, teamId: team, requesterName: '나' },
            { ...requests.requests[0], id: 'a2', requesterId: 'someone-else', teamId: team, requesterName: '팀원' },
            { ...requests.requests[0], id: 'a3', requesterId: 'other', teamId: 'other-team', requesterName: '남의 팀' },
          ],
        },
      }),
    );
    await page.goto('/approvals');

    // Three requests are listed; only the teammate's may be decided.
    await expect(page.getByText('팀원')).toBeVisible();
    await expect(page.getByText('나', { exact: true })).toBeVisible();
    await expect(page.getByText('남의 팀')).toBeVisible();
    await expect(page.getByRole('button', { name: '승인' })).toHaveCount(1);
    await expect(page.getByRole('button', { name: '반려' })).toHaveCount(1);
  });
});
