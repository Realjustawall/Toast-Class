import { test, expect } from './owned-browser';
import { chooseMicrophone } from './classroom-actions';

test('join stays interactive, consent precedes ICE, cancellation works and no classroom overlay is mounted', async ({
  page,
}) => {
  test.skip(!process.env.TEST_MEDIA_KEY, 'Requires an actual isolated SFU');
  const origin = process.env.TEST_APP_ORIGIN!;
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post('/api/v1' + path, { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  await page.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem('language', 'en');
    const events: string[] = [];
    Object.assign(window, { mediaLifecycle: events });
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      events.push('media.request');
      const stream = await capture(constraints);
      events.push('media.allowed');
      return stream;
    };
    const Native = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends Native {
      constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
        events.push('rtc.created');
        super(...args);
      }
    };
  });
  const email = crypto.randomUUID() + '@media-consent.test',
    password = 'media-consent-password';
  await post('/auth/register', { email, password, name: 'Media consent instructor' });
  await post('/auth/login', { email, password });
  const org = await post('/organizations', { name: 'Media consent classroom' });
  const room = await post('/organizations/' + org.id + '/classrooms', {
    name: 'Nonblocking media',
  });
  await post('/classrooms/' + room.id + '/session/start', {});
  await page.goto('/#classroom/' + room.id);
  let releaseJoin!: () => void;
  const joinGate = new Promise<void>((resolve) => {
    releaseJoin = resolve;
  });
  await page.route('**/classrooms/' + room.id + '/join', async (route) => {
    await joinGate;
    await route.continue().catch(() => {});
  });
  await page.getByRole('button', { name: 'Connect audio & video', exact: true }).click();
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  await expect(page.locator('iframe,.classroom-loading,[aria-modal="true"]')).toHaveCount(0);
  // This is an explicit choice dialog, not a loading overlay. Cancel closes it
  // without requesting devices, including while policy retrieval is pending.
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  releaseJoin();
  await page.unroute('**/classrooms/' + room.id + '/join');
  await expect(
    page.getByRole('button', { name: 'Connect audio & video', exact: true }),
  ).toBeEnabled();
  let releaseSignal!: () => void;
  const signalGate = new Promise<void>((resolve) => {
    releaseSignal = resolve;
  });
  await page.routeWebSocket(/\/api\/v1\/media\/signal/, async (route) => {
    await signalGate;
    route.connectToServer();
  });
  await page.getByRole('button', { name: 'Connect audio & video', exact: true }).click();
  await chooseMicrophone(page);
  await expect(page.locator('.media-connection-inline')).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => (window as any).mediaLifecycle.includes('media.allowed')))
    .toBe(true);
  await page
    .getByRole('textbox', { name: 'Write a message', exact: true })
    .fill('ICE can wait; chat remains usable');
  await expect(page.locator('iframe,.classroom-loading,[aria-modal="true"]')).toHaveCount(0);
  releaseSignal();
  const mic = page.getByRole('button', { name: 'Microphone', exact: true });
  await expect(mic).toHaveAttribute('aria-pressed', 'true', { timeout: 20000 });
  await expect(page.locator('.media-status')).toContainText('Connected');
  const events = await page.evaluate(() => (window as any).mediaLifecycle as string[]);
  expect(events.indexOf('media.allowed')).toBeGreaterThanOrEqual(0);
  expect(events.indexOf('rtc.created')).toBeGreaterThan(events.indexOf('media.allowed'));
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  await post('/classrooms/' + room.id + '/session/end', {});
});

test('denied microphone shows an actionable error, preserves chat and can reconnect after permission is allowed', async ({
  page,
}) => {
  test.skip(!process.env.TEST_MEDIA_KEY, 'Requires the actual SFU');
  const origin = process.env.TEST_APP_ORIGIN!;
  await page.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem('language', 'en');
    Object.assign(window, {
      savedCapture: navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices),
    });
    navigator.mediaDevices.getUserMedia = async () => {
      throw new DOMException('Permission declined', 'NotAllowedError');
    };
  });
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post('/api/v1' + path, { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const email = crypto.randomUUID() + '@permission.test',
    password = 'microphone-permission-password';
  await post('/auth/register', { email, password, name: 'Microphone permission' });
  await post('/auth/login', { email, password });
  const org = await post('/organizations', { name: 'Microphone permission' });
  const room = await post('/organizations/' + org.id + '/classrooms', { name: 'Permission retry' });
  await post('/classrooms/' + room.id + '/session/start', {});
  await page.goto('/#classroom/' + room.id);
  await page.getByRole('button', { name: 'Connect audio & video', exact: true }).click();
  await chooseMicrophone(page);
  await expect(page.getByRole('alert')).toContainText('Microphone access was denied');
  await page
    .getByRole('textbox', { name: 'Write a message', exact: true })
    .fill('Chat still works');
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  await expect(page.locator('iframe,.classroom-loading')).toHaveCount(0);
  await page.evaluate(() => {
    navigator.mediaDevices.getUserMedia = (window as any).savedCapture;
  });
  await page.getByRole('button', { name: 'Connect audio & video', exact: true }).click();
  await chooseMicrophone(page);
  await expect(page.getByRole('button', { name: 'Microphone', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
    { timeout: 20000 },
  );
  await expect(page.getByRole('textbox', { name: 'Write a message', exact: true })).toHaveText(
    'Chat still works',
  );
  await post('/classrooms/' + room.id + '/session/end', {});
});
