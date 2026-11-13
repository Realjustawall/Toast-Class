import { setAppLanguage, selectEditorText, openDocumentMenu } from './classroom-actions';
import type { BrowserContext } from './owned-browser';
import { test, expect } from './owned-browser';
test.use({ actionTimeout: 15000 });

test('owner configures type and enrollment, students only see assigned classes, teachers teach, text formats and all four layouts fit', async ({
  browser,
}) => {
  test.setTimeout(120000);
  const origin = process.env.TEST_APP_ORIGIN!,
    contexts: BrowserContext[] = [];
  const suffix = crypto.randomUUID();
  const post = async (context: BrowserContext, path: string, data: unknown) => {
    const r = await context.request.post(origin + '/api/v1' + path, { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  try {
    const users = [];
    for (const name of ['Owner', 'Assigned instructor', 'Assigned learner', 'Other learner']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      contexts.push(context);
      await context.addInitScript(() => {
        if (window !== window.top) return;
        localStorage.setItem('language', 'en');
        const Native = AudioContext.prototype.createOscillator;
        let count = 0;
        Object.defineProperty(window, 'testSoundCount', { get: () => count });
        AudioContext.prototype.createOscillator = function () {
          count++;
          return Native.call(this);
        };
      });
      const email = name.replaceAll(' ', '-') + suffix + '@classroom.test',
        password = 'classroom-test-password';
      await post(context, '/auth/register', {
        email,
        password,
        name: name === 'Assigned learner' ? name + ' ' + 'نام بسیار طولانی '.repeat(5) : name,
      });
      users.push(await post(context, '/auth/login', { email, password }));
    }
    const [owner, teacher, student, other] = contexts;
    const org = await post(owner, '/organizations', { name: 'Scoped classroom layouts' });
    for (const index of [1, 2, 3])
      await post(owner, '/organizations/' + org.id + '/members', {
        email: users[index].email,
        role: index === 1 ? 'teacher' : 'student',
      });
    const themes = ['classic-bbb', 'modular-skyroom', 'immersive-glass', 'studio-hybrid'];
    const rooms = [];
    for (const [index, theme] of themes.entries())
      rooms.push(
        await post(owner, '/organizations/' + org.id + '/classrooms', {
          name: 'Layout ' + theme,
          theme,
          memberIds: index === 0 ? [users[1].id, users[2].id] : index === 1 ? [users[3].id] : [],
        }),
      );
    const room = rooms[0],
      base = '/classrooms/' + room.id;
    const sharedDocument = await post(owner, base + '/documents', {
      name: 'Shared lesson',
      kind: 'notes',
    });
    await post(teacher, base + '/session/start', {});
    const teacherPage = await teacher.newPage(),
      studentPage = await student.newPage(),
      otherPage = await other.newPage(),
      ownerPage = await owner.newPage();
    await studentPage.goto('/');
    await expect(studentPage.locator('.room-card')).toHaveCount(1);
    await expect(studentPage.locator('.room-card')).toContainText(room.name);
    await otherPage.goto('/');
    await expect(otherPage.locator('.room-card')).toHaveCount(1);
    await expect(otherPage.locator('.room-card')).toContainText(rooms[1].name);
    await teacherPage.goto('/');
    await expect(
      teacherPage.getByRole('button', { name: 'Create classroom', exact: true }),
    ).toHaveCount(0);
    await expect(
      teacherPage.getByRole('button', { name: 'Administration', exact: true }),
    ).toHaveCount(0);
    await teacherPage.getByRole('button', { name: 'Enter classroom', exact: true }).click();
    await studentPage.getByRole('button', { name: 'Enter classroom', exact: true }).click();
    await expect(teacherPage.locator('.classroom-shell')).toHaveAttribute(
      'data-theme',
      'classic-bbb',
    );
    await expect(teacherPage.getByRole('radiogroup', { name: 'Classroom type' })).toHaveCount(0);
    await teacherPage.getByRole('button', { name: 'Class announcement', exact: true }).click();
    await expect(teacherPage.getByRole('radio')).toHaveCount(0);
    await teacherPage.keyboard.press('Escape');
    const denied = await teacher.request.post(origin + '/api/v1' + base + '/settings', {
      headers: { origin },
      data: { theme: 'studio-hybrid' },
    });
    expect(denied.status()).toBe(403);
    const composer = studentPage.getByLabel('Write a message', { exact: true });
    let unrelatedNoteRefreshes = 0;
    teacherPage.on('request', (request) => {
      if (
        request.method() === 'GET' &&
        new URL(request.url()).pathname === '/api/v1' + base + '/documents/' + sharedDocument.id
      )
        unrelatedNoteRefreshes++;
    });
    await composer.fill('Hello class');
    await selectEditorText(composer, 0, 5);
    await studentPage
      .locator('.chat-composer')
      .getByRole('button', { name: 'Bold', exact: true })
      .click();
    await expect(composer.locator('strong')).toHaveText('Hello');
    await studentPage.reload();
    await expect(composer.locator('strong')).toHaveText('Hello');
    const beforeChat = unrelatedNoteRefreshes;
    await studentPage.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(teacherPage.locator('.messages .formatted-text strong')).toHaveText('Hello');
    expect(unrelatedNoteRefreshes).toBe(beforeChat);
    const sent = studentPage.locator('.messages article');
    await sent.getByRole('button', { name: 'Edit message', exact: true }).click();
    await sent.getByRole('textbox').fill('Edited class');
    await selectEditorText(sent.getByRole('textbox'), 0, 6);
    if (
      (await sent
        .getByRole('button', { name: 'Bold', exact: true })
        .getAttribute('aria-pressed')) !== 'true'
    )
      await sent.getByRole('button', { name: 'Bold', exact: true }).click();
    await sent.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(teacherPage.locator('.messages .formatted-text strong')).toContainText('Edited');
    await studentPage.getByLabel('Chat text size').selectOption('20');
    await expect(studentPage.locator('.messages .formatted-text')).toHaveCSS('font-size', '20px');
    await sent.getByRole('button', { name: 'Delete message', exact: true }).click();
    await expect(teacherPage.locator('.messages article')).toHaveCount(0);
    await teacherPage.getByRole('button', { name: 'Shared lesson', exact: true }).click();
    const notes = teacherPage.getByRole('textbox', { name: 'Shared notes', exact: true });
    await expect(
      teacherPage.locator('.document-editor').getByRole('button', { name: 'Bold', exact: true }),
    ).toBeEnabled();
    await expect(notes).toHaveAttribute('contenteditable', 'true');
    await notes.fill('Shared lesson');
    await selectEditorText(notes, 0, 6);
    await teacherPage
      .locator('.document-editor')
      .getByRole('button', { name: 'Bold', exact: true })
      .click();
    await expect(
      studentPage.getByRole('textbox', { name: 'Shared notes', exact: true }).locator('strong'),
    ).toHaveText('Shared');
    await openDocumentMenu(studentPage);
    await studentPage.getByRole('button', { name: 'Preview text', exact: true }).click();
    await expect(studentPage.locator('.shared-notes-preview strong')).toHaveText('Shared');
    const sounds = teacherPage.getByRole('button', { name: 'Notification sounds', exact: true });
    await sounds.click();
    await expect(sounds).toHaveAttribute('aria-pressed', 'false');
    const silentCount = await teacherPage.evaluate(
      () => (window as unknown as { testSoundCount: number }).testSoundCount,
    );
    await post(student, base + '/messages', { body: 'Silent notification' });
    await expect(teacherPage.locator('.messages')).toContainText('Silent notification');
    expect(
      await teacherPage.evaluate(
        () => (window as unknown as { testSoundCount: number }).testSoundCount,
      ),
    ).toBe(silentCount);
    await sounds.click();
    await expect(sounds).toHaveAttribute('aria-pressed', 'true');
    const audibleCount = await teacherPage.evaluate(
      () => (window as unknown as { testSoundCount: number }).testSoundCount,
    );
    await post(student, base + '/messages', { body: 'Audible notification' });
    await expect
      .poll(() =>
        teacherPage.evaluate(
          () => (window as unknown as { testSoundCount: number }).testSoundCount,
        ),
      )
      .toBeGreaterThan(audibleCount);
    // Identity colors survive intervening messages and a reload. The offline
    // organization owner remains square without relying on the live roster.
    const studentAvatars = teacherPage.locator(
      '.messages .message-avatar[data-user-id="' + users[2].id + '"]',
    );
    const color = await studentAvatars
      .first()
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    await post(owner, base + '/messages', { body: 'Offline owner announcement' });
    await post(student, base + '/messages', { body: 'Same learner again' });
    await expect(studentAvatars).toHaveCount(3);
    const longAuthor = teacherPage
      .locator('.messages article > strong')
      .filter({ hasText: 'Assigned learner' })
      .first();
    await expect(longAuthor).toHaveCSS('text-overflow', 'ellipsis');
    expect(await longAuthor.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(
      true,
    );
    for (const avatar of await studentAvatars.all()) {
      await expect(avatar).toHaveCSS('background-color', color);
      await expect(avatar).toHaveCSS('border-radius', '50%');
    }
    const ownerAvatar = teacherPage.locator(
      '.messages .message-avatar[data-user-id="' + users[0].id + '"]',
    );
    await expect(ownerAvatar).toHaveCSS('border-radius', '6px');
    await teacherPage.reload();
    await expect(studentAvatars.first()).toHaveCSS('background-color', color);
    await expect(ownerAvatar).toHaveCSS('border-radius', '6px');
    await ownerPage.goto('/');
    await ownerPage.getByRole('button', { name: '+ Create classroom', exact: true }).click();
    const dialog = ownerPage.getByRole('dialog');
    await dialog.getByLabel('Name', { exact: true }).fill('Created with assigned members');
    await dialog.getByRole('radio', { name: 'Glass', exact: false }).click();
    await dialog.getByRole('checkbox', { name: /Assigned instructor/ }).check();
    await dialog.getByRole('checkbox', { name: /Assigned learner/ }).check();
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();
    await expect(ownerPage.locator('.room-card')).toHaveCount(5);
    await studentPage.goto('/');
    await expect(studentPage.locator('.room-card')).toHaveCount(2);
    await otherPage.reload();
    await expect(otherPage.locator('.room-card')).toHaveCount(1);
    await ownerPage.getByRole('button', { name: 'Administration', exact: true }).click();
    await ownerPage.getByRole('button', { name: 'Themes & Security', exact: true }).click();
    await ownerPage
      .locator('.admin-room-item')
      .filter({ hasText: room.name })
      .getByRole('button', { name: 'Edit classroom', exact: true })
      .click();
    await ownerPage
      .locator('.classroom-enrollment')
      .getByRole('checkbox', { name: /Assigned learner/ })
      .uncheck();
    await ownerPage.getByRole('button', { name: 'Save classroom settings', exact: true }).click();
    await studentPage.reload();
    await expect(studentPage.locator('.room-card')).toHaveCount(1);
    expect((await student.request.get(origin + '/api/v1' + base + '/documents')).status()).toBe(
      403,
    );
    for (const [index, theme] of themes.entries()) {
      await ownerPage.setViewportSize({ width: 1440, height: 900 });
      await ownerPage.goto('/#classroom/' + rooms[index].id);
      await expect(ownerPage.locator('.classroom-shell')).toHaveAttribute('data-theme', theme);
      await expect(ownerPage.getByTestId('classroom-connection')).toHaveText('Live connection');
      const areas = await ownerPage
        .locator('.classroom-shell')
        .evaluate((element) => getComputedStyle(element).gridTemplateAreas);
      expect(areas).toContain('stage');
      if (theme === 'classic-bbb')
        await expect(ownerPage.locator('.classroom-people-panel')).toBeVisible();
      if (theme === 'modular-skyroom')
        await expect(ownerPage.locator('.classroom-tools-panel')).toBeVisible();
      if (theme === 'immersive-glass')
        await expect(ownerPage.locator('[data-layout-panel="media"]')).toBeVisible();
      await ownerPage
        .getByRole('navigation', { name: 'Classroom navigation' })
        .getByRole('button', { name: 'Documents', exact: true })
        .click();
      if (theme === 'modular-skyroom' || theme === 'studio-hybrid') {
        await expect(ownerPage.locator('.excalidraw__canvas').first()).toBeVisible();
      }
      const layoutNoteName = 'Layout notes ' + index;
      await post(owner, '/classrooms/' + rooms[index].id + '/documents', {
        kind: 'notes',
        name: layoutNoteName,
      });
      await ownerPage.getByRole('button', { name: layoutNoteName, exact: true }).click();
      await expect(
        ownerPage.getByRole('textbox', { name: 'Shared notes', exact: true }),
      ).toBeVisible();
      await setAppLanguage(ownerPage, 'fa');
      for (const viewport of [
        { width: 1440, height: 900 },
        { width: 390, height: 844 },
        { width: 320, height: 568 },
        { width: 667, height: 375 },
      ]) {
        await ownerPage.setViewportSize(viewport);
        for (const selector of ['.classroom-topbar', '.classroom-stage', '.classroom-actions']) {
          const b = (await ownerPage.locator(selector).boundingBox())!;
          expect(b.x).toBeGreaterThanOrEqual(0);
          expect(b.y).toBeGreaterThanOrEqual(0);
          expect(b.x + b.width).toBeLessThanOrEqual(viewport.width + 1);
          expect(b.y + b.height).toBeLessThanOrEqual(viewport.height + 1);
          expect(b.height).toBeGreaterThan(30);
        }
        const overflow = await ownerPage
          .locator('.classroom-actions')
          .evaluate((e) => e.scrollWidth > e.clientWidth + 1);
        expect(overflow).toBe(false);
        const notesEditor = ownerPage.locator('.document-editor');
        if (await notesEditor.locator('.rich-text-editor').count()) {
          const sections = await notesEditor.evaluate((editor) =>
            ['header', '.rich-text-toolbar', '.tiptap'].map((selector) => {
              const box = editor.querySelector(selector)!.getBoundingClientRect();
              return { top: box.top, bottom: box.bottom };
            }),
          );
          for (let n = 1; n < sections.length; n++)
            expect(
              sections[n].top,
              'Notes controls must not overlap at any viewport',
            ).toBeGreaterThanOrEqual(sections[n - 1].bottom - 1);
          await notesEditor.evaluate((editor) => {
            editor.scrollTop = 0;
          });
          const preview = notesEditor.locator('header button[aria-pressed]');
          await openDocumentMenu(ownerPage);
          await expect(preview).toBeVisible();
          await preview.evaluate((element) => (element as HTMLElement).click());
          await expect(notesEditor.locator('.shared-notes-preview')).toBeVisible();
          await openDocumentMenu(ownerPage);
          await expect(preview).toBeVisible();
          await preview.evaluate((element) => (element as HTMLElement).click());
          await expect(notesEditor.locator('.tiptap')).toBeVisible();
          await notesEditor.evaluate((editor) => {
            editor.scrollTop = 0;
          });
        }
        if (viewport.width === 1440 || viewport.width === 320)
          await ownerPage.screenshot({
            path: `test-results/review-${theme}-${viewport.width}.png`,
          });
      }
      await setAppLanguage(ownerPage, 'en');
    }
  } finally {
    await Promise.race([
      Promise.allSettled(contexts.map((c) => c.close())),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
  }
});
