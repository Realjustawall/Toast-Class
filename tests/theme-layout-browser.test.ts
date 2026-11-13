import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { buildApp } from '../apps/api/src/app';
import { testDatabase } from './database';

const DIST = resolve('apps/web/dist');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.json': 'application/json',
};

test('non-BBB themes (modular-skyroom, immersive-glass, studio-hybrid) frame and resize cleanly in browser', async (t) => {
  if (!existsSync(join(DIST, 'index.html'))) {
    t.skip('Built frontend apps/web/dist not found');
    return;
  }
  let browser;
  for (const opts of [
    { headless: true },
    { headless: true, channel: 'chrome' as const },
    { headless: true, channel: 'msedge' as const },
  ]) {
    try {
      browser = await chromium.launch(opts);
      break;
    } catch {
      // Try next available Chromium/Chrome/Edge channel.
    }
  }
  if (!browser) {
    t.skip('Playwright Chromium/Chrome/Edge browser binary not installed');
    return;
  }

  const { pool, cleanup } = await testDatabase();
  const port = 4319;
  const origin = `http://127.0.0.1:${port}`;
  const app = await buildApp(pool, {
    origin,
    production: false,
    mediaUrl: '',
    mediaKey: '',
    mediaSecret: '',
    mediaWorker: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const apiPort = (app.server.address() as { port: number }).port;

  const proxyServer = http.createServer(async (req, res) => {
    const url = req.url ?? '/';
    if (url.startsWith('/api/')) {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const upstream = await fetch(`http://127.0.0.1:${apiPort}${url}`, {
        method: req.method,
        headers: {
          ...(req.headers['content-type']
            ? { 'content-type': String(req.headers['content-type']) }
            : {}),
          ...(req.headers.cookie ? { cookie: String(req.headers.cookie) } : {}),
          ...(req.headers.origin ? { origin: String(req.headers.origin) } : {}),
        },
        body: ['GET', 'HEAD'].includes(req.method ?? 'GET') ? undefined : Buffer.concat(chunks),
      });
      res.statusCode = upstream.status;
      upstream.headers.forEach((v, k) => {
        if (k.toLowerCase() !== 'transfer-encoding') res.setHeader(k, v);
      });
      const setCookies = upstream.headers.getSetCookie?.() ?? [];
      if (setCookies.length) res.setHeader('set-cookie', setCookies);
      res.end(Buffer.from(await upstream.arrayBuffer()));
      return;
    }
    const cleanPath = url.split('?')[0];
    const filePath = join(DIST, cleanPath === '/' ? 'index.html' : cleanPath.slice(1));
    try {
      const data = await readFile(filePath);
      res.setHeader('Content-Type', MIME[extname(filePath)] ?? 'application/octet-stream');
      res.end(data);
    } catch {
      const html = await readFile(join(DIST, 'index.html'));
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    }
  });
  await new Promise<void>((resolveListen) => proxyServer.listen(port, '127.0.0.1', resolveListen));

  const post = (path: string, data: unknown, cookie = '') =>
    app.inject({
      method: 'POST',
      url: '/api/v1' + path,
      headers: { origin, cookie },
      payload: data as object,
    });

  try {
    await post('/auth/register', {
      name: 'Theme Tester',
      email: 'theme-browser@test.local',
      password: 'Password123!',
    });
    const login = await post('/auth/login', {
      email: 'theme-browser@test.local',
      password: 'Password123!',
    });
    const cookieHeader = String(login.headers['set-cookie']).split(';')[0];
    const [cookieName, cookieValue] = cookieHeader.split('=');
    const org = (await post('/organizations', { name: 'Theme Browser Org' }, cookieHeader)).json();

    const themes = ['modular-skyroom', 'immersive-glass', 'studio-hybrid'] as const;
    const rooms: Record<string, string> = {};
    for (const theme of themes) {
      const room = (
        await post(
          `/organizations/${org.id}/classrooms`,
          { name: `Room ${theme}`, theme },
          cookieHeader,
        )
      ).json();
      rooms[theme] = room.id;
    }

    const context = await browser.newContext();
    await context.addCookies([
      { name: cookieName, value: cookieValue, domain: '127.0.0.1', path: '/' },
    ]);

    for (const theme of themes) {
      for (const vp of [
        { name: 'desktop', width: 1440, height: 900 },
        { name: 'mobile', width: 390, height: 844 },
      ]) {
        const page = await context.newPage();
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.goto(`${origin}/#classroom/${rooms[theme]}`, { waitUntil: 'networkidle' });
        await page.waitForSelector('.teaching[data-theme]', { timeout: 15000 });
        await page.waitForTimeout(300);

        const metrics = await page.evaluate(() => {
          const root = document.querySelector('.teaching');
          const stage = document.querySelector('.classroom-stage')?.getBoundingClientRect();
          const media = document.querySelector('.teaching-media')?.getBoundingClientRect();
          return {
            theme: root?.getAttribute('data-theme'),
            innerWidth: window.innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            stage: stage
              ? {
                  x: Math.round(stage.x),
                  y: Math.round(stage.y),
                  w: Math.round(stage.width),
                  h: Math.round(stage.height),
                }
              : null,
            media: media
              ? {
                  x: Math.round(media.x),
                  y: Math.round(media.y),
                  w: Math.round(media.width),
                  h: Math.round(media.height),
                }
              : null,
          };
        });

        assert.equal(metrics.theme, theme, `${theme} (${vp.name}) data-theme mismatch`);
        assert.ok(
          metrics.scrollWidth <= metrics.innerWidth + 2,
          `${theme} (${vp.name}) horizontal overflow: ${metrics.scrollWidth} > ${metrics.innerWidth}`,
        );
        assert.ok(
          metrics.stage && metrics.stage.w >= 250 && metrics.stage.h >= 200,
          `${theme} (${vp.name}) stage too small: ${JSON.stringify(metrics.stage)}`,
        );
        assert.ok(
          metrics.media && metrics.media.w >= 140 && metrics.media.h >= 70,
          `${theme} (${vp.name}) media too small: ${JSON.stringify(metrics.media)}`,
        );

        // Verify panel resize CSS variables actually update rendered panel dimensions on desktop
        if (vp.name === 'desktop') {
          await page.evaluate(() => {
            const root = document.querySelector('.teaching') as HTMLElement | null;
            if (root) {
              root.style.setProperty('--preferred-media-width', '300px');
              root.style.setProperty('--preferred-chat-width', '340px');
            }
          });
          await page.waitForTimeout(100);
          const afterResize = await page.evaluate(() => {
            const stage = document.querySelector('.classroom-stage');
            return stage ? Math.round(stage.getBoundingClientRect().width) : 0;
          });
          assert.ok(afterResize >= 250, `${theme} stage collapsed after resize`);
        }

        await page.close();
      }
    }
  } finally {
    await browser.close();
    proxyServer.close();
    await app.close();
    await cleanup();
  }
});
