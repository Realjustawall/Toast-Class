import { test, expect } from './owned-browser';
import { testPng } from '../file-fixtures';
import { PDFDocument, rgb } from 'pdf-lib';
import * as Y from 'yjs';
import { readFile } from 'node:fs/promises';
import { boardAction } from './classroom-actions';

test('provided login design, six-character password, image grants, participant locks, signal and blank board pages work in real browsers', async ({
  browser,
}) => {
  test.setTimeout(180000);
  const origin = process.env.TEST_APP_ORIGIN!,
    owner = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
    student = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  for (const c of [owner, student])
    await c.addInitScript(() => {
      if (window === window.top) localStorage.setItem('language', 'en');
    });
  const a = await owner.newPage(),
    email = 'owner-' + crypto.randomUUID() + '@new-ui.test';
  try {
    await a.goto('/');
    await expect(a.locator('.login-design .kinetic-stage-curtain')).toBeVisible();
    await a.screenshot({ path: '.local/runtime/login-design-desktop.png' });
    for (const width of [320, 768, 1440]) {
      await a.setViewportSize({ width, height: 900 });
      await expect
        .poll(() => a.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
    }
    await a.setViewportSize({ width: 1440, height: 900 });
    await a
      .locator('.mode-pills')
      .getByRole('button', { name: 'Create account', exact: true })
      .click();
    const form = a.locator('form.auth-form');
    await form.getByLabel('Name', { exact: true }).fill('Moderator');
    await form.getByLabel('Email', { exact: true }).fill(email);
    await form.getByLabel('Password', { exact: true }).fill('123456');
    await form.locator('[name=passwordConfirmation]').fill('123456');
    await form.getByRole('button', { name: 'Create account', exact: true }).click();
    await expect(a.locator('.login-design')).toHaveCount(0);
    const post = async (path: string, data: unknown) => {
      const response = await owner.request.post('/api/v1' + path, { headers: { origin }, data });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const learnerEmail = 'student-' + crypto.randomUUID() + '@new-ui.test';
    const learner = await student.request.post('/api/v1/auth/register', {
      headers: { origin },
      data: { name: 'Learner', email: learnerEmail, password: '123456' },
    });
    expect(learner.status()).toBe(201);
    const learnerId = (await learner.json()).id;
    await student.request.post('/api/v1/auth/login', {
      headers: { origin },
      data: { email: learnerEmail, password: '123456' },
    });
    const org = await post('/organizations', { name: 'New classroom UI' });
    await post('/organizations/' + org.id + '/members', { email: learnerEmail, role: 'student' });
    const room = await post('/organizations/' + org.id + '/classrooms', {
        name: 'Image and pages',
        enrollmentMode: 'organization',
      }),
      base = '/classrooms/' + room.id;
    await post(base + '/session/start', {});
    const b = await student.newPage();
    await Promise.all([a.goto('/#classroom/' + room.id), b.goto('/#classroom/' + room.id)]);
    await expect(a.getByTestId('classroom-connection')).toHaveAttribute('data-level', /[1-4]/);
    await expect(a.getByRole('button', { name: 'Blank page', exact: true })).toBeVisible();
    await a.getByRole('button', { name: 'Blank page', exact: true }).click();
    await expect(a.getByRole('combobox', { name: 'Whiteboard pages', exact: true })).toHaveValue(
      /.+/,
    );
    await expect(
      a.getByRole('combobox', { name: 'Whiteboard pages', exact: true }).locator('option'),
    ).toHaveCount(2);
    await expect(
      b.getByRole('combobox', { name: 'Whiteboard pages', exact: true }).locator('option'),
    ).toHaveCount(2);
    const studentState = await student.request.get('/api/v1' + base + '/teaching');
    expect((await studentState.json()).role).toBe('student');
    expect((await studentState.json()).myPermissions.canChatImages).toBe(false);
    await expect(b.getByRole('button', { name: 'Attach image', exact: true })).toBeDisabled();
    const attach = async (page: typeof a) => {
      await page
        .locator('input[aria-label="Attach image"]')
        .setInputFiles({ name: 'lesson.png', mimeType: 'image/png', buffer: testPng() });
      await page
        .locator('.chat-composer')
        .getByRole('button', { name: 'Send', exact: true })
        .click();
    };
    await attach(a);
    await expect(b.locator('.chat-image-thumbnail img')).toHaveCount(1);
    await expect
      .poll(() =>
        b
          .locator('.chat-image-thumbnail img')
          .first()
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0),
      )
      .toBe(true);
    await post(base + '/user-permissions/' + learnerId, { canChatImages: true });
    await expect(b.getByRole('button', { name: 'Attach image', exact: true })).toBeEnabled();
    await attach(b);
    await expect(a.locator('.chat-image-thumbnail img')).toHaveCount(2);
    await a.locator('.chat-image-thumbnail').first().click();
    await expect(a.getByRole('dialog')).toBeVisible();
    await a.getByRole('dialog').getByRole('button', { name: 'Close panel', exact: true }).click();
    await post(base + '/user-permissions/' + learnerId, { interactionLocked: true });
    await expect(b.getByRole('textbox', { name: 'Write a message', exact: true })).toHaveAttribute(
      'contenteditable',
      'false',
    );
    await expect(b.getByRole('button', { name: 'Attach image', exact: true })).toBeDisabled();
    await post(base + '/user-permissions/' + learnerId, { interactionLocked: false });
    await expect(b.getByRole('button', { name: 'Attach image', exact: true })).toBeEnabled();
    await a.reload();
    await expect(a.locator('.chat-image-thumbnail img')).toHaveCount(2);
    await expect(
      a.getByRole('combobox', { name: 'Whiteboard pages', exact: true }).locator('option'),
    ).toHaveCount(2);
    await a.screenshot({ path: '.local/runtime/images-pages-desktop.png' });
    const pdf = await PDFDocument.create();
    for (let n = 0; n < 2; n++) {
      const page = pdf.addPage([600, 800]);
      page.drawRectangle({
        x: 60,
        y: 620,
        width: 480,
        height: 100,
        color: n ? rgb(0.1, 0.2, 0.8) : rgb(0.8, 0.1, 0.1),
      });
    }
    await a.locator('input[aria-label="Import PDF"]').setInputFiles({
      name: 'Lesson.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await pdf.save()),
    });
    await expect(a.getByRole('button', { name: 'Lesson.pdf', exact: true })).toBeVisible({
      timeout: 60000,
    });
    await expect
      .poll(
        async () => {
          const result = await owner.request.get('/api/v1' + base + '/documents');
          return (await result.json()).filter(
            (d: { background_file_id: string | null }) => d.background_file_id,
          ).length;
        },
        { timeout: 60000 },
      )
      .toBe(2);
    await expect(a.getByRole('button', { name: 'Highlighter', exact: true })).toBeVisible();
    await expect(a.locator('.board-page-bar [role=alert]')).toHaveCount(0);
    await a.getByRole('button', { name: 'Highlighter', exact: true }).click();
    const canvas = a.locator('.excalidraw__canvas.interactive');
    const bounds = (await canvas.boundingBox())!;
    await a.mouse.move(bounds.x + bounds.width / 2 - 70, bounds.y + bounds.height / 2);
    await a.mouse.down();
    await a.mouse.move(bounds.x + bounds.width / 2 + 70, bounds.y + bounds.height / 2, {
      steps: 8,
    });
    await a.mouse.up();
    const docs = await (await owner.request.get('/api/v1' + base + '/documents')).json();
    const first = docs.find(
      (d: { name: string; board_book_id: string | null }) =>
        d.name === 'Lesson.pdf' && !d.board_book_id,
    );
    const elements = async () => {
      const state = await (
        await owner.request.get('/api/v1' + base + '/documents/' + first.id + '/board')
      ).json();
      const y = new Y.Doc();
      try {
        if (state.state) Y.applyUpdate(y, Buffer.from(state.state, 'base64'));
        return [...y.getMap('elements').values()] as { type: string; opacity: number }[];
      } finally {
        y.destroy();
      }
    };
    await expect
      .poll(
        async () =>
          (await elements()).filter((e) => e.type === 'freedraw' && e.opacity === 30).length,
      )
      .toBe(1);
    const download = a.waitForEvent('download');
    await boardAction(a, 'PDF');
    const exported = await download,
      path = test.info().outputPath('annotated.pdf');
    await exported.saveAs(path);
    const bytes = await readFile(path);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect((await PDFDocument.load(bytes)).getPageCount()).toBe(1);
    const bookDownload = a.waitForEvent('download');
    await boardAction(a, 'Export all pages as PDF');
    const book = await bookDownload,
      bookPath = test.info().outputPath('annotated-book.pdf');
    await book.saveAs(bookPath);
    expect((await PDFDocument.load(await readFile(bookPath))).getPageCount()).toBe(2);
    await a.screenshot({ path: '.local/runtime/pdf-annotation-desktop.png' });
    for (const width of [320, 390, 768]) {
      await a.setViewportSize({ width, height: 844 });
      await expect
        .poll(() => a.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      if (width === 390) await a.screenshot({ path: '.local/runtime/pdf-annotation-mobile.png' });
    }
  } finally {
    await owner.close();
    await student.close();
  }
});
