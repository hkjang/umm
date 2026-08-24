import { expect, test } from '@playwright/test';
import { signIn } from './helpers';

/**
 * Embeddings can live on a different server from the chat model, so the fields
 * that point at them must not disturb the one that points at chat.
 *
 * Discovery used to write the address it found into Base URL. That was right
 * while both shared one field; with them separated it would aim the chat model
 * at an embeddings-only server and break answering.
 */
test.describe('admin embedding gateway', () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
  });

  test('discovery fills the embedding address and leaves the chat one alone', async ({ page }) => {
    // Stubbed rather than probing the host: a test that only runs where an
    // embedding server happens to be listening is skipped in CI and protects
    // nothing.
    await page.route('**/api/v1/admin/ai-gateway/discover', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          gateways: [{ baseUrl: 'http://embeddings:11434', models: [{ name: 'bge-m3', likelyEmbedding: true }] }],
        }),
      });
    });

    await page.goto('/admin/ai_gateway');
    const chat = page.getByLabel('Base URL');
    await expect(chat).toBeVisible();
    await chat.fill('https://chat-model.example/v1');

    await page
      .getByRole('button', { name: /자동|찾기/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'bge-m3', exact: true }).click();

    // The discovered address belongs to embeddings.
    await expect(page.getByLabel('임베딩 Gateway 주소')).toHaveValue('http://embeddings:11434');
    await expect(page.getByLabel('임베딩 모델')).toHaveValue('bge-m3');
    // And the chat model is left where the administrator put it.
    await expect(chat).toHaveValue('https://chat-model.example/v1');
  });

  test('offers a separate key for the embedding server', async ({ page }) => {
    await page.goto('/admin/ai_gateway');
    await expect(page.getByLabel('임베딩 API Key')).toBeVisible();
    // Saying so matters: leaving it empty must not be read as "reuse the other
    // key", because that key belongs to a different host.
    await expect(page.getByText(/위의 API Key는 그쪽으로 보내지 않습니다/)).toBeVisible();
  });
});
