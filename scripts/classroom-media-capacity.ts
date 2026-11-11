// Isolated native MySQL + authenticated API + real SFU/browser RTP benchmark.
// Fixtures are created only in a generated test database and never in preview data.
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import WebSocket, { WebSocketServer } from 'ws';
import { chromium, type BrowserServer, type Page } from '@playwright/test';
import dotenv from 'dotenv';
import { testDatabase } from '../tests/database';

const configuration = dotenv.parse(await readFile('.local/runtime/native-media.env'));
if (process.env.CAPACITY_PREVIEW_SFU === 'true') {
  const preview = dotenv.parse(await readFile('.local/runtime/native-preview.env'));
  configuration.TEST_MEDIA_URL = preview.LIVEKIT_URL;
  configuration.TEST_MEDIA_KEY = preview.LIVEKIT_API_KEY;
  configuration.TEST_MEDIA_SECRET = preview.LIVEKIT_API_SECRET;
}
Object.assign(process.env, dotenv.parse(await readFile('.local/runtime/native-mysql.env')));
const counts = process.argv.slice(2).map(Number);
if (!counts.length || counts.some((n) => !Number.isInteger(n) || n < 2 || n > 800))
  throw new Error('Specify 2..800 simulated users');
const exec = promisify(execFile);
const sfuPid = Number(
  (
    await readFile(
      process.env.CAPACITY_PREVIEW_SFU === 'true'
        ? '.local/runtime/preview-sfu.pid'
        : '.local/runtime/sfu.pid',
      'utf8',
    )
  ).trim(),
);
if (!Number.isInteger(sfuPid) || sfuPid < 1) throw new Error('Invalid owned SFU PID');
async function ready(url: string, child: ChildProcess) {
  for (let i = 0; i < 240; i++) {
    if (child.exitCode !== null) throw new Error('Owned server exited');
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(500) })).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Readiness deadline exceeded');
}
async function bounded<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Benchmark phase deadline exceeded')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
async function resources(apiPid: number) {
  const { stdout } = await exec(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      `Get-Process -Id ${apiPid},${sfuPid} | Select-Object Id,WorkingSet64,PrivateMemorySize64,CPU | ConvertTo-Json -Compress`,
    ],
    { windowsHide: true, timeout: 5000 },
  );
  return { at: Date.now(), processes: JSON.parse(stdout) };
}

