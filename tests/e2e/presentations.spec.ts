import { setAppLanguage } from './classroom-actions';
import { test, expect, type BrowserContext } from './owned-browser';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { testPdf, testDocx } from '../document-fixtures';

test.use({ actionTimeout: 10000 });
test('real converter and two-user presentation: pages, independent viewing, reload, downloads and Persian mobile', async ({
  browser,
}) => {
  test.skip(
    process.env.TEST_CONVERSION_DOCKER !== 'true',
    'Requires the actual isolated converter image and worker',
  );
  test.setTimeout(90000);
  const owner = await browser.newContext(),
    student = await browser.newContext(),
    origin = process.env.TEST_APP_ORIGIN ?? 'http://localhost:5173',
    suffix = randomUUID() + '@presentation-browser.test';
  const post = async (context: BrowserContext, path: string, data: unknown) => {
    const response = await context.request.post(origin + '/api/v1' + path, {
      headers: { Origin: origin },
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  try {
    for (const [index, context] of [owner, student].entries()) {
      await context.addInitScript(() => {
        if (window === window.top) localStorage.setItem('language', 'en');
      });
      const credentials = { email: index + suffix, password: 'presentation-browser-password' };
      await post(context, '/auth/register', {
        ...credentials,
        name: index ? 'Learner' : 'Educator',
      });
      await post(context, '/auth/login', credentials);
    }
    const org = await post(owner, '/organizations', { name: 'Document studio' });
    await post(owner, '/organizations/' + org.id + '/members', {
      email: '1' + suffix,
      role: 'student',
    });
    const room = await post(owner, '/organizations/' + org.id + '/classrooms', {
      enrollmentMode: 'organization',
      name: 'Shared reading',
    });
    await post(owner, '/classrooms/' + room.id + '/session/start', {});
    const teacher = await owner.newPage(),
      learner = await student.newPage();
    teacher.on('dialog', (dialog) => void dialog.accept());
    await teacher.goto('/#classroom/' + room.id);
    await learner.goto('/#classroom/' + room.id);
    await teacher.getByRole('button', { name: 'Apps', exact: true }).click();
    await teacher.getByRole('menuitem', { name: 'Files', exact: true }).click();
    const original = testPdf(2);
    await teacher
      .getByLabel('Choose a file', { exact: true })
      .setInputFiles({ name: 'Reading.pdf', mimeType: 'application/pdf', buffer: original });
    const resource = teacher.locator('.file-row').filter({ hasText: 'Reading.pdf' });
    await expect(resource).toBeVisible();
    await resource.getByRole('button', { name: 'Prepare presentation', exact: true }).click();
    const prepared = teacher
      .locator('.presentation-library-list article')
      .filter({ hasText: 'Reading.pdf' });
    await expect(prepared).toContainText('Ready to present', { timeout: 45000 });
    await prepared.getByRole('button', { name: 'Present document', exact: true }).click();
    const learnerPresentations = learner.getByRole('button', {
      name: 'Presentations',
      exact: true,
    });
    if (await learnerPresentations.isEnabled()) await learnerPresentations.click();
    await expect(learner.getByAltText('Presentation page 1 of 2', { exact: true })).toBeVisible();
    await expect
      .poll(() =>
        learner
          .getByAltText('Presentation page 1 of 2', { exact: true })
          .evaluate((img: HTMLImageElement) => img.naturalWidth),
      )
      .toBe(1600);
    await expect
      .poll(() =>
        teacher.locator('.presentation-slide-scroll').evaluate((element) => {
          const image = element.querySelector('img')!;
          return (
            image.clientHeight <= element.clientHeight + 1 &&
            image.clientWidth <= element.clientWidth + 1
          );
        }),
      )
      .toBeTruthy();
    await teacher.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(learner.getByAltText('Presentation page 2 of 2', { exact: true })).toBeVisible();
    await learner.reload();
    await learner.getByRole('button', { name: 'Presentations', exact: true }).click();
    await expect(learner.getByAltText('Presentation page 2 of 2', { exact: true })).toBeVisible();
    await expect(learner.getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
    await teacher.getByLabel('Allow students to browse independently', { exact: true }).check();
    await learner.getByLabel('Follow presenter', { exact: true }).uncheck();
    await learner.getByRole('button', { name: 'Previous page', exact: true }).click();
    await expect(learner.getByAltText('Presentation page 1 of 2', { exact: true })).toBeVisible();
    await expect(teacher.getByAltText('Presentation page 2 of 2', { exact: true })).toBeVisible();
    await teacher.getByLabel('Allow students to browse independently', { exact: true }).uncheck();
    await expect(learner.getByAltText('Presentation page 2 of 2', { exact: true })).toBeVisible();
    const downloaded = learner.waitForEvent('download');
    await learner.getByRole('link', { name: 'Download original', exact: true }).click();
    const saved = await downloaded;
    const originalPath = test.info().outputPath('original.pdf');
    await saved.saveAs(originalPath);
    expect(await readFile(originalPath)).toEqual(original);
    await teacher.screenshot({ path: 'docs/screenshots/presentations-en.png', fullPage: true });
    await setAppLanguage(learner, 'fa');
    await learner.setViewportSize({ width: 390, height: 844 });
    await expect(learner.locator('html')).toHaveAttribute('dir', 'rtl');
    expect(
      await learner.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
    await learner.screenshot({
      path: 'docs/screenshots/presentations-mobile-fa.png',
      fullPage: true,
    });
    await teacher.getByRole('button', { name: 'Stop presenting', exact: true }).click();
    await expect(
      learner.getByRole('heading', { name: 'نمای مشترک درس شما', exact: true }),
    ).toBeVisible();
    await teacher.getByRole('button', { name: 'Files', exact: true }).click();
    await teacher.getByLabel('Choose a file', { exact: true }).setInputFiles({
      name: 'Workshop.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: await testDocx(),
    });
    await teacher
      .locator('.file-row')
      .filter({ hasText: 'Workshop.docx' })
      .getByRole('button', { name: 'Prepare presentation', exact: true })
      .click();
    const office = teacher
      .locator('.presentation-library-list article')
      .filter({ hasText: 'Workshop.docx' });
    await expect(office).toContainText('Ready to present', { timeout: 45000 });
    await office.getByRole('button', { name: 'Present document', exact: true }).click();
    await expect(learner.getByAltText('صفحهٔ ۱ از ۱ ارائه', { exact: true })).toBeVisible();
  } finally {
    await Promise.all([owner.close(), student.close()]);
  }
});
