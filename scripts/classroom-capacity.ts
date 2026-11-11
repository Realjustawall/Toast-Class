// Isolated protocol benchmark. This never reads or changes the application database.
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';
import WebSocket from 'ws';
import { testDatabase } from '../tests/database';
import { buildApp } from '../apps/api/src/app';

const results = [];
for (const count of [200, 800]) {
  const { pool, cleanup } = await testDatabase();
  const app = await buildApp(pool, {
    origin: 'http://localhost:5173',
    production: false,
    mediaUrl: '',
    mediaKey: '',
    mediaSecret: '',
  });
  const sockets: WebSocket[] = [];
  const loop = monitorEventLoopDelay({ resolution: 20 });
  try {
    const org = randomUUID(),
      room = randomUUID(),
      owner = randomUUID();
    await pool.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [
      owner,
      owner + '@load.test',
      'Load owner',
      'disabled-test-login',
    ]);
    await pool.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [
      org,
      'Isolated load test',
    ]);
    await pool.query('INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)', [
      org,
      owner,
      'owner',
    ]);
    await pool.query(
      'INSERT INTO classrooms(id,organization_id,name,created_by,enrollment_mode) VALUES($1,$2,$3,$4,$5)',
      [room, org, 'Load room', owner, 'organization'],
    );
    const cookies: string[] = [];
    for (let i = 0; i < count; i++) {
      const id = randomUUID(),
        token = randomBytes(32).toString('hex');
      await pool.query('INSERT INTO users(id,email,name,password_hash) VALUES($1,$2,$3,$4)', [
        id,
        id + '@load.test',
        'Learner ' + i,
        'disabled-test-login',
      ]);
      await pool.query('INSERT INTO memberships(organization_id,user_id,role) VALUES($1,$2,$3)', [
        org,
        id,
        'student',
      ]);
      await pool.query(
        'INSERT INTO auth_sessions(id,token_hash,user_id,expires_at) VALUES($1,$2,$3,$4)',
        [
          randomUUID(),
          createHash('sha256').update(token).digest('hex'),
          id,
          new Date(Date.now() + 600000),
        ],
      );
      cookies.push('toaster_session=' + token);
    }
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    let delivered = 0,
      rejected = 0;
    const latency: number[] = [],
      start = performance.now();
    const baseline = process.memoryUsage().rss;
    loop.enable();
    for (let offset = 0; offset < count; offset += 25) {
      await Promise.all(
        cookies.slice(offset, offset + 25).map(
          (cookie) =>
            new Promise<void>((resolve) => {
              const at = performance.now();
              const socket = new WebSocket(
                address.replace('http', 'ws') + '/api/v1/classrooms/' + room + '/live',
                { headers: { origin: 'http://localhost:5173', cookie } },
              );
              sockets.push(socket);
              let settled = false;
              const finish = (ok: boolean) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                if (ok) latency.push(performance.now() - at);
                else rejected++;
                resolve();
              };
              const timer = setTimeout(() => {
                finish(false);
                socket.terminate();
              }, 15000);
              socket.on('message', (raw) => {
                const message = JSON.parse(raw.toString());
                if (message.type === 'ready') finish(true);
                if (message.type === 'capacity_probe') delivered++;
              });
              socket.on('error', () => finish(false));
            }),
        ),
      );
    }
    (app as unknown as { notifyClassroom: (id: string, type: string) => void }).notifyClassroom(
      room,
      'capacity_probe',
    );
    const deliveryStarted = performance.now();
    while (delivered < latency.length && performance.now() - deliveryStarted < 10000)
      await new Promise((resolve) => setTimeout(resolve, 25));
    latency.sort((a, b) => a - b);
    results.push({
      users: count,
      accepted: latency.length,
      rejected,
      delivered,
      connectMs: Math.round(performance.now() - start),
      connectP95Ms: Math.round(latency[Math.floor(latency.length * 0.95)] ?? 0),
      rssMiB: Math.round(process.memoryUsage().rss / 1048576),
      rssDeltaMiB: Math.round((process.memoryUsage().rss - baseline) / 1048576),
      eventLoopP99Ms: Math.round(loop.percentile(99) / 1e6),
      database: process.env.TEST_DATABASE_ENGINE ?? 'pg-mem',
      scope:
        'Authenticated WebSocket signaling only; no media, browser rendering or production capacity certification',
    });
    console.log(JSON.stringify(results.at(-1)));
  } finally {
    loop.disable();
    for (const socket of sockets) socket.terminate();
    await app.close();
    await cleanup();
  }
}
await writeFile(
  'test-results/classroom-capacity.json',
  JSON.stringify({ measuredAt: new Date().toISOString(), results }, null, 2),
);
