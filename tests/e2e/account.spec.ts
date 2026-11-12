import { setAppLanguage } from './classroom-actions';
import { test, expect } from './owned-browser';

test('registration recovery, personal panel, independent device revocation and password change', async ({
  page,
  browser,
}) => {
  await page.addInitScript(() => {
    if (window === window.top) localStorage.setItem('language', 'en');
  });
  await page.goto('/');
  const registrationTab = page
    .getByRole('navigation', { name: 'Your account' })
    .getByRole('button', { name: 'Create account', exact: true });
  await expect(registrationTab).toBeEnabled();
  await registrationTab.click();
  const submitRegistration = page
    .locator('form')
    .getByRole('button', { name: 'Create account', exact: true });
  await page.getByLabel('Name', { exact: true }).fill('Account Learner');
  const email = `account-${Date.now()}@example.org`,
    password = 'abc123';
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByLabel('Confirm password', { exact: true }).fill('different-password');
  await submitRegistration.click();
  await expect(page.getByText('The passwords do not match.', { exact: true })).toBeVisible();
  await page.getByLabel('Confirm password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Show password', exact: true }).click();
  await expect(page.getByLabel('Password', { exact: true })).toHaveAttribute('type', 'text');
  await page.screenshot({ path: 'docs/screenshots/registration-en.png', fullPage: true });
  let fail = true;
  await page.route('**/api/v1/auth/register', (route) =>
    fail ? route.fulfill({ status: 502, body: '' }) : route.continue(),
  );
  await submitRegistration.click();
  await expect(page.getByRole('alert')).toContainText('The server is restarting or unavailable');
  fail = false;
  await submitRegistration.click();
  await page.getByRole('button', { name: 'My account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'My account', exact: true })).toBeVisible();
  await page.getByLabel('Name', { exact: true }).fill('Updated Learner');
  await page.getByLabel('Preferred language', { exact: true }).selectOption('en');
  await page.getByLabel('Timezone', { exact: true }).fill('Europe/London');
  await page.getByRole('button', { name: 'Save profile', exact: true }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Your profile has been saved' }),
  ).toBeVisible();
  const device = await browser.newContext();
  try {
    const response = await device.request.post(
      (process.env.TEST_APP_ORIGIN ?? 'http://localhost:5173') + '/api/v1/auth/login',
      {
        headers: { origin: process.env.TEST_APP_ORIGIN ?? 'http://localhost:5173' },
        data: { email, password },
      },
    );
    expect(response.ok()).toBe(true);
    // Reload the panel to collect actual sessions created by the other device.
    await page.getByRole('link', { name: 'Classrooms', exact: true }).click();
    await page.getByRole('button', { name: 'My account', exact: true }).click();
    await expect(page.getByText('Another session', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Sign out device', exact: true }).click();
    await expect(page.getByText('Another session', { exact: true })).toHaveCount(0);
    expect(
      (
        await device.request.get(
          (process.env.TEST_APP_ORIGIN ?? 'http://localhost:5173') + '/api/v1/me',
        )
      ).status(),
    ).toBe(401);
    await page.getByLabel('Current password', { exact: true }).fill(password);
    await page.getByLabel('New password', { exact: true }).fill('changed-account-password');
    await page.getByLabel('Confirm password', { exact: true }).fill('changed-account-password');
    await page.getByRole('button', { name: 'Change password', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Password changed' })).toBeVisible();
    await page.screenshot({ path: 'docs/screenshots/account-en.png', fullPage: true });
    await setAppLanguage(page, 'fa');
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole('heading', { name: 'حساب من', exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({ path: 'docs/screenshots/account-mobile-fa.png', fullPage: true });
  } finally {
    await device.close();
  }
});
