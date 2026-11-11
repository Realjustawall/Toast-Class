import { test, expect } from './browser-fixtures';

test('independent browser fixture owns and releases native test devices', async ({
  classroomBrowsers,
}) => {
  for (const browser of classroomBrowsers) {
    const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
    const page = await context.newPage();
    await page.goto('/media-probe.html');
    const kinds = await page.evaluate(async () => {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      const kinds = stream
        .getTracks()
        .map((track) => track.kind)
        .sort();
      stream.getTracks().forEach((track) => track.stop());
      return kinds;
    });
    expect(kinds).toEqual(['audio', 'video']);
  }
});
