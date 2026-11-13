import { test, expect } from './owned-browser';

test('brand animation is confined to the landing page and classroom transitions use inline recoverable feedback', async ({
  page,
}) => {
  const origin = process.env.TEST_APP_ORIGIN!;
  const external: string[] = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (['localhost', '127.0.0.1'].includes(url.hostname)) return route.continue();
    external.push(url.href);
    return route.abort();
  });
  await page.addInitScript(() => {
    if (window === window.top) localStorage.setItem('language', 'en');
  });
  await page.goto('/');
  const scene = page.frameLocator('.stage-3d-mount');
  await expect(scene.locator('canvas')).toBeVisible();
  const animation = page.frames().find((frame) => frame.url().includes('/intro/'))!;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => animation.evaluate('playing')).toBe(false);
  await expect(
    page.locator('form').getByRole('button', { name: 'Sign in', exact: true }),
  ).toBeEnabled();
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post('/api/v1' + path, { headers: { origin }, data });
    expect(response.ok()).toBe(true);
    return response.json();
  };
  const email = crypto.randomUUID() + '@landing.test',
    password = 'landing-browser-password';
  await post('/auth/register', { email, password, name: 'Landing instructor' });
  await post('/auth/login', { email, password });
  const org = await post('/organizations', { name: 'Landing test' });
  const room = await post('/organizations/' + org.id + '/classrooms', { name: 'Inline classroom' });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/classrooms/' + room.id + '/teaching', async (route) => {
    await gate;
    await route.continue().catch(() => {});
  });
  await page.goto('/#classroom/' + room.id);
  await page.reload();
  await expect(page.locator('.classroom-inline-state')).toBeVisible();
  await expect(page.locator('iframe,.classroom-loading,[aria-modal="true"]')).toHaveCount(0);
  await expect(page.locator('#root')).toHaveJSProperty('inert', false);
  release();
  await expect(page.getByRole('heading', { name: 'Inline classroom', exact: true })).toBeVisible();
  await page.unroute('**/classrooms/' + room.id + '/teaching');
  await page.route('**/classrooms/' + room.id + '/teaching', (route) =>
    route.fulfill({ status: 503, json: { error: 'Unavailable' } }),
  );
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
  await expect(page.locator('iframe,.classroom-loading')).toHaveCount(0);
  await page.unroute('**/classrooms/' + room.id + '/teaching');
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Inline classroom', exact: true })).toBeVisible();
  expect(external).toEqual([]);
});
