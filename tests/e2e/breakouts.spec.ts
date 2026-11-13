import { setAppLanguage } from './classroom-actions';
import { test, expect } from './owned-browser';
import { randomUUID } from 'node:crypto';

test('self-selected group room, refresh and Persian mobile management', async ({ browser }) => {
  const owner = await browser.newContext(),
    student = await browser.newContext();
  const origin = process.env.TEST_APP_ORIGIN ?? 'http://localhost:5173',
    suffix = randomUUID() + '@groups-ui.test';
  const post = async (ctx: typeof owner, path: string, data: unknown) => {
    const r = await ctx.request.post(origin + '/api/v1' + path, {
      headers: { Origin: origin },
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  try {
    for (const [i, ctx] of [owner, student].entries()) {
      await ctx.addInitScript(() => {
        if (window === window.top) localStorage.setItem('language', 'en');
      });
      const credentials = { email: i + suffix, password: 'group-browser-test-password' };
      await post(ctx, '/auth/register', { ...credentials, name: i ? 'Learner' : 'Teacher' });
      await post(ctx, '/auth/login', credentials);
    }
    const org = await post(owner, '/organizations', { name: 'Group learning' });
    await post(owner, '/organizations/' + org.id + '/members', {
      email: '1' + suffix,
      role: 'student',
    });
    const room = await post(owner, '/organizations/' + org.id + '/classrooms', {
      enrollmentMode: 'organization',
      name: 'Workshop',
    });
    await post(owner, '/classrooms/' + room.id + '/session/start', {});
    await post(owner, '/classrooms/' + room.id + '/breakouts', {
      rooms: [{ name: 'گروه پژوهش' }, { name: 'گروه گفتگو' }],
      durationSeconds: 900,
      allowSelfSelect: true,
      allocation: { mode: 'manual', assignments: [] },
    });
    const teacher = await owner.newPage(),
      learner = await student.newPage();
    for (const p of [teacher, learner]) {
      await p.goto('/#classroom/' + room.id);
      await p.getByRole('button', { name: 'Apps', exact: true }).click();
      await p.getByRole('menuitem', { name: 'Breakout rooms', exact: true }).click();
    }
    await learner
      .locator('.breakout-room')
      .filter({ hasText: 'گروه پژوهش' })
      .getByRole('button', { name: 'Enter room', exact: true })
      .click();
    await expect(
      learner.getByRole('heading', { name: 'گروه پژوهش', exact: true, level: 1 }),
    ).toBeVisible();
    const childUrl = learner.url();
    expect(childUrl).not.toContain(room.id);
    await learner.reload();
    expect(learner.url()).toBe(childUrl);
    await expect(
      learner.getByRole('heading', { name: 'گروه پژوهش', exact: true, level: 1 }),
    ).toBeVisible();
    await learner.getByRole('button', { name: 'Return to main classroom', exact: true }).click();
    await expect(learner.getByRole('heading', { name: 'Workshop', exact: true })).toBeVisible();
    const returned = await (
      await student.request.get(origin + '/api/v1/classrooms/' + room.id + '/breakouts')
    ).json();
    expect(returned.destination.id).toBe(room.id);
    await setAppLanguage(teacher, 'fa');
    await teacher.setViewportSize({ width: 390, height: 844 });
    await expect(teacher.locator('html')).toHaveAttribute('dir', 'rtl');
    await teacher.getByRole('button', { name: 'فعالیت‌ها', exact: true }).click();
    await teacher.getByRole('menuitem', { name: 'اتاق‌های گروهی', exact: true }).click();
    await expect(
      teacher.getByRole('heading', { name: 'کار گروهی در حال انجام', exact: true }),
    ).toBeVisible();
    expect(
      await teacher.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBeTruthy();
    await teacher.screenshot({ path: 'docs/screenshots/breakouts-mobile-fa.png', fullPage: true });
    await teacher.getByRole('button', { name: 'بستن اتاق‌های گروهی', exact: true }).click();
    await expect(
      teacher.getByRole('heading', { name: 'کار گروهی پایان‌یافته', exact: true }),
    ).toBeVisible();
  } finally {
    await Promise.all([owner.close(), student.close()]);
  }
});
