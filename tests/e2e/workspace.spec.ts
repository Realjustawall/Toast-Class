import { setAppLanguage } from './classroom-actions';
import { test, expect } from './owned-browser';
test('real UI: register, create organization and classroom, switch RTL/LTR and persist across reload', async ({
  page,
}) => {
  await page.goto('/');
  await setAppLanguage(page, 'en');
  await page
    .getByRole('navigation', { name: 'Your account' })
    .getByRole('button', { name: 'Create account', exact: true })
    .click();
  await page.getByLabel('Name', { exact: true }).fill('Neda Rahimi');
  await page.getByLabel('Email', { exact: true }).fill('neda@example.org');
  await page.getByLabel('Password', { exact: true }).fill('browser-test-password-123');
  await page.getByLabel('Confirm password', { exact: true }).fill('browser-test-password-123');
  await page.locator('form').getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'A little space. A lot to learn.' }),
  ).toBeVisible();
  await page.getByRole('button', { name: '+ Create organization' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Mehr Learning');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.getByRole('button', { name: '+ Create classroom' }).click();
  await page.getByLabel('Name', { exact: true }).fill('Collaborative learning');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Collaborative learning' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Collaborative learning' })).toBeVisible();
  await page.screenshot({ path: 'docs/screenshots/workspace-en.png', fullPage: true });
  await setAppLanguage(page, 'fa');
  await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
  await page.screenshot({ path: 'docs/screenshots/workspace-fa.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('heading', { name: 'Collaborative learning' })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  ).toBeTruthy();
  await page.screenshot({ path: 'docs/screenshots/workspace-mobile-fa.png', fullPage: true });
  await page.getByRole('button', { name: 'ورود به کلاس' }).click();
  await expect(
    page.getByRole('heading', { name: 'Collaborative learning', level: 1, exact: true }),
  ).toBeVisible();
  await expect(page.locator('.classroom-shell')).toBeVisible();
  await expect(page.getByRole('button', { name: 'اتصال صوت و تصویر', exact: true })).toBeVisible();
});
