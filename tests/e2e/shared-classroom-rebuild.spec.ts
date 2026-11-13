import { test, expect } from './owned-browser';
import { PDFDocument, rgb } from 'pdf-lib';
import { readFile } from 'node:fs/promises';
import { boardAction } from './classroom-actions';
test.use({ actionTimeout: 15000 });

test('moderator locks use real dialogs and all viewers follow the same live board, GeoGebra view and PDF page across themes', async ({
  browser,
}) => {
  test.setTimeout(240000);
  const origin = process.env.TEST_APP_ORIGIN!,
    owner = await browser.newContext({ viewport: { width: 1440, height: 900 } }),
    student = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  for (const ctx of [owner, student])
    await ctx.addInitScript(() => {
      if (window === window.top) localStorage.setItem('language', 'en');
    });
  const make = async (ctx: typeof owner, name: string) => {
    const email = name + crypto.randomUUID() + '@shared-class-ui.test';
    const created = await ctx.request.post('/api/v1/auth/register', {
      headers: { origin },
      data: { name, email, password: '123456' },
    });
    expect(created.status()).toBe(201);
    const login = await ctx.request.post('/api/v1/auth/login', {
      headers: { origin },
      data: { email, password: '123456' },
    });
    expect(login.ok()).toBe(true);
    return { id: (await created.json()).id, email };
  };
  try {
    await make(owner, 'Moderator');
    const learner = await make(student, 'Learner');
    const post = async (path: string, data: unknown) => {
      const r = await owner.request.post('/api/v1' + path, { headers: { origin }, data });
      expect(r.ok(), await r.text()).toBe(true);
      return r.json();
    };
    const org = await post('/organizations', { name: 'Shared teaching' });
    await post('/organizations/' + org.id + '/members', { email: learner.email, role: 'student' });
    const room = await post('/organizations/' + org.id + '/classrooms', {
        name: 'نمایش مشترک کلاس',
        enrollmentMode: 'organization',
      }),
      base = '/classrooms/' + room.id;
    await post(base + '/geogebra', { name: 'Shared geometry' });
    await post(base + '/session/start', {});
    const a = await owner.newPage(),
      b = await student.newPage();
    const browserErrors: string[] = [];
    for (const p of [a, b]) p.on('pageerror', (e) => browserErrors.push(e.message));
    await Promise.all([a.goto('/#classroom/' + room.id), b.goto('/#classroom/' + room.id)]);
    await expect(a.locator('.board-tool-dock')).toBeVisible();
    await expect(b.locator('.advanced-board-canvas')).toBeVisible();
    await a.getByRole('button', { name: 'Blank page', exact: true }).click();
    const selector = a.getByRole('combobox', { name: 'Whiteboard pages', exact: true });
    await expect(selector.locator('option')).toHaveCount(2);
    await expect(b.getByRole('combobox', { name: 'Whiteboard pages', exact: true })).toHaveValue(
      await selector.inputValue(),
      { timeout: 10000 },
    );
    await a.getByRole('button', { name: 'Text', exact: true }).click();
    const canvas = a.locator('.excalidraw__canvas.interactive'),
      box = (await canvas.boundingBox())!;
    await canvas.click({ position: { x: box.width * 0.4, y: box.height * 0.45 } });
    await a.locator('textarea.excalidraw-wysiwyg').fill('Live classroom text');
    await a.keyboard.press('Escape');
    await expect(a.getByText('All board changes saved', { exact: true })).toBeVisible();
    const exported = b.waitForEvent('download');
    await boardAction(b, 'SVG');
    const exportPath = test.info().outputPath('live-board.svg');
    await (await exported).saveAs(exportPath);
    expect(await readFile(exportPath, 'utf8')).toContain('Live classroom text');
    console.info('Shared board content received by viewer');
    await a.getByRole('button', { name: 'Student permissions', exact: true }).click();
    const lock = a.getByRole('dialog', { name: 'Lock student features', exact: true });
    await expect(lock).toBeVisible();
    for (const name of ['Microphone', 'Camera', 'Public chat', 'Shared notes'])
      await lock.getByRole('switch', { name, exact: true }).check();
    await a.screenshot({ path: '.local/runtime/lock-dialog-desktop.png' });
    await lock.getByRole('button', { name: 'Apply locks', exact: true }).click();
    await expect(lock).toHaveCount(0);
    await expect(b.getByRole('textbox', { name: 'Write a message', exact: true })).toHaveAttribute(
      'contenteditable',
      'false',
      { timeout: 3000 },
    );
    const denied = await student.request.post('/api/v1' + base + '/messages', {
      headers: { origin },
      data: { body: 'Forbidden while locked' },
    });
    expect(denied.status()).toBe(403);
    const join = await student.request.post('/api/v1' + base + '/join', {
      headers: { origin },
      data: {},
    });
    expect(join.ok(), await join.text()).toBe(true);
    expect((await join.json()).policy.microphone).toBe(false);
    expect((await join.json()).policy.camera).toBe(false);
    await a.screenshot({ path: '.local/runtime/class-locks-shared-desktop.png' });
    await a.locator('[data-participant-id="' + learner.id + '"] strong[role=button]').click();
    const target = a
      .locator('[data-participant-id="' + learner.id + '"] .participant-inline-perms button')
      .first();
    await target.click();
    const personal = a.getByRole('dialog', { name: 'Lock features for Learner', exact: true });
    await expect(personal).toBeVisible();
    await personal
      .getByRole('checkbox', { name: 'Exempt this student from class-wide locks', exact: true })
      .check();
    await personal.getByRole('switch', { name: 'Microphone', exact: true }).uncheck();
    await personal.getByRole('button', { name: 'Apply locks', exact: true }).click();
    await expect(personal).toHaveCount(0);
    const allowed = await student.request.post('/api/v1' + base + '/join', {
      headers: { origin },
      data: {},
    });
    expect((await allowed.json()).policy.microphone).toBe(true);
    expect((await allowed.json()).policy.camera).toBe(false);
    console.info('Class locks and individual exemptions enforced');
    await a.getByRole('button', { name: 'Random student', exact: true }).click();
    await expect(b.locator('.random-student-banner')).toContainText('Learner', { timeout: 3000 });
    expect(
      (
        await student.request.post('/api/v1' + base + '/random-student', {
          headers: { origin },
          data: {},
        })
      ).status(),
    ).toBe(403);
    await a.getByRole('button', { name: 'Clear random selection', exact: true }).click();
    await expect(b.locator('.random-student-banner')).toHaveCount(0, { timeout: 3000 });
    await a
      .locator('.shared-workspace-modes')
      .getByRole('button', { name: 'GeoGebra', exact: true })
      .click();
    await expect(a.locator('iframe[title="GeoGebra drawing"]')).toBeVisible({ timeout: 60000 });
    await expect(b.locator('iframe[title="GeoGebra drawing"]')).toBeVisible({ timeout: 60000 });
    await expect(a.getByRole('combobox', { name: 'Drawing view', exact: true })).toBeEnabled({
      timeout: 60000,
    });
    await a.getByRole('combobox', { name: 'Drawing view', exact: true }).selectOption('4');
    await expect(b.getByRole('combobox', { name: 'Drawing view', exact: true })).toHaveValue('4', {
      timeout: 3000,
    });
    await expect(b.getByRole('combobox', { name: 'Drawing view', exact: true })).toBeDisabled();
    await expect(a.getByRole('link', { name: 'Official source', exact: true })).toHaveCount(0);
    await b.reload();
    await expect(b.getByRole('combobox', { name: 'Drawing view', exact: true })).toHaveValue('4', {
      timeout: 60000,
    });
    console.info('Shared GeoGebra perspective persists after viewer reload');
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 2; i++) {
      const page = pdf.addPage([600, 800]);
      page.drawRectangle({
        x: 60,
        y: 620,
        width: 480,
        height: 100,
        color: i ? rgb(0.1, 0.2, 0.8) : rgb(0.8, 0.1, 0.1),
      });
    }
    await a.locator('input[aria-label="Import PDF"]').setInputFiles({
      name: 'Shared lesson.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from(await pdf.save()),
    });
    await expect(a.getByRole('button', { name: 'Shared lesson.pdf', exact: true })).toBeVisible({
      timeout: 60000,
    });
    await expect(
      b.getByRole('combobox', { name: 'Whiteboard pages', exact: true }).locator('option'),
    ).toHaveCount(2, { timeout: 10000 });
    await a.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(b.getByRole('combobox', { name: 'Whiteboard pages', exact: true })).toHaveValue(
      await a.getByRole('combobox', { name: 'Whiteboard pages', exact: true }).inputValue(),
      { timeout: 3000 },
    );
    await b.reload();
    await expect(b.getByRole('combobox', { name: 'Whiteboard pages', exact: true })).toHaveValue(
      await a.getByRole('combobox', { name: 'Whiteboard pages', exact: true }).inputValue(),
    );
    const geometry = [];
    for (const theme of ['classic-bbb', 'modular-skyroom', 'immersive-glass', 'studio-hybrid']) {
      await post(base + '/settings', { theme });
      await expect(a.locator('.classroom-shell')).toHaveAttribute('data-theme', theme);
      for (const [width, height] of [
        [1440, 900],
        [1024, 768],
        [390, 844],
        [320, 568],
      ]) {
        await a.setViewportSize({ width, height });
        await expect
          .poll(() => a.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
          .toBe(true);
        const bounds = await a.locator('.advanced-board-canvas').boundingBox();
        expect(bounds!.width).toBeGreaterThan(180);
        expect(bounds!.height).toBeGreaterThan(100);
        const stage = (await a.locator('.classroom-stage').boundingBox())!;
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(stage.y + stage.height + 1);
        if (width >= 1100) {
          await expect
            .poll(async () => {
              const tile = await a
                .locator('.teaching-media .media-idle-tile')
                .first()
                .boundingBox();
              return tile ? Math.abs(tile.width / tile.height - 16 / 9) : 99;
            })
            .toBeLessThan(0.035);
        }
        geometry.push({ theme, width, height, canvas: bounds });
        await a.screenshot({ path: '.local/runtime/rebuilt-' + theme + '-' + width + '.png' });
      }
    }
    await a.getByRole('button', { name: 'Student permissions', exact: true }).click();
    await expect(
      a.getByRole('dialog', { name: 'Lock student features', exact: true }),
    ).toBeVisible();
    await a.screenshot({ path: '.local/runtime/lock-dialog-mobile.png' });
    await a.keyboard.press('Escape');
    expect(browserErrors).toEqual([]);
    await test.info().attach('responsive-geometry', {
      body: JSON.stringify(geometry, null, 2),
      contentType: 'application/json',
    });
  } finally {
    await Promise.race([
      Promise.allSettled([owner.close(), student.close()]),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
  }
});
