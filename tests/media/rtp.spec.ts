import { test, expect } from './browser-fixtures';

import { randomUUID } from 'node:crypto';
type Probe = typeof import('../../apps/web/src/__media-probe');
declare global {
  interface Window {
    mediaProbe: Probe;
  }
}
test('real SFU: two independent browsers publish and receive RTP, replace and mute tracks', async ({
  classroomBrowsers,
}) => {
  const url = process.env.TEST_MEDIA_URL,
    key = process.env.TEST_MEDIA_KEY,
    secret = process.env.TEST_MEDIA_SECRET;
  if (!url || !key || !secret)
    throw new Error(
      'Set TEST_MEDIA_URL, TEST_MEDIA_KEY and TEST_MEDIA_SECRET to a running self-hosted SFU',
    );
  const a = await classroomBrowsers[0].newContext(),
    b = await classroomBrowsers[1].newContext(),
    moderator = await classroomBrowsers[2].newContext();
  try {
    const origin = process.env.TEST_APP_ORIGIN ?? 'http://localhost:5173';
    const post = async (ctx: typeof a, path: string, data: unknown) => {
      const r = await ctx.request.post(origin + '/api/v1' + path, {
        headers: { Origin: origin },
        data,
      });
      expect(r.ok(), await r.text()).toBeTruthy();
      return r.json();
    };
    const accounts: { id: string }[] = [];
    const joins: { url: string; token: string }[] = [];
    const suffix = randomUUID() + '@media.test';
    for (const [i, ctx] of [a, b].entries()) {
      const email = i + suffix;
      await post(ctx, '/auth/register', {
        email,
        password: 'synthetic-media-test-password',
        name: 'Publisher ' + i,
      });
      accounts.push(
        await post(ctx, '/auth/login', { email, password: 'synthetic-media-test-password' }),
      );
    }
    const org = await post(a, '/organizations', { name: 'RTP test organization' });
    await post(a, '/organizations/' + org.id + '/members', {
      email: '1' + suffix,
      role: 'student',
    });
    const room = await post(a, '/organizations/' + org.id + '/classrooms', {
      enrollmentMode: 'organization',
      name: 'RTP classroom',
    });
    await post(a, '/classrooms/' + room.id + '/session/start', {});
    const pages = [await a.newPage(), await b.newPage()];
    for (const [i, p] of pages.entries()) {
      const join = await post(i ? b : a, '/classrooms/' + room.id + '/join', {});
      joins.push(join);
      await p.goto('/media-probe.html');
      await expect(p).toHaveTitle('TOASTER media integration probe');
      await p.waitForFunction(() => !!window.mediaProbe);
      expect(
        await p.evaluate(async ({ url, token }) => window.mediaProbe.connect(url, token), {
          url: join.url,
          token: join.token,
        }),
      ).toBe('connected');
      await p.evaluate(() => window.mediaProbe.publish());
    }
    for (const p of pages) {
      await expect
        .poll(() => p.evaluate(() => window.mediaProbe.stats()), { timeout: 20000 })
        .toMatchObject({ participants: 1, tracks: 2 });
      await expect
        .poll(
          async () => {
            const s = await p.evaluate(() => window.mediaProbe.stats());
            return s.audioBytes > 0 && s.videoBytes > 0 && s.frames > 0;
          },
          { timeout: 20000 },
        )
        .toBeTruthy();
    }
    const before = await pages[1].evaluate(() => window.mediaProbe.stats());
    await pages[0].evaluate(() => window.mediaProbe.replaceVideo());
    await expect
      .poll(async () => (await pages[1].evaluate(() => window.mediaProbe.stats())).frames, {
        timeout: 10000,
      })
      .toBeGreaterThan(before.frames);
    expect(await pages[0].evaluate(() => window.mediaProbe.mute())).toBeTruthy();
    expect(await pages[0].evaluate(() => window.mediaProbe.unmute())).toBeFalsy();
    console.log(
      'Measured received RTP stats:',
      JSON.stringify(
        await Promise.all(pages.map((p) => p.evaluate(() => window.mediaProbe.stats()))),
      ),
    );
    // A server-side permission change must affect an already connected publisher.
    await moderator.addCookies(await a.cookies());
    await moderator.addInitScript(() => {
      if (window === window.top) localStorage.setItem('language', 'en');
    });
    const moderatorPage = await moderator.newPage();
    await moderatorPage.goto('/');
    await moderatorPage.getByRole('button', { name: 'Enter classroom', exact: true }).click();
    const peopleButton = moderatorPage.getByRole('button', { name: 'Participants', exact: true });
    await expect(peopleButton).toBeVisible();
    if ((await peopleButton.getAttribute('aria-pressed')) !== 'true') await peopleButton.click();
    await expect(moderatorPage.locator('.classroom-people-panel')).toBeVisible();
    await moderatorPage.getByText('Audio and video permissions', { exact: true }).click();
    await expect(moderatorPage.locator('.moderation-list')).toContainText('Publisher 1');

    await moderatorPage
      .getByRole('button', { name: 'Disable microphone permission', exact: true })
      .click();
    await moderatorPage
      .getByRole('button', { name: 'Disable camera permission', exact: true })
      .click();
    await moderatorPage
      .getByRole('button', { name: 'Disable screen sharing', exact: true })
      .click();
    await moderatorPage.screenshot({
      path: 'docs/screenshots/media-moderation-en.png',
      fullPage: true,
    });
    await expect
      .poll(() => pages[1].evaluate(() => window.mediaProbe.permissions()?.canPublish), {
        timeout: 10000,
      })
      .toBe(false);
    expect(await pages[1].evaluate(() => window.mediaProbe.attemptForbiddenPublish())).toBeTruthy();
    const stalePath =
      origin +
      '/api/v1/media/signal/rtc/validate?access_token=' +
      encodeURIComponent(joins[1].token);
    expect((await b.request.get(stalePath)).status()).toBe(403);
    expect((await a.request.get(stalePath)).status()).toBe(403);
    const restricted = await post(b, '/classrooms/' + room.id + '/join', {});
    const restrictedClaims = JSON.parse(
      Buffer.from(restricted.token.split('.')[1], 'base64url').toString(),
    );
    expect(restrictedClaims.video.canPublish).toBe(false);
    await moderatorPage.getByRole('button', { name: 'Block media access', exact: true }).click();
    await expect
      .poll(() => pages[1].evaluate(() => window.mediaProbe.state()), { timeout: 10000 })
      .toBe('disconnected');
    expect(
      (
        await b.request.post(origin + '/api/v1/classrooms/' + room.id + '/join', {
          headers: { Origin: origin },
          data: {},
        })
      ).status(),
    ).toBe(403);
    const restoreCommitted = moderatorPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/participants/' + accounts[1].id + '/permissions'),
    );
    await moderatorPage.getByRole('button', { name: 'Restore media access', exact: true }).click();
    expect((await restoreCommitted).ok()).toBe(true);
    const fresh = await post(b, '/classrooms/' + room.id + '/join', {});
    expect(
      await pages[1].evaluate(({ url, token }) => window.mediaProbe.connect(url, token), fresh),
    ).toBe('connected');
    await pages[1].evaluate(() => window.mediaProbe.publish());
    // Ending the session disconnects media and rejects old tokens before their TTL expires.
    await moderatorPage.getByRole('button', { name: 'End session', exact: true }).click();
    for (const p of pages)
      await expect
        .poll(() => p.evaluate(() => window.mediaProbe.state()), { timeout: 10000 })
        .toBe('disconnected');
    expect(
      (
        await b.request.get(
          origin +
            '/api/v1/media/signal/rtc/validate?access_token=' +
            encodeURIComponent(fresh.token),
        )
      ).status(),
    ).toBe(403);
    expect(
      (
        await a.request.post(origin + '/api/v1/classrooms/' + room.id + '/join', {
          headers: { Origin: origin },
          data: {},
        })
      ).status(),
    ).toBe(409);
    for (const p of pages)
      expect(await p.evaluate(() => window.mediaProbe.disconnect())).toBe('disconnected');

    if (process.env.TEST_MEDIA_WEBHOOKS === 'true') {
      await expect
        .poll(
          async () => {
            const r = await a.request.get(origin + '/api/v1/classrooms/' + room.id + '/attendance');
            const data = await r.json();
            return data.participants.length;
          },
          { timeout: 15000 },
        )
        .toBe(2);
      await expect
        .poll(
          async () => {
            const r = await a.request.get(origin + '/api/v1/classrooms/' + room.id + '/attendance');
            const data = await r.json();
            return data.participants.every(
              (p: { totalDurationMs: number; connections: { left_at: string | null }[] }) =>
                p.totalDurationMs > 0 && p.connections.every((c) => c.left_at),
            );
          },
          { timeout: 15000 },
        )
        .toBeTruthy();
      await a.addInitScript(() => {
        if (window === window.top) localStorage.setItem('language', 'en');
      });
      const reportPage = await a.newPage();
      await reportPage.goto('/');
      await reportPage.getByRole('button', { name: 'Enter classroom', exact: true }).click();
      await reportPage.getByRole('button', { name: 'Attendance', exact: true }).click();
      await expect(reportPage.getByRole('row')).toHaveCount(3);
      await expect(reportPage.getByRole('table')).toContainText('Publisher 0');
      await expect(reportPage.getByRole('table')).toContainText('Publisher 1');
      const downloaded = reportPage.waitForEvent('download');
      await reportPage.getByRole('button', { name: 'Export CSV', exact: true }).click();
      expect((await downloaded).suggestedFilename()).toBe('attendance.csv');
      await reportPage.screenshot({ path: 'docs/screenshots/attendance-en.png', fullPage: true });
    }
  } finally {
    for (const context of [a, b])
      for (const page of context.pages())
        await page
          .evaluate(async () => {
            if (window.mediaProbe) await window.mediaProbe.disconnect();
          })
          .catch(() => {});
    await a.close();
    await b.close();
    await moderator.close();
  }
});
