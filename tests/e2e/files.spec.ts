import { setAppLanguage } from './classroom-actions';
import { test, expect, type BrowserContext } from './owned-browser';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { testPng } from '../file-fixtures';

test.use({ actionTimeout: 10000 });

test('real file workflows: two users, previews, download, folders, copy, persistence and Persian mobile', async ({
  browser,
}) => {
  test.setTimeout(60000);
  const owner = await browser.newContext(),
    student = await browser.newContext(),
    origin = process.env.TEST_APP_ORIGIN ?? 'http://localhost:5173',
    suffix = randomUUID() + '@files-browser.test';
  const post = async (context: BrowserContext, path: string, data: unknown) => {
    const r = await context.request.post(origin + '/api/v1' + path, {
      headers: { Origin: origin },
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  try {
    for (const [i, context] of [owner, student].entries()) {
      await context.addInitScript(() => {
        if (window === window.top) localStorage.setItem('language', 'en');
      });
      const credentials = { email: i + suffix, password: 'browser-file-test-password' };
      await post(context, '/auth/register', { ...credentials, name: i ? 'Learner' : 'Instructor' });
      await post(context, '/auth/login', credentials);
    }
    const org = await post(owner, '/organizations', { name: 'Resource studio' });
    await post(owner, '/organizations/' + org.id + '/members', {
      email: '1' + suffix,
      role: 'student',
    });
    const room = await post(owner, '/organizations/' + org.id + '/classrooms', {
      enrollmentMode: 'organization',
      name: 'Learning resources',
    });
    const teacher = await owner.newPage(),
      learner = await student.newPage();
    teacher.on('dialog', (dialog) => void dialog.accept());
    for (const page of [teacher, learner]) {
      await page.goto('/#classroom/' + room.id);
      await page.getByRole('button', { name: 'Apps', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Files', exact: true }).click();
    }
    await expect(learner.getByLabel('Choose a file', { exact: true })).toHaveCount(0);
    const contents = Buffer.from('Workshop notes — یادداشت کارگاه\nBring your questions.');
    await teacher
      .getByLabel('Choose a file', { exact: true })
      .setInputFiles({ name: 'یادداشت.txt', mimeType: 'text/plain', buffer: contents });
    const resource = learner.locator('.file-row').filter({ hasText: 'یادداشت.txt' });
    await expect(resource).toBeVisible();
    await expect(resource).toContainText('Not scanned · development mode');
    await resource.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(learner.locator('dialog[open] pre')).toHaveText(contents.toString());
    await learner.getByRole('button', { name: 'Close preview', exact: true }).click();
    await expect(resource.getByRole('button', { name: 'Preview', exact: true })).toBeFocused();
    const download = learner.waitForEvent('download');
    await resource.getByRole('button', { name: 'Download', exact: true }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe('یادداشت.txt');
    const path = test.info().outputPath('downloaded-notes.txt');
    await saved.saveAs(path);
    expect(await readFile(path)).toEqual(contents);
    await teacher.getByText('New folder', { exact: true }).click();
    await teacher.getByLabel('Folder name', { exact: true }).fill('Workshop resources');
    await teacher.getByRole('button', { name: 'Create', exact: true }).click();
    const original = teacher.locator('.file-row').filter({ hasText: 'یادداشت.txt' });
    await original.getByText('File options', { exact: true }).click();
    await original.getByRole('button', { name: 'Rename or move', exact: true }).click();
    await teacher.getByLabel('File name', { exact: true }).fill('Session guide.txt');
    await teacher
      .getByRole('combobox', { name: 'Move to folder', exact: true })
      .selectOption({ label: 'Workshop resources' });
    await teacher.getByRole('button', { name: 'Save changes', exact: true }).click();
    for (const page of [teacher, learner]) {
      await page
        .locator('.file-folder')
        .getByRole('button', { name: 'Workshop resources', exact: true })
        .click();
      await expect(page.locator('.file-row')).toContainText('Session guide.txt');
    }
    const source = teacher.locator('.file-row').first();
    await source.getByText('File options', { exact: true }).click();
    await source.getByRole('button', { name: 'Create a copy', exact: true }).click();
    await expect(teacher.locator('.file-row')).toHaveCount(2);
    await expect(learner.locator('.file-row')).toHaveCount(2);
    const remove = teacher.locator('.file-row').last();
    if (!(await remove.locator('details').evaluate((details: HTMLDetailsElement) => details.open)))
      await remove.getByText('File options', { exact: true }).click();
    await remove.getByRole('button', { name: 'Delete file', exact: true }).click();
    await expect(learner.locator('.file-row')).toHaveCount(1);
    await expect(teacher.locator('.file-row')).toHaveCount(1, { timeout: 15000 });
    await teacher
      .getByLabel('Choose a file', { exact: true })
      .setInputFiles({ name: 'Workshop mark.png', mimeType: 'image/png', buffer: testPng() });
    await expect(
      learner.locator('.file-row').filter({ hasText: 'Workshop mark.png' }),
    ).toBeVisible();
    await learner
      .locator('.file-row')
      .filter({ hasText: 'Workshop mark.png' })
      .getByRole('button', { name: 'Preview', exact: true })
      .click();
    await expect
      .poll(() =>
        learner
          .locator('dialog[open] img')
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBe(1);
    await learner.getByRole('button', { name: 'Close preview', exact: true }).click();
    await teacher.screenshot({ path: 'docs/screenshots/files-en.png', fullPage: true });
    await learner.reload();
    await learner.getByRole('button', { name: 'Apps', exact: true }).click();
    await learner.getByRole('menuitem', { name: 'Files', exact: true }).click();
    await learner
      .locator('.file-folder')
      .getByRole('button', { name: 'Workshop resources', exact: true })
      .click();
    await expect(learner.locator('.file-row')).toHaveCount(2);
    await setAppLanguage(teacher, 'fa');
    await teacher.setViewportSize({ width: 390, height: 844 });
    await expect(teacher.locator('html')).toHaveAttribute('dir', 'rtl');
    await teacher.getByRole('button', { name: 'فعالیت‌ها', exact: true }).click();
    await teacher.getByRole('menuitem', { name: 'فایل‌ها', exact: true }).click();
    await expect(
      teacher
        .getByRole('region', { name: 'فایل‌ها' })
        .getByRole('heading', { name: 'فایل‌ها', exact: true }),
    ).toBeVisible();
    expect(
      await teacher.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
    await teacher.screenshot({ path: 'docs/screenshots/files-mobile-fa.png', fullPage: true });
    await teacher.locator('.classroom-leave').click();
    await teacher.getByRole('button', { name: 'فایل‌ها', exact: true }).click();
    await expect(teacher.locator('.file-row')).toHaveCount(0);
    await teacher.getByLabel('انتخاب فایل', { exact: true }).setInputFiles({
      name: 'Organization policy.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('Organization-wide resources.'),
    });
    await expect(teacher.locator('.file-row')).toContainText('Organization policy.txt');
  } finally {
    await Promise.all([owner.close(), student.close()]);
  }
});
