import { setAppLanguage } from './classroom-actions';
import { test, expect } from './owned-browser';

test('all four classrooms support readable text, keyboard and drag resizing, panel expansion and saved sizes', async ({
  page,
}) => {
  test.setTimeout(120000);
  const origin = process.env.TEST_APP_ORIGIN!;
  await page.addInitScript(() => {
    if (window === window.top) localStorage.setItem('language', 'en');
  });
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post('/api/v1' + path, { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const email = crypto.randomUUID() + '@panels.test',
    password = 'panel-sizing-password';
  await post('/auth/register', { email, password, name: 'Layout instructor' });
  await post('/auth/login', { email, password });
  const org = await post('/organizations', { name: 'Resizable classrooms' });
  for (const theme of ['classic-bbb', 'modular-skyroom', 'immersive-glass', 'studio-hybrid']) {
    await page.setViewportSize({ width: 1440, height: 900 });
    const room = await post('/organizations/' + org.id + '/classrooms', {
      name: 'Panels ' + theme,
      theme,
    });
    await page.goto('/#classroom/' + room.id);
    await page.reload();
    await expect(page.locator('.classroom-shell')).toHaveAttribute('data-theme', theme);
    const chat = page.locator('[data-layout-panel="chat"]');
    if (theme === 'immersive-glass')
      await page.getByRole('button', { name: 'Class discussion', exact: true }).click();
    await expect(chat).toBeVisible();
    const before = (await chat.boundingBox())!.width;
    await chat.getByRole('button', { name: /Make panel larger:/ }).click();
    await expect.poll(async () => (await chat.boundingBox())!.width).toBeGreaterThan(before + 20);
    const separator = chat.getByRole('separator');
    await separator.focus();
    await page.keyboard.press(theme === 'studio-hybrid' ? 'ArrowLeft' : 'ArrowRight');
    const resized = (await chat.boundingBox())!.width;
    const handle = (await separator.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(
      handle.x + handle.width / 2 + (theme === 'studio-hybrid' ? -25 : 25),
      handle.y + handle.height / 2,
      { steps: 5 },
    );
    await page.mouse.up();
    await expect.poll(async () => (await chat.boundingBox())!.width).toBeGreaterThan(resized + 15);
    for (const name of ['chat', 'people', 'media', 'stage']) {
      const panel = page.locator('[data-layout-panel="' + name + '"]');
      if (theme === 'immersive-glass' && name === 'people')
        await page.getByRole('button', { name: 'Participants', exact: true }).click();
      console.log('Expanding classroom panel:', theme, name);
      await panel.getByRole('button', { name: /Expand panel:/ }).click({ timeout: 5000 });
      const box = (await panel.boundingBox())!;
      expect(box.width).toBeGreaterThan(1300);
      await page.keyboard.press('Escape');
      await expect(page.locator('.classroom-shell')).toHaveAttribute('data-expanded-panel', 'none');
    }
    await page.locator('.application-settings-trigger').first().click();
    const preferences = page.locator('.application-settings-page');
    const savedPreferences = page.waitForResponse(
      (r) =>
        r.url().includes('/preferences') &&
        r.request().method() === 'POST' &&
        (r.request().postData() ?? '').includes('"text":20'),
    );
    await preferences
      .getByRole('combobox', { name: 'Classroom text size', exact: true })
      .selectOption('20');
    await savedPreferences;
    expect(
      await page
        .locator('.classroom-meeting-name h1')
        .evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
    ).toBeGreaterThanOrEqual(20);
    await page.keyboard.press('Escape');
    await page.reload();
    await expect(page.locator('.classroom-shell')).toHaveAttribute('data-theme', theme);
    expect(
      await page
        .locator('.classroom-meeting-name h1')
        .evaluate((e) => parseFloat(getComputedStyle(e).fontSize)),
    ).toBeGreaterThanOrEqual(20);
    await setAppLanguage(page, 'fa');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'گفت‌وگوی کلاس', exact: true }).click();
    await expect(chat).toBeVisible();
    await chat.getByRole('button', { name: /بزرگ‌نمایی بخش/ }).click();
    const mobile = (await chat.boundingBox())!;
    expect(mobile.x).toBeGreaterThanOrEqual(0);
    expect(mobile.x + mobile.width).toBeLessThanOrEqual(391);
    await page.keyboard.press('Escape');
    await expect(page.locator('iframe,.classroom-loading')).toHaveCount(0);
    const resetLang = page.waitForResponse(
      (r) =>
        r.url().includes('/preferences') &&
        r.request().method() === 'POST' &&
        (r.request().postData() ?? '').includes('"language":"en"'),
    );
    await setAppLanguage(page, 'en');
    await resetLang;
  }
});
