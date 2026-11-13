import { test, expect } from './owned-browser';

test('sandbox board runs uploaded HTML/CSS/JS in a separate strictly isolated iframe', async ({
  page,
}) => {
  test.setTimeout(90000);
  const origin = process.env.TEST_APP_ORIGIN!;
  await page.addInitScript(() => {
    if (window === window.top) localStorage.setItem('language', 'en');
  });
  const post = async (path: string, data: unknown) => {
    const response = await page.request.post('/api/v1' + path, { headers: { origin }, data });
    expect(response.ok(), await response.text()).toBe(true);
    return response.json();
  };
  const email = crypto.randomUUID() + '@sandbox.test';
  await post('/auth/register', { email, password: 'sandbox-password', name: 'Sandbox Teacher' });
  await post('/auth/login', { email, password: 'sandbox-password' });
  const org = await post('/organizations', { name: 'Sandbox Org' });
  const room = await post('/organizations/' + org.id + '/classrooms', {
    name: 'Sandbox Classroom',
  });

  await page.goto('/#classroom/' + room.id);
  await expect(page.getByTestId('classroom-connection')).toHaveText('Live connection');
  await page.getByRole('button', { name: 'HTML / JS', exact: true }).click();
  await expect(page.locator('.sandbox-workspace')).toBeVisible();

  const html = `<!doctype html>
<html>
<head>
  <style>body { font-family: sans-serif; } #status { color: rgb(12, 120, 60); }</style>
</head>
<body>
  <h2 id="title">Interactive Widget</h2>
  <p id="status">init</p>
  <button id="btn" type="button">Click me</button>
  <script>
    const checks = [];
    try { void window.parent.document.body; checks.push('parent-exposed'); } catch { checks.push('parent-blocked'); }
    try { void document.cookie; checks.push('cookie-exposed'); } catch { checks.push('cookie-blocked'); }
    try { void window.localStorage.getItem('x'); checks.push('storage-exposed'); } catch { checks.push('storage-blocked'); }
    document.getElementById('status').textContent = checks.join(',');
    document.getElementById('btn').addEventListener('click', () => {
      document.getElementById('title').textContent = 'Clicked!';
    });
  </script>
</body>
</html>`;

  const fileInput = page.locator('.sandbox-workspace input[type="file"]');
  await fileInput.setInputFiles({
    name: 'interactive-demo.html',
    mimeType: 'text/html',
    buffer: Buffer.from(html, 'utf8'),
  });

  const frame = page.frameLocator('.sandbox-frame');
  await expect(frame.locator('#status')).toHaveText(
    'parent-blocked,cookie-blocked,storage-blocked',
  );
  await frame.locator('#btn').click();
  await expect(frame.locator('#title')).toHaveText('Clicked!');
});
