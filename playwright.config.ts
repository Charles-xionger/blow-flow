import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { baseURL: 'http://127.0.0.1:3217', headless: true, channel: 'chromium', trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/canvas-test-server.cjs',
    url: 'http://127.0.0.1:3217',
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
