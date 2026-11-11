import { setAppLanguage } from './classroom-actions';
import { test, expect } from './owned-browser';

test('connection recovers, optional service failure preserves classroom, settings drafts and geometry survive updates', async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.addInitScript(() => localStorage.setItem('language', 'en'));
  const origin = process.env.TEST_APP_ORIGIN ?? 'http://localhost:5173';
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post('/api/v1' + path, { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  const email = `polish-${crypto.randomUUID()}@example.org`;
  await post('/auth/register', { email, name: 'Connection teacher', password: 'polish-password' });
  await post('/auth/login', { email, password: 'polish-password' });
  const org = await post('/organizations', { name: 'Connection school' });
  const room = await post(`/organizations/${org.id}/classrooms`, {
    enrollmentMode: 'organization',
    name: 'Responsive classroom with a long descriptive title',
  });
  const base = `/classrooms/${room.id}`;
  let sockets = 0;
  page.on('websocket', (socket) => {
    if (socket.url().endsWith('/live')) sockets++;
  });
  await page.goto('/#classroom/' + room.id);
  const connection = page.getByTestId('classroom-connection');
  await expect(connection).toHaveText('Live connection');
  await expect(page.locator('.chat > small')).toHaveText('Live connection');
  expect(sockets).toBe(1);
  // An optional presentation API must not gate access to chat and teaching controls.
  await page.route('**/presentations', (route) =>
    route.fulfill({ status: 503, json: { error: 'Internal server error' } }),
  );
  await page.reload();
  await expect(page.locator('.classroom-shell')).toBeVisible();
  await expect(page.locator('.classroom-shell > .error')).toBeVisible();
  await page.unroute('**/presentations');
  await page.context().setOffline(true);
  await expect(connection).toHaveText('Offline — waiting for network');
  await page.context().setOffline(false);
  await expect(connection).toHaveText('Live connection');
  await expect(page.locator('.classroom-shell > .error')).toHaveCount(0);
  // A live notification must not overwrite an unsaved settings form.
  await page.getByRole('button', { name: 'Class announcement', exact: true }).click();
  const settings = page.locator('dialog.classroom-settings-dialog');
  const notice = settings.locator('.notice-settings-grid input').first();
  await notice.fill('Unsaved teacher draft');
  await post(base + '/messages', { body: 'Trigger a genuine live invalidation' });
  await expect(page.locator('.messages')).toContainText('Trigger a genuine live invalidation');
  await expect(notice).toHaveValue('Unsaved teacher draft');
  await expect(settings).toBeVisible();
  expect((await settings.boundingBox())!.width).toBeGreaterThan(700);
  await page.keyboard.press('Escape');
  await expect(settings).not.toBeVisible();
  for (const theme of ['classic-bbb', 'modular-skyroom', 'immersive-glass', 'studio-hybrid']) {
    await post(base + '/settings', { theme });
    await expect(page.locator('.classroom-shell')).toHaveAttribute('data-theme', theme);
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 900, height: 650 },
      { width: 390, height: 844 },
      { width: 320, height: 568 },
      { width: 667, height: 375 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(connection).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      for (const selector of ['.classroom-topbar', '.classroom-stage', '.classroom-actions']) {
        const bounds = (await page.locator(selector).boundingBox())!;
        expect(bounds.x).toBeGreaterThanOrEqual(0);
        expect(bounds.y).toBeGreaterThanOrEqual(0);
        expect(bounds.x + bounds.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height + 1);
        expect(bounds.height).toBeGreaterThan(30);
      }
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await setAppLanguage(page, 'fa');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await expect(connection).toBeVisible();
  await page.screenshot({ path: 'test-results/polish-classroom-mobile-fa.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: 'test-results/polish-classroom-desktop-fa.png', fullPage: true });
});
