import { test, expect, type Page } from './owned-browser';
import { PDFDocument } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
test.use({ actionTimeout: 15000 });
test('presenter controls persisted file and board downloads; all-page PDF includes ink and cancellation/revocation prevent delivery', async ({
  browser,
}) => {
  test.setTimeout(150000);
  const origin = process.env.TEST_APP_ORIGIN!,
    contexts = await Promise.all(
      [0, 1, 2].map(() => browser.newContext({ viewport: { width: 1440, height: 900 } })),
    );
  for (const context of contexts)
    await context.addInitScript(() => {
      if (window === window.top) localStorage.setItem('language', 'en');
    });
  const [owner, presenter, viewer] = contexts;
  const post = async (context: typeof owner, path: string, data: object) => {
    const r = await context.request.post('/api/v1' + path, { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  try {
    const users = [];
    for (const [i, context] of contexts.entries()) {
      const email = crypto.randomUUID() + '@downloads-browser.test';
      users.push(
        await post(context, '/auth/register', {
          email,
          password: '123456',
          name: ['Teacher', 'Presenter', 'Viewer'][i],
        }),
      );
      await post(context, '/auth/login', { email, password: '123456' });
      users[i].email = email;
    }
    const org = await post(owner, '/organizations', { name: 'Download controls' });
    for (const u of users.slice(1))
      await post(owner, '/organizations/' + org.id + '/members', {
        email: u.email,
        role: 'student',
      });
    const room = await post(owner, '/organizations/' + org.id + '/classrooms', {
        name: 'Download class',
        enrollmentMode: 'organization',
      }),
      base = '/classrooms/' + room.id;
    await post(owner, base + '/session/start', {});
    const root = await post(owner, base + '/board-book', {});
    await post(owner, base + '/documents/' + root.id + '/pages', {});
    const [a, b, c] = await Promise.all(contexts.map((context) => context.newPage()));
    await Promise.all([a, b, c].map((page) => page.goto('/#classroom/' + room.id)));
    await expect(a.locator('.board-tool-dock')).toBeVisible();
    await expect(c.getByRole('button', { name: 'Download board PDF', exact: true })).toBeEnabled();
    await expect(b.locator('.download-access-toggle')).toHaveCount(0);
    await a.getByRole('button', { name: 'Pen', exact: true }).click();
    const box = (await a.locator('.excalidraw__canvas.interactive').boundingBox())!;
    await a.mouse.move(box.x + 120, box.y + 90);
    await a.mouse.down();
    await a.mouse.move(box.x + 260, box.y + 115, { steps: 10 });
    await a.mouse.up();
    const first = c.waitForEvent('download');
    await c.getByRole('button', { name: 'Download board PDF', exact: true }).click();
    const pdfPath = test.info().outputPath('shared-board.pdf');
    await (await first).saveAs(pdfPath);
    const pdf = await PDFDocument.load(await readFile(pdfPath));
    expect(pdf.getPageCount()).toBe(2);
    expect(pdf.getPages()[0].node.Contents()).toBeTruthy();
    await post(owner, base + '/user-permissions/' + users[1].id, { isPresenter: true });
    const boardSwitch = b.locator('.advanced-board .download-access-toggle');
    await expect(boardSwitch).toBeVisible();
    await boardSwitch.click();
    await expect(boardSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(c.getByRole('button', { name: 'Download board PDF', exact: true })).toBeDisabled();
    expect(
      (
        await viewer.request.post('/api/v1' + base + '/downloads/authorize', {
          headers: { origin },
          data: { targetId: root.id, format: 'pdf' },
        })
      ).status(),
    ).toBe(403);
    await c.reload();
    await expect(c.getByRole('button', { name: 'Download board PDF', exact: true })).toBeDisabled();
    await expect(boardSwitch).toBeEnabled();
    await boardSwitch.click();
    await expect(c.getByRole('button', { name: 'Download board PDF', exact: true })).toBeEnabled();
    let checks = 0,
      waiting = false,
      release!: () => void,
      downloadCount = 0;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    c.on('download', () => downloadCount++);
    await c.route('**/downloads/authorize', async (route) => {
      checks++;
      if (checks === 2) {
        waiting = true;
        await gate;
      }
      try {
        await route.continue();
      } catch {}
    });
    await c.getByRole('button', { name: 'Download board PDF', exact: true }).click();
    await expect.poll(() => waiting).toBe(true);
    const state = await (await owner.request.get('/api/v1' + base + '/downloads')).json(),
      revision = state.items.find((p: { targetId: string }) => p.targetId === root.id).revision;
    await post(owner, base + '/downloads', {
      kind: 'board',
      targetId: root.id,
      enabled: false,
      expectedRevision: revision,
    });
    release();
    await expect(c.getByRole('button', { name: 'Download board PDF', exact: true })).toBeDisabled();
    await expect(c.getByRole('button', { name: 'Cancel', exact: true })).toHaveCount(0);
    expect(downloadCount).toBe(0);
    await c.unrouteAll({ behavior: 'wait' });
    await expect(boardSwitch).toHaveAttribute('aria-checked', 'false');
    await boardSwitch.click();
    await expect(c.getByRole('button', { name: 'Download board PDF', exact: true })).toBeEnabled();
    await c.route('**/board', async (route) => {
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        await route.fulfill({ response });
      } catch {}
    });
    await c.getByRole('button', { name: 'Download board PDF', exact: true }).click();
    await c.getByRole('button', { name: 'Cancel', exact: true }).click();
    await c.unrouteAll({ behavior: 'wait' });
    await expect(c.getByRole('button', { name: 'Download board PDF', exact: true })).toBeEnabled();
    expect(downloadCount).toBe(0);
    const basic = await post(owner, base + '/documents', {
      name: 'Basic board',
      kind: 'board',
      boardFormat: 'legacy',
    });
    await a.getByRole('button', { name: 'Basic board', exact: true }).click();
    const basicCanvas = a.locator('svg.whiteboard');
    await expect(basicCanvas).toBeVisible();
    const basicBounds = (await basicCanvas.boundingBox())!;
    await a.mouse.move(basicBounds.x + 50, basicBounds.y + 50);
    await a.mouse.down();
    await a.mouse.move(basicBounds.x + 200, basicBounds.y + 85, { steps: 5 });
    await a.mouse.up();
    await expect(c.locator('svg.whiteboard path,svg.whiteboard polyline')).not.toHaveCount(0);
    const basicDownload = c.waitForEvent('download');
    await c.getByRole('button', { name: 'Download board PDF', exact: true }).click();
    const basicPath = test.info().outputPath('basic-board.pdf');
    await (await basicDownload).saveAs(basicPath);
    expect((await PDFDocument.load(await readFile(basicPath))).getPageCount()).toBe(1);
    const basicSwitch = b.locator('.document-editor .download-access-toggle');
    await basicSwitch.click();
    await expect(c.getByRole('button', { name: 'Download board PDF', exact: true })).toBeDisabled();
    expect(
      (
        await viewer.request.post('/api/v1' + base + '/downloads/authorize', {
          headers: { origin },
          data: { targetId: basic.id, format: 'pdf' },
        })
      ).status(),
    ).toBe(403);
    await a
      .locator('.document-list button')
      .filter({ hasText: root.name ?? 'Whiteboard' })
      .first()
      .click();
    const bytes = Buffer.from('A real downloadable classroom file.'),
      upload = await owner.request.post('/api/v1' + base + '/files', {
        headers: { origin, 'x-toaster-file-size': String(bytes.length) },
        multipart: { file: { name: 'lesson.txt', mimeType: 'text/plain', buffer: bytes } },
      });
    expect(upload.ok(), await upload.text()).toBe(true);
    const file = await upload.json();
    for (const page of [b, c]) {
      await page.getByRole('button', { name: 'Apps', exact: true }).first().click();
      await page.getByRole('menuitem', { name: 'Files', exact: true }).click();
    }
    const row = (page: Page) => page.locator('.file-row').filter({ hasText: 'lesson.txt' }),
      fileSwitch = row(b).getByRole('switch');
    await expect(fileSwitch).toBeVisible();
    await fileSwitch.click();
    await expect(fileSwitch).toHaveAttribute('aria-checked', 'false');
    await expect(row(c).getByRole('button', { name: 'Download', exact: true })).toBeDisabled();
    expect(
      (
        await viewer.request.get('/api/v1' + base + '/files/' + file.id + '/content?raw=1')
      ).status(),
    ).toBe(403);
    await post(owner, base + '/user-permissions/' + users[1].id, { isPresenter: false });
    await expect(row(b).getByRole('switch')).toHaveCount(0);
    expect(
      (
        await presenter.request.post('/api/v1' + base + '/downloads', {
          headers: { origin },
          data: { kind: 'file', targetId: file.id, enabled: true, expectedRevision: 1 },
        })
      ).status(),
    ).toBe(403);
    await post(owner, base + '/downloads', {
      kind: 'file',
      targetId: file.id,
      enabled: true,
      expectedRevision: 1,
    });
    await expect(row(c).getByRole('button', { name: 'Download', exact: true })).toBeEnabled();
    const original = c.waitForEvent('download');
    await row(c).getByRole('button', { name: 'Download', exact: true }).click();
    const path = test.info().outputPath('lesson.txt');
    await (await original).saveAs(path);
    expect(await readFile(path)).toEqual(bytes);
    await c.screenshot({ path: '.local/runtime/download-controls-files.png' });
    await a.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => a.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await a.screenshot({ path: '.local/runtime/download-controls-board-mobile.png' });
  } finally {
    await Promise.race([
      Promise.allSettled(contexts.map((c) => c.close())),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
  }
});
