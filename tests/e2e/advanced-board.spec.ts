import { setAppLanguage, boardAction } from './classroom-actions';
import { test, expect, type BrowserContext, type Download } from './owned-browser';
import * as Y from 'yjs';
import { readFile } from 'node:fs/promises';

async function localDownload(download: Download) {
  const path = test.info().outputPath(crypto.randomUUID());
  await download.saveAs(path);
  return path;
}
test('advanced editor synchronizes independent users, persists refresh, enforces read-only and loads local assets', async ({
  browser,
}) => {
  const teacher = await browser.newContext(),
    student = await browser.newContext();
  const origin = process.env.TEST_APP_ORIGIN ?? 'http://localhost:5173';
  const outside: string[] = [];
  const localFonts: string[] = [];
  const suffix = crypto.randomUUID();
  const post = async (ctx: BrowserContext, path: string, data: unknown) => {
    const response = await ctx.request.post(origin + '/api/v1' + path, {
      headers: { Origin: origin },
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  try {
    for (const [ctx, name] of [
      [teacher, 'teacher'],
      [student, 'student'],
    ] as const) {
      await ctx.addInitScript(() => localStorage.setItem('language', 'en'));
      await ctx.route('**/*', async (route) => {
        const url = route.request().url();
        if (/^https?:/.test(url) && new URL(url).origin !== origin) {
          outside.push(url);
          return route.abort();
        }
        if (url.includes('/excalidraw/fonts/')) localFonts.push(url);
        await route.continue();
      });
      const email = name + suffix + '@board.test';
      await post(ctx, '/auth/register', { email, name, password: 'board-browser-password' });
      await post(ctx, '/auth/login', { email, password: 'board-browser-password' });
    }
    const org = await post(teacher, '/organizations', { name: 'Board school' });
    await post(teacher, `/organizations/${org.id}/members`, {
      email: 'student' + suffix + '@board.test',
      role: 'student',
    });
    const room = await post(teacher, `/organizations/${org.id}/classrooms`, {
      enrollmentMode: 'organization',
      name: 'Advanced board workshop',
      permissions: { studentWhiteboardEnabled: true },
    });
    const a = await teacher.newPage(),
      b = await student.newPage();
    for (const page of [a, b]) {
      await page.goto('/');
      await page.getByRole('button', { name: 'Enter classroom', exact: true }).click();
      await page.getByRole('button', { name: 'Documents', exact: true }).click();
    }
    await a.getByRole('button', { name: 'Manage class content', exact: true }).click();
    await a.getByLabel('Name', { exact: true }).fill('Workshop board');
    await a.getByLabel('Document type').selectOption('board');
    await a.getByRole('button', { name: 'Create', exact: true }).click();
    for (const page of [a, b]) {
      await page.getByRole('button', { name: 'Workshop board', exact: true }).click();
      await expect(page.getByText('All board changes saved', { exact: true })).toBeVisible();
    }
    const docs = await (
      await teacher.request.get(origin + `/api/v1/classrooms/${room.id}/documents`)
    ).json();
    const doc = docs.find((d: { name: string }) => d.name === 'Workshop board');
    expect(doc.board_format).toBe('excalidraw');
    const base = origin + `/api/v1/classrooms/${room.id}/documents/${doc.id}/board`;
    const serverElements = async () => {
      const data = await (await teacher.request.get(base)).json();
      const y = new Y.Doc();
      try {
        if (data.state) Y.applyUpdate(y, Buffer.from(data.state, 'base64'));
        return [...y.getMap('elements').values()] as {
          type: string;
          text?: string;
          isDeleted: boolean;
        }[];
      } finally {
        y.destroy();
      }
    };
    const canvas = a.locator('.excalidraw__canvas.interactive');
    await expect(canvas).toBeVisible();
    const bounds = (await canvas.boundingBox())!;
    await canvas.click({ position: { x: bounds.width / 2, y: bounds.height / 2 } });
    await a.keyboard.press('r');
    await a.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await a.mouse.down();
    await a.mouse.move(bounds.x + bounds.width / 2 + 90, bounds.y + bounds.height / 2 + 65, {
      steps: 5,
    });
    await a.mouse.up();
    await expect
      .poll(
        async () =>
          (await serverElements()).filter((e) => e.type === 'rectangle' && !e.isDeleted).length,
      )
      .toBe(1);
    await expect(b.getByText('All board changes saved', { exact: true })).toBeVisible();
    await expect(a.getByText('Live cursor connection', { exact: true })).toBeVisible();
    await expect(b.locator('.board-presence')).toContainText('teacher');
    await boardAction(a, 'Board history');
    await a.getByLabel('Version name', { exact: true }).fill('Baseline');
    await a.getByRole('button', { name: 'Save version', exact: true }).click();
    await expect(a.getByRole('button', { name: 'Restore Baseline', exact: true })).toBeVisible();
    await a.getByRole('button', { name: 'Preview Baseline', exact: true }).click();
    await expect(
      a.getByRole('img', { name: 'Saved board preview: Baseline', exact: true }),
    ).toBeVisible();
    await boardAction(a, 'Board history');
    const textBounds = (await canvas.boundingBox())!;
    const textPoint = { x: textBounds.width / 4, y: textBounds.height * 0.55 };
    await canvas.click({ position: textPoint });
    await a.keyboard.press('t');
    await a.mouse.click(textBounds.x + textPoint.x, textBounds.y + textPoint.y);
    await a.locator('textarea.excalidraw-wysiwyg').fill('سلام — Shared board');
    await a.keyboard.press('Escape');
    await expect
      .poll(async () => (await serverElements()).some((e) => e.text === 'سلام — Shared board'))
      .toBe(true);
    await b.reload();
    await b.getByRole('button', { name: 'Documents', exact: true }).click();
    await b.getByRole('button', { name: 'Workshop board', exact: true }).click();
    await expect(b.getByText('All board changes saved', { exact: true })).toBeVisible();
    const exported = b.waitForEvent('download');
    await boardAction(b, 'SVG');
    const exportPath = test.info().outputPath('shared-board.svg');
    await (await exported).saveAs(exportPath);
    expect(await readFile(exportPath, 'utf8')).toContain('Shared board');
    await b.route('**/board/updates', (route) => route.abort('internetdisconnected'));
    const studentCanvas = b.locator('.excalidraw__canvas.interactive');
    const studentBounds = (await studentCanvas.boundingBox())!;
    await studentCanvas.click({
      position: { x: studentBounds.width / 3, y: studentBounds.height * 0.55 },
    });
    await b.keyboard.press('t');
    await b.mouse.click(
      studentBounds.x + studentBounds.width / 3,
      studentBounds.y + studentBounds.height * 0.55,
    );
    await b.locator('textarea.excalidraw-wysiwyg').fill('یادداشت دانشجو');
    await b.keyboard.press('Escape');
    await expect(b.locator('.board-status [role=status]')).toContainText('awaiting sync');
    b.on('dialog', (dialog) => void dialog.accept());
    await b.reload();
    await b.getByRole('button', { name: 'Documents', exact: true }).click();
    await b.getByRole('button', { name: 'Workshop board', exact: true }).click();
    await expect(b.locator('.board-status [role=status]')).toContainText('awaiting sync');
    await b.unroute('**/board/updates');
    // Wait for the receiving browser's authorized delta, not just the sender's receipt.
    const receivedByTeacher = a.waitForResponse(async (response) => {
      if (!response.url().startsWith(base + '?since=') || !response.ok()) return false;
      const data = await response.json();
      const updates = data.state
        ? [data.state]
        : (data.updates ?? []).map((item: { update: string }) => item.update);
      return updates.some((value: string) =>
        Buffer.from(value, 'base64').includes(Buffer.from('یادداشت دانشجو')),
      );
    });
    await b.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect
      .poll(async () => (await serverElements()).some((e) => e.text === 'یادداشت دانشجو'))
      .toBe(true);
    await expect(b.getByText('All board changes saved', { exact: true })).toBeVisible();
    await receivedByTeacher;
    const teacherExport = a.waitForEvent('download');
    await boardAction(a, 'SVG');
    expect(await readFile(await localDownload(await teacherExport), 'utf8')).toContain(
      'یادداشت دانشجو',
    );
    const pngExport = a.waitForEvent('download');
    await boardAction(a, 'PNG');
    expect(
      (await readFile(await localDownload(await pngExport))).subarray(0, 8).toString('hex'),
    ).toBe('89504e470d0a1a0a');
    await boardAction(a, 'Teacher editing only');
    await expect(b.getByText('Read-only board', { exact: true })).toBeVisible();
    expect((await (await student.request.get(base)).json()).canEdit).toBe(false);
    expect(outside).toEqual([]);
    expect(localFonts.length).toBeGreaterThan(0);
    await setAppLanguage(b, 'fa');
    await expect(b.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(b.getByText('تخته فقط خواندنی است', { exact: true })).toBeVisible();
    await b.setViewportSize({ width: 375, height: 812 });
    await b.getByRole('button', { name: 'نمایش همهٔ محتوا', exact: true }).click();
    await expect(b.locator('.advanced-board')).toBeVisible();
    expect(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await a.screenshot({ path: 'test-results/advanced-board-desktop.png', fullPage: true });
    await b.screenshot({ path: 'test-results/advanced-board-mobile.png', fullPage: true });
    await setAppLanguage(b, 'en');
    await b.setViewportSize({ width: 1280, height: 900 });
    await boardAction(a, 'Allow participant editing');
    await expect(b.getByText('All board changes saved', { exact: true })).toBeVisible();
    await b.route('**/board/updates', (route) => route.abort('internetdisconnected'));
    const pendingCanvas = b.locator('.excalidraw__canvas.interactive'),
      pendingBounds = (await pendingCanvas.boundingBox())!;
    await pendingCanvas.click({
      position: { x: pendingBounds.width / 2, y: pendingBounds.height / 2 },
    });
    await b.keyboard.press('t');
    await b.mouse.click(
      pendingBounds.x + pendingBounds.width / 2,
      pendingBounds.y + pendingBounds.height * 0.55,
    );
    await b.locator('textarea.excalidraw-wysiwyg').fill('Unsent after baseline');
    await b.keyboard.press('Escape');
    await expect(b.locator('.board-status [role=status]')).toContainText('awaiting sync');
    await boardAction(a, 'Board history');
    a.once('dialog', (dialog) => void dialog.accept());
    await a.getByRole('button', { name: 'Restore Baseline', exact: true }).click();
    await expect
      .poll(async () => (await serverElements()).filter((e) => !e.isDeleted).length)
      .toBe(1);
    await expect(
      b.getByRole('button', { name: 'Download pending edit recovery data', exact: true }),
    ).toBeVisible();
    const recoveryDownload = b.waitForEvent('download');
    await b
      .getByRole('button', { name: 'Download pending edit recovery data', exact: true })
      .click();
    const recovery = JSON.parse(
      await readFile(await localDownload(await recoveryDownload), 'utf8'),
    );
    expect(recovery.pending.length).toBeGreaterThan(0);
    await b.reload();
    await b.getByRole('button', { name: 'Documents', exact: true }).click();
    await b.getByRole('button', { name: 'Workshop board', exact: true }).click();
    await expect(
      b.getByRole('button', { name: 'Download pending edit recovery data', exact: true }),
    ).toBeVisible();
    await b.unroute('**/board/updates');
    await b
      .getByRole('button', { name: 'Discard pending edits and load restored board', exact: true })
      .click();
    await expect(b.getByText('All board changes saved', { exact: true })).toBeVisible();
    const restoredExport = b.waitForEvent('download');
    await boardAction(b, 'SVG');
    const restoredSvg = await readFile(await localDownload(await restoredExport), 'utf8');
    expect(restoredSvg).not.toContain('Shared board');
    expect(restoredSvg).not.toContain('Unsent after baseline');
    await a.screenshot({ path: 'test-results/board-history.png', fullPage: true });
  } finally {
    await teacher.close();
    await student.close();
  }
});
