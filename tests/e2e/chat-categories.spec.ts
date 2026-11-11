import { test, expect, type BrowserContext } from './owned-browser';
import { setAppLanguage } from './classroom-actions';

test('Public is the only default category; only moderators add or remove shared categories without deleting messages', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const origin = process.env.TEST_APP_ORIGIN!,
    contexts: BrowserContext[] = [],
    emails: string[] = [];
  try {
    for (const name of ['Moderator', 'Student']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      contexts.push(context);
      await context.addInitScript(() => {
        if (window === window.top) localStorage.setItem('language', 'en');
      });
      const email = name + crypto.randomUUID() + '@categories-browser.test',
        password = 'chat-categories-browser-password';
      const create = await context.request.post('/api/v1/auth/register', {
        headers: { origin },
        data: { name, email, password },
      });
      expect(create.ok()).toBe(true);
      expect(
        (
          await context.request.post('/api/v1/auth/login', {
            headers: { origin },
            data: { email, password },
          })
        ).ok(),
      ).toBe(true);
      emails.push(email);
    }
    const [owner, student] = contexts;
    const post = async (path: string, data: unknown) => {
      const result = await owner.request.post('/api/v1' + path, { headers: { origin }, data });
      expect(result.ok(), await result.text()).toBe(true);
      return result.json();
    };
    const org = await post('/organizations', { name: 'Shared chat categories' });
    await post('/organizations/' + org.id + '/members', {
      email: emails[1],
      role: 'student',
    });
    const room = await post('/organizations/' + org.id + '/classrooms', {
        name: 'Category controls',
        enrollmentMode: 'organization',
      }),
      base = '/classrooms/' + room.id;
    await post(base + '/session/start', {});
    const a = await owner.newPage(),
      b = await student.newPage();
    await Promise.all([a.goto('/#classroom/' + room.id), b.goto('/#classroom/' + room.id)]);
    for (const page of [a, b]) {
      await expect(page.getByTestId('classroom-connection')).toHaveText('Live connection');
      await expect(page.getByRole('tab')).toHaveCount(1);
      await expect(page.getByRole('tab', { name: 'Public', exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    }
    await expect(
      b.getByRole('button', { name: 'Manage chat categories', exact: true }),
    ).toHaveCount(0);
    const denied = await student.request.post('/api/v1' + base + '/chat-categories', {
      headers: { origin },
      data: { name: 'Forbidden' },
    });
    expect(denied.status()).toBe(403);
    const publicDraft = a.getByRole('textbox', { name: 'Write a message', exact: true });
    await publicDraft.fill('Unsent public draft');
    await a.getByRole('button', { name: 'Manage chat categories', exact: true }).click();
    const dialog = a.getByRole('dialog', { name: 'Manage chat categories', exact: true });
    await dialog.getByLabel('Category name', { exact: true }).fill('Exercises');
    await dialog.getByRole('button', { name: 'Add category', exact: true }).click();
    await expect(dialog.getByText('Exercises', { exact: true })).toBeVisible();
    await expect(b.getByRole('tab', { name: 'Exercises', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
    await a.getByRole('tab', { name: 'Exercises', exact: true }).click();
    await expect(publicDraft).toHaveText('');
    await publicDraft.fill('Unsent exercise draft');
    await a.getByRole('tab', { name: 'Public', exact: true }).click();
    await expect(publicDraft).toHaveText('Unsent public draft');
    await a.reload();
    await expect(a.getByRole('tab', { name: 'Exercises', exact: true })).toBeVisible();
    await a.getByRole('tab', { name: 'Exercises', exact: true }).click();
    await expect(publicDraft).toHaveText('Unsent exercise draft');
    await b.getByRole('tab', { name: 'Exercises', exact: true }).click();
    await b
      .getByRole('textbox', { name: 'Write a message', exact: true })
      .fill('Answer in exercises');
    await b.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(a.locator('.messages')).toContainText('Answer in exercises');
    await b.getByRole('tab', { name: 'Public', exact: true }).click();
    await expect(b.locator('.messages article')).toHaveCount(0);
    await b
      .getByRole('textbox', { name: 'Write a message', exact: true })
      .fill('Question? This stays public.');
    await b.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(b.locator('.messages')).toContainText('Question? This stays public.');
    await b.getByRole('tab', { name: 'Exercises', exact: true }).click();
    await a.getByRole('button', { name: 'Manage chat categories', exact: true }).click();
    await dialog.getByRole('button', { name: 'Delete category: Exercises', exact: true }).click();
    await expect(b.getByRole('tab')).toHaveCount(1);
    await expect(b.getByRole('tab', { name: 'Public', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(b.locator('.messages')).toContainText('Answer in exercises');
    await expect(b.locator('.messages')).toContainText('Question? This stays public.');
    await dialog.getByRole('button', { name: 'Close panel', exact: true }).click();
    await expect(publicDraft).toHaveText('Unsent public draft');
    // Many long category names scroll inside the tabs, while admin controls fit.
    for (let index = 0; index < 12; index++)
      await post(base + '/chat-categories', { name: 'دستهٔ گفتگو با عنوان طولانی ' + index });
    await expect(b.getByRole('tab')).toHaveCount(13);
    await setAppLanguage(a, 'fa');
    await a.setViewportSize({ width: 320, height: 568 });
    await expect(a.locator('.classroom-shell')).toHaveAttribute('data-compact-layout', 'true');
    await a.getByRole('button', { name: 'گفت‌وگوی کلاس', exact: true }).click();
    const chat = a.locator('[data-layout-panel="chat"]');
    await expect(chat).toBeVisible();
    expect(
      await chat
        .locator('.chat-title-row')
        .evaluate((element) => element.scrollWidth > element.clientWidth + 1),
    ).toBe(false);
    await chat.getByRole('button', { name: 'مدیریت دسته‌های گفتگو', exact: true }).click();
    const management = a.getByRole('dialog');
    await expect(
      management.getByRole('button', { name: 'افزودن دسته', exact: true }),
    ).toBeDisabled();
    const bounds = (await management.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(321);
    await a.screenshot({ path: 'test-results/chat-categories-admin-mobile-fa.png' });
    await management.getByRole('button', { name: 'بستن پنل', exact: true }).click();
    await b.reload();
    await expect(b.getByRole('tab')).toHaveCount(13);
    await b.getByRole('tab', { name: 'Public', exact: true }).focus();
    await b.keyboard.press('End');
    await expect(b.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
    await b.screenshot({ path: 'test-results/chat-categories-student.png' });
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
