import { defineConfig } from '@playwright/test';
import { prepareTestCamera } from './scripts/test-camera';
import base from './playwright.config';
const testCamera = await prepareTestCamera();
export default defineConfig({
  ...base,
  testDir: 'tests/media',
  workers: 1,
  expect: { timeout: 20000 },
  timeout: 60000,
  globalTimeout: 240000,
  use: {
    ...base.use,
    channel: process.env.PW_CHANNEL,
    launchOptions: {
      args: [
        '--disable-gpu',
        '--disable-accelerated-video-encode',
        '--disable-accelerated-video-decode',
        '--autoplay-policy=no-user-gesture-required',
        '--use-fake-device-for-media-stream',
        '--use-file-for-fake-video-capture=' + testCamera,
        '--use-fake-ui-for-media-stream',
        '--enable-usermedia-screen-capturing',
      ],
    },
  },
  reporter: 'list',
});
