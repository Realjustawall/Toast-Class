import { test, expect, type Page } from './owned-browser';
import type { Browser, BrowserContext } from '@playwright/test';
import { chooseMicrophone, boardAction } from './classroom-actions';
import * as Y from 'yjs';
import { readFile, writeFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { testPng } from '../file-fixtures';
test.use({ actionTimeout: 15000 });
async function setup(browser: Browser, label: string) {
  const owner = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ['microphone', 'camera'],
    }),
    student = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      permissions: ['microphone', 'camera'],
    }),
    origin = process.env.TEST_APP_ORIGIN!;
  for (const ctx of [owner, student])
    await ctx.addInitScript(() => {
      if (window !== window.top) return;
      localStorage.setItem('language', 'en');
      const testWindow = window as unknown as {
        capturedTracks: MediaStreamTrack[];
        peerConnections: RTCPeerConnection[];
      };
      testWindow.capturedTracks = [];
      testWindow.peerConnections = [];
      const Native = RTCPeerConnection;
      window.RTCPeerConnection = class extends Native {
        constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
          super(...args);
          testWindow.peerConnections.push(this);
        }
      };
      const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async (constraints) => {
        const stream = await original(constraints);
        testWindow.capturedTracks.push(...stream.getTracks());
        return stream;
      };
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const context = canvas.getContext('2d')!,
          timer = setInterval(() => {
            context.fillStyle = '#fb923c';
            context.fillRect(0, 0, 640, 360);
            context.fillStyle = '#000';
            context.fillText('Shared screen ' + Date.now(), 20, 30);
          }, 50),
          stream = canvas.captureStream(20),
          track = stream.getVideoTracks()[0],
          stop = track.stop.bind(track);
        track.stop = () => {
          clearInterval(timer);
          stop();
        };
        testWindow.capturedTracks.push(track);
        return stream;
      };
    });
  const post = async (ctx: BrowserContext, path: string, data: unknown) => {
    const response = await ctx.request.post('/api/v1' + path, { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const users = [];
  for (const [name, ctx] of [
    ['Teacher', owner],
    ['Learner', student],
  ] as const) {
    const email = crypto.randomUUID() + '@annotation-ui.test';
    users.push({
      ...(await post(ctx, '/auth/register', { name, email, password: '123456' })),
      email,
    });
    await post(ctx, '/auth/login', { email, password: '123456' });
  }
  const org = await post(owner, '/organizations', { name: label });
  await post(owner, '/organizations/' + org.id + '/members', {
    email: users[1].email,
    role: 'student',
  });
  const room = await post(owner, '/organizations/' + org.id + '/classrooms', {
    name: label,
    enrollmentMode: 'organization',
    permissions: { studentWhiteboardEnabled: false, defaultScreenShare: false },
  });
  await post(owner, '/classrooms/' + room.id + '/session/start', {});
  const a = await owner.newPage(),
    b = await student.newPage();
  await Promise.all([a.goto('/#classroom/' + room.id), b.goto('/#classroom/' + room.id)]);
  await expect(a.locator('.board-tool-dock')).toBeVisible();
  await expect(b.locator('.advanced-board-canvas')).toBeVisible();
  return {
    owner,
    student,
    a,
    b,
    room,
    learner: users[1],
    post: (path: string, data: unknown) => post(owner, path, data),
    close: async () => {
      await Promise.race([
        Promise.allSettled([owner.close(), student.close()]),
        new Promise((resolve) => setTimeout(resolve, 2500)),
      ]);
    },
  };
}
async function color(page: Page, value: string) {
  const details = page.locator('.board-tool-options');
  if (!((await details.getAttribute('open')) !== null)) await details.locator('summary').click();
  await details.getByLabel('Ink color', { exact: true }).evaluate((element, value) => {
    const input = element as HTMLInputElement;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await details.locator('summary').click();
}
async function draw(page: Page, y: number) {
  const canvas = page.locator('.excalidraw__canvas.interactive'),
    box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 120, box.y + y);
  await page.mouse.down();
  await page.mouse.move(box.x + 260, box.y + y + 15, { steps: 12 });
  await page.mouse.up();
}
async function scene(ctx: BrowserContext, roomId: string) {
  const workspace = await (
      await ctx.request.get('/api/v1/classrooms/' + roomId + '/workspace')
    ).json(),
    state = await (
      await ctx.request.get(
        '/api/v1/classrooms/' + roomId + '/documents/' + workspace.documentId + '/board',
      )
    ).json(),
    doc = new Y.Doc();
  try {
    if (state.state) Y.applyUpdate(doc, Buffer.from(state.state, 'base64'));
    return [...doc.getMap<Record<string, unknown>>('elements').values()]
      .filter((element) => !element.isDeleted)
      .sort((a, b) => String(a.index).localeCompare(String(b.index)));
  } finally {
    doc.destroy();
  }
}

test('pen and marker keep their styles; student presenter gets real fullscreen and screen sharing; locks revoke capture and survive reopening', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const s = await setup(browser, 'Presenter and lock regression'),
    { a, b, owner, student, room, learner } = s,
    base = '/classrooms/' + room.id;
  try {
    await a.getByRole('button', { name: 'Pen', exact: true }).click();
    await color(a, '#ef4444');
    await draw(a, 70);
    await a.getByRole('button', { name: 'Highlighter', exact: true }).click();
    await color(a, '#1d4ed8');
    await draw(a, 120);
    await a.getByRole('button', { name: 'Pen', exact: true }).click();
    await draw(a, 170);
    await a.getByRole('button', { name: 'Highlighter', exact: true }).click();
    await draw(a, 220);
    await a.screenshot({ path: '.local/runtime/annotation-style-debug.png' });
    await expect
      .poll(async () => {
        const elements = await scene(owner, room.id);
        return elements
          .filter((e) => e.type === 'freedraw')
          .map((e) => ({ color: e.strokeColor, opacity: e.opacity }));
      })
      .toEqual([
        { color: '#ef4444', opacity: 100 },
        { color: '#1d4ed8', opacity: 30 },
        { color: '#ef4444', opacity: 100 },
        { color: '#1d4ed8', opacity: 30 },
      ]);
    expect(
      (await scene(owner, room.id))
        .filter((e) => e.type === 'freedraw')
        .every((e) => Number(e.width) > 100),
    ).toBe(true);
    const download = a.waitForEvent('download');
    await boardAction(a, 'SVG');
    const file = test.info().outputPath('pen-colors.svg');
    await (await download).saveAs(file);
    const svg = await readFile(file, 'utf8');
    expect(svg).toContain('#ef4444');
    expect(svg).toContain('#1d4ed8');
    for (const page of [a, b]) {
      await page.getByRole('button', { name: 'Connect audio & video', exact: true }).click();
      await chooseMicrophone(page);
      await expect(page.locator('.media-status')).toContainText('Connected', { timeout: 30000 });
      const voiceCard = page.locator('.media-tile[data-audio-only=true]').first();
      await expect(voiceCard).toBeVisible();
      expect((await voiceCard.boundingBox())!.height).toBeLessThanOrEqual(96);
    }
    await expect(b.getByRole('button', { name: 'Share screen', exact: true })).toBeDisabled();
    const row = a.locator('.participant-item[data-participant-id="' + learner.id + '"]');
    await row.locator('strong[role=button]').click();
    await row
      .getByRole('button', { name: 'Make / remove presenter - Learner', exact: true })
      .click();
    await expect(b.locator('.board-tool-dock')).toBeVisible({ timeout: 5000 });
    await expect(b.getByRole('button', { name: 'Share screen', exact: true })).toBeEnabled({
      timeout: 10000,
    });
    await boardAction(b, 'Present my view');
    const current = await (await student.request.get('/api/v1' + base + '/workspace')).json();
    await expect
      .poll(
        async () =>
          (
            await (
              await owner.request.get(
                '/api/v1' + base + '/documents/' + current.documentId + '/board/view',
              )
            ).json()
          ).actorId,
      )
      .toBe(learner.id);
    await b
      .locator('[data-layout-panel=stage]>.classroom-panel-heading .classroom-panel-tools button')
      .click();
    await expect
      .poll(() => b.evaluate(() => document.fullscreenElement?.getAttribute('data-layout-panel')))
      .toBe('stage');
    const stage = (await b.locator('[data-layout-panel=stage]').boundingBox())!;
    expect(stage.x).toBe(0);
    expect(stage.y).toBe(0);
    expect(stage.width).toBeGreaterThan(1400);
    expect((await b.locator('.advanced-board-canvas').boundingBox())!.height).toBeGreaterThan(600);
    await b.screenshot({ path: '.local/runtime/presenter-native-fullscreen.png' });
    await b
      .locator('[data-layout-panel=stage]>.classroom-panel-heading .classroom-panel-tools button')
      .click();
    await expect.poll(() => b.evaluate(() => document.fullscreenElement === null)).toBe(true);
    await b.getByRole('button', { name: 'Share screen', exact: true }).click();
    await expect(a.locator('.media-tile[data-source=screen_share] video')).toBeVisible({
      timeout: 10000,
    });
    await expect
      .poll(
        () =>
          a.evaluate(async () => {
            let frames = 0;
            for (const peer of (window as unknown as { peerConnections: RTCPeerConnection[] })
              .peerConnections) {
              const stats = await peer.getStats();
              stats.forEach((row) => {
                if (row.type === 'inbound-rtp' && row.kind === 'video')
                  frames += row.framesDecoded ?? 0;
              });
            }
            return frames;
          }),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);
    await a.getByRole('button', { name: 'Student permissions', exact: true }).click();
    let dialog = a.getByRole('dialog', { name: 'Lock student features', exact: true });
    for (const name of ['Microphone', 'Screen sharing', 'Whiteboard editing'])
      await dialog.getByRole('switch', { name, exact: true }).check();
    await dialog.getByRole('button', { name: 'Apply locks', exact: true }).click();
    await expect(b.locator('.board-tool-dock')).toHaveCount(0, { timeout: 5000 });
    await expect(b.getByRole('button', { name: 'Share screen', exact: true })).toBeDisabled({
      timeout: 10000,
    });
    await expect(b.getByRole('button', { name: 'Microphone', exact: true })).toBeDisabled();
    await expect
      .poll(
        () =>
          b.evaluate(() =>
            (window as unknown as { capturedTracks: MediaStreamTrack[] }).capturedTracks.every(
              (track) => track.readyState === 'ended',
            ),
          ),
        { timeout: 10000 },
      )
      .toBe(true);
    await row.locator('.participant-inline-perms button').first().click();
    dialog = a.getByRole('dialog', { name: 'Lock features for Learner', exact: true });
    for (const name of ['Microphone', 'Screen sharing', 'Whiteboard editing'])
      await dialog.getByRole('switch', { name, exact: true }).uncheck();
    await expect(
      dialog.getByRole('checkbox', {
        name: 'Exempt this student from class-wide locks',
        exact: true,
      }),
    ).toBeChecked();
    await dialog.getByRole('button', { name: 'Apply locks', exact: true }).click();
    await expect(b.locator('.board-tool-dock')).toBeVisible({ timeout: 5000 });
    await expect(b.getByRole('button', { name: 'Microphone', exact: true })).toBeEnabled({
      timeout: 10000,
    });
    await expect(b.getByRole('button', { name: 'Microphone', exact: true })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    await row.locator('.participant-inline-perms button').first().click();
    dialog = a.getByRole('dialog', { name: 'Lock features for Learner', exact: true });
    await expect(dialog.getByRole('switch', { name: 'Microphone', exact: true })).not.toBeChecked();
    await expect(
      dialog.getByRole('checkbox', {
        name: 'Exempt this student from class-wide locks',
        exact: true,
      }),
    ).toBeChecked();
    await a.keyboard.press('Escape');
    await b.getByRole('button', { name: 'Microphone', exact: true }).click();
    await expect(b.getByRole('button', { name: 'Microphone', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect
      .poll(() =>
        b.evaluate(() =>
          (window as unknown as { capturedTracks: MediaStreamTrack[] }).capturedTracks.some(
            (track) => track.readyState === 'live',
          ),
        ),
      )
      .toBe(true);
    await a.screenshot({ path: '.local/runtime/presenter-lock-grants-desktop.png' });
  } catch (error) {
    await a.screenshot({ path: '.local/runtime/annotation-presenter-failure.png' });
    throw error;
  } finally {
    await s.close();
  }
});

test('PDF pages, searchable original text, vector export, images, formulas, stamps, measurements and page management persist for both browsers', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const s = await setup(browser, 'PDF annotation regression'),
    { a, b, owner, room } = s;
  try {
    const pdf = await PDFDocument.create(),
      font = await pdf.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < 2; i++) {
      const page = pdf.addPage([600, 800]);
      page.drawText(i ? 'Second searchable theorem' : 'First vector lesson', {
        x: 40,
        y: 700,
        font,
        size: 24,
        color: rgb(0.1, 0.2, 0.5),
      });
    }
    await a.locator('input[aria-label="Import PDF"]').setInputFiles({
      name: 'Vector lesson.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await pdf.save()),
    });
    await expect(a.getByRole('button', { name: 'Vector lesson.pdf', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
      { timeout: 60000 },
    );
    await expect(
      a.getByRole('combobox', { name: 'Whiteboard pages', exact: true }).locator('option'),
    ).toHaveCount(2);
    const originalDocs = await (
        await owner.request.get('/api/v1/classrooms/' + room.id + '/documents')
      ).json(),
      originalSource = originalDocs.find(
        (doc: { pdf_source_file_id?: string }) => doc.pdf_source_file_id,
      ),
      response = await owner.request.get(
        '/api/v1/classrooms/' +
          room.id +
          '/files/' +
          originalSource.pdf_source_file_id +
          '/content?documentId=' +
          originalSource.id,
        { timeout: 5000 },
      );
    expect(response.status()).toBe(200);
    expect((await PDFDocument.load(await response.body())).getPageCount()).toBe(2);
    await a.getByRole('button', { name: 'Annotation tools', exact: true }).click();
    let tools = a.getByRole('dialog', { name: 'Annotation tools', exact: true });
    await tools
      .getByLabel('Text, stamp name or LaTeX formula', { exact: true })
      .fill('Shared note on PDF');
    await tools.getByRole('button', { name: 'Insert text note', exact: true }).click();
    await expect
      .poll(async () =>
        (await scene(owner, room.id)).some((element) => element.text === 'Shared note on PDF'),
      )
      .toBe(true);
    const options = a.locator('.board-tool-options');
    await options.locator('summary').click();
    await options.getByLabel('Text size', { exact: true }).fill('36');
    await options.locator('summary').click();
    await expect
      .poll(async () =>
        Number(
          (await scene(owner, room.id)).find((e) => e.text === 'Shared note on PDF')?.fontSize,
        ),
      )
      .toBe(36);
    expect(
      Number((await scene(owner, room.id)).find((e) => e.text === 'Shared note on PDF')?.height),
    ).toBeGreaterThan(30);
    await a.getByRole('button', { name: 'Annotation tools', exact: true }).click();
    await a
      .getByRole('dialog', { name: 'Annotation tools', exact: true })
      .getByRole('button', { name: 'Align text right', exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await scene(owner, room.id)).find((e) => e.text === 'Shared note on PDF')?.textAlign,
      )
      .toBe('right');
    await a.getByRole('button', { name: 'Annotation tools', exact: true }).click();
    tools = a.getByRole('dialog', { name: 'Annotation tools', exact: true });
    await tools
      .getByLabel('Text, stamp name or LaTeX formula', { exact: true })
      .fill('Saved lesson stamp');
    await tools
      .getByRole('button', { name: 'Save selection as a reusable stamp', exact: true })
      .click();
    await expect(
      tools.getByRole('button', { name: 'Saved lesson stamp', exact: true }),
    ).toBeVisible();
    await tools.getByRole('button', { name: 'Saved lesson stamp', exact: true }).click();
    await expect
      .poll(
        async () =>
          (await scene(owner, room.id)).filter((element) => element.text === 'Shared note on PDF')
            .length,
      )
      .toBe(2);
    await a.getByRole('button', { name: 'Annotation tools', exact: true }).click();
    tools = a.getByRole('dialog', { name: 'Annotation tools', exact: true });
    await tools
      .getByLabel('Text, stamp name or LaTeX formula', { exact: true })
      .fill('\\frac{a^2+b^2}{\\sqrt{x}}');
    await tools.getByRole('button', { name: 'Insert LaTeX formula', exact: true }).click();
    await expect(tools).toHaveCount(0, { timeout: 30000 });
    await a.getByRole('button', { name: 'Annotation tools', exact: true }).click();
    await a
      .locator('.advanced-board input[type=file][accept^="image/"]')
      .setInputFiles({ name: 'annotation.png', mimeType: 'image/png', buffer: testPng() });
    await expect(a.getByRole('dialog', { name: 'Annotation tools', exact: true })).toHaveCount(0, {
      timeout: 10000,
    });
    await a.screenshot({ path: '.local/runtime/annotation-image-debug.png' });
    await expect
      .poll(
        async () =>
          (await scene(owner, room.id)).filter((element) => element.type === 'image').length,
      )
      .toBe(2);
    await a.getByRole('button', { name: 'Annotation tools', exact: true }).click();
    tools = a.getByRole('dialog', { name: 'Annotation tools', exact: true });
    await tools.getByLabel('Canvas pixels per unit', { exact: true }).fill('8');
    await tools.getByLabel('Measurement unit', { exact: true }).selectOption('cm');
    await tools.getByRole('button', { name: 'Measure selected area', exact: true }).click();
    await expect
      .poll(async () =>
        (await scene(owner, room.id)).some(
          (e) =>
            (e.customData as { measurementKind?: string })?.measurementKind === 'area' &&
            String(e.text).includes('cm²'),
        ),
      )
      .toBe(true);
    const measurement = (await scene(owner, room.id)).find(
      (e) => (e.customData as { measurementKind?: string })?.measurementKind === 'area',
    )!;
    await a.getByRole('button', { name: 'Annotation tools', exact: true }).click();
    await a
      .getByRole('dialog', { name: 'Annotation tools', exact: true })
      .getByRole('button', { name: 'Lock selection', exact: true })
      .click();
    await expect
      .poll(async () => (await scene(owner, room.id)).find((e) => e.id === measurement.id)?.locked)
      .toBe(true);
    await a.getByRole('button', { name: 'Annotation tools', exact: true }).click();
    tools = a.getByRole('dialog', { name: 'Annotation tools', exact: true });
    await tools.locator('.annotation-object-list summary').click();
    await tools
      .locator('.annotation-object-list label')
      .filter({ hasText: String(measurement.text) })
      .getByRole('checkbox')
      .check();
    await tools.getByRole('button', { name: 'Unlock selection', exact: true }).click();
    await expect
      .poll(async () => (await scene(owner, room.id)).find((e) => e.id === measurement.id)?.locked)
      .toBe(false);
    await b.reload();
    await expect(b.locator('.advanced-board-canvas')).toBeVisible();
    const current = await (
      await owner.request.get('/api/v1/classrooms/' + room.id + '/workspace')
    ).json();
    const state = await (
      await owner.request.get(
        '/api/v1/classrooms/' + room.id + '/documents/' + current.documentId + '/board',
      )
    ).json();
    expect(state.state).toBeTruthy();
    await a.getByRole('button', { name: 'Pages and bookmarks', exact: true }).click();
    let manager = a.getByRole('dialog', { name: 'Pages and bookmarks', exact: true });
    await manager
      .getByRole('searchbox', { name: 'Search page text or bookmark', exact: true })
      .fill('theorem');
    await expect(manager.locator('nav>button')).toHaveCount(1, { timeout: 15000 });
    await manager.getByRole('searchbox').fill('');
    await expect(manager.locator('nav>button')).toHaveCount(2);
    await manager.getByRole('textbox', { name: 'Bookmark label', exact: true }).fill('Main lesson');
    await manager.getByRole('button', { name: 'Save', exact: true }).click();
    await expect
      .poll(async () => {
        const docs = await (
          await owner.request.get('/api/v1/classrooms/' + room.id + '/documents')
        ).json();
        return docs.some((doc: { page_bookmark?: string }) => doc.page_bookmark === 'Main lesson');
      })
      .toBe(true);
    await manager.getByRole('button', { name: 'Duplicate page', exact: true }).click();
    await expect(manager.locator('nav>button')).toHaveCount(3);
    await manager.getByRole('button', { name: 'Rotate page clockwise', exact: true }).click();
    await expect
      .poll(async () => {
        const docs = await (
          await owner.request.get('/api/v1/classrooms/' + room.id + '/documents')
        ).json();
        return docs.some((doc: { page_rotation?: number }) => doc.page_rotation === 90);
      })
      .toBe(true);
    await a.keyboard.press('Escape');
    await expect(
      b.getByRole('combobox', { name: 'Whiteboard pages', exact: true }).locator('option'),
    ).toHaveCount(3);
    await a.screenshot({ path: '.local/runtime/pdf-annotations-desktop.png' });
    const exportWorkspace = await (
        await owner.request.get('/api/v1/classrooms/' + room.id + '/workspace')
      ).json(),
      exportDocs = await (
        await owner.request.get('/api/v1/classrooms/' + room.id + '/documents')
      ).json();
    await expect(a.locator('.advanced-board')).toHaveAttribute(
      'aria-label',
      exportDocs.find((doc: { id: string }) => doc.id === exportWorkspace.documentId).name,
    );
    await expect(a.locator('.board-status>[role="status"]')).toHaveText('All board changes saved');
    const [download] = await Promise.all([
      a.waitForEvent('download', { timeout: 45000 }),
      boardAction(a, 'Export all pages as PDF'),
    ]);
    const path = test.info().outputPath('annotated-vector.pdf');
    await download.saveAs(path);
    const exported = await PDFDocument.load(await readFile(path));
    expect(exported.getPageCount()).toBe(3);
    expect(exported.getPages().some((page) => page.getRotation().angle === 90)).toBe(true);
    await writeFile('.local/runtime/annotated-vector.pdf', await readFile(path));
    const exportedText = await a.evaluate(
      async (data) => {
        const url = '/src/pdf-text-search.ts';
        const { pdfBytesText } = await import(url);
        return (
          await pdfBytesText(
            Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
            AbortSignal.timeout(10000),
          )
        ).join('\n');
      },
      Buffer.from(await readFile(path)).toString('base64'),
    );
    expect(exportedText).toContain('first vector lesson');
    expect(exportedText).toContain('second searchable theorem');
    await a.setViewportSize({ width: 390, height: 844 });
    await a.getByRole('button', { name: 'Annotation tools', exact: true }).click();
    await expect
      .poll(() => a.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await a.screenshot({ path: '.local/runtime/pdf-annotations-mobile-tools.png' });
  } catch (error) {
    await a.screenshot({ path: '.local/runtime/annotation-pdf-failure.png' });
    console.info('PDF failure dialog', await a.getByRole('dialog').allTextContents());
    throw error;
  } finally {
    await s.close();
  }
});
