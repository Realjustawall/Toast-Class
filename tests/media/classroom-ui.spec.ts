import { setAppLanguage, chooseMicrophone } from '../e2e/classroom-actions';
import { test, expect } from './browser-fixtures';
import { randomUUID } from 'node:crypto';

// Only display-capture workflows need Chromium's fake browser-tab source.
test.use({
  launchOptions: {
    args: [
      '--autoplay-policy=no-user-gesture-required',
      '--use-fake-device-for-media-stream=display-media-type=browser',
      '--use-fake-ui-for-media-stream',
      '--enable-usermedia-screen-capturing',
    ],
  },
});
test('classroom media UI transmits browser test devices and localizes controls', async ({
  classroomBrowsers,
}) => {
  const a = await classroomBrowsers[0].newContext({ permissions: ['camera', 'microphone'] }),
    b = await classroomBrowsers[1].newContext({ permissions: ['camera', 'microphone'] });
  const origin = process.env.TEST_APP_ORIGIN ?? 'http://localhost:5173';
  const suffix = randomUUID() + '@devices.test';
  const post = async (ctx: typeof a, path: string, data: unknown) => {
    const response = await ctx.request.post(origin + '/api/v1' + path, {
      headers: { Origin: origin },
      data,
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    return response.json();
  };
  try {
    for (const [index, ctx] of [a, b].entries()) {
      await ctx.addInitScript(() => {
        if (window === window.top) localStorage.setItem('language', 'en');
      });
      await post(ctx, '/auth/register', {
        email: index + suffix,
        name: index ? 'UI learner' : 'UI instructor',
        password: 'browser-devices-test-password',
      });
      await post(ctx, '/auth/login', {
        email: index + suffix,
        password: 'browser-devices-test-password',
      });
    }
    const org = await post(a, '/organizations', { name: 'Browser devices' });
    await post(a, '/organizations/' + org.id + '/members', {
      email: '1' + suffix,
      role: 'student',
    });
    const room = await post(a, '/organizations/' + org.id + '/classrooms', {
      enrollmentMode: 'organization',
      name: 'Camera and audio classroom',
    });
    const teacher = await a.newPage(),
      student = await b.newPage();
    for (const p of [teacher, student]) {
      p.on('pageerror', (e) => console.error('Media UI browser error:', e.message));
      await p.goto('/');
      await p.getByRole('button', { name: 'Enter classroom', exact: true }).click();
    }
    await teacher.getByRole('button', { name: 'Start session', exact: true }).click();
    for (const p of [teacher, student]) {
      await p.getByRole('button', { name: 'Connect audio & video', exact: true }).click();
      await chooseMicrophone(p);
      await expect(p.getByRole('button', { name: 'Camera', exact: true })).toBeEnabled({
        timeout: 20000,
      });
    }
    await teacher.getByRole('button', { name: 'Camera', exact: true }).click();
    await expect(teacher.getByRole('button', { name: 'Camera', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(teacher.getByRole('button', { name: 'Microphone', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(teacher.getByRole('button', { name: 'Camera', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const remote = student
      .locator('.media-tile')
      .filter({ hasText: 'UI instructor' })
      .locator('video');
    try {
      await expect
        .poll(
          () => remote.evaluate((v: HTMLVideoElement) => v.videoWidth > 0 && v.readyState >= 2),
          { timeout: 15000 },
        )
        .toBeTruthy();
    } catch (e) {
      for (const [index, p] of [teacher, student].entries()) {
        console.log(
          'Media UI debug',
          index,
          await p.locator('video').evaluateAll((vs) =>
            vs.map((element) => {
              const v = element as HTMLVideoElement;
              return {
                width: v.videoWidth,
                ready: v.readyState,
                visibility: getComputedStyle(v).visibility,
                tracks: (v.srcObject as MediaStream | null)
                  ?.getTracks()
                  .map((t) => ({ kind: t.kind, enabled: t.enabled, state: t.readyState })),
              };
            }),
          ),
        );
        console.log('UI alert', await p.getByRole('alert').allTextContents());
        await p.screenshot({
          path: 'test-results/media-ui-debug-' + index + '.png',
          fullPage: true,
        });
      }
      console.log(
        'SFU participants',
        (await a.request.get(origin + '/api/v1/classrooms/' + room.id + '/participants')).status(),
        await (
          await a.request.get(origin + '/api/v1/classrooms/' + room.id + '/participants')
        ).json(),
      );
      throw e;
    }
    await student.getByRole('button', { name: 'Focus UI instructor', exact: true }).click();
    await expect(student.locator('.media-tile')).toHaveCount(1);
    await student.getByRole('button', { name: 'Grid view', exact: true }).click();
    await expect(student.locator('.media-tile')).toHaveCount(2);
    await student.getByRole('button', { name: 'Auto layout', exact: true }).click();
    await teacher.getByRole('button', { name: 'Share screen', exact: true }).click();
    const screen = student
      .locator('.media-tile')
      .filter({ hasText: 'Sharing screen' })
      .locator('video');
    await expect
      .poll(() => screen.evaluate((v: HTMLVideoElement) => v.videoWidth > 0 && v.readyState >= 2), {
        timeout: 15000,
      })
      .toBeTruthy();
    await teacher.getByRole('button', { name: 'Share screen', exact: true }).click();
    await expect(student.locator('.media-tile').filter({ hasText: 'Sharing screen' })).toHaveCount(
      0,
    );
    await teacher.getByText('Media devices', { exact: true }).click();
    await expect(teacher.getByLabel('Camera', { exact: true })).toBeVisible();
    await setAppLanguage(teacher, 'fa');
    await expect(teacher.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(teacher.getByRole('button', { name: 'دوربین', exact: true })).toBeVisible();
    await teacher.screenshot({ path: 'docs/screenshots/classroom-media-fa.png', fullPage: true });
    await setAppLanguage(teacher, 'en');
    await teacher.getByRole('button', { name: 'End session', exact: true }).click();
    for (const p of [teacher, student])
      await expect(p.locator('.toaster-media-room')).toHaveCount(0, { timeout: 10000 });
  } finally {
    for (const context of [a, b])
      for (const page of context.pages()) {
        const button = page.getByRole('button', { name: /Disconnect audio/ });
        if (await button.count())
          await button
            .first()
            .click({ timeout: 3000 })
            .catch(() => {});
      }
    await a.close();
    await b.close();
  }
});
