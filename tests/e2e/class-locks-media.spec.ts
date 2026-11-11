import { test, expect } from './owned-browser';
import type { Page } from './owned-browser';
import { unlockedPolicy } from '../../apps/api/src/classroom-lock-policy';
type Probe = typeof import('../../apps/web/src/__media-probe');

test('class-wide locks revoke real SFU publishers without a classroom UI socket and restore only fresh grants', async ({
  browser,
}) => {
  test.setTimeout(90000);
  const origin = process.env.TEST_APP_ORIGIN!,
    teacher = await browser.newContext(),
    learner = await browser.newContext(),
    pages: Page[] = [];
  const post = async (ctx: typeof teacher, path: string, data: unknown) => {
    const r = await ctx.request.post('/api/v1' + path, { headers: { origin }, data });
    expect(r.ok(), await r.text()).toBe(true);
    return r.json();
  };
  try {
    const people = [];
    for (const [i, ctx] of [teacher, learner].entries()) {
      const email = crypto.randomUUID() + '@class-lock-rtp.test';
      const user = await post(ctx, '/auth/register', {
        email,
        password: '123456',
        name: 'Publisher ' + i,
      });
      await post(ctx, '/auth/login', { email, password: '123456' });
      people.push({ ...user, email });
    }
    const org = await post(teacher, '/organizations', { name: 'Actual class locks' });
    await post(teacher, '/organizations/' + org.id + '/members', {
      email: people[1].email,
      role: 'student',
    });
    const room = await post(teacher, '/organizations/' + org.id + '/classrooms', {
        name: 'Direct SDK publishers',
        enrollmentMode: 'organization',
      }),
      base = '/classrooms/' + room.id;
    await post(teacher, base + '/session/start', {});
    let originalToken = '';
    for (const ctx of [teacher, learner]) {
      const join = await post(ctx, base + '/join', {});
      if (ctx === learner) originalToken = join.token;
      const page = await ctx.newPage();
      pages.push(page);
      await page.goto('/media-probe.html');
      await page.waitForFunction(() => !!(window as unknown as { mediaProbe: Probe }).mediaProbe);
      await page.evaluate(async (join) => {
        const probe = (window as unknown as { mediaProbe: Probe }).mediaProbe;
        await probe.connect(join.url, join.token);
        await probe.publish();
      }, join);
    }
    await expect
      .poll(
        () =>
          pages[0].evaluate(async () => {
            const stats = await (window as unknown as { mediaProbe: Probe }).mediaProbe.stats();
            return stats.audioBytes > 0 && stats.videoBytes > 0 && stats.frames > 0;
          }),
        { timeout: 20000 },
      )
      .toBe(true);
    const locks = { ...unlockedPolicy, microphone: true, camera: true, screenShare: true };
    await post(teacher, base + '/locks', { locks, expectedRevision: 0 });
    await expect
      .poll(
        () =>
          pages[1].evaluate(
            () => (window as unknown as { mediaProbe: Probe }).mediaProbe.permissions()?.canPublish,
          ),
        { timeout: 12000 },
      )
      .toBe(false);
    expect(
      await pages[1].evaluate(() =>
        (window as unknown as { mediaProbe: Probe }).mediaProbe.attemptForbiddenPublish(),
      ),
    ).toBe(true);
    expect(
      (
        await learner.request.get(
          '/api/v1/media/signal/rtc/validate?access_token=' + encodeURIComponent(originalToken),
        )
      ).status(),
    ).toBe(403);
    const denied = await post(learner, base + '/join', {});
    expect(denied.policy.microphone).toBe(false);
    expect(denied.policy.camera).toBe(false);
    await post(teacher, base + '/locks', { locks: unlockedPolicy, expectedRevision: 1 });
    await expect
      .poll(
        () =>
          pages[1].evaluate(
            () => (window as unknown as { mediaProbe: Probe }).mediaProbe.permissions()?.canPublish,
          ),
        { timeout: 12000 },
      )
      .toBe(true);
    const fresh = await post(learner, base + '/join', {});
    expect(fresh.policy.microphone).toBe(true);
    expect(fresh.policy.camera).toBe(true);
    await post(teacher, base + '/session/end', {});
    for (const page of pages)
      await expect
        .poll(
          () =>
            page.evaluate(() => (window as unknown as { mediaProbe: Probe }).mediaProbe.state()),
          { timeout: 12000 },
        )
        .toBe('disconnected');
  } finally {
    await Promise.race([
      Promise.allSettled([teacher.close(), learner.close()]),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
  }
});
