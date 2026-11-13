import { test, expect } from './owned-browser';

test('the official local GeoGebra runtime draws, computes CAS and exposes its full Classic perspectives on an isolated static origin', async ({
  page,
}) => {
  test.setTimeout(120000);
  page.on('console', (message) => {
    if (message.type() === 'error')
      console.log('GeoGebra console: ' + message.text().slice(0, 600));
  });
  page.on('pageerror', (error) => console.log('GeoGebra error: ' + error.message.slice(0, 600)));
  page.on('requestfailed', (request) =>
    console.log(
      'GeoGebra request failed: ' +
        request.url().split('?')[0].slice(0, 180) +
        ' ' +
        request.failure()?.errorText,
    ),
  );
  const external: string[] = [];
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (
      ['http:', 'https:'].includes(url.protocol) &&
      !['localhost', '127.0.0.1', 'geogebra.localhost'].includes(url.hostname)
    ) {
      external.push(url.href);
      return route.abort();
    }
    return route.continue();
  });
  await page.goto('/');
  await page.evaluate(() => {
    const frame = document.createElement('iframe');
    frame.id = 'math-test';
    frame.sandbox.add('allow-scripts', 'allow-same-origin', 'allow-downloads');
    frame.src =
      location.protocol +
      '//geogebra.localhost:' +
      location.port +
      '/geogebra/frame.html#token=runtime-test&lang=en&edit=1&parent=' +
      encodeURIComponent(location.origin);
    frame.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:1000';
    document.body.append(frame);
    window.addEventListener('message', (event) => {
      if (event.source === frame.contentWindow && event.data?.type === 'ready')
        frame.contentWindow!.postMessage(
          {
            channel: 'toaster-geogebra',
            token: 'runtime-test',
            type: 'load',
            state: '',
            canEdit: true,
          },
          '*',
        );
    });
  });
  const frame = page.frameLocator('#math-test');
  await expect
    .poll(
      () =>
        page
          .frames()
          .find((frame) => frame.url().includes('/geogebra/frame.html'))
          ?.evaluate(() => Boolean((window as unknown as { __ggbApi?: unknown }).__ggbApi)),
      { timeout: 60000 },
    )
    .toBe(true);
  const math = page.frames().find((frame) => frame.url().includes('/geogebra/frame.html'))!;
  await expect
    .poll(
      () =>
        math.evaluate(() => {
          const api = (window as any).__ggbApi;
          if (!api.exists?.('s')) api.evalCommand('A=(1,2)\nB=(4,6)\ns=Segment(A,B)\nf(x)=sin(x)');
          return api.getValue('s');
        }),
      { timeout: 30000 },
    )
    .toBe(5);
  await expect
    .poll(() => math.evaluate(() => (window as any).__ggbApi.evalCommandCAS('Factor(x^2-1)')), {
      timeout: 30000,
    })
    .toContain('x');
  const evidence = await math.evaluate(async () => {
    const api = (window as any).__ggbApi;
    api.setPerspective('5');
    api.evalCommand('Q=(1,2,3)');
    const point3d = api.getObjectType('Q');
    api.setPerspective('3');
    api.evalCommand('A1=5\nA2=7');
    const spreadsheet = api.getValue('A1');
    api.setPerspective('6');
    api.setPerspective('1');
    const state = await new Promise<string>((resolve) => api.getBase64(resolve));
    return { version: api.getVersion(), point3d, spreadsheet, archive: state.startsWith('UEs') };
  });
  expect(evidence.spreadsheet).toBe(5);
  expect(evidence.archive).toBe(true);
  expect(evidence.point3d).toBe('point');
  expect(
    await page.evaluate(() => {
      try {
        (document.querySelector('#math-test') as HTMLIFrameElement).contentWindow!.localStorage;
        return false;
      } catch {
        return true;
      }
    }),
  ).toBe(true);
  await expect(frame.locator('canvas').first()).toBeVisible();
  await page.screenshot({ path: 'test-results/geogebra-runtime.png' });
  console.log(JSON.stringify({ geoGebra: evidence, blockedExternalRequests: external.length }));
});
