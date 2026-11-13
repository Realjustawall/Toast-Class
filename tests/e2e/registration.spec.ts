import { setAppLanguage } from './classroom-actions';
import { test, expect } from './owned-browser';

test('platform administrator closes registration while existing users can still sign in', async ({
  page,
  browser,
}) => {
  test.skip(
    process.env.TEST_PLATFORM_ADMIN_SEED !== 'true',
    'Explicit trusted administrator fixture required',
  );
  const origin = process.env.TEST_APP_ORIGIN ?? 'http://localhost:5173';
  await page.addInitScript(() => {
    if (window === window.top) localStorage.setItem('language', 'en');
  });
  await page.goto('/');
  await page.getByLabel('Email', { exact: true }).fill('platform-admin@browser.test');
  await page.getByLabel('Password', { exact: true }).fill('admin123');
  await page.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.getByRole('button', { name: 'Platform settings', exact: true }).click();
  await page.getByRole('button', { name: 'Close registration', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'New account registration is closed.' }),
  ).toBeVisible();
  const visitor = await browser.newContext();
  try {
    await visitor.addInitScript(() => {
      if (window === window.top) localStorage.setItem('language', 'en');
    });
    const guest = await visitor.newPage();
    await guest.goto('/');
    await expect(
      guest.getByText('New account registration is closed.', { exact: true }),
    ).toBeVisible();
    await expect(guest.getByRole('button', { name: 'Create account', exact: true })).toHaveCount(0);
    const denied = await visitor.request.post(origin + '/api/v1/auth/register', {
      headers: { origin },
      data: { name: 'Blocked visitor', email: 'blocked@browser.test', password: 'abc123' },
    });
    expect(denied.status()).toBe(403);
    await guest.getByLabel('Email', { exact: true }).fill('platform-admin@browser.test');
    await guest.getByLabel('Password', { exact: true }).fill('admin123');
    await guest.locator('form').getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(guest.getByRole('button', { name: 'My account', exact: true })).toBeVisible();
    await setAppLanguage(page, 'fa');
    await page.screenshot({
      path: 'docs/screenshots/platform-registration-fa.png',
      fullPage: true,
    });
    await page.getByRole('button', { name: 'باز کردن ثبت‌نام', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'ثبت‌نام حساب جدید باز است.' }),
    ).toBeVisible();
    await guest.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(
      guest.locator('form').getByRole('button', { name: 'Create account', exact: true }),
    ).toBeVisible();
  } finally {
    await visitor.close();
  }
});
