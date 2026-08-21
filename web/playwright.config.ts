import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const baseURL = process.env.UMM_BASE_URL ?? 'http://127.0.0.1:8080';
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * The suite drives the real binary serving the real bundle, because the bugs it
 * is meant to catch — the offline queue, the language switch surviving a
 * reload, an import writing to the database — only exist across that boundary.
 *
 * Set UMM_E2E_COMMAND to the server binary. Without it the config assumes a
 * server is already listening on UMM_BASE_URL.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? [['github'], ['list']] : [['list']],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    locale: 'ko-KR',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: process.env.UMM_E2E_COMMAND
    ? {
        command: process.env.UMM_E2E_COMMAND,
        // The server resolves the static bundle relative to its working
        // directory, so it has to start from the repository root.
        cwd: repoRoot,
        url: `${baseURL}/healthz`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
        stdout: 'pipe',
        stderr: 'pipe',
      }
    : undefined,
});
