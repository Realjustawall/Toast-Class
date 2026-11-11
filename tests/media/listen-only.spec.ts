import { test, expect, type BrowserContext } from '../e2e/owned-browser';
import { chooseMicrophone } from '../e2e/classroom-actions';
test.use({
  launchOptions: {
    args: ['--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
  },
});
test('listen only never opens devices, receives RTP, and moderator grants unlock controls', async ({
  browser,
  playwright,
}) => {
  test.setTimeout(90000);
  const origin = process.env.TEST_APP_ORIGIN!,
    contexts: BrowserContext[] = [];
  const listenerServer = await playwright.chromium.launchServer({
    channel: process.env.PW_CHANNEL,
    host: '127.0.0.1',
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
  const listenerBrowser = await playwright.chromium.connect(listenerServer.wsEndpoint());
  const post = async (context: BrowserContext, path: string, data: unknown) => {
    const response = await context.request.post(origin + '/api/v1' + path, {
      headers: { origin },
      data,
    });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  try {
    const suffix = crypto.randomUUID(),
      users = [];
    for (let index = 0; index < 2; index++) {
      const context =
        index === 0
          ? await browser.newContext({ permissions: ['microphone', 'camera'] })
          : await listenerBrowser.newContext();
      contexts.push(context);
      await context.addInitScript(() => {
        if (window === window.top) localStorage.setItem('language', 'en');
      });
      const account = {
        email: index + suffix + '@listener.test',
        password: 'listener-classroom-password',
        name: index ? 'Listener' : 'Instructor',
      };
      await post(context, '/auth/register', account);
      users.push(await post(context, '/auth/login', account));
    }
    const [owner, student] = contexts;
    const org = await post(owner, '/organizations', { name: 'Listen only permissions' });
    await post(owner, '/organizations/' + org.id + '/members', {
      email: users[1].email,
      role: 'student',
    });
    const room = await post(owner, '/organizations/' + org.id + '/classrooms', {
      name: 'Listener classroom',
      enrollmentMode: 'organization',
      permissions: { defaultMicrophone: false, defaultCamera: false },
    });
    const base = '/classrooms/' + room.id;
    await post(owner, base + '/session/start', {});
    const teacher = await owner.newPage(),
      learner = await student.newPage();
    await learner.addInitScript(() => {
      const pcs: RTCPeerConnection[] = [];
      Object.assign(window, { listenerPcs: pcs, listenerCaptureCalls: 0 });
      const Native = window.RTCPeerConnection;
      window.RTCPeerConnection = class extends Native {
        constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
          super(...args);
          pcs.push(this);
        }
      };
      navigator.mediaDevices.getUserMedia = async () => {
        (window as any).listenerCaptureCalls++;
        throw new DOMException('Listener has no device permission', 'NotAllowedError');
      };
    });
    await teacher.goto('/#classroom/' + room.id);
    await learner.goto('/#classroom/' + room.id);
    await teacher.getByRole('button', { name: 'Connect audio & video', exact: true }).click();
    await chooseMicrophone(teacher);
    await expect(teacher.getByRole('button', { name: 'Microphone', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await teacher.getByRole('button', { name: 'Camera', exact: true }).click();
    await learner.getByRole('button', { name: 'Connect audio & video', exact: true }).click();
    await expect(
      learner.getByRole('dialog').getByRole('button', { name: /^Use microphone/ }),
    ).toBeDisabled();
    await learner
      .getByRole('dialog')
      .getByRole('button', { name: /^Listen only/ })
      .click();
    await expect(learner.locator('.media-status')).toContainText('Connected', { timeout: 25000 });
    for (const name of ['Microphone', 'Camera'])
      await expect(learner.getByRole('button', { name, exact: true })).toBeDisabled();
    expect(await learner.evaluate(() => (window as any).listenerCaptureCalls)).toBe(0);
    await expect
      .poll(() =>
        learner.evaluate(async () => {
          let bytes = 0;
          for (const pc of (window as any).listenerPcs as RTCPeerConnection[])
            (await pc.getStats()).forEach((stat) => {
              if (stat.type === 'inbound-rtp') bytes += stat.bytesReceived ?? 0;
            });
          return bytes;
        }),
      )
      .toBeGreaterThan(1000);
    await post(owner, base + '/user-permissions/' + users[1].id, {
      canMicrophone: true,
      canCamera: true,
    });
    for (const name of ['Microphone', 'Camera'])
      await expect(learner.getByRole('button', { name, exact: true })).toBeEnabled();
    expect(await learner.evaluate(() => (window as any).listenerCaptureCalls)).toBe(0);
    const rectangle = await learner
      .locator('.media-tiles .media-tile[data-source="camera"]')
      .first()
      .boundingBox();
    expect(rectangle!.width / rectangle!.height).toBeCloseTo(16 / 9, 1);
    await post(owner, base + '/session/end', {});
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
    const child = listenerServer.process();
    if (child.exitCode === null) child.kill('SIGKILL');
    await listenerServer.kill();
    await listenerBrowser.close();
  }
});
