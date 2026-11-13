import { test, expect, type Page } from './owned-browser';
import type { Browser } from '@playwright/test';
import * as Y from 'yjs';
import { testPng } from '../file-fixtures';
test.use({ actionTimeout: 15000 });
async function setup(browser: Browser) {
  const owner = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
    student = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
    origin = process.env.TEST_APP_ORIGIN!;
  for (const ctx of [owner, student])
    await ctx.addInitScript(() => {
      if (window === window.top) localStorage.setItem('language', 'en');
    });
  const post = async (ctx: typeof owner, path: string, data: object) => {
    const r = await ctx.request.post('/api/v1' + path, { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const users = [];
  for (const [i, ctx] of [owner, student].entries()) {
    const email = crypto.randomUUID() + '@pressure-chat.test';
    users.push({
      ...(await post(ctx, '/auth/register', {
        email,
        password: '123456',
        name: i ? 'Learner' : 'Teacher',
      })),
      email,
    });
    await post(ctx, '/auth/login', { email, password: '123456' });
  }
  const org = await post(owner, '/organizations', { name: 'Pressure and reliable chat' });
  await post(owner, '/organizations/' + org.id + '/members', {
    email: users[1].email,
    role: 'student',
  });
  const room = await post(owner, '/organizations/' + org.id + '/classrooms', {
    name: 'Pressure and chat',
    enrollmentMode: 'organization',
  });
  await post(owner, '/classrooms/' + room.id + '/session/start', {});
  const a = await owner.newPage(),
    b = await student.newPage();
  await Promise.all([a.goto('/#classroom/' + room.id), b.goto('/#classroom/' + room.id)]);
  await expect(a.locator('.board-tool-dock')).toBeVisible();
  await expect(b.locator('.chat-composer')).toBeVisible();
  return {
    owner,
    student,
    a,
    b,
    room,
    learner: users[1],
    post: (path: string, data: object) => post(owner, path, data),
    close: async () => {
      await Promise.race([
        Promise.allSettled([owner.close(), student.close()]),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    },
  };
}
async function scene(s: Awaited<ReturnType<typeof setup>>) {
  const base = '/api/v1/classrooms/' + s.room.id,
    workspace = await (await s.owner.request.get(base + '/workspace')).json(),
    state = await (
      await s.owner.request.get(base + '/documents/' + workspace.documentId + '/board')
    ).json(),
    doc = new Y.Doc();
  try {
    if (state.state) Y.applyUpdate(doc, Buffer.from(state.state, 'base64'));
    return [...doc.getMap<Record<string, unknown>>('elements').values()].filter(
      (e) => !e.isDeleted && e.type === 'freedraw',
    );
  } finally {
    doc.destroy();
  }
}
async function style(page: Page, color: string, width: string) {
  const panel = page.locator('.board-tool-options');
  if ((await panel.getAttribute('open')) === null) await panel.locator('summary').click();
  await panel.getByLabel('Ink color', { exact: true }).evaluate((element, value) => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, color);
  await panel.getByLabel('Stroke width', { exact: true }).fill(width);
  await panel.locator('summary').click();
}
test('normal pen stays constant; pressure pen stores real stylus samples, broadcasts before release and supports whole-stroke undo', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const s = await setup(browser),
    { a, b } = s;
  try {
    await a.bringToFront();
    let boardRequests = 0;
    a.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/updates')) boardRequests++;
    });
    const cdp = await s.owner.newCDPSession(a),
      box = (await a.locator('.excalidraw__canvas.interactive').boundingBox())!;
    const start = async (y: number) =>
      cdp.send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: box.x + 130,
        y: box.y + y,
        button: 'left',
        buttons: 1,
        pointerType: 'pen',
        force: 0.5,
      });
    const move = async (y: number) => {
      for (let i = 1; i <= 12; i++) {
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: box.x + 130 + i * 15,
          y: box.y + y + i * 0.7,
          button: 'left',
          buttons: 1,
          pointerType: 'pen',
          force: i / 13,
        });
        await a.waitForTimeout(20);
      }
    };
    const end = async (y: number) =>
      cdp.send('Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x: box.x + 310,
        y: box.y + y + 8.4,
        button: 'left',
        buttons: 0,
        pointerType: 'pen',
        force: 0,
      });
    await a.getByRole('button', { name: 'Pen', exact: true }).click();
    await style(a, '#dc2626', '3.2');
    await start(75);
    await move(75);
    await end(75);
    await expect.poll(async () => (await scene(s)).length).toBe(1);
    let fixed = (await scene(s))[0];
    expect(fixed.simulatePressure).toBe(false);
    expect((fixed.pressures as number[]).every((p) => Math.abs(p - 0.5) < 0.00001)).toBe(true);
    expect(
      Math.max(...(fixed.pressures as number[])) - Math.min(...(fixed.pressures as number[])),
    ).toBeLessThan(0.00000001);
    await a.getByRole('button', { name: 'Pressure-sensitive pen', exact: true }).click();
    await style(a, '#2563eb', '5.5');
    await start(150);
    await move(150);
    await expect.poll(async () => (await scene(s)).length, { timeout: 10000 }).toBe(2);
    await end(150);
    await expect
      .poll(async () =>
        Math.max(
          ...(((await scene(s)).find((e) => e.strokeColor === '#2563eb')?.pressures as number[]) ??
            []),
        ),
      )
      .toBeGreaterThan(0.85);
    let lines = await scene(s),
      pressure = lines.find((e) => e.strokeColor === '#2563eb')!;
    expect(Math.min(...(pressure.pressures as number[]))).toBeLessThan(0.15);
    expect(Math.max(...(pressure.pressures as number[]))).toBeGreaterThan(0.85);
    expect(pressure.pressures as unknown[]).toHaveLength((pressure.points as unknown[]).length);
    expect(pressure.strokeWidth).toBe(5.5);
    expect(
      boardRequests,
      'Live strokes batch point samples into bounded network submissions',
    ).toBeLessThanOrEqual(25);
    await a.screenshot({ path: '.local/runtime/pressure-pen-live.png' });
    await a.keyboard.press('Control+z');
    await expect.poll(async () => (await scene(s)).length).toBe(1);
    await a.keyboard.press('Control+Shift+z');
    await expect.poll(async () => (await scene(s)).length).toBe(2);
    await b.reload();
    await expect(b.locator('.advanced-board-canvas')).toBeVisible();
    await expect
      .poll(
        async () =>
          (await (await s.owner.request.get('/api/v1/account/preferences')).json()).preferences
            .tools.pressurePen.width,
      )
      .toBe(5.5);
    await a.reload();
    await expect(a.locator('.board-tool-dock')).toBeVisible();
    await a.getByRole('button', { name: 'Pressure-sensitive pen', exact: true }).click();
    const options = a.locator('.board-tool-options');
    await options.locator('summary').click();
    await expect(options.getByLabel('Stroke width', { exact: true })).toHaveValue('5.5');
    await expect(options.getByLabel('Pressure sensitivity', { exact: true })).toHaveValue('1');
    await a.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => a.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await a.screenshot({ path: '.local/runtime/pressure-pen-mobile.png' });
  } finally {
    await s.close();
  }
});
test('chat preserves drafts through rate limits and lost responses, coalesces reads and requires an image grant', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const s = await setup(browser),
    { a, b, owner, room } = s,
    base = '/api/v1/classrooms/' + room.id,
    editor = a.locator('.chat-composer [role=textbox]');
  try {
    await expect(b.getByRole('button', { name: 'Attach image', exact: true })).toBeDisabled();
    await a.evaluate(() => {
      const read = Storage.prototype.getItem,
        write = Storage.prototype.setItem;
      Storage.prototype.getItem = function (key) {
        if (key.startsWith('chat-draft:')) throw new DOMException('Blocked', 'SecurityError');
        return read.call(this, key);
      };
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith('chat-draft:')) throw new DOMException('Blocked', 'SecurityError');
        return write.call(this, key, value);
      };
    });
    let loseOnce = true,
      attempts: string[] = [];
    await a.route('**/api/v1/classrooms/*/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const data = route.request().postDataJSON();
      attempts.push(data.clientMessageId);
      if (loseOnce) {
        loseOnce = false;
        await route.fetch();
        return route.abort('failed');
      }
      return route.continue();
    });
    await editor.fill('Exactly once after a lost response');
    await a.locator('.chat-composer').evaluate((form) => {
      (form as HTMLFormElement).requestSubmit();
      (form as HTMLFormElement).requestSubmit();
    });
    await expect(a.locator('.chat [role=alert]')).toBeVisible();
    await expect(editor).toHaveText('Exactly once after a lost response');
    await a.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(editor).toBeEmpty();
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts).size).toBe(1);
    expect(
      (await (await owner.request.get(base + '/messages')).json()).filter(
        (m: { body: string }) => m.body === 'Exactly once after a lost response',
      ),
    ).toHaveLength(1);
    await a.unrouteAll({ behavior: 'wait' });
    let throttle = true;
    await a.route('**/api/v1/classrooms/*/messages', async (route) => {
      if (route.request().method() === 'POST' && throttle) {
        throttle = false;
        return route.fulfill({
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': '2' },
          body: '{"error":"Too many requests"}',
        });
      }
      return route.continue();
    });
    await editor.fill('Preserved during cooldown');
    await a.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(a.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(editor).toHaveText('Preserved during cooldown');
    expect(
      (await (await owner.request.get(base + '/messages')).json()).some(
        (m: { body: string }) => m.body === 'Preserved during cooldown',
      ),
    ).toBe(false);
    await expect(a.getByRole('button', { name: 'Send', exact: true })).toBeEnabled({
      timeout: 5000,
    });
    await a.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(editor).toBeEmpty();
    await a.unrouteAll({ behavior: 'wait' });
    await s.post('/classrooms/' + room.id + '/chat-categories', { name: 'Questions' });
    await a.getByRole('tab', { name: 'Questions', exact: true }).waitFor();
    await editor.fill('Public draft');
    await a.getByRole('tab', { name: 'Questions', exact: true }).click();
    await expect(editor).toBeEmpty();
    await editor.fill('Question draft');
    await a.getByRole('tab', { name: 'Public', exact: true }).click();
    await expect(editor).toHaveText('Public draft');
    let committed = false,
      release!: () => void;
    const responseGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await a.route('**/api/v1/classrooms/*/messages', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const response = await route.fetch();
      committed = true;
      await responseGate;
      await route.fulfill({ response });
    });
    await editor.fill('Message with a delayed response');
    await a.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => committed).toBe(true);
    await editor.fill('New draft typed during submission');
    release();
    await expect(a.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await expect(editor).toHaveText('New draft typed during submission');
    await a.unrouteAll({ behavior: 'wait' });
    await editor.fill('');
    let inFlight = 0,
      peak = 0,
      reads = 0;
    await a.route('**/api/v1/classrooms/*/messages?categoryId=*', async (route) => {
      inFlight++;
      reads++;
      peak = Math.max(peak, inFlight);
      try {
        const response = await route.fetch();
        await new Promise((resolve) => setTimeout(resolve, 300));
        await route.fulfill({ response });
      } finally {
        inFlight--;
      }
    });
    for (let i = 0; i < 12; i++) {
      await s.post('/classrooms/' + room.id + '/messages', {
        body: 'Live burst ' + i,
        clientMessageId: crypto.randomUUID(),
      });
      await a.waitForTimeout(90);
    }
    await expect.poll(() => a.locator('.chat article').count()).toBe(15);
    await a.unrouteAll({ behavior: 'wait' });
    expect(peak).toBeLessThanOrEqual(1);
    expect(reads).toBeLessThan(10);
    await s.post('/classrooms/' + room.id + '/user-permissions/' + s.learner.id, {
      canChatImages: true,
    });
    await expect(b.getByRole('button', { name: 'Attach image', exact: true })).toBeEnabled();
    let failImage = true;
    await a.route('**/files/*/content', async (route) => {
      if (failImage) {
        failImage = false;
        return route.fulfill({ status: 503, body: 'temporary failure' });
      }
      return route.continue();
    });
    await b
      .locator('input[aria-label="Attach image"]')
      .setInputFiles({ name: 'chat.png', mimeType: 'image/png', buffer: testPng() });
    await b.getByRole('button', { name: 'Send', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await owner.request.get(base + '/messages')).json()).filter(
            (m: { image_file_id?: string }) => m.image_file_id,
          ).length,
      )
      .toBe(1);
    await a.getByRole('button', { name: 'Retry loading image', exact: true }).click();
    await expect(a.locator('.chat-image-thumbnail img').last()).toBeVisible();
    await expect
      .poll(() =>
        a
          .locator('.chat-image-thumbnail img')
          .last()
          .evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
    await a.unrouteAll({ behavior: 'wait' });
    await s.post('/classrooms/' + room.id + '/user-permissions/' + s.learner.id, {
      canChatImages: false,
    });
    await expect(b.getByRole('button', { name: 'Attach image', exact: true })).toBeDisabled();
    await a.screenshot({ path: '.local/runtime/reliable-chat-images.png' });
    await b.setViewportSize({ width: 390, height: 844 });
    await b.screenshot({ path: '.local/runtime/chat-image-locked-mobile.png' });
  } finally {
    await s.close();
  }
});
