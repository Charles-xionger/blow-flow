import { defineConfig } from '@playwright/test';
const port = Number(process.env.BROWSER_TEST_PORT || 3217);

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  reporter: [['list'], ['./scripts/source-guard-reporter.cjs']],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: { baseURL: `http://127.0.0.1:${port}`, headless: true, channel: 'chromium', trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/canvas-test-server.cjs',
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
