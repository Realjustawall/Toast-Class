import { test, expect, type BrowserContext, type Page } from './owned-browser';
import { readFile } from 'node:fs/promises';

test('GeoGebra worksheets save in MySQL, synchronize between users, export and enforce live editing grants', async ({
  browser,
}) => {
  test.setTimeout(150000);
  const origin = process.env.TEST_APP_ORIGIN!,
    contexts: BrowserContext[] = [];
  try {
    const emails: string[] = [],
      ids: string[] = [];
    for (const name of ['Math teacher', 'Math learner']) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      contexts.push(context);
      await context.addInitScript(() => {
        if (window === window.top) localStorage.setItem('language', 'en');
      });
      const email = crypto.randomUUID() + '@math-classroom.test',
        password = 'math-classroom-password';
      emails.push(email);
      const identity = await context.request.post('/api/v1/auth/register', {
        headers: { origin },
        data: { name, email, password },
      });
      expect(identity.ok()).toBe(true);
      ids.push((await identity.json()).id);
      expect(
        (
          await context.request.post('/api/v1/auth/login', {
            headers: { origin },
            data: { email, password },
          })
        ).ok(),
      ).toBe(true);
    }
    const [owner, student] = contexts;
    const post = async (path: string, data: unknown) => {
      const response = await owner.request.post('/api/v1' + path, { headers: { origin }, data });
      expect(response.ok(), await response.text()).toBe(true);
      return response.json();
    };
    const org = await post('/organizations', { name: 'Math classroom' });
    await post('/organizations/' + org.id + '/members', { email: emails[1], role: 'student' });
    const room = await post('/organizations/' + org.id + '/classrooms', {
        name: 'Full GeoGebra lesson',
        enrollmentMode: 'organization',
      }),
      base = '/classrooms/' + room.id;
    const studentId = ids[1];
    await post(base + '/session/start', {});
    const a = await owner.newPage(),
      b = await student.newPage();
    const open = async (page: Page) => {
      await page.goto('/#classroom/' + room.id);
      await expect(page.getByTestId('classroom-connection')).toHaveText('Live connection');
      await page
        .locator('.classroom-actions')
        .getByRole('button', { name: 'Apps', exact: true })
        .click();
      await page.getByRole('menuitem', { name: 'GeoGebra drawing', exact: true }).click();
    };
    await open(a);
    const publicTab = a.getByRole('tab', { name: 'Public', exact: true });
    const width = await publicTab.evaluate((element) => ({
      tab: element.getBoundingClientRect().width,
      bar: element.parentElement!.clientWidth,
    }));
    expect(width.tab).toBeGreaterThanOrEqual(width.bar - 6);
    await a.getByRole('button', { name: 'New worksheet', exact: true }).click();
    const workspace = a.locator('.geogebra-stage .geogebra-workspace');
    await expect(workspace.getByRole('button', { name: 'Save', exact: true })).toBeEnabled({
      timeout: 60000,
    });
    const math = a.frames().find((frame) => frame.url().includes('/geogebra/frame.html'))!;
    await math.evaluate(() =>
      (window as any).__ggbApi.evalCommand('A=(1,2)\nB=(4,6)\ns=Segment(A,B)'),
    );
    const worksheets = await (await owner.request.get('/api/v1' + base + '/geogebra')).json(),
      id = worksheets[0].id;
    await expect
      .poll(
        async () => {
          const document = await (
            await owner.request.get('/api/v1' + base + '/geogebra/' + id)
          ).json();
          return document.state_base64.length;
        },
        { timeout: 20000 },
      )
      .toBeGreaterThan(100);
    await expect(workspace.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await b.goto('/#classroom/' + room.id);
    await expect(b.getByTestId('classroom-connection')).toHaveText('Live connection');
    const viewer = b.locator('.geogebra-stage .geogebra-workspace');
    await expect(
      viewer.getByText('Viewing; a moderator can grant editing access', { exact: true }),
    ).toBeVisible({ timeout: 60000 });
    const studentMath = () =>
      b.frames().find((frame) => frame.url().includes('/geogebra/frame.html'))!;
    await expect
      .poll(() => studentMath()?.evaluate(() => (window as any).__ggbApi?.getValue('s')), {
        timeout: 60000,
      })
      .toBe(5);
    await expect(viewer.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    const current = await (await owner.request.get('/api/v1' + base + '/geogebra/' + id)).json();
    expect(
      (
        await student.request.post('/api/v1' + base + '/geogebra/' + id, {
          headers: { origin },
          data: { revision: current.revision, state: current.state_base64 },
        })
      ).status(),
    ).toBe(403);
    await post(base + '/user-permissions/' + studentId, { canWhiteboard: true });
    await expect(viewer.getByRole('button', { name: 'Save', exact: true })).toBeEnabled({
      timeout: 20000,
    });
    await studentMath().evaluate(() => (window as any).__ggbApi.evalCommand('n=12'));
    await expect
      .poll(() => math.evaluate(() => (window as any).__ggbApi.getValue('n')), { timeout: 20000 })
      .toBe(12);
    await post(base + '/user-permissions/' + studentId, { canWhiteboard: false });
    await expect(viewer.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    expect([401, 404]).toContain(
      await math.evaluate(() => fetch('/api/v1/me').then((response) => response.status)),
    );
    expect((await a.request.get('/geogebra/frame.html')).status()).toBe(404);
    expect(
      await a.evaluate(() => {
        try {
          document.querySelector<HTMLIFrameElement>('.geogebra-workspace iframe')!.contentWindow!
            .document;
          return false;
        } catch {
          return true;
        }
      }),
    ).toBe(true);
    await workspace.locator('.overflow-menu > summary').click();
    const exported = a.waitForEvent('download');
    await workspace.getByRole('button', { name: 'Download GGB', exact: true }).click();
    const file = await exported;
    await file.saveAs('test-results/geogebra-lesson.ggb');
    expect((await readFile('test-results/geogebra-lesson.ggb')).readUInt32LE(0)).toBe(0x04034b50);
    for (const format of ['PNG', 'SVG', 'PDF']) {
      await workspace.locator('.overflow-menu > summary').click();
      const event = a.waitForEvent('download', { timeout: 15000 });
      await workspace.getByRole('button', { name: 'Download ' + format, exact: true }).click();
      const exported = await event,
        path = 'test-results/geogebra-lesson.' + format.toLowerCase();
      await exported.saveAs(path);
      const bytes = await readFile(path);
      if (format === 'PNG') expect([...bytes.subarray(0, 4)]).toEqual([137, 80, 78, 71]);
      else if (format === 'PDF') expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
      else expect(bytes.toString()).toContain('<svg');
    }
    const imported = a.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1' + base + '/geogebra/' + id,
    );
    await workspace.locator('input[type="file"]').setInputFiles('test-results/geogebra-lesson.ggb');
    expect((await imported).ok()).toBe(true);
    await expect.poll(() => math.evaluate(() => (window as any).__ggbApi.getValue('s'))).toBe(5);
    await workspace.getByRole('combobox', { name: 'Drawing view', exact: true }).selectOption('4');
    await expect
      .poll(() => math.evaluate(() => (window as any).__ggbApi.evalCommandCAS('Factor(x^2-1)')), {
        timeout: 30000,
      })
      .toContain('x');
    await workspace.getByRole('combobox', { name: 'Drawing view', exact: true }).selectOption('1');
    await expect(workspace.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    await a.screenshot({ path: 'test-results/geogebra-classroom-desktop.png' });
    await a.reload();
    await a
      .locator('.classroom-actions')
      .getByRole('button', { name: 'Apps', exact: true })
      .click();
    await a.getByRole('menuitem', { name: 'GeoGebra drawing', exact: true }).click();
    await expect
      .poll(
        () =>
          a
            .frames()
            .find((frame) => frame.url().includes('/geogebra/frame.html'))
            ?.evaluate(() => (window as any).__ggbApi?.getValue('n')),
        { timeout: 60000 },
      )
      .toBe(12);
    await a.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        a
          .frames()
          .find((frame) => frame.url().includes('/geogebra/frame.html'))
          ?.evaluate(() => {
            const surface = document.querySelector('.GeoGebraFrame');
            return surface ? surface.getBoundingClientRect().width : 0;
          }),
      )
      .toBeGreaterThan(250);
    await a.screenshot({ path: 'test-results/geogebra-classroom-mobile.png' });
    expect(
      await a
        .locator('.geogebra-toolbar')
        .evaluate((element) => element.scrollWidth > element.clientWidth + 1),
    ).toBe(false);
    const savedResponse = a.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/api/v1' + base + '/geogebra/' + id,
    );
    await workspace.getByRole('button', { name: 'Save', exact: true }).click();
    expect((await savedResponse).ok()).toBe(true);
    await expect(workspace.getByRole('status').filter({ hasText: 'Saved' })).toBeVisible();
    const beforeIdle = await (await owner.request.get('/api/v1' + base + '/geogebra/' + id)).json();
    await a.waitForTimeout(2500);
    const afterIdle = await (await owner.request.get('/api/v1' + base + '/geogebra/' + id)).json();
    expect(afterIdle.revision, 'Idle viewers must not create a save feedback loop').toBe(
      beforeIdle.revision,
    );
  } finally {
    await Promise.all(contexts.map((context) => context.close()));
  }
});
