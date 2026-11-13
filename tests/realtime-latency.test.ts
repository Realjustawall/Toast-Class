import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { buildApp } from '../apps/api/src/app';
import { testDatabase } from './database';

const MAX_LATENCY_MS = 500;

test(
  'presenter-to-viewer realtime payloads (chat, board, document, presence, presentation) arrive under 500ms',
  { timeout: 30000 },
  async () => {
    const { pool, cleanup } = await testDatabase();
    const origin = 'http://localhost:5173';
    const app = await buildApp(pool, {
      origin,
      production: false,
      mediaUrl: '',
      mediaKey: '',
      mediaSecret: '',
      mediaWorker: false,
      breakoutWorker: false,
    });

    const post = (path: string, body: unknown, cookie = '') =>
      app.inject({
        method: 'POST',
        url: '/api/v1' + path,
        headers: { origin, cookie, 'content-type': 'application/json' },
        payload: JSON.stringify(body),
      });

    const get = (path: string, cookie = '') =>
      app.inject({
        method: 'GET',
        url: '/api/v1' + path,
        headers: { cookie },
      });

    let teacherLive: WebSocket | undefined;
    let studentLive: WebSocket | undefined;
    let teacherPresence: WebSocket | undefined;
    let studentPresence: WebSocket | undefined;

    try {
      const tEmail = randomUUID() + '@presenter.test';
      const sEmail = randomUUID() + '@viewer.test';
      const password = 'realtime-latency-password';
      const teacherReg = await post('/auth/register', {
        email: tEmail,
        password,
        name: 'Presenter',
      });
      assert.equal(teacherReg.statusCode, 201);
      const teacherId = String(teacherReg.json().id);
      assert.equal(
        (await post('/auth/register', { email: sEmail, password, name: 'Viewer' })).statusCode,
        201,
      );

      const tCookie = String(
        (await post('/auth/login', { email: tEmail, password })).headers['set-cookie'],
      ).split(';')[0];
      const sCookie = String(
        (await post('/auth/login', { email: sEmail, password })).headers['set-cookie'],
      ).split(';')[0];

      const org = (await post('/organizations', { name: 'Latency Org' }, tCookie)).json();
      assert.equal(
        (
          await post(
            `/organizations/${org.id}/members`,
            { email: sEmail, role: 'student' },
            tCookie,
          )
        ).statusCode,
        201,
      );
      const room = (
        await post(
          `/organizations/${org.id}/classrooms`,
          {
            enrollmentMode: 'organization',
            name: 'Latency Room',
            permissions: { studentWhiteboardEnabled: true },
          },
          tCookie,
        )
      ).json();

      const sessionRes = await post(`/classrooms/${room.id}/session/start`, {}, tCookie);
      assert.equal(sessionRes.statusCode, 201);
      const teachingState = (await get(`/classrooms/${room.id}/teaching`, tCookie)).json();
      const sessionId = String(teachingState.session.id);

      const boardDoc = (
        await post(
          `/classrooms/${room.id}/documents`,
          { kind: 'board', name: 'Adv Board', boardFormat: 'excalidraw' },
          tCookie,
        )
      ).json();
      const legacyDoc = (
        await post(
          `/classrooms/${room.id}/documents`,
          { kind: 'notes', name: 'Notes', boardFormat: 'legacy' },
          tCookie,
        )
      ).json();

      const boardState = (
        await get(`/classrooms/${room.id}/documents/${boardDoc.id}/board`, tCookie)
      ).json();

      const presentationId = randomUUID();
      const sourceFileId = randomUUID();
      await pool.query(
        "INSERT INTO files(id,organization_id,classroom_id,name,original_name,object_key,byte_size,sha256,media_type,status,scan_status,purpose,uploaded_by) VALUES($1,$2,$3,'slides.pdf','slides.pdf',$4,100,$5,'application/pdf','ready','clean','presentation',$6)",
        [sourceFileId, org.id, room.id, randomUUID(), '0'.repeat(64), teacherId],
      );
      await pool.query(
        "INSERT INTO presentations(id,organization_id,classroom_id,source_file_id,name,status,generation,page_count,reserved_bytes,created_by) VALUES($1,$2,$3,$4,'Deck','ready',$5,5,0,$6)",
        [presentationId, org.id, room.id, sourceFileId, randomUUID(), teacherId],
      );

      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const wsBase = address.replace('http:', 'ws:');

      const connectWS = (path: string, cookie: string) =>
        new Promise<WebSocket>((resolve, reject) => {
          const ws = new WebSocket(wsBase + '/api/v1' + path, { headers: { origin, cookie } });
          const timer = setTimeout(() => reject(new Error('WS connect timeout: ' + path)), 5000);
          ws.on('message', function onMsg(data) {
            const parsed = JSON.parse(data.toString());
            if (parsed.type === 'ready') {
              clearTimeout(timer);
              ws.off('message', onMsg);
              resolve(ws);
            }
          });
          ws.on('error', (err) => {
            clearTimeout(timer);
            reject(err);
          });
        });

      teacherLive = await connectWS(`/classrooms/${room.id}/live`, tCookie);
      studentLive = await connectWS(`/classrooms/${room.id}/live`, sCookie);
      teacherPresence = await connectWS(
        `/classrooms/${room.id}/documents/${boardDoc.id}/board/presence/live?clientId=${randomUUID()}`,
        tCookie,
      );
      studentPresence = await connectWS(
        `/classrooms/${room.id}/documents/${boardDoc.id}/board/presence/live?clientId=${randomUUID()}`,
        sCookie,
      );

      const waitEvent = (ws: WebSocket, predicate: (msg: Record<string, unknown>) => boolean) =>
        new Promise<Record<string, unknown>>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Timeout waiting for WS event')), 5000);
          const onMsg = (raw: WebSocket.RawData) => {
            const msg = JSON.parse(raw.toString()) as Record<string, unknown>;
            if (predicate(msg)) {
              clearTimeout(timer);
              ws.off('message', onMsg);
              resolve(msg);
            }
          };
          ws.on('message', onMsg);
        });

      // 1. Chat
      const chatWait = waitEvent(studentLive, (m) => m.type === 'chat_changed' && !!m.message);
      const t0Chat = performance.now();
      const chatRes = await post(
        `/classrooms/${room.id}/messages`,
        { body: 'ping-under-500ms' },
        tCookie,
      );
      assert.equal(chatRes.statusCode, 201);
      const chatMsg = await chatWait;
      const chatMs = performance.now() - t0Chat;
      assert.equal((chatMsg.message as Record<string, unknown>).body, 'ping-under-500ms');
      assert.ok(
        chatMs < MAX_LATENCY_MS,
        `Chat latency ${chatMs.toFixed(1)}ms exceeded ${MAX_LATENCY_MS}ms`,
      );

      // 2. Excalidraw Whiteboard
      const ydoc = new Y.Doc();
      ydoc.getMap('elements').set('el-1', {
        id: 'el-1',
        type: 'rectangle',
        x: 10,
        y: 20,
        width: 100,
        height: 50,
        angle: 0,
        strokeColor: '#000000',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        seed: 1,
        version: 1,
        versionNonce: 1,
        isDeleted: false,
        boundElements: null,
        updated: Date.now(),
        link: null,
        locked: false,
      });
      const boardUpdate = Buffer.from(Y.encodeStateAsUpdate(ydoc)).toString('base64');
      ydoc.destroy();

      const boardWait = waitEvent(
        studentLive,
        (m) =>
          m.type === 'board_changed' &&
          m.documentId === boardDoc.id &&
          typeof m.update === 'string',
      );
      const t0Board = performance.now();
      const boardRes = await post(
        `/classrooms/${room.id}/documents/${boardDoc.id}/board/updates`,
        { id: randomUUID(), generation: boardState.generation, update: boardUpdate },
        tCookie,
      );
      assert.equal(boardRes.statusCode, 200);
      const boardMsg = await boardWait;
      const boardMs = performance.now() - t0Board;
      assert.equal(boardMsg.revision, 1);
      assert.ok(
        boardMs < MAX_LATENCY_MS,
        `Board latency ${boardMs.toFixed(1)}ms exceeded ${MAX_LATENCY_MS}ms`,
      );

      // 3. Legacy Document / Notes
      const ldoc = new Y.Doc();
      ldoc.getText('content').insert(0, 'Fast notes');
      const legacyUpdate = Buffer.from(Y.encodeStateAsUpdate(ldoc)).toString('base64');
      ldoc.destroy();
      const legacyUpdateId = randomUUID();

      const legacyWait = waitEvent(
        studentLive,
        (m) =>
          m.type === 'document_changed' &&
          m.documentId === legacyDoc.id &&
          m.updateId === legacyUpdateId,
      );
      const t0Legacy = performance.now();
      const legacyRes = await post(
        `/classrooms/${room.id}/documents/${legacyDoc.id}/updates`,
        { id: legacyUpdateId, update: legacyUpdate },
        tCookie,
      );
      assert.equal(legacyRes.statusCode, 200);
      await legacyWait;
      const legacyMs = performance.now() - t0Legacy;
      assert.ok(
        legacyMs < MAX_LATENCY_MS,
        `Document latency ${legacyMs.toFixed(1)}ms exceeded ${MAX_LATENCY_MS}ms`,
      );

      // 4. Cursor / Laser Presence
      const presenceWait = waitEvent(
        studentPresence,
        (m) => m.type === 'presence_changed' && Array.isArray(m.peers) && m.peers.length > 0,
      );
      const t0Presence = performance.now();
      teacherPresence.send(
        JSON.stringify({
          generation: boardState.generation,
          pointer: { x: 123, y: 456, tool: 'laser' },
          button: 'down',
        }),
      );
      const presenceMsg = await presenceWait;
      const presenceMs = performance.now() - t0Presence;
      assert.equal((presenceMsg.peers as { pointer: { x: number } }[])[0].pointer.x, 123);
      assert.ok(
        presenceMs < MAX_LATENCY_MS,
        `Presence latency ${presenceMs.toFixed(1)}ms exceeded ${MAX_LATENCY_MS}ms`,
      );

      // 5. Presentation Slide Change
      const presWait = waitEvent(
        studentLive,
        (m) =>
          m.type === 'presentation_changed' &&
          !!m.current &&
          (m.current as { page: number }).page === 3,
      );
      const t0Pres = performance.now();
      const presRes = await post(
        `/classrooms/${room.id}/presentations/control`,
        {
          action: 'show',
          sessionId,
          presentationId,
          page: 3,
          independentView: false,
          expectedRevision: 0,
        },
        tCookie,
      );
      assert.equal(presRes.statusCode, 200);
      await presWait;
      const presMs = performance.now() - t0Pres;
      assert.ok(
        presMs < MAX_LATENCY_MS,
        `Presentation latency ${presMs.toFixed(1)}ms exceeded ${MAX_LATENCY_MS}ms`,
      );

      console.log(
        `Latency check passed -> chat: ${chatMs.toFixed(1)}ms, board: ${boardMs.toFixed(1)}ms, doc: ${legacyMs.toFixed(1)}ms, presence: ${presenceMs.toFixed(1)}ms, slide: ${presMs.toFixed(1)}ms`,
      );
    } finally {
      teacherLive?.terminate();
      studentLive?.terminate();
      teacherPresence?.terminate();
      studentPresence?.terminate();
      await app.close();
      await cleanup();
    }
  },
);
