import { test, expect } from './owned-browser';

test('local segmentation model processes blur and replacement frames without CDN access', async ({
  page,
}) => {
  test.setTimeout(60000);
  const external: string[] = [];
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (!['localhost', '127.0.0.1'].includes(url.hostname)) {
      external.push(url.href);
      await route.abort();
    } else await route.continue();
  });
  await page.goto('/media-probe.html');
  await page.waitForFunction(() => Boolean((window as any).mediaProbe));
  const result = await page.evaluate(() => (window as any).mediaProbe.verifyBackgroundProcessor());
  expect(result.blurFrames).toBeGreaterThanOrEqual(3);
  expect(result.replaceFrames).toBeGreaterThanOrEqual(3);
  expect(result.sourceAlive).toBe(true);
  expect(external).toEqual([]);
});
