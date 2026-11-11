import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
import base from './playwright.media.config';

// The launcher owns the exact server child handles. This avoids taskkill,
// which managed Windows accounts may deny even for their own processes.
export default defineConfig({
  ...base,
  webServer: undefined,
  testDir: resolve('tests'),
  globalTimeout: 360000,
  reporter: [['list'], ['json', { outputFile: 'test-results/native-media-results.json' }]],
});
