import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

test.describe('hardening', () => {
  test('serves a per-response nonce and a strict policy', async ({ page }) => {
    const response = await page.goto('/');
    const policy = response?.headers()['content-security-policy'] ?? '';
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("frame-ancestors 'none'");
    const nonce = /'nonce-([A-Za-z0-9+/]+)'/.exec(policy)?.[1];
    expect(nonce).toBeTruthy();

    // Browsers blank the nonce content attribute after parsing, so it is only
    // readable through the IDL property. Matching it against the header is what
    // proves the policy is enforcing the served bundle rather than blocking it.
    const scriptNonce = await page.evaluate(
      () => document.querySelector<HTMLScriptElement>('script[type="module"]')?.nonce ?? '',
    );
    expect(scriptNonce).toBe(nonce);
    await expect(page.locator('#root')).not.toBeEmpty();
    const second = await page.goto('/today');
    expect(second?.headers()['content-security-policy']).not.toBe(policy);
  });

  test('rejects a cross-site write', async ({ page, request }) => {
    await signIn(page);
    const response = await request.post('/api/v1/spaces', {
      data: { name: 'cross site' },
      headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(403);
  });

  test('exposes readiness without authentication', async ({ request }) => {
    const response = await request.get('/readyz');
    expect(response.ok()).toBeTruthy();
  });
});
