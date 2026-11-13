import { test, expect, type BrowserContext } from './owned-browser';
test('two independent users synchronize polls, hand queue, notes and board', async ({
  browser,
}) => {
  const owner = await browser.newContext(),
    student = await browser.newContext();
  const origin = process.env.TEST_APP_ORIGIN ?? 'http://localhost:5173';
  async function post(ctx: BrowserContext, path: string, data: unknown) {
    const r = await ctx.request.post(origin + '/api/v1' + path, {
      headers: { Origin: origin },
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  }
  try {
    for (const [ctx, email] of [
      [owner, 'instructor@browser.org'],
      [student, 'learner@browser.org'],
    ] as const) {
      await ctx.addInitScript(() => {
        if (window === window.top) localStorage.setItem('language', 'en');
      });
      await post(ctx, '/auth/register', {
        email,
        name: email.startsWith('instructor') ? 'Instructor' : 'Learner',
        password: 'browser-test-password',
      });
      await post(ctx, '/auth/login', { email, password: 'browser-test-password' });
    }
    const org = await post(owner, '/organizations', { name: 'Workshop' });
    await post(owner, '/organizations/' + org.id + '/members', {
      email: 'learner@browser.org',
      role: 'student',
    });
    const room = await post(owner, '/organizations/' + org.id + '/classrooms', {
      enrollmentMode: 'organization',
      name: 'Collaborative workshop',
    });
    const teacherPage = await owner.newPage(),
      studentPage = await student.newPage();
    for (const p of [teacherPage, studentPage]) {
      await p.goto('/');
      await p.getByRole('button', { name: 'Enter classroom', exact: true }).click();
      await expect(p.locator('.classroom-topbar [role=status]')).toHaveText('Live connection');
    }
    await expect(
      studentPage.getByRole('button', { name: 'Start session', exact: true }),
    ).toHaveCount(0);
    await teacherPage.getByRole('button', { name: 'Start session', exact: true }).click();
    await expect(
      studentPage.getByRole('button', { name: 'Connect audio & video', exact: true }),
    ).toBeEnabled();
    await teacherPage
      .getByLabel('Write a message', { exact: true })
      .fill('Live classroom chat — سلام');
    await teacherPage.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(studentPage.locator('.messages')).toContainText('Live classroom chat — سلام');
    for (const p of [teacherPage, studentPage])
      await p.getByRole('button', { name: 'Class discussion', exact: true }).click();
    await studentPage.getByRole('button', { name: 'Raise hand', exact: true }).click();
    for (const p of [teacherPage, studentPage]) {
      await p.getByRole('button', { name: 'Apps', exact: true }).click();
      await p.getByRole('menuitem', { name: 'Activities', exact: true }).click();
    }
    await expect(
      teacherPage.locator('.classroom-app-activities').getByRole('listitem'),
    ).toContainText('Learner');
    await teacherPage.getByRole('button', { name: 'Lower hand Learner', exact: true }).click();
    await expect(studentPage.getByText('No hands raised.')).toBeVisible();
    await teacherPage.getByLabel('Question', { exact: true }).fill('Which topic next?');
    await teacherPage.getByLabel('Options (one per line)').fill('Concurrency\nNetworking');
    await teacherPage.getByRole('button', { name: 'Launch poll', exact: true }).click();
    await studentPage.getByRole('button', { name: 'Concurrency', exact: true }).click();
    await expect(teacherPage.locator('.poll button').first()).toContainText('1');
    await teacherPage.getByRole('button', { name: 'Publish results', exact: true }).click();
    await expect(studentPage.locator('.poll button').first()).toContainText('1');
    await teacherPage.getByRole('button', { name: 'Documents', exact: true }).click();
    await teacherPage.getByRole('button', { name: 'Manage class content', exact: true }).click();
    await teacherPage.getByLabel('Name', { exact: true }).fill('Group notes');
    await teacherPage.getByRole('button', { name: 'Create', exact: true }).click();
    await studentPage.getByRole('button', { name: 'Documents', exact: true }).click();
    for (const p of [teacherPage, studentPage])
      await p.getByRole('button', { name: 'Group notes', exact: true }).click();
    await teacherPage
      .getByRole('textbox', { name: 'Shared notes', exact: true })
      .fill('Hello — سلام');
    await expect(
      studentPage.getByRole('textbox', { name: 'Shared notes', exact: true }),
    ).toHaveText('Hello — سلام');
    await studentPage
      .getByRole('textbox', { name: 'Shared notes', exact: true })
      .fill('Hello — سلام / group');
    await expect(
      teacherPage.getByRole('textbox', { name: 'Shared notes', exact: true }),
    ).toHaveText('Hello — سلام / group');
    await teacherPage
      .locator('.document-editor')
      .getByRole('button', { name: 'Undo', exact: true })
      .click();
    // Undo only this user's edit; it must not erase the other user's contribution.
    await expect(
      studentPage.getByRole('textbox', { name: 'Shared notes', exact: true }),
    ).toHaveText(' / group');
    await teacherPage
      .locator('.document-editor')
      .getByRole('button', { name: 'Redo', exact: true })
      .click();
    await expect(
      studentPage.getByRole('textbox', { name: 'Shared notes', exact: true }),
    ).toHaveText('Hello — سلام / group');
    // Offline delivery uses a per-account local outbox; reload must not discard edits.
    await studentPage.route('**/updates', (route) => route.abort('internetdisconnected'));
    await studentPage
      .getByRole('textbox', { name: 'Shared notes', exact: true })
      .fill('Hello — سلام / group / offline');
    await expect(studentPage.getByText('Saving...', { exact: true })).toBeVisible();
    studentPage.on('dialog', (dialog) => void dialog.accept());
    await studentPage.reload();
    await expect(
      studentPage.getByRole('heading', { name: room.name, exact: true, level: 1 }),
    ).toBeVisible({ timeout: 20_000 });
    await studentPage.getByRole('button', { name: 'Documents', exact: true }).click();
    await studentPage.getByRole('button', { name: 'Group notes', exact: true }).click();
    await expect(
      studentPage.getByRole('textbox', { name: 'Shared notes', exact: true }),
    ).toHaveText('Hello — سلام / group / offline');
    await studentPage.unroute('**/updates');
    await expect(
      teacherPage.getByRole('textbox', { name: 'Shared notes', exact: true }),
    ).toHaveText('Hello — سلام / group / offline', { timeout: 10000 });
    await teacherPage.getByRole('button', { name: 'Manage class content', exact: true }).click();
    await teacherPage.getByLabel('Name', { exact: true }).fill('Group board');
    await teacherPage.getByLabel('Document type').selectOption('board');
    await teacherPage.getByLabel('Board editor').selectOption('legacy');
    await teacherPage.getByRole('button', { name: 'Create', exact: true }).click();
    for (const p of [teacherPage, studentPage])
      await p.getByRole('button', { name: 'Group board', exact: true }).click();
    await teacherPage.getByRole('button', { name: 'Rectangle', exact: true }).click();
    await expect(teacherPage.getByText('Saved', { exact: true })).toBeVisible();
    const board = teacherPage.getByRole('img', { name: 'Whiteboard', exact: true });
    const bounds = await board.boundingBox();
    if (!bounds) throw new Error('Missing board');
    await teacherPage.mouse.move(bounds.x + 100, bounds.y + 100);
    await teacherPage.mouse.down();
    await teacherPage.mouse.move(bounds.x + 220, bounds.y + 190);
    await teacherPage.mouse.up();
    await expect(studentPage.locator('svg.whiteboard rect')).toHaveCount(1);
    await teacherPage.screenshot({
      path: 'docs/screenshots/teaching-board-en.png',
      fullPage: true,
    });
    await studentPage.reload();
    await expect(
      studentPage.getByRole('heading', { name: room.name, exact: true, level: 1 }),
    ).toBeVisible();
    await studentPage.getByRole('button', { name: 'Documents', exact: true }).click();
    await studentPage.getByRole('button', { name: 'Group board', exact: true }).click();
    await expect(studentPage.locator('svg.whiteboard rect')).toHaveCount(1);
    await teacherPage.getByRole('button', { name: 'End session', exact: true }).click();
    await expect(
      studentPage.getByRole('button', { name: 'Connect audio & video', exact: true }),
    ).toBeDisabled();
  } finally {
    await owner.close();
    await student.close();
  }
});
