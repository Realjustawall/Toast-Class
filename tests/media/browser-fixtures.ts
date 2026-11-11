import { test as base, expect, type Browser, type BrowserServer } from '@playwright/test';

/** Three actual independent browser processes, owned solely by this test. */
export const test = base.extend<{ classroomBrowsers: Browser[] }>({
  classroomBrowsers: [
    async ({ playwright }, use, testInfo) => {
      const servers: BrowserServer[] = [];
      const clients: Browser[] = [];
      try {
        for (let i = 0; i < 3; i++) {
          const server = await playwright.chromium.launchServer({
            ...testInfo.project.use.launchOptions,
            channel: process.env.PW_CHANNEL,
            host: '127.0.0.1',
          });
          servers.push(server);
          clients.push(await playwright.chromium.connect(server.wsEndpoint()));
        }
        await use(clients);
      } finally {
        console.log('Closing owned test browser servers');
        // Chrome's graceful native-capture shutdown may hang on Windows. The
        // application's disconnect assertions finish before this fixture ends.
        // Kill only these recorded BrowserServer processes, then detach clients.
        const results = await Promise.allSettled(
          servers.map(async (server) => {
            const child = server.process();
            if (child.exitCode === null && child.signalCode === null) {
              if (process.platform === 'win32') child.kill('SIGKILL');
              await server.kill();
            }
          }),
        );
        const clientResults = await Promise.allSettled(clients.map((client) => client.close()));
        const failures = [...results, ...clientResults].filter(
          (r): r is PromiseRejectedResult => r.status === 'rejected',
        );
        if (failures.length)
          throw new AggregateError(
            failures.map((r) => r.reason),
            'Test browser cleanup failed',
          );
        console.log('Owned test browser servers stopped and clients detached');
      }
    },
    { timeout: 30000 },
  ],
});
export { expect };
