import { setAppLanguage } from './classroom-actions';
import { test, expect, type BrowserContext } from './owned-browser';
import * as Y from 'yjs';
test('classroom shell keeps stage, live chat, real people and controls in one responsive viewport', async ({
  browser,
}) => {
  const teacher = await browser.newContext(),
    student = await browser.newContext(),
    origin = process.env.TEST_APP_ORIGIN ?? 'http://localhost:5173',
    suffix = crypto.randomUUID();
  async function post(ctx: BrowserContext, path: string, data: unknown) {
    const response = await ctx.request.post(origin + '/api/v1' + path, {
      headers: { Origin: origin },
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  }
  try {
    for (const [ctx, role] of [
      [teacher, 'teacher'],
      [student, 'student'],
    ] as const) {
      await ctx.addInitScript(() => localStorage.setItem('language', 'en'));
      const email = role + suffix + '@layout.test';
      await post(ctx, '/auth/register', {
        email,
        name: role === 'teacher' ? 'مدرس آزمون' : 'دانش‌آموز آزمون',
        password: 'layout-browser-password',
      });
      await post(ctx, '/auth/login', { email, password: 'layout-browser-password' });
    }
    const org = await post(teacher, '/organizations', { name: 'آموزشگاه TOASTER' });
    await post(teacher, `/organizations/${org.id}/members`, {
      email: 'student' + suffix + '@layout.test',
      role: 'student',
    });
    const room = await post(teacher, `/organizations/${org.id}/classrooms`, {
      enrollmentMode: 'organization',
      name: 'کلاس آنلاین — کارگاه یادگیری',
    });
    const board = await post(teacher, `/classrooms/${room.id}/documents`, {
      kind: 'board',
      name: 'تختهٔ کلاس',
      boardFormat: 'excalidraw',
    });
    const base = `/classrooms/${room.id}/documents/${board.id}/board`;
    const initial = await (await teacher.request.get(origin + '/api/v1' + base)).json();
    const doc = new Y.Doc();
    const common = {
      angle: 0,
      strokeColor: '#20394f',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 1,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: Date.now(),
      link: null,
      locked: false,
    };
    doc.getMap('elements').set('welcome', {
      ...common,
      id: 'welcome',
      type: 'text',
      x: 80,
      y: 100,
      width: 450,
      height: 60,
      text: 'TOASTER',
      originalText: 'TOASTER',
      fontSize: 48,
      fontFamily: 2,
      textAlign: 'center',
      verticalAlign: 'top',
      containerId: null,
      autoResize: false,
      lineHeight: 1.25,
    });
    doc.getMap('elements').set('subtitle', {
      ...common,
      id: 'subtitle',
      type: 'text',
      x: 80,
      y: 175,
      width: 450,
      height: 40,
      text: 'به کلاس آنلاین خوش آمدید',
      originalText: 'به کلاس آنلاین خوش آمدید',
      fontSize: 24,
      fontFamily: 2,
      textAlign: 'center',
      verticalAlign: 'top',
      containerId: null,
      autoResize: false,
      lineHeight: 1.25,
    });
    await post(teacher, base + '/updates', {
      id: crypto.randomUUID(),
      generation: initial.generation,
      update: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'),
    });
    doc.destroy();
    await post(teacher, `/classrooms/${room.id}/messages`, {
      body: 'سلام، خوش آمدید. امروز از تختهٔ مشترک استفاده می‌کنیم.',
    });
    await post(student, `/classrooms/${room.id}/messages`, {
      body: 'سلام، آماده‌ام. می‌توانیم شروع کنیم.',
    });
    const a = await teacher.newPage(),
      b = await student.newPage();
    for (const page of [a, b]) {
      await page.goto('/');
      await page.getByRole('button', { name: 'Enter classroom', exact: true }).click();
      await expect(page.locator('.classroom-shell')).toBeVisible();
      await expect(page.getByText('All board changes saved', { exact: true })).toBeVisible();
    }
    await expect(a.locator('.classroom-sidepanel .messages')).toContainText('سلام، آماده‌ام');
    await a.getByLabel('Write a message', { exact: true }).fill('پیام از رابط جدید کلاس');
    await a.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(b.locator('.classroom-sidepanel .messages')).toContainText(
      'پیام از رابط جدید کلاس',
    );
    await a.getByRole('button', { name: 'Participants', exact: true }).click();
    await expect(a.locator('.classroom-people')).toContainText('مدرس آزمون');
    await expect(a.locator('.classroom-people')).toContainText('دانش‌آموز آزمون');
    await a.getByRole('button', { name: 'Class discussion', exact: true }).click();
    await a.getByRole('button', { name: 'Fit to content', exact: true }).click();
    await setAppLanguage(a, 'fa');
    await expect(a.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(a.getByRole('navigation', { name: 'راهبری کلاس' })).toBeVisible();
    await a.screenshot({ path: 'test-results/classroom-layout-desktop.png', fullPage: true });
    const desktopFooter = (await a.locator('.classroom-actions').boundingBox())!;
    expect(desktopFooter.y + desktopFooter.height).toBeLessThanOrEqual(720);
    const stageWidth = (await a.locator('.document-layout').boundingBox())!.width;
    expect((await a.locator('.advanced-board').boundingBox())!.width).toBeGreaterThan(
      stageWidth - 3,
    );
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await a.setViewportSize({ width: 390, height: 844 });
    await a.getByRole('button', { name: 'نمایش همهٔ محتوا', exact: true }).click();
    expect(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await expect(a.locator('.classroom-actions')).toBeInViewport();
    await a.screenshot({ path: 'test-results/classroom-layout-mobile.png', fullPage: true });
  } finally {
    await Promise.allSettled([teacher.close(), student.close()]);
  }
});
