import { test, expect } from './owned-browser';
test.use({ actionTimeout: 15000 });

test('platform administrator saves real settings and users receive the enforced limits and disabled features', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const origin = process.env.TEST_APP_ORIGIN!,
    admin = await browser.newContext(),
    viewer = await browser.newContext();
  let initial: Record<string, unknown> | undefined;
  for (const ctx of [admin, viewer])
    await ctx.addInitScript(() => {
      if (window === window.top) localStorage.setItem('language', 'en');
    });
  try {
    const login = await admin.request.post('/api/v1/auth/login', {
      headers: { origin },
      data: { email: 'platform-admin@browser.test', password: 'admin123' },
    });
    expect(login.ok()).toBe(true);
    initial = await (await admin.request.get('/api/v1/platform/settings')).json();
    const a = await admin.newPage();
    await a.goto('/');
    await a.getByRole('button', { name: 'Platform settings', exact: true }).click();
    const settings = a.locator('.platform-settings');
    await expect(settings.getByLabel('Site name', { exact: true })).toBeVisible();
    await settings.getByLabel('Site name', { exact: true }).fill('مدرسهٔ زنده');
    await settings
      .getByLabel('Sign-in welcome text', { exact: true })
      .fill('به کلاس زنده خوش آمدید');
    await settings.getByLabel('Messages returned (20–200)', { exact: true }).fill('25');
    await settings.getByLabel('Maximum message length (200–2000)', { exact: true }).fill('250');
    await settings
      .getByRole('combobox', { name: 'Maximum chat image size', exact: true })
      .selectOption('1');
    await settings.getByLabel('Enable GeoGebra', { exact: true }).uncheck();
    await settings.getByLabel('Enable PDF import', { exact: true }).uncheck();
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(settings.getByText('Settings saved and applied.', { exact: true })).toBeVisible();
    const saved = await (await admin.request.get('/api/v1/platform/settings')).json();
    expect(saved.options.chatHistoryLimit).toBe(25);
    expect(saved.options.geoEnabled).toBe(false);
    expect(saved.options.pdfImportEnabled).toBe(false);
    await a.reload();
    await a.getByRole('button', { name: 'Platform settings', exact: true }).click();
    await expect(settings.getByLabel('Site name', { exact: true })).toHaveValue('مدرسهٔ زنده');
    await a.screenshot({ path: '.local/runtime/platform-settings-desktop.png', fullPage: true });
    await a.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() => a.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await a.screenshot({ path: '.local/runtime/platform-settings-mobile.png' });
    const v = await viewer.newPage();
    await v.goto('/');
    await expect(v.locator('.brand-glass-pill')).toContainText('مدرسهٔ زنده');
    await expect(v.getByText('به کلاس زنده خوش آمدید', { exact: true })).toBeVisible();
    expect((await viewer.request.get('/api/v1/platform/settings')).status()).toBe(401);
    const post = async (path: string, data: unknown) => {
      const r = await admin.request.post('/api/v1' + path, { headers: { origin }, data });
      expect(r.ok(), await r.text()).toBe(true);
      return r.json();
    };
    const org = await post('/organizations', { name: 'Actual platform defaults' }),
      room = await post('/organizations/' + org.id + '/classrooms', { name: 'Feature control' });
    await a.goto('/#classroom/' + room.id);
    await expect(a.locator('.advanced-board-canvas')).toBeVisible();
    await expect(
      a.locator('.shared-workspace-modes').getByRole('button', { name: 'GeoGebra', exact: true }),
    ).toHaveCount(0);
    await expect(a.locator('input[aria-label="Import PDF"]')).toHaveCount(0);
    const blocked = await admin.request.post('/api/v1/classrooms/' + room.id + '/geogebra', {
      headers: { origin },
      data: { name: 'Disabled' },
    });
    expect(blocked.status()).toBe(403);
  } finally {
    if (initial) {
      const current = await (await admin.request.get('/api/v1/platform/settings')).json();
      const restored = await admin.request.post('/api/v1/platform/settings', {
        headers: { origin },
        data: {
          options: initial.options,
          registrationOpen: initial.registrationOpen,
          expectedRevision: current.revision,
        },
      });
      expect(restored.ok()).toBe(true);
    }
    await Promise.race([
      Promise.allSettled([admin.close(), viewer.close()]),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
  }
});
