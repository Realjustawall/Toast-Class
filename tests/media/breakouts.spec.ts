import { chooseMicrophone } from '../e2e/classroom-actions';
import type { Page } from '@playwright/test';
import { test, expect } from './browser-fixtures';
import { randomUUID } from 'node:crypto';

test('real SFU breakout isolation, teacher visits, room moves and automatic return', async ({
  classroomBrowsers,
}) => {
  // Includes a genuine 30-second server deadline and several media reconnections.
  test.setTimeout(180000);
  if (!process.env.TEST_MEDIA_URL || !process.env.TEST_MEDIA_KEY || !process.env.TEST_MEDIA_SECRET)
    throw new Error('Configure a running self-hosted SFU before media tests');
  const contexts = await Promise.all(
    classroomBrowsers.map((client) => client.newContext({ permissions: ['camera', 'microphone'] })),
  );
  const [owner, alpha, beta] = contexts;
  const origin = process.env.TEST_APP_ORIGIN ?? 'http://localhost:5173';
  const suffix = randomUUID() + '@breakouts.test';
  const uiPages: Page[] = [];
  const post = async (ctx: typeof owner, path: string, data: unknown) => {
    const r = await ctx.request.post(origin + '/api/v1' + path, {
      headers: { Origin: origin },
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  const get = async (ctx: typeof owner, path: string) => {
    const r = await ctx.request.get(origin + '/api/v1' + path);
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  };
  try {
    const accounts: { id: string }[] = [];
    for (const [i, ctx] of contexts.entries()) {
      await ctx.addInitScript(() => {
        if (window === window.top) localStorage.setItem('language', 'en');
      });
      if (process.env.TEST_MEDIA_CAPTURE_DIAGNOSTICS === 'true')
        await ctx.addInitScript(() => {
          const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
          navigator.mediaDevices.getUserMedia = async (constraints) => {
            console.log('test-capture:start', JSON.stringify(constraints));
            try {
              const stream = await original(constraints);
              console.log(
                'test-capture:success',
                JSON.stringify(
                  stream.getTracks().map((t) => ({ kind: t.kind, settings: t.getSettings() })),
                ),
              );
              for (const track of stream.getTracks())
                track.addEventListener('ended', () =>
                  console.log('test-capture:ended', track.kind),
                );
              return stream;
            } catch (e) {
              console.log('test-capture:failure', String(e));
              throw e;
            }
          };
        });
      const credentials = { email: i + suffix, password: 'breakout-media-browser-password' };
      await post(ctx, '/auth/register', {
        ...credentials,
        name: ['Instructor', 'Alpha learner', 'Beta learner'][i],
      });
      accounts.push(await post(ctx, '/auth/login', credentials));
    }
    const org = await post(owner, '/organizations', { name: 'Group workshop' });
    for (const i of [1, 2])
      await post(owner, '/organizations/' + org.id + '/members', {
        email: i + suffix,
        role: 'student',
      });
    const room = await post(owner, '/organizations/' + org.id + '/classrooms', {
      enrollmentMode: 'organization',
      name: 'Main workshop',
    });
    const base = '/classrooms/' + room.id;
    await post(owner, base + '/session/start', {});
    const [teacher, a, b] = await Promise.all(contexts.map((ctx) => ctx.newPage()));
    uiPages.push(teacher, a, b);
    for (const p of [teacher, a, b])
      p.on('pageerror', (e) => console.error('Breakout browser error:', e.message));
    for (const [index, p] of [teacher, a, b].entries())
      p.on('console', (message) => {
        if (message.text().startsWith('test-capture:'))
          console.log('Browser ' + index, message.text());
      });
    for (const p of [teacher, a, b]) await p.goto('/#classroom/' + room.id);
    await teacher.getByRole('button', { name: 'Apps', exact: true }).click();
    await teacher.getByRole('menuitem', { name: 'Breakout rooms', exact: true }).click();
    await teacher.getByLabel('Room name 1', { exact: true }).fill('Alpha room');
    await teacher.getByLabel('Room name 2', { exact: true }).fill('Beta room');
    await teacher.getByLabel('Assign student Alpha learner', { exact: true }).selectOption('0');
    await teacher.getByLabel('Assign student Beta learner', { exact: true }).selectOption('1');
    await teacher.getByRole('button', { name: 'Start group work', exact: true }).click();
    await expect(
      teacher.getByRole('heading', { name: 'Group work in progress', exact: true }),
    ).toBeVisible();
    const group = (await get(owner, base + '/breakouts')).groups[0];
    const [ra, rb] = group.rooms as { id: string; name: string }[];
    const doc = await post(owner, '/classrooms/' + ra.id + '/documents', {
      name: 'Alpha findings',
      kind: 'notes',
      teacherOnly: false,
    });
    for (const [index, p] of [a, b].entries()) {
      await p.getByRole('button', { name: 'Enter assigned room', exact: true }).click();
      await expect(
        p.getByRole('heading', { name: group.rooms[index].name, level: 1, exact: true }),
      ).toBeVisible();
      await p.getByRole('button', { name: 'Connect audio & video', exact: true }).click();
      await chooseMicrophone(p);
      await expect(p.getByRole('button', { name: 'Camera', exact: true })).toBeEnabled({
        timeout: 20000,
      });
      await p.getByRole('button', { name: 'Camera', exact: true }).click();
      await expect(p.getByRole('button', { name: 'Microphone', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
    // Inspect actual SFU participant lists as well as rendered tiles.
    for (const [id, user] of [
      [ra.id, accounts[1].id],
      [rb.id, accounts[2].id],
    ]) {
      await expect
        .poll(async () =>
          (await get(owner, '/classrooms/' + id + '/participants')).participants.map(
            (p: { identity: string }) => p.identity,
          ),
        )
        .toEqual([user]);
    }
    await expect(a.locator('.media-tile')).toHaveCount(1);
    await expect(b.locator('.media-tile')).toHaveCount(1);
    expect(
      (await beta.request.get(origin + '/api/v1/classrooms/' + ra.id + '/documents')).status(),
    ).toBe(403);
    await a.getByRole('button', { name: 'Documents', exact: true }).click();
    await a.getByRole('button', { name: 'Alpha findings', exact: true }).click();
    await a
      .getByRole('textbox', { name: 'Shared notes', exact: true })
      .fill('Alpha group result — نتیجهٔ گروه');
    await expect(a.getByText('Saved', { exact: true })).toBeVisible();
    // A refresh restores the authorized child route, without activating devices.
    await a.reload();
    await expect(a.getByRole('heading', { name: 'Alpha room', exact: true })).toBeVisible();
    await expect(a.getByRole('button', { name: 'Camera', exact: true })).toHaveCount(0);
    await a.getByRole('button', { name: 'Connect audio & video', exact: true }).click();
    await chooseMicrophone(a);
    await expect(a.getByRole('button', { name: 'Camera', exact: true })).toBeEnabled({
      timeout: 20000,
    });
    await a.getByRole('button', { name: 'Camera', exact: true }).click();
    await expect(a.getByRole('button', { name: 'Microphone', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await teacher
      .getByLabel('Announcement to all groups', { exact: true })
      .fill('Two minutes to share your findings.');
    await teacher.getByRole('button', { name: 'Send announcement', exact: true }).click();
    for (const p of [a, b])
      await expect(p.getByRole('status').filter({ hasText: 'Two minutes' })).toBeVisible();
    const probe = await owner.newPage();
    await probe.goto('/media-probe.html');
    await expect(probe).toHaveTitle('TOASTER media integration probe');
    await probe.waitForFunction(() => !!window.mediaProbe);
    const join = await post(owner, '/classrooms/' + ra.id + '/join', {});
    await probe.evaluate(({ url, token }) => window.mediaProbe.connect(url, token), join);
    try {
      await expect
        .poll(() => probe.evaluate(() => window.mediaProbe.stats()), { timeout: 15000 })
        .toMatchObject({ participants: 1, tracks: 2 });
    } catch (e) {
      console.log(
        'Breakout publications',
        await probe.evaluate(() => window.mediaProbe.publications()),
      );
      console.log(
        'Publisher controls',
        await a.getByRole('button', { name: 'Camera', exact: true }).getAttribute('aria-pressed'),
        await a
          .getByRole('button', { name: 'Microphone', exact: true })
          .getAttribute('aria-pressed'),
      );
      console.log('Publisher alerts', await a.getByRole('alert').allTextContents());
      throw e;
    }
    await expect
      .poll(
        async () => {
          const s = await probe.evaluate(() => window.mediaProbe.stats());
          return s.frames > 0 && s.audioBytes > 0;
        },
        { timeout: 15000 },
      )
      .toBeTruthy();
    const stale = await post(alpha, '/classrooms/' + ra.id + '/join', {});
    await teacher.getByLabel('Move student Alpha learner', { exact: true }).selectOption(rb.id);
    await expect(a.getByRole('heading', { name: 'Beta room', exact: true })).toBeVisible();
    await expect(a.getByRole('button', { name: 'Camera', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(a.getByRole('button', { name: 'Microphone', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect
      .poll(() => probe.evaluate(() => window.mediaProbe.stats()), { timeout: 15000 })
      .toMatchObject({ participants: 0, tracks: 0 });
    const video = b.locator('.media-tile').filter({ hasText: 'Alpha learner' }).locator('video');
    await expect
      .poll(
        () => video.evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);
    expect(
      (
        await alpha.request.get(
          origin +
            '/api/v1/media/signal/rtc/validate?access_token=' +
            encodeURIComponent(stale.token),
        )
      ).status(),
    ).toBe(403);
    await teacher.screenshot({ path: 'docs/screenshots/breakouts-en.png', fullPage: true });
    await teacher.getByRole('button', { name: 'Close group rooms', exact: true }).click();
    for (const p of [a, b]) {
      await expect(p.getByRole('heading', { name: 'Main workshop', exact: true })).toBeVisible();
      await expect(p.getByRole('button', { name: 'Camera', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(p.locator('.media-tile')).toHaveCount(2);
    }
    await expect
      .poll(() => probe.evaluate(() => window.mediaProbe.state()), { timeout: 15000 })
      .toBe('disconnected');
    await probe.evaluate(() => window.mediaProbe.disconnect());
    console.info('Breakout manual close and media return completed.');
    await teacher
      .getByRole('button', { name: 'Copy document to main classroom', exact: true })
      .click();
    // click resolves after dispatch, before the asynchronous import transaction commits.
    await expect
      .poll(async () =>
        (await get(owner, base + '/documents')).some(
          (d: { source_document_id: string }) => d.source_document_id === doc.id,
        ),
      )
      .toBe(true);
    await teacher.getByRole('button', { name: 'Documents', exact: true }).click();
    await teacher.getByRole('button', { name: 'Alpha findings', exact: true }).click();
    await expect(teacher.getByRole('textbox', { name: 'Shared notes', exact: true })).toHaveText(
      'Alpha group result — نتیجهٔ گروه',
    );
    console.info('Breakout document import persisted and appeared in the main classroom.');
    // A real server deadline also tears down media without a teacher pressing Close.
    await post(owner, base + '/breakouts', {
      rooms: [{ name: 'Timed A' }, { name: 'Timed B' }],
      durationSeconds: 30,
      allocation: {
        mode: 'manual',
        assignments: [
          { userId: accounts[1].id, roomIndex: 0 },
          { userId: accounts[2].id, roomIndex: 1 },
        ],
      },
    });
    const timed = (await get(owner, base + '/breakouts')).groups[0];
    for (const [index, p] of [a, b].entries()) {
      await p.getByRole('button', { name: 'Enter assigned room', exact: true }).click();
      await expect(
        p.getByRole('heading', { name: timed.rooms[index].name, level: 1, exact: true }),
      ).toBeVisible();
      await expect(p.getByRole('button', { name: 'Camera', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
    const timedJoin = await post(owner, '/classrooms/' + timed.rooms[0].id + '/join', {});
    await probe.evaluate(({ url, token }) => window.mediaProbe.connect(url, token), timedJoin);
    await expect
      .poll(() => probe.evaluate(() => window.mediaProbe.stats()), { timeout: 15000 })
      .toMatchObject({ participants: 1, tracks: 2 });
    for (const p of [a, b])
      await expect(p.getByRole('heading', { name: 'Main workshop', exact: true })).toBeVisible({
        timeout: 40000,
      });
    for (const p of [a, b]) {
      await expect(p.getByRole('button', { name: 'Camera', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(p.getByRole('button', { name: 'Microphone', exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
    }
    await expect
      .poll(() => probe.evaluate(() => window.mediaProbe.state()), { timeout: 10000 })
      .toBe('disconnected');
    await probe.evaluate(() => window.mediaProbe.disconnect());
    expect((await get(owner, base + '/breakouts')).groups[0].status).toBe('closed');
    await post(owner, base + '/session/end', {});
    for (const p of [a, b])
      await expect(p.getByRole('button', { name: 'Camera', exact: true })).toHaveCount(0);
    console.log(
      'Breakout media assertions completed, including real expiry and final SFU disconnect.',
    );
  } catch (error) {
    for (const [index, p] of uiPages.entries()) {
      if (p.isClosed()) continue;
      console.log(
        'Breakout failure state',
        index,
        await p
          .locator('h1')
          .allTextContents()
          .catch(() => ['page unavailable']),
        await p
          .getByRole('alert')
          .allTextContents()
          .catch(() => []),
        await p
          .locator('[data-lk-theme]')
          .evaluateAll((nodes) => nodes.map((node) => ({ ...(node as HTMLElement).dataset })))
          .catch(() => []),
      );
      await p
        .screenshot({
          path: test.info().outputPath('breakout-failure-' + index + '.png'),
          fullPage: true,
        })
        .catch(() => {});
    }
    throw error;
  }
});
