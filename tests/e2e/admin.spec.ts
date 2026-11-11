import { setAppLanguage } from './classroom-actions';
import { test, expect } from './owned-browser';

test('owner uses real operations, members, audit filtering and Persian mobile administration', async ({
  page,
}) => {
  const post = async (path: string, data: unknown) => {
    const r = await page.request.post('/api/v1' + path, {
      headers: { origin: process.env.TEST_APP_ORIGIN ?? 'http://localhost:5173' },
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  await page.addInitScript(() => {
    if (window === window.top) localStorage.setItem('language', 'en');
  });
  const email = `operations-${Date.now()}@example.org`;
  await post('/auth/register', {
    email,
    name: 'Operations owner',
    password: 'admin-browser-password',
  });
  await post('/auth/login', { email, password: 'admin-browser-password' });
  const org = await post('/organizations', { name: 'Mehr Academy' });
  const room = await post(`/organizations/${org.id}/classrooms`, {
    enrollmentMode: 'organization',
    name: 'Physics seminar',
  });
  await post(`/classrooms/${room.id}/session/start`, {});
  await page.goto('/');
  await page.getByRole('button', { name: 'Administration', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Administration', exact: true })).toBeVisible();
  await expect(page.getByRole('cell', { name: 'Physics seminar', exact: true })).toBeVisible();
  await expect(page.locator('.admin-panel')).toHaveAttribute('aria-busy', 'false');
  await page.screenshot({ path: 'docs/screenshots/admin-operations-en.png', fullPage: true });
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  await expect(page.getByRole('cell', { name: email, exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Audit trail', exact: true }).click();
  const audit = await page.request.get(`/api/v1/organizations/${org.id}/admin/audit?limit=1`);
  const action = (await audit.json()).items[0].action;
  await page.getByLabel('Action identifier').fill(action);
  await page.getByRole('button', { name: 'Apply filter' }).click();
  await expect(page.locator('tbody tr')).toHaveCount(1);
  await expect(page.locator('tbody')).toContainText(action);
  await setAppLanguage(page, 'fa');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'وضعیت عملیاتی', exact: true }).click();
  await expect(page.getByRole('cell', { name: 'Physics seminar', exact: true })).toBeVisible();
  await expect(page.locator('.admin-panel')).toHaveAttribute('aria-busy', 'false');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: 'docs/screenshots/admin-operations-mobile-fa.png',
    fullPage: true,
  });
  await post(`/classrooms/${room.id}/session/end`, {});
  await page.getByRole('button', { name: 'به‌روزرسانی داده‌ها', exact: true }).click();
  await expect(page.getByText('در حال حاضر نشستی باز نیست.', { exact: true })).toBeVisible();
});
