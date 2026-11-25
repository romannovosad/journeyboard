// The no-code way: the journeyboard reporter turns every passing test's final screenshot into a screen.
// Flow = the test file, step = the test's title. Run: JOURNEYBOARD_SHOTS=shots npx playwright test -c playwright.reporter.config.mjs
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  reporter: [['list'], ['journeyboard/reporter']],
  // journeyShotsDir: '' turns `snap` off here, so only the reporter writes.
  use: { baseURL: 'http://localhost:4173', viewport: { width: 1280, height: 800 }, screenshot: 'on', journeyShotsDir: '' },
  webServer: { command: 'node server.mjs', url: 'http://localhost:4173', reuseExistingServer: !process.env.CI },
});