for (const users of counts) {
  const { pool, cleanup, workerDatabaseUrl } = await testDatabase();
  if (!workerDatabaseUrl || pool.dialect !== 'mysql')
    throw new Error('This benchmark requires isolated native MySQL');
  const apiPort = 35040,
    webPort = 35240,
    proxyPort = 35340;
  const origin = 'http://localhost:' + webPort,
    apiOrigin = 'http://127.0.0.1:' + apiPort;
  const cookieByUser = new Map<string, string>(),
    live: WebSocket[] = [],
    browserServers: BrowserServer[] = [],
    pages: Page[] = [];
  const samples: unknown[] = [];
  let api: ChildProcess | undefined,
    web: ChildProcess | undefined,
    timer: ReturnType<typeof setInterval> | undefined,
    progressTimer: ReturnType<typeof setInterval> | undefined,
    chatDelivered = 0;
  const liveClosures: Record<string, number> = {};
  const proxy = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const started = Date.now();
  let result: Record<string, unknown> = { users, success: false };
  try {
    const org = randomUUID(),
      room = randomUUID(),
      identities: string[] = [];
    for (let index = 0; index < users; index++) {
      const id = randomUUID(),
        token = randomBytes(32).toString('hex');
      identities.push(id);
      cookieByUser.set(id, 'toaster_session=' + token);
      await pool.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [
        id,
        id + '@capacity.test',
        'Participant ' + index,
        'disabled-test-login',
      ]);
      await pool.query(
        'INSERT INTO auth_sessions(id,token_hash,user_id,expires_at) VALUES($1,$2,$3,$4)',
        [
          randomUUID(),
          createHash('sha256').update(token).digest('hex'),
          id,
          new Date(Date.now() + 1800000),
        ],
      );
    }
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [
      org,
      'Isolated media capacity',
    ]);
    for (const [index, id] of identities.entries())
      await pool.query('INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)', [
        org,
        id,
        index ? 'student' : 'owner',
      ]);
    await pool.query(
      'INSERT INTO classrooms(id,organization_id,name,created_by,enrollment_mode) VALUES($1,$2,$3,$4,$5)',
      [room, org, 'Isolated media capacity', identities[0], 'organization'],
    );
    const env = {
      ...process.env,
      DATABASE_URL: workerDatabaseUrl,
      APP_ORIGIN: origin,
      PORT: String(apiPort),
      LIVEKIT_URL: configuration.TEST_MEDIA_URL,
      LIVEKIT_API_KEY: configuration.TEST_MEDIA_KEY,
      LIVEKIT_API_SECRET: configuration.TEST_MEDIA_SECRET,
      TOASTER_API_TARGET: apiOrigin,
    };
    api = spawn(process.execPath, ['--import', 'tsx', 'scripts/capacity-api.ts'], {
      env,
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    await bounded(
      Promise.race([
        once(api, 'message'),
        once(api, 'exit').then(() => {
          throw new Error('Owned capacity API failed to start');
        }),
      ]),
      30000,
    );
    await ready(apiOrigin + '/health', api);
    result.processRoles = { api: api.pid, sfu: sfuPid, loadGenerator: process.pid };
    const post = async (path: string, body: unknown, id: string) => {
      const r = await fetch(apiOrigin + '/api/v1' + path, {
        method: 'POST',
        headers: { origin, cookie: cookieByUser.get(id)!, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      if (!r.ok) throw new Error(path + ': ' + r.status);
      return r.json();
    };
    await post('/classrooms/' + room + '/session/start', {}, identities[0]);
    const joins = identities.map((id) => ({
      id,
      url: 'ws://127.0.0.1:' + proxyPort + '/' + id,
      tokenUrl: 'http://127.0.0.1:' + proxyPort + '/' + id + '/token',
    }));
    // Each virtual user gets its own actual session cookie at the test-only
    // loopback transport bridge; production gateway authorization is unchanged.
    const route = (raw: string) => {
      const u = new URL(raw, 'http://localhost');
      const match = /^\/([a-f0-9-]{36})(\/rtc(?:\/v1)?(?:\/validate)?)$/.exec(u.pathname);
      return match && cookieByUser.has(match[1])
        ? { id: match[1], target: apiOrigin + '/api/v1/media/signal' + match[2] + u.search }
        : null;
    };
    proxy.on('request', (req, res) => {
      void (async () => {
        const tokenRequest = /^\/([a-f0-9-]{36})\/token$/.exec(req.url ?? '');
        if (tokenRequest && cookieByUser.has(tokenRequest[1]) && req.headers.origin === origin) {
          const grant = await post('/classrooms/' + room + '/join', {}, tokenRequest[1]);
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': origin,
          });
          res.end(JSON.stringify({ token: grant.token }));
          return;
        }
        const r = route(req.url ?? '');
        if (!r) {
          res.writeHead(404);
          res.end();
          return;
        }
        const response = await fetch(r.target, {
          headers: { origin, cookie: cookieByUser.get(r.id)! },
          signal: AbortSignal.timeout(20000),
        });
        res.writeHead(response.status, {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Credentials': 'true',
        });
        res.end(await response.text());
      })().catch(() => {
        res.writeHead(502);
        res.end();
      });
    });
    proxy.on('upgrade', (req, socket, head) => {
      const r = route(req.url ?? '');
      if (!r || req.headers.origin !== origin) {
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (client) => {
        const upstream = new WebSocket(r.target.replace('http:', 'ws:'), {
          headers: { origin, cookie: cookieByUser.get(r.id)! },
          handshakeTimeout: 20000,
        });
        const queue: { data: WebSocket.RawData; binary: boolean }[] = [];
        let bytes = 0;
        client.on('message', (data, binary) => {
          if (upstream.readyState === WebSocket.OPEN) upstream.send(data, { binary });
          else if (upstream.readyState === WebSocket.CONNECTING) {
            bytes += Buffer.byteLength(data as Buffer);
            if (bytes > 1024 * 1024) {
              client.terminate();
              upstream.terminate();
            } else queue.push({ data, binary });
          }
        });
        upstream.on('open', () => {
          for (const message of queue) upstream.send(message.data, { binary: message.binary });
          queue.length = 0;
        });
        upstream.on('message', (data, binary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
        });
        upstream.on('error', () => client.close(1011));
        client.on('error', () => upstream.terminate());
        upstream.on('close', () => client.close());
        client.on('close', () => upstream.terminate());
      });
    });
    await new Promise<void>((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve));
    web = spawn(
      process.execPath,
      [
        'node_modules/vite/bin/vite.js',
        'apps/web',
        '--config',
        'apps/web/vite.config.ts',
        '--host',
        '127.0.0.1',
        '--port',
        String(webPort),
        '--strictPort',
      ],
      { env, windowsHide: true, stdio: 'ignore' },
    );
    await ready(origin, web);
    for (let offset = 0; offset < users; offset += 20)
      await Promise.all(
        identities.slice(offset, offset + 20).map((id) =>
          bounded(
            new Promise<void>((resolve, reject) => {
              const socket = new WebSocket(
                apiOrigin.replace('http:', 'ws:') + '/api/v1/classrooms/' + room + '/live',
                { headers: { origin, cookie: cookieByUser.get(id)! } },
              );
              live.push(socket);
              socket.on('message', (raw) => {
                const m = JSON.parse(raw.toString());
                if (m.type === 'ready') resolve();
                if (m.type === 'chat_changed') chatDelivered++;
              });
              socket.on('close', (code) => {
                liveClosures[String(code)] = (liveClosures[String(code)] ?? 0) + 1;
              });
              socket.once('error', reject);
            }),
            20000,
          ),
        ),
      );
    samples.push(await resources(api.pid!));
    let sampling = false;
    timer = setInterval(() => {
      if (sampling) return;
      sampling = true;
      resources(api!.pid!)
        .then((s) => samples.push(s))
        .catch(() => {})
        .finally(() => (sampling = false));
    }, 5000);
    const groups = Math.ceil(users / 200);
    for (let index = 0; index < groups; index++) {
      const server = await chromium.launchServer({
        channel: process.env.PW_CHANNEL ?? 'chromium',
        host: '127.0.0.1',
        args: [
          '--autoplay-policy=no-user-gesture-required',
          '--disable-gpu',
          '--use-fake-device-for-media-stream',
          '--use-fake-ui-for-media-stream',
        ],
      });
      browserServers.push(server);
      const browser = await chromium.connect(server.wsEndpoint());
      const context = await browser.newContext({ permissions: ['microphone', 'camera'] });
      const page = await context.newPage();
      pages.push(page);
      page.on('console', (message) => {
        if (message.text().startsWith('Capacity connection failure:')) console.log(message.text());
      });
      await page.addInitScript(() => {
        const target = window as any;
        target.capacityIce = [];
        const Native = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Native {
          constructor(...args: ConstructorParameters<typeof RTCPeerConnection>) {
            super(...args);
            const index = target.capacityIce.length;
            target.capacityIce.push({
              events: [],
              iceTransportPolicy: args[0]?.iceTransportPolicy,
            });
            this.addEventListener('iceconnectionstatechange', () =>
              target.capacityIce[index].events.push({
                ice: this.iceConnectionState,
                connection: this.connectionState,
              }),
            );
            this.addEventListener('icecandidate', (event) => {
              if (event.candidate)
                target.capacityIce[index].events.push({
                  candidateType: event.candidate.type,
                  protocol: event.candidate.protocol,
                });
            });
          }
        };
      });
      await page.goto(origin + '/capacity-probe.html');
      await page.waitForFunction(() => !!(window as any).capacityProbe);
    }
    const publisher = joins.find((j) => j.id === identities[0])!;
    const publisherResult = await pages[0].evaluate(
      (join) => (window as any).capacityProbe.connect([join], true),
      publisher,
    );
    if (publisherResult.errors.length) {
      console.log(
        'ICE diagnostics:',
        JSON.stringify(await pages[0].evaluate(() => (window as any).capacityIce)),
      );
      throw new Error('Publisher failed: ' + publisherResult.errors[0]);
    }
    await pages[0].evaluate(() => (window as any).capacityProbe.publish());
    const receivers = joins.filter((j) => j.id !== publisher.id);
    let checkingProgress = false;
    progressTimer = setInterval(() => {
      if (checkingProgress) return;
      checkingProgress = true;
      bounded(
        Promise.all(
          pages.map((page) => page.evaluate(() => (window as any).capacityProbe.progress())),
        ),
        5000,
      )
        .then((groups) => console.log('Media connection progress:', JSON.stringify(groups)))
        .catch(() => {})
        .finally(() => {
          checkingProgress = false;
        });
    }, 15000);
    const connected = await bounded(
      Promise.all(
        pages.map((page, index) =>
          page.evaluate(
            (group) => (window as any).capacityProbe.connect(group),
            receivers.slice(index * 200, (index + 1) * 200),
          ),
        ),
      ),
      600000,
    );
    console.log(
      'Connected media groups:',
      JSON.stringify(connected.map((r) => ({ connected: r.connected, failed: r.errors.length }))),
    );
    await post(
      '/classrooms/' + room + '/messages',
      { body: 'Authenticated capacity probe' },
      identities[0],
    );
    let chatRead = 0;
    for (let offset = 0; offset < users; offset += 20)
      await Promise.all(
        identities.slice(offset, offset + 20).map(async (id) => {
          const response = await fetch(apiOrigin + '/api/v1/classrooms/' + room + '/messages', {
            headers: { cookie: cookieByUser.get(id)! },
            signal: AbortSignal.timeout(20000),
          });
          if (
            response.ok &&
            (await response.json()).some(
              (message: { body: string }) => message.body === 'Authenticated capacity probe',
            )
          )
            chatRead++;
        }),
      );
    let stats: any[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      stats = await bounded(
        Promise.all(
          pages.map((page) => page.evaluate(() => (window as any).capacityProbe.stats())),
        ),
        60000,
      );
      if (stats.reduce((n, s) => n + s.complete, 0) === users - 1) break;
    }
    samples.push(await resources(api.pid!));
    result = {
      ...result,
      success:
        chatDelivered === users &&
        chatRead === users &&
        stats.reduce((n, s) => n + s.complete, 0) === users - 1 &&
        connected.every((r) => !r.errors.length),
      liveUsers: live.filter((s) => s.readyState === WebSocket.OPEN).length,
      liveClosures: { ...liveClosures },
      chatDelivered,
      chatRead,
      stats,
      connectionErrors: connected.flatMap((r) => r.errors),
      elapsedMs: Date.now() - started,
      samples,
      scope:
        'Native MySQL, authenticated application live/signaling gateways, synthetic microphone/camera/screen RTP; virtual SDK clients grouped in up to four browser processes, not 800 rendered React classrooms',
    };
    if (result.success !== true) process.exitCode = 1;
  } catch (error) {
    const progress = await bounded(
      Promise.all(
        pages.map((page) => page.evaluate(() => (window as any).capacityProbe.progress())),
      ),
      5000,
    ).catch(() => []);
    result = {
      ...result,
      error: String(error),
      progress,
      liveUsers: live.filter((s) => s.readyState === WebSocket.OPEN).length,
      liveClosures: { ...liveClosures },
      elapsedMs: Date.now() - started,
      samples,
    };
    process.exitCode = 1;
  } finally {
    if (timer) clearInterval(timer);
    if (progressTimer) clearInterval(progressTimer);
    for (const page of pages)
      await bounded(
        page.evaluate(() => (window as any).capacityProbe.disconnect()),
        10000,
      ).catch(() => {});
    for (const server of browserServers) {
      const p = server.process();
      if (p.exitCode === null) p.kill('SIGKILL');
      await bounded(server.kill(), 10000).catch(() => {});
    }
    for (const socket of live) socket.terminate();
    for (const socket of wss.clients) socket.terminate();
    wss.close();
    proxy.close();
    if (web?.exitCode === null) web.kill();
    if (api?.exitCode === null) {
      const exited = once(api, 'exit');
      api.send({ type: 'shutdown' });
      await bounded(exited, 10000).catch(() => api!.kill());
    }
    await cleanup();
    await writeFile(
      'test-results/browser-media-capacity-' + users + '.json',
      JSON.stringify({ measuredAt: new Date().toISOString(), ...result }, null, 2),
    );
    console.log(
      JSON.stringify({
        ...result,
        samples: undefined,
        connectionErrors: Array.isArray(result.connectionErrors)
          ? { count: result.connectionErrors.length, first: result.connectionErrors.slice(0, 3) }
          : undefined,
      }),
    );
  }
  if (result.success !== true) break;
}
