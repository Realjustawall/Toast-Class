import { test, expect } from './owned-browser';
test.use({ actionTimeout: 15000 });
test('platform administrator chooses a registered user by name; membership is saved by user ID', async ({
  browser,
}) => {
  test.setTimeout(60000);
  const admin = await browser.newContext(),
    candidate = await browser.newContext(),
    origin = process.env.TEST_APP_ORIGIN!,
    name = 'Selected learner ' + crypto.randomUUID().slice(0, 8),
    email = crypto.randomUUID() + '@chooser.test';
  try {
    await admin.addInitScript(() => {
      if (window === window.top) localStorage.setItem('language', 'en');
    });
    const post = async (ctx: typeof admin, path: string, data: unknown) => {
      const response = await ctx.request.post('/api/v1' + path, { headers: { origin }, data });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const user = await post(candidate, '/auth/register', { name, email, password: '123456' });
    await post(candidate, '/auth/login', { email, password: '123456' });
    await post(admin, '/auth/login', {
      email: 'platform-admin@browser.test',
      password: 'admin123',
    });
    const org = await post(admin, '/organizations', { name: 'Choose users by name' }),
      page = await admin.newPage();
    await page.goto('/');
    await page.getByLabel('Organization', { exact: true }).selectOption(org.id);
    await page.getByRole('button', { name: 'Add member', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Add member', exact: true });
    await dialog.getByRole('searchbox', { name: 'Search users by name', exact: true }).fill(name);
    await expect(dialog.getByRole('option', { name, exact: true })).toBeVisible();
    await expect(dialog.locator('input[name=email]')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Create', exact: true })).toBeDisabled();
    await dialog.getByRole('option', { name, exact: true }).click();
    await expect(dialog.locator('input[name=userId]')).toHaveValue(user.id);
    await expect(dialog.getByRole('status')).toContainText(name);
    await page.screenshot({ path: '.local/runtime/admin-member-name-selection.png' });
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const organizations = await (await candidate.request.get('/api/v1/organizations')).json();
    expect(
      organizations.some(
        (item: { id: string; role: string }) => item.id === org.id && item.role === 'student',
      ),
    ).toBe(true);
    await page.getByRole('button', { name: 'Add member', exact: true }).click();
    await expect(
      page.getByRole('dialog').getByRole('button', { name: 'Create', exact: true }),
    ).toBeDisabled();
  } finally {
    await Promise.race([
      Promise.allSettled([admin.close(), candidate.close()]),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
  }
});
