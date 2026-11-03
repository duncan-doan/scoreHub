// Playwright checks of the pages (docs/ARCHITECTURE.md §9, step 4): a phone-sized Chromium against a fresh app.
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/ui',
  workers: 1,
  reporter: 'list',
  use: { ...devices['Pixel 7'], baseURL: 'http://localhost:3100', trace: 'retain-on-failure' },
  webServer: { command: 'node tests/ui/server.js', url: 'http://localhost:3100/api/state', reuseExistingServer: false },
});
