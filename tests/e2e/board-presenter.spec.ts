import { boardAction } from './classroom-actions';
import { test, expect, type BrowserContext, type Page } from './owned-browser';

test('teacher viewport follows across independent browsers, supports opt-out, refresh and stopping', async ({
  browser,
}) => {
  const a = await browser.newContext(),
    b = await browser.newContext(),
    origin = process.env.TEST_APP_ORIGIN!,
    suffix = crypto.randomUUID();
  async function post(ctx: BrowserContext, path: string, data: unknown) {
    const r = await ctx.request.post(origin + '/api/v1' + path, {
      headers: { Origin: origin },
      data,
    });
    expect(r.ok(), await r.text()).toBeTruthy();
    return r.json();
  }
  try {
    for (const [ctx, name] of [
      [a, 'teacher'],
      [b, 'student'],
    ] as const) {
      await ctx.addInitScript(() => localStorage.setItem('language', 'en'));
      const email = name + suffix + '@view.test';
      await post(ctx, '/auth/register', { email, name, password: 'presenter-browser-password' });
      await post(ctx, '/auth/login', { email, password: 'presenter-browser-password' });
    }
    const org = await post(a, '/organizations', { name: 'Presenter workshop' });
    await post(a, `/organizations/${org.id}/members`, {
      email: 'student' + suffix + '@view.test',
      role: 'student',
    });
    const room = await post(a, `/organizations/${org.id}/classrooms`, {
      enrollmentMode: 'organization',
      name: 'Follow the board',
    });
    const doc = await post(a, `/classrooms/${room.id}/documents`, {
      name: 'Workshop board',
      kind: 'board',
      boardFormat: 'excalidraw',
    });
    const base = `/classrooms/${room.id}/documents/${doc.id}/board`;
    const teacher = await a.newPage(),
      student = await b.newPage();
    // Keep the rectangle fully visible after the 60px pan. Measuring the
    // bounding box of a clipped rectangle compares different geometry.
    await teacher.setViewportSize({ width: 1280, height: 1000 });
    await student.setViewportSize({ width: 1440, height: 900 });
    for (const page of [teacher, student]) {
      await page.goto('/');
      await page.getByRole('button', { name: 'Enter classroom', exact: true }).click();
      await expect(page.getByText('All board changes saved', { exact: true })).toBeVisible();
    }
    await expect(student.getByRole('button', { name: 'Present my view', exact: true })).toHaveCount(
      0,
    );
    const canvas = teacher.locator('.excalidraw__canvas.interactive');
    const initialBounds = (await canvas.boundingBox())!;
    await canvas.click();
    await teacher.keyboard.press('r');
    await teacher.mouse.move(
      initialBounds.x + initialBounds.width / 2 - 40,
      initialBounds.y + initialBounds.height / 2 - 30,
    );
    await teacher.mouse.down();
    await teacher.mouse.move(
      initialBounds.x + initialBounds.width / 2 + 40,
      initialBounds.y + initialBounds.height / 2 + 30,
      { steps: 5 },
    );
    await teacher.mouse.up();
    await teacher.keyboard.press('Escape');
    await expect
      .poll(async () => (await (await a.request.get(origin + '/api/v1' + base)).json()).revision)
      .toBeGreaterThan(0);
    await expect(teacher.getByText('All board changes saved', { exact: true })).toBeVisible();
    const contentRevision = (await (await a.request.get(origin + '/api/v1' + base)).json())
      .revision;
    // Measure actual drawn pixels, not just the label or HTTP viewport. Different viewport sizes
    // must put the rectangle at the same offset from each canvas centre.
    const rectanglePosition = (page: Page) =>
      page
        .locator('canvas.excalidraw__canvas.static')
        .first()
        .evaluate((element) => {
          const c = element as HTMLCanvasElement,
            pixels = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
          let minX = c.width,
            minY = c.height,
            maxX = -1,
            maxY = -1;
          for (let y = 0; y < c.height; y++)
            for (let x = 0; x < c.width; x++) {
              const at = (y * c.width + x) * 4;
              if (
                pixels[at + 3] > 200 &&
                pixels[at] < 80 &&
                pixels[at + 1] < 80 &&
                pixels[at + 2] < 80
              ) {
                minX = Math.min(minX, x);
                maxX = Math.max(maxX, x);
                minY = Math.min(minY, y);
                maxY = Math.max(maxY, y);
              }
            }
          const bounds = c.getBoundingClientRect(),
            ratio = c.width / bounds.width;
          return maxX < 0
            ? null
            : {
                x: ((minX + maxX) / 2 - c.width / 2) / ratio,
                y: ((minY + maxY) / 2 - c.height / 2) / ratio,
              };
        });
    const zoom = teacher.getByLabel('Board zoom', { exact: true });
    await boardAction(teacher, 'Present my view');
    await expect(
      student.getByRole('button', { name: 'Following presenter', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await canvas.click();
    await teacher.keyboard.press('Control+Equal');
    await expect(zoom).not.toHaveText('100%');
    await expect
      .poll(async () => student.getByLabel('Board zoom', { exact: true }).textContent())
      .toBe(await zoom.textContent());
    const state = async () => (await a.request.get(origin + '/api/v1' + base + '/view')).json();
    const beforePan = await state();
    await expect
      .poll(async () => {
        const left = await rectanglePosition(teacher),
          right = await rectanglePosition(student);
        return left && right ? Math.abs(left.x - right.x) + Math.abs(left.y - right.y) : 1000;
      })
      .toBeLessThan(4);
    const bounds = (await canvas.boundingBox())!;
    await teacher.keyboard.press('h');
    await teacher.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await teacher.mouse.down();
    const panStarted = performance.now();
    await teacher.mouse.move(bounds.x + bounds.width / 2 + 100, bounds.y + bounds.height / 2 + 60, {
      steps: 6,
    });
    await teacher.mouse.up();
    await expect
      .poll(async () => (await state()).viewport.centerX)
      .not.toBe(beforePan.viewport.centerX);
    await expect
      .poll(async () => {
        const left = await rectanglePosition(teacher),
          right = await rectanglePosition(student);
        return left && right ? Math.abs(left.x - right.x) + Math.abs(left.y - right.y) : 1000;
      })
      .toBeLessThan(4);
    const panLatency = performance.now() - panStarted;
    console.log('Presenter input-to-view latency (ms):', panLatency);
    expect(panLatency).toBeLessThanOrEqual(500);
    await boardAction(student, 'Following presenter');
    const independentZoom = await student.getByLabel('Board zoom', { exact: true }).textContent();
    await canvas.click();
    await teacher.keyboard.press('Control+Equal');
    await expect.poll(async () => (await state()).viewport.zoom).not.toBe(beforePan.viewport.zoom);
    await expect(student.getByLabel('Board zoom', { exact: true })).toHaveText(independentZoom!);
    await student.reload();
    await expect(
      student.getByRole('button', { name: 'Independent view', exact: true }),
    ).toHaveAttribute('aria-pressed', 'false');
    await boardAction(student, 'Independent view');
    await expect
      .poll(async () => student.getByLabel('Board zoom', { exact: true }).textContent())
      .toBe(await zoom.textContent());
    await student.reload();
    await expect
      .poll(async () => student.getByLabel('Board zoom', { exact: true }).textContent())
      .toBe(await zoom.textContent());
    await teacher.screenshot({ path: 'test-results/board-presenter-teacher.png', fullPage: true });
    await student.screenshot({ path: 'test-results/board-presenter-student.png', fullPage: true });
    await boardAction(teacher, 'Stop presenting view');
    await expect(
      student.getByRole('button', { name: 'Following presenter', exact: true }),
    ).toHaveCount(0);
    expect((await state()).active).toBe(false);
    expect((await (await a.request.get(origin + '/api/v1' + base)).json()).revision).toBe(
      contentRevision,
    );
  } finally {
    await a.close();
    await b.close();
  }
});
