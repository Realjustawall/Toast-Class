import { defineConfig } from '@playwright/test';
const webPort = Number(process.env.TEST_WEB_PORT ?? 4175),
  apiPort = Number(process.env.TEST_API_PORT ?? 33001);
if (
  ![webPort, apiPort].every((v) => Number.isInteger(v) && v > 1024 && v <= 65535) ||
  webPort === apiPort
)
  throw new Error('Invalid isolated browser test ports');
const origin = 'http://localhost:' + webPort;
process.env.TEST_APP_ORIGIN = origin;
export default defineConfig({
  testDir: 'tests/e2e',
  workers: 1,
  // Disconnected CI exercises the real WebGL intro on a software GPU.
  timeout: 60_000,
  expect: { timeout: 20_000 },
  globalTimeout: 180000,
  use: { baseURL: origin, channel: process.env.PW_CHANNEL },
  webServer: [
    {
      command: 'npx tsx scripts/browser-test-server.ts',
      env: { TEST_API_PORT: String(apiPort), TEST_APP_ORIGIN: origin },
      url: 'http://127.0.0.1:' + apiPort + '/health',
      reuseExistingServer: false,
    },
    {
      command:
        process.env.TEST_WEB_BUILD === 'true'
          ? 'npx tsx scripts/browser-test-web.ts'
          : 'npm run dev -w apps/web -- --host 127.0.0.1 --port ' + webPort + ' --strictPort',
      env: { TOASTER_API_TARGET: 'http://127.0.0.1:' + apiPort, TEST_WEB_PORT: String(webPort) },
      url: origin,
      reuseExistingServer: false,
    },
  ],
  reporter: 'list',
});
