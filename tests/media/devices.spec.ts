import { test, expect } from '../e2e/owned-browser';

test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
});

test('browser test devices can be reacquired after repeated stop and reload', async ({
  browser,
}) => {
  const contexts = await Promise.all(
    [0, 1].map(() => browser.newContext({ permissions: ['camera', 'microphone'] })),
  );
  try {
    const pages = await Promise.all(contexts.map((c) => c.newPage()));
    for (const p of pages) await p.goto('/media-probe.html');
    for (let cycle = 0; cycle < 5; cycle++) {
      for (const p of pages) {
        const state = await p.evaluate(async () => {
          const video = await navigator.mediaDevices.getUserMedia({ video: true });
          const audio = await navigator.mediaDevices.getUserMedia({ audio: true });
          const tracks = [...video.getTracks(), ...audio.getTracks()];
          const result = tracks.map((t) => ({ kind: t.kind, state: t.readyState }));
          tracks.forEach((t) => t.stop());
          return result;
        });
        expect(state).toEqual([
          { kind: 'video', state: 'live' },
          { kind: 'audio', state: 'live' },
        ]);
      }
      for (const p of pages) await p.reload();
    }
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
