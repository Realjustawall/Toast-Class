import { test, expect, type BrowserContext } from './owned-browser';

test('private messages stay between participants and public/private switches work independently', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const contexts: BrowserContext[] = [],
    emails: string[] = [],
    origin = process.env.TEST_APP_ORIGIN!;
  const post = async (ctx: BrowserContext, path: string, data: unknown) => {
    const r = await ctx.request.post('/api/v1' + path, { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  try {
    for (const name of ['Moderator', 'Alice', 'Bob']) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      contexts.push(ctx);
      await ctx.addInitScript(() => {
        if (window === window.top) localStorage.setItem('language', 'en');
      });
      const email = crypto.randomUUID() + '@private-browser.test';
      emails.push(email);
      await post(ctx, '/auth/register', { email, password: '123456', name });
      await post(ctx, '/auth/login', { email, password: '123456' });
    }
    const [owner, alice, bob] = contexts,
      org = await post(owner, '/organizations', { name: 'Private chat verification' });
    for (const email of emails.slice(1))
      await post(owner, '/organizations/' + org.id + '/members', { email, role: 'student' });
    const room = await post(owner, '/organizations/' + org.id + '/classrooms', {
      name: 'Independent chat controls',
      enrollmentMode: 'organization',
    });
    await post(owner, '/classrooms/' + room.id + '/session/start', {});
    const pages = await Promise.all(contexts.map((ctx) => ctx.newPage())),
      [m, a, b] = pages;
    await Promise.all(pages.map((page) => page.goto('/#classroom/' + room.id)));
    for (const page of pages)
      await expect(page.getByTestId('classroom-connection')).toHaveText('Live connection');
    const editor = (p: typeof a) => p.locator('.chat-composer').getByRole('textbox');
    const scope = (p: typeof a) => p.locator('.chat-scope-bar');
    await editor(a).fill('Unsent public draft');
    await scope(a).getByRole('button', { name: 'Private', exact: true }).click();
    await a.locator('.chat-private-peer select').selectOption({ label: 'Bob' });
    await editor(a).fill('Only Alice and Bob can read this');
    await a.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(a.locator('.messages')).toContainText('Only Alice and Bob can read this');
    await expect(b.locator('.chat-private-unread')).toHaveText('1');
    await expect(m.locator('.messages')).not.toContainText('Only Alice and Bob');
    await expect(b.locator('.messages')).not.toContainText('Only Alice and Bob');
    await scope(b)
      .getByRole('button', { name: /Private/ })
      .click();
    await b.locator('.chat-private-peer select').selectOption({ label: 'Alice (1)' });
    await expect(b.locator('.messages')).toContainText('Only Alice and Bob can read this');
    await expect(b.locator('.chat-private-unread')).toHaveCount(0);
    await expect(
      b.locator('.messages').getByRole('button', { name: 'Delete', exact: true }),
    ).toHaveCount(0);
    await expect(a.getByRole('button', { name: 'Attach image', exact: true })).toHaveCount(0);
    await scope(a).getByRole('button', { name: 'Public', exact: true }).click();
    await expect(editor(a)).toHaveText('Unsent public draft');
    await m.locator('.chat-policy-controls summary').click();
    await m.getByRole('switch', { name: 'Enable public chat' }).click();
    await expect(m.getByRole('switch', { name: 'Enable public chat' })).not.toBeChecked();
    await expect(a.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await editor(b).fill('Private remains enabled');
    await b.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(b.locator('.messages')).toContainText('Private remains enabled');
    await m.getByRole('switch', { name: 'Enable public chat' }).click();
    await expect(m.getByRole('switch', { name: 'Enable public chat' })).toBeChecked();
    await m.getByRole('switch', { name: 'Enable private chat' }).click();
    await expect(m.getByRole('switch', { name: 'Enable private chat' })).not.toBeChecked();
    await expect(b.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await a.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(m.locator('.messages')).toContainText('Unsent public draft');
    await b.reload();
    await scope(b)
      .getByRole('button', { name: /Private/ })
      .click();
    await b.locator('.chat-private-peer select').selectOption({ label: 'Alice' });
    await expect(b.locator('.messages')).toContainText('Private remains enabled');
    await expect(b.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await b.setViewportSize({ width: 320, height: 568 });
    if (!(await b.locator('[data-layout-panel="chat"]').isVisible()))
      await b.getByRole('button', { name: 'Class discussion', exact: true }).click();
    await expect(b.locator('.chat-private-peer select')).toBeVisible();
    const overflow = await b.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
    expect(overflow).toBe(false);
    await b.screenshot({ path: '.local/runtime/private-chat-mobile.png' });
  } finally {
    await Promise.race([
      Promise.allSettled(contexts.map((ctx) => ctx.close())),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
  }
});
