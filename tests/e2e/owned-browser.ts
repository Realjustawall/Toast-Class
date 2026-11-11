import { test as base, expect } from '@playwright/test';

// Windows Chrome can hang during graceful capture shutdown. Own the exact process
// and terminate it after all application assertions and context cleanup finish.
export const test = base.extend({
  browser: async ({ playwright }, use, testInfo) => {
    const server = await playwright.chromium.launchServer({
      ...testInfo.project.use.launchOptions,
      channel: process.env.PW_CHANNEL,
      host: '127.0.0.1',
    });
    const browser = await playwright.chromium.connect(server.wsEndpoint());
    try {
      await use(browser);
    } finally {
      // Use the recorded child handle on managed Windows accounts where
      // taskkill is denied, including for processes owned by the test.
      const child = server.process();
      if (process.platform === 'win32' && child.exitCode === null && child.signalCode === null)
        child.kill('SIGKILL');
      await server.kill();
      await browser.close();
    }
  },
});
export { expect };
export type { BrowserContext, Page, Download } from '@playwright/test';
