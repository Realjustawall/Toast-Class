import { chooseMicrophone } from './classroom-actions';
import type { BrowserContext } from './owned-browser';
import { test, expect } from './owned-browser';

test('real microphone RTP lights the speaker name and avatar, clears on mute and disconnects on enrollment revocation', async ({
  browser,
}) => {
  test.skip(!process.env.TEST_MEDIA_KEY, 'Requires the actual SFU');
  test.setTimeout(90000);
  const origin = process.env.TEST_APP_ORIGIN!,
    contexts: BrowserContext[] = [];
  try {
    const users = [];
    for (const name of ['Speaking teacher', 'Speaking learner']) {
      const context = await browser.newContext({ permissions: ['microphone'] });
      contexts.push(context);
      await context.addInitScript(() => {
        if (window !== window.top) return;
        localStorage.setItem('language', 'en');
        const windowTest = window as unknown as {
          testMicrophoneGain?: GainNode;
          testPeerConnections: RTCPeerConnection[];
        };
        const Native = window.RTCPeerConnection;
        windowTest.testPeerConnections = [];
        window.RTCPeerConnection = class extends Native {
          constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
            super(...args);
            windowTest.testPeerConnections.push(this);
          }
        };
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          if (constraints?.audio && !constraints.video) {
            const audio = new AudioContext();
            await audio.resume();
            const oscillator = audio.createOscillator(),
              gain = audio.createGain(),
              destination = audio.createMediaStreamDestination();
            oscillator.frequency.value = 440;
            gain.gain.value = 0;
            oscillator.connect(gain);
            gain.connect(destination);
            oscillator.start();
            windowTest.testMicrophoneGain = gain;
            return destination.stream;
          }
          return original(constraints);
        };
      });
      const email = crypto.randomUUID() + '@speaking.test',
        password = 'real-audio-test-password';
      const post = async (path: string, data: unknown) => {
        const r = await context.request.post(origin + '/api/v1' + path, {
          headers: { origin },
          data,
        });
        expect(r.ok(), await r.text()).toBe(true);
        return r.json();
      };
      await post('/auth/register', { email, password, name });
      users.push(await post('/auth/login', { email, password }));
    }
    const [teacher, student] = contexts;
    const post = async (path: string, data: unknown) => {
      const r = await teacher.request.post(origin + '/api/v1' + path, {
        headers: { origin },
        data,
      });
      expect(r.ok(), await r.text()).toBe(true);
      return r.json();
    };
    const org = await post('/organizations', { name: 'Actual speaking signals' });
    await post('/organizations/' + org.id + '/members', { email: users[1].email, role: 'student' });
    const room = await post('/organizations/' + org.id + '/classrooms', {
      name: 'Speaking indicator classroom',
      memberIds: [users[1].id],
    });
    const base = '/classrooms/' + room.id;
    await post(base + '/session/start', {});
    const pages = [];
    for (const context of contexts) {
      const page = await context.newPage();
      pages.push(page);
      await page.goto('/#classroom/' + room.id);
      await page.getByRole('button', { name: 'Connect audio & video', exact: true }).click();
      await chooseMicrophone(page);
      await expect(page.locator('.media-status')).toContainText('Connected', { timeout: 30000 });
      await expect(page.getByRole('button', { name: 'Microphone', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
    const [a, b] = pages,
      participant = users[1].id;
    await b.evaluate(() => {
      (window as unknown as { testMicrophoneGain: GainNode }).testMicrophoneGain.gain.value = 0.8;
    });
    const name = a.locator('.participant-item[data-participant-id="' + participant + '"]');
    const tile = a.locator('.media-tile[data-participant-id="' + participant + '"]');
    await expect(name).toHaveAttribute('data-speaking', 'true', { timeout: 20000 });
    await expect(name).toHaveAttribute('data-microphone', 'true');
    await expect(tile).toHaveAttribute('data-speaking', 'true');
    await expect
      .poll(() =>
        name.locator('.classroom-avatar').evaluate((e) => getComputedStyle(e).borderTopColor),
      )
      .toMatch(/^rgba?\(16,\s*185,\s*129(?:,|\))/);
    await expect(tile.locator('.media-tile-label > span:not(.media-mic-state)')).toHaveCSS(
      'background-color',
      'rgb(0, 107, 80)',
    );
    const audioBytes = await a.evaluate(async () => {
      let bytes = 0;
      for (const peer of (window as unknown as { testPeerConnections: RTCPeerConnection[] })
        .testPeerConnections) {
        const stats = await peer.getStats();
        stats.forEach((s) => {
          if (s.type === 'inbound-rtp' && s.kind === 'audio') bytes += s.bytesReceived ?? 0;
        });
      }
      return bytes;
    });
    expect(audioBytes).toBeGreaterThan(0);
    console.log('Actual received microphone RTP bytes:', audioBytes);
    await a.screenshot({ path: 'test-results/real-speaking-indicator.png' });
    await b.getByRole('button', { name: 'Microphone', exact: true }).click();
    await expect(name).toHaveAttribute('data-speaking', 'false', { timeout: 15000 });
    await expect(name).toHaveAttribute('data-microphone', 'false');
    await expect(tile).toHaveAttribute('data-speaking', 'false');
    await post(base + '/access', { enrollmentMode: 'assigned', memberIds: [] });
    await expect(b.locator('.classroom-shell')).toHaveCount(0, { timeout: 15000 });
    await expect(tile).toHaveCount(0, { timeout: 15000 });
    await expect(name).toHaveCount(0, { timeout: 15000 });
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});
