import { test, expect } from './owned-browser';
import { setAppLanguage, selectEditorText } from './classroom-actions';

test('compact chat leaves room for messages, keeps formatting usable and fits all four layouts', async ({
  page,
  browser,
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
  const email = crypto.randomUUID() + '@compact.test',
    password = 'compact-classroom-password';
  await post('/auth/register', {
    email,
    password,
    name: 'Instructor with a very long name for constrained panels',
  });
  await post('/auth/login', { email, password });
  const org = await post('/organizations', { name: 'Compact classroom layouts' });
  for (const theme of ['classic-bbb', 'modular-skyroom', 'immersive-glass', 'studio-hybrid']) {
    await page.setViewportSize({ width: 1440, height: 900 });
    const room = await post('/organizations/' + org.id + '/classrooms', {
      name: 'Compact classroom ' + theme,
      theme,
    });
    await post('/classrooms/' + room.id + '/session/start', {});
    await post('/classrooms/' + room.id + '/messages', { body: 'A short message' });
    await page.goto('/#classroom/' + room.id);
    await expect(page.locator('.classroom-shell')).toHaveAttribute('data-theme', theme);
    await expect(page.getByTestId('classroom-connection')).toHaveText('Live connection');
    const chat = page.locator('[data-layout-panel="chat"]');
    if (theme === 'immersive-glass')
      await page.getByRole('button', { name: 'Class discussion', exact: true }).click();
    await expect(chat).toBeVisible();
    const composer = chat.locator('.chat-composer'),
      editor = composer.getByRole('textbox');
    await expect(chat.getByLabel('Chat text size')).toHaveValue('14');
    expect((await chat.boundingBox())!.width).toBeLessThanOrEqual(280);
    expect((await composer.boundingBox())!.height).toBeLessThanOrEqual(110);
    const header = (await chat.locator(':scope > header').boundingBox())!;
    expect(header.height).toBeLessThanOrEqual(46);
    // The compact toolbar still exposes the full editor through its overflow menu.
    await editor.fill('Compact formatted message');
    await selectEditorText(editor, 0, 7);
    await composer.getByRole('button', { name: 'Bold', exact: true }).click();
    await expect(editor.locator('strong')).toHaveText('Compact');
    await composer.getByLabel('More options', { exact: true }).click();
    await expect(
      composer.getByRole('button', { name: 'Numbered list', exact: true }),
    ).toBeVisible();
    const menu = (await composer.locator('.rich-text-more > div').boundingBox())!;
    expect(menu.y).toBeGreaterThan(header.y + header.height);
    expect(menu.y + menu.height).toBeLessThanOrEqual((await composer.boundingBox())!.y + 40);
    await composer.getByRole('button', { name: 'Numbered list', exact: true }).click();
    await expect(editor.locator('ol')).toHaveCount(1);
    await expect(composer.locator('.rich-text-more')).not.toHaveAttribute('open');
    await composer.getByLabel('More options', { exact: true }).click();
    await composer.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(editor.locator('ol')).toHaveCount(0);
    await composer.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(chat.locator('.messages .formatted-text strong')).toHaveText('Compact');
    expect(
      (await chat.locator('.messages article').first().boundingBox())!.height,
    ).toBeLessThanOrEqual(72);
    await chat.getByLabel('Chat text size').selectOption('20');
    await expect(chat.locator('.messages .formatted-text p').last()).toHaveCSS('font-size', '20px');
    await chat.getByLabel('Chat text size').selectOption('14');
    for (const language of ['en', 'fa'] as const) {
      await setAppLanguage(page, language);
      for (const viewport of [
        { width: 3840, height: 2160 },
        { width: 1440, height: 900 },
        { width: 1280, height: 720 },
        { width: 1024, height: 768 },
        { width: 768, height: 1024 },
        { width: 390, height: 844 },
        { width: 320, height: 568 },
        { width: 667, height: 375 },
        { width: 640, height: 360 },
      ]) {
        await page.setViewportSize(viewport);
        await expect(page.locator('.classroom-shell')).toHaveAttribute(
          'data-compact-layout',
          String(viewport.width <= 1099),
        );
        if (!(await chat.isVisible()))
          await page
            .getByRole('button', {
              name: language === 'en' ? 'Class discussion' : 'گفت‌وگوی کلاس',
              exact: true,
            })
            .click();
        await expect(chat).toBeVisible();
        const box = (await chat.boundingBox())!,
          input = (await composer.boundingBox())!;
        expect(box.x).toBeGreaterThanOrEqual(-1);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width + 1);
        expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + 1);
        expect(input.y + input.height).toBeLessThanOrEqual(box.y + box.height + 1);
        expect(input.height).toBeLessThanOrEqual(110);
        expect((await chat.locator('.messages').boundingBox())!.height).toBeGreaterThan(45);
        const overflow = await chat.evaluate((element) =>
          [
            element,
            ...element.querySelectorAll(
              '.chat,.chat-title-row,.chat-composer,.rich-text-toolbar,.messages',
            ),
          ].some((item) => item.scrollWidth > item.clientWidth + 1),
        );
        expect(overflow, 'No chat controls should overflow horizontally').toBe(false);
        const toolbar = await composer.locator('.rich-text-toolbar').boundingBox();
        expect(toolbar!.height).toBeLessThanOrEqual(36);
        if (language === 'fa' && [1440, 320].includes(viewport.width))
          await page.screenshot({
            path: 'test-results/compact-' + theme + '-' + viewport.width + '.png',
          });
      }
    }
    await setAppLanguage(page, 'en');
    await expect
      .poll(
        async () =>
          (await (await page.request.get('/api/v1/account/preferences')).json()).preferences
            .language,
      )
      .toBe('en');
    const phone = await browser.newContext({
      storageState: await page.context().storageState(),
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    try {
      const touchPage = await phone.newPage();
      await touchPage.goto('/#classroom/' + room.id);
      await expect(touchPage.locator('.classroom-shell')).toHaveAttribute('data-theme', theme);
      await touchPage.screenshot({ path: '.local/runtime/compact-touch-before-' + theme + '.png' });
      await touchPage
        .getByRole('button', { name: 'Class discussion', exact: true })
        .tap({ timeout: 15000 });
      const touchChat = touchPage.locator('[data-layout-panel="chat"]');
      for (const viewport of [
        { width: 390, height: 844 },
        { width: 320, height: 568 },
        { width: 667, height: 375 },
      ]) {
        await touchPage.setViewportSize(viewport);
        await expect(touchChat).toBeVisible();
        expect(
          (await touchChat.locator('.chat-composer').boundingBox())!.height,
        ).toBeLessThanOrEqual(110);
        expect((await touchChat.locator('.messages').boundingBox())!.height).toBeGreaterThan(45);
        const edit = touchChat.getByRole('button', { name: 'Edit message', exact: true }).first();
        await expect(edit).toBeVisible();
        expect((await edit.boundingBox())!.height).toBeGreaterThanOrEqual(32);
        expect(
          await touchChat.evaluate((element) => element.scrollWidth > element.clientWidth + 1),
        ).toBe(false);
      }
      await touchChat.getByRole('button', { name: 'Edit message', exact: true }).first().tap();
      await expect(touchChat.locator('.chat-edit-form').getByRole('textbox')).toBeVisible();
      await touchChat.getByRole('button', { name: 'Cancel', exact: true }).tap();
      await expect(touchChat.locator('.chat-edit-form')).toHaveCount(0);
    } finally {
      await phone.close();
    }
  }
});
