import { test, expect, type Page } from './owned-browser';
import type { Browser } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import * as Y from 'yjs';
import { chooseMicrophone } from './classroom-actions';
test.use({ actionTimeout: 15000 });
async function setup(browser: Browser) {
  const owner = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ['microphone', 'camera'],
    }),
    student = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
    origin = process.env.TEST_APP_ORIGIN!;
  for (const ctx of [owner, student])
    await ctx.addInitScript(() => {
      if (window !== window.top) return;
      localStorage.setItem('language', 'en');
      const probe = window as unknown as {
        sounds: { cue: string; volume: number }[];
        tracks: MediaStreamTrack[];
        oscillators: number;
      };
      probe.sounds = [];
      probe.tracks = [];
      probe.oscillators = 0;
      window.addEventListener('classroom-sound-played', (e) =>
        probe.sounds.push((e as CustomEvent).detail),
      );
      const Audio = AudioContext;
      window.AudioContext = class extends Audio {
        createOscillator() {
          probe.oscillators++;
          return super.createOscillator();
        }
      };
      const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await capture(constraints);
        probe.tracks.push(...stream.getTracks());
        return stream;
      };
    });
  const post = async (ctx: typeof owner, path: string, data: object) => {
    const r = await ctx.request.post('/api/v1' + path, { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  const users = [];
  for (const [index, ctx] of [owner, student].entries()) {
    const email = crypto.randomUUID() + '@tool-settings.test';
    users.push({
      ...(await post(ctx, '/auth/register', {
        name: index ? 'Learner' : 'Teacher',
        email,
        password: '123456',
      })),
      email,
    });
    await post(ctx, '/auth/login', { email, password: '123456' });
  }
  const org = await post(owner, '/organizations', { name: 'Tool settings regression' });
  await post(owner, '/organizations/' + org.id + '/members', {
    email: users[1].email,
    role: 'student',
  });
  const room = await post(owner, '/organizations/' + org.id + '/classrooms', {
    name: 'Precise board controls',
    enrollmentMode: 'organization',
  });
  await post(owner, '/classrooms/' + room.id + '/session/start', {});
  const a = await owner.newPage(),
    b = await student.newPage();
  await Promise.all([a.goto('/#classroom/' + room.id), b.goto('/#classroom/' + room.id)]);
  await expect(a.locator('.board-tool-dock')).toBeVisible();
  return {
    owner,
    student,
    a,
    b,
    room,
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
    data = await (
      await s.owner.request.get(base + '/documents/' + workspace.documentId + '/board')
    ).json(),
    doc = new Y.Doc();
  try {
    if (data.state) Y.applyUpdate(doc, Buffer.from(data.state, 'base64'));
    return [...doc.getMap<Record<string, unknown>>('elements').values()].filter(
      (e) => !e.isDeleted,
    );
  } finally {
    doc.destroy();
  }
}
async function options(page: Page) {
  const box = page.locator('.board-tool-options');
  if ((await box.getAttribute('open')) === null) await box.locator('summary').click();
  return box;
}
async function color(page: Page, value: string) {
  const box = await options(page);
  await box.getByLabel('Ink color', { exact: true }).evaluate((element, value) => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}
async function draw(page: Page, y = 120) {
  const box = (await page.locator('.excalidraw__canvas.interactive').boundingBox())!;
  await page.mouse.move(box.x + 120, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + y + 15, { steps: 12 });
  await page.mouse.up();
}
test('precise pen/text controls and sized eraser persist; settings are a separate page without disconnecting media; sounds obey saved controls', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const s = await setup(browser),
    { a, owner, room } = s;
  try {
    await a.getByRole('button', { name: 'Pen', exact: true }).click();
    await color(a, '#b91c1c');
    let box = await options(a);
    await box.getByLabel('Stroke width', { exact: true }).fill('7.3');
    await box.getByLabel('Opacity', { exact: true }).fill('63');
    await box.locator('summary').click();
    await draw(a);
    await expect
      .poll(async () =>
        (await scene(s))
          .filter((e) => e.type === 'freedraw')
          .map((e) => [e.strokeColor, e.strokeWidth, e.opacity]),
      )
      .toEqual([['#b91c1c', 7.3, 63]]);
    await a.getByRole('button', { name: 'Eraser', exact: true }).click();
    box = await options(a);
    await box.getByLabel('Eraser diameter (pixels)', { exact: true }).fill('4');
    const surface = a.locator('.board-eraser-surface'),
      bounds = (await surface.boundingBox())!;
    await a.mouse.click(bounds.x + 180, bounds.y + 153);
    expect((await scene(s)).filter((e) => e.type === 'freedraw')).toHaveLength(1);
    await box.getByLabel('Eraser diameter (pixels)', { exact: true }).fill('80');
    await a.mouse.click(bounds.x + 180, bounds.y + 153);
    await expect
      .poll(async () => (await scene(s)).filter((e) => e.type === 'freedraw').length)
      .toBe(0);
    await a.getByRole('button', { name: 'Text', exact: true }).click();
    box = await options(a);
    await box.getByLabel('Text size', { exact: true }).fill('37.5');
    await box.getByLabel('Text font', { exact: true }).selectOption('3');
    await box.getByLabel('Text alignment', { exact: true }).selectOption('right');
    await color(a, '#2563eb');
    await box.locator('summary').click();
    await a.locator('.excalidraw__canvas.interactive').click({ position: { x: 180, y: 200 } });
    const editor = a.locator('textarea.excalidraw-wysiwyg');
    await editor.fill('Precise text');
    await editor.press('Escape');
    await expect
      .poll(async () =>
        (await scene(s))
          .filter((e) => e.type === 'text')
          .map((e) => [e.text, e.fontSize, e.fontFamily, e.strokeColor, e.textAlign]),
      )
      .toEqual([['Precise text', 37.5, 3, '#2563eb', 'right']]);
    await expect
      .poll(
        async () =>
          (await (await owner.request.get('/api/v1/account/preferences')).json()).preferences.tools
            .text.fontSize,
      )
      .toBe(37.5);
    await a.getByRole('button', { name: 'Connect audio & video', exact: true }).click();
    await chooseMicrophone(a);
    await expect(a.locator('.media-status')).toContainText('Connected', { timeout: 30000 });
    await a.getByRole('button', { name: 'Microphone', exact: true }).click();
    await expect
      .poll(() =>
        a.evaluate(() =>
          (window as unknown as { sounds: { cue: string }[] }).sounds.some(
            (sound) => sound.cue === 'microphoneOff',
          ),
        ),
      )
      .toBe(true);
    await a.getByRole('button', { name: 'Microphone', exact: true }).click();
    await expect
      .poll(() =>
        a.evaluate(() =>
          (window as unknown as { sounds: { cue: string }[] }).sounds.some(
            (sound) => sound.cue === 'microphoneOn',
          ),
        ),
      )
      .toBe(true);
    await a.locator('.application-settings-trigger').first().click();
    const settings = a.getByRole('dialog', { name: 'Application settings', exact: true });
    await expect(settings).toBeVisible();
    await expect(a).toHaveURL(/#settings\?/);
    expect(
      await a.evaluate(() =>
        (window as unknown as { tracks: MediaStreamTrack[] }).tracks.some(
          (track) => track.readyState === 'live',
        ),
      ),
    ).toBe(true);
    await settings.getByLabel('Sound volume', { exact: true }).fill('37');
    await settings.getByLabel('Classroom text size', { exact: true }).selectOption('16');
    await settings.getByLabel('Text font', { exact: true }).selectOption('6');
    await settings
      .getByRole('checkbox', { name: 'Microphone, camera and screen sharing', exact: true })
      .uncheck();
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await (await owner.request.get('/api/v1/account/preferences')).json()).preferences
            .sounds,
      )
      .toMatchObject({ volume: 0.37, devices: false });
    await settings.getByRole('button', { name: 'Play sample sound', exact: true }).click();
    await expect
      .poll(() =>
        a.evaluate(() =>
          (window as unknown as { sounds: { cue: string; volume: number }[] }).sounds.some(
            (sound) => sound.cue === 'connected' && sound.volume === 0.37,
          ),
        ),
      )
      .toBe(true);
    await expect
      .poll(() => a.evaluate(() => (window as unknown as { oscillators: number }).oscillators))
      .toBeGreaterThan(0);
    await a.screenshot({ path: '.local/runtime/precise-settings-desktop.png' });
    await a.keyboard.press('Escape');
    await expect(a).toHaveURL(new RegExp('#classroom/' + room.id));
    await expect(a.locator('.media-status')).toContainText('Connected');
    const mutedCount = await a.evaluate(
      () =>
        (window as unknown as { sounds: { cue: string }[] }).sounds.filter(
          (sound) => sound.cue === 'microphoneOff',
        ).length,
    );
    await a.getByRole('button', { name: 'Microphone', exact: true }).click();
    await expect(a.getByRole('button', { name: 'Microphone', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(
      await a.evaluate(
        () =>
          (window as unknown as { sounds: { cue: string }[] }).sounds.filter(
            (sound) => sound.cue === 'microphoneOff',
          ).length,
      ),
    ).toBe(mutedCount);
    await a.getByRole('button', { name: 'Microphone', exact: true }).click();
    expect(
      await a.evaluate(
        () =>
          (window as unknown as { tracks: MediaStreamTrack[] }).tracks.filter(
            (track) => track.readyState === 'live',
          ).length,
      ),
    ).toBe(1);
    const activityBase = '/classrooms/' + room.id;
    await s.post(activityBase + '/polls', { question: 'Sound cue check?', options: ['Yes', 'No'] });
    await expect
      .poll(() =>
        a.evaluate(() =>
          (window as unknown as { sounds: { cue: string }[] }).sounds.some(
            (sound) => sound.cue === 'poll',
          ),
        ),
      )
      .toBe(true);
    await s.post(activityBase + '/timer', { action: 'start', durationSeconds: 1 });
    await expect
      .poll(() =>
        a.evaluate(() =>
          (window as unknown as { sounds: { cue: string }[] }).sounds.some(
            (sound) => sound.cue === 'timer',
          ),
        ),
      )
      .toBe(true);
    const hand = await s.student.request.post('/api/v1' + activityBase + '/hand', {
      headers: { origin: process.env.TEST_APP_ORIGIN! },
      data: { raised: true },
    });
    expect(hand.ok()).toBe(true);
    await expect
      .poll(() =>
        a.evaluate(() =>
          (window as unknown as { sounds: { cue: string }[] }).sounds.some(
            (sound) => sound.cue === 'hand',
          ),
        ),
      )
      .toBe(true);
    const policy = await (await owner.request.get('/api/v1' + activityBase + '/locks')).json();
    const locked = await s.post(activityBase + '/locks', {
      expectedRevision: policy.revision,
      locks: { ...policy.locks, microphone: true },
    });
    await expect
      .poll(() =>
        a.evaluate(() =>
          (window as unknown as { sounds: { cue: string }[] }).sounds.some(
            (sound) => sound.cue === 'lock',
          ),
        ),
      )
      .toBe(true);
    await s.post(activityBase + '/locks', {
      expectedRevision: locked.revision,
      locks: policy.locks,
    });
    await expect
      .poll(() =>
        a.evaluate(() =>
          (window as unknown as { sounds: { cue: string }[] }).sounds.some(
            (sound) => sound.cue === 'unlock',
          ),
        ),
      )
      .toBe(true);
    await a.setViewportSize({ width: 390, height: 844 });
    await a.locator('.application-settings-trigger').first().click();
    await expect
      .poll(() => a.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await a.screenshot({ path: '.local/runtime/precise-settings-mobile.png' });
    await a.goBack();
    await expect(a.getByRole('dialog', { name: 'Application settings', exact: true })).toHaveCount(
      0,
    );
    await a.goForward();
    await expect(
      a
        .getByRole('dialog', { name: 'Application settings', exact: true })
        .getByLabel('Classroom text size', { exact: true }),
    ).toHaveValue('16');
    await expect(
      a.getByRole('dialog', { name: 'Application settings', exact: true }),
    ).toBeVisible();
    await a.keyboard.press('Escape');
    await expect(a.getByRole('dialog', { name: 'Application settings', exact: true })).toHaveCount(
      0,
    );
    await a.reload();
    await expect(a.locator('.board-tool-dock')).toBeVisible();
    await a.getByRole('button', { name: 'Pen', exact: true }).click();
    box = await options(a);
    await expect(box.getByLabel('Stroke width', { exact: true })).toHaveValue('7.3');
    await a.screenshot({ path: '.local/runtime/precise-tools-mobile.png' });
    let release!: () => void;
    const hydrationGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await a.route('**/api/v1/account/preferences', async (route) => {
      if (route.request().method() === 'GET') await hydrationGate;
      try {
        await route.continue();
      } catch (error) {
        if (!route.request().failure()) throw error;
      }
    });
    await a.reload();
    await expect(a.locator('.board-tool-dock')).toBeVisible();
    await a.getByRole('button', { name: 'Pen', exact: true }).click();
    box = await options(a);
    await box.getByLabel('Stroke width', { exact: true }).fill('9.1');
    release();
    await expect
      .poll(
        async () =>
          (await (await owner.request.get('/api/v1/account/preferences')).json()).preferences,
      )
      .toMatchObject({ tools: { pen: { width: 9.1 } }, sounds: { volume: 0.37, devices: false } });
    await a.unrouteAll({ behavior: 'wait' });
    await expect
      .poll(
        async () =>
          (await (await owner.request.get('/api/v1/account/preferences')).json()).preferences,
      )
      .toMatchObject({
        layouts: { 'classic-bbb': { text: 16 } },
        tools: { text: { fontFamily: 6 } },
      });
  } finally {
    await s.close();
  }
});
test('PDF can be placed on the current board preserving ink, or replace the displayed board for everyone', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const s = await setup(browser),
    { a, b, owner, room } = s;
  try {
    await a.getByRole('button', { name: 'Pen', exact: true }).click();
    await draw(a, 70);
    await expect
      .poll(async () => (await scene(s)).filter((e) => e.type === 'freedraw').length)
      .toBe(1);
    const base = '/api/v1/classrooms/' + room.id,
      original = await (await owner.request.get(base + '/workspace')).json();
    const pdf = await PDFDocument.create();
    pdf.addPage([400, 600]);
    pdf.addPage([400, 600]);
    const file = {
      name: 'On board.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await pdf.save()),
    };
    await a.getByRole('combobox', { name: 'PDF display mode', exact: true }).selectOption('board');
    await a.locator('input[aria-label="Import PDF"]').setInputFiles(file);
    await expect
      .poll(
        async () => {
          const docs = await (await owner.request.get(base + '/documents')).json();
          return docs.find((d: { id: string }) => d.id === original.documentId)?.pdf_source_page;
        },
        { timeout: 60000 },
      )
      .toBe(1);
    await expect(
      a.getByRole('combobox', { name: 'Whiteboard pages', exact: true }).locator('option'),
    ).toHaveCount(2);
    expect((await (await owner.request.get(base + '/workspace')).json()).documentId).toBe(
      original.documentId,
    );
    expect((await scene(s)).some((e) => e.type === 'freedraw')).toBe(true);
    await expect(
      b.getByRole('combobox', { name: 'Whiteboard pages', exact: true }).locator('option'),
    ).toHaveCount(2);
    await a
      .getByRole('combobox', { name: 'PDF display mode', exact: true })
      .selectOption('replace');
    await a
      .locator('input[aria-label="Import PDF"]')
      .setInputFiles({ ...file, name: 'Replacement.pdf' });
    await expect(a.getByRole('button', { name: 'Replacement.pdf', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 60000 },
    );
    const workspace = await (await owner.request.get(base + '/workspace')).json();
    expect(workspace.documentId).not.toBe(original.documentId);
    await expect
      .poll(
        async () => (await (await s.student.request.get(base + '/workspace')).json()).documentId,
      )
      .toBe(workspace.documentId);
    const documents = await (await owner.request.get(base + '/documents')).json();
    expect(documents.some((d: { id: string }) => d.id === original.documentId)).toBe(true);
    await a.screenshot({ path: '.local/runtime/pdf-board-display-modes.png' });
  } finally {
    await s.close();
  }
});
