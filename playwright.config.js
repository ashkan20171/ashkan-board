import { defineConfig, devices } from '@playwright/test';

const apiEnv = {
  ...process.env,
  PORT: '4000',
  CORS_ORIGIN: 'http://127.0.0.1:5173',
  JWT_SECRET: 'ashkanboard-e2e-only-secret-key-32-characters-minimum',
  DATA_FILE: '/tmp/ashkan-board-e2e-data.json',
  NODE_ENV: 'test',
  METRICS_ENABLED: 'false',
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  use: {
    baseURL: 'http://127.0.0.1:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node server/app.mjs',
      url: 'http://127.0.0.1:4000/api/health/live',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: apiEnv,
    },
    {
      command: 'npm run dev -- --host 127.0.0.1 --port 5173 --strictPort',
      url: 'http://127.0.0.1:5173',
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
    },
  ],
  outputDir: 'test-results',
});
