import { defineConfig } from '@playwright/test';

// Use the managed frontend workflow (or an explicitly supplied frontend URL).
// No backend is started: the fixture harness blocks all real API requests.
export default defineConfig({
  testDir: './e2e',
  outputDir: '../../generated-artifacts/run-progress/results',
  reporter: [['list'], ['html', {
    outputFolder: '../../generated-artifacts/run-progress/report',
    open: 'never',
  }]],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  use: {
    baseURL: process.env.E2E_BASE_URL
      ?? (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : 'http://localhost:80'),
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    reducedMotion: 'no-preference',
    launchOptions: {
      ...(process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE
        ? { executablePath: process.env.REPLIT_PLAYWRIGHT_CHROMIUM_EXECUTABLE }
        : {}),
    },
  },
  projects: [
    { name: 'desktop', use: { browserName: 'chromium', viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { browserName: 'chromium', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});
