import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // The project is often developed on a Windows-mounted filesystem where
    // spawning a fork and booting jsdom is slow; the defaults time the worker
    // out before the first test runs.
    pool: 'threads',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    teardownTimeout: 30_000,
  },
});
