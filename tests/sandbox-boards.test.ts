import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';
import { buildApp } from '../apps/api/src/app.js';
import { buildSandboxSrcDoc } from '../apps/web/src/sandbox-bundle.js';
import { testDatabase } from './database.js';

const require = createRequire(import.meta.url);
const yazl = require('yazl') as {
  ZipFile: new () => {
    addBuffer: (buf: Buffer, metadataPath: string) => void;
    end: () => void;
    outputStream: NodeJS.ReadableStream;
  };
};

function makeZip(entries: Record<string, string | Buffer>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('error', reject);
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, content] of Object.entries(entries)) {
      zip.addBuffer(typeof content === 'string' ? Buffer.from(content, 'utf8') : content, name);
    }
    zip.end();
  });
}

test('sandbox boards: upload HTML/ZIP, enforce strict security & permissions, and build isolated srcDoc', async () => {
  const db = await testDatabase();
  const app = await buildApp(db.pool, {
    origin: 'http://localhost:5173',
    production: false,
    mediaUrl: '',
    mediaKey: '',
    mediaSecret: '',
    mediaWorker: false,
  });

  try {
    const teacherCookie = await (async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: { origin: 'http://localhost:5173' },
        payload: { email: 'sb-teacher@test.local', name: 'Teacher', password: 'password123' },
      });
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: 'http://localhost:5173' },
        payload: { email: 'sb-teacher@test.local', password: 'password123' },
      });
      return login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    })();

    const studentCookie = await (async () => {
      await app.inject({
        method: 'POST',
        url: '/api/v1/auth/register',
        headers: { origin: 'http://localhost:5173' },
        payload: { email: 'sb-student@test.local', name: 'Student', password: 'password123' },
      });
      const login = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        headers: { origin: 'http://localhost:5173' },
        payload: { email: 'sb-student@test.local', password: 'password123' },
      });
      return login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    })();

    const org = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/organizations',
        headers: { origin: 'http://localhost:5173', cookie: teacherCookie },
        payload: { name: 'Sandbox Org' },
      })
    ).json();

    await app.inject({
      method: 'POST',
      url: `/api/v1/organizations/${org.id}/members`,
      headers: { origin: 'http://localhost:5173', cookie: teacherCookie },
      payload: { email: 'sb-student@test.local', role: 'student' },
    });

    const room = (
      await app.inject({
        method: 'POST',
        url: `/api/v1/organizations/${org.id}/classrooms`,
        headers: { origin: 'http://localhost:5173', cookie: teacherCookie },
        payload: { name: 'Sandbox Room', enrollmentMode: 'organization' },
      })
    ).json();

    // 1. Upload single HTML file with attempted CSP/base bypass
    const htmlPayload = `<!doctype html><html><head><base href="https://evil.example/"><meta http-equiv="Content-Security-Policy" content="default-src *"><title>Demo</title></head><body><h1 id="out">Hi</h1><script>document.getElementById('out').textContent='Ran';</script></body></html>`;
    const createHtml = await app.inject({
      method: 'POST',
      url: `/api/v1/classrooms/${room.id}/sandbox`,
      headers: { origin: 'http://localhost:5173', cookie: teacherCookie },
      payload: {
        name: 'Single HTML Demo',
        fileName: 'demo.html',
        contentBase64: Buffer.from(htmlPayload, 'utf8').toString('base64'),
      },
    });
    assert.equal(createHtml.statusCode, 201);
    const htmlBoard = createHtml.json();

    // 2. Student cannot upload or delete
    const studentUpload = await app.inject({
      method: 'POST',
      url: `/api/v1/classrooms/${room.id}/sandbox`,
      headers: { origin: 'http://localhost:5173', cookie: studentCookie },
      payload: {
        name: 'Evil',
        fileName: 'evil.html',
        contentBase64: Buffer.from('<h1>x</h1>', 'utf8').toString('base64'),
      },
    });
    assert.equal(studentUpload.statusCode, 403);

    // 3. Reject unsupported file types inside ZIP
    const badZip = await makeZip({
      'index.html': '<h1>Hi</h1>',
      'shell.php': '<?php echo 1; ?>',
    });
    const badZipRes = await app.inject({
      method: 'POST',
      url: `/api/v1/classrooms/${room.id}/sandbox`,
      headers: { origin: 'http://localhost:5173', cookie: teacherCookie },
      payload: {
        name: 'Bad ZIP',
        fileName: 'bad.zip',
        contentBase64: badZip.toString('base64'),
      },
    });
    assert.equal(badZipRes.statusCode, 400);

    // 4. Reject path traversal inside ZIP
    const rawTraversalZip = await makeZip({
      'aa/escape.html': '<h1>Escape</h1>',
    });
    const traversalZip = Buffer.from(
      rawTraversalZip.toString('latin1').replaceAll('aa/escape.html', '../escape.html'),
      'latin1',
    );
    const traversalRes = await app.inject({
      method: 'POST',
      url: `/api/v1/classrooms/${room.id}/sandbox`,
      headers: { origin: 'http://localhost:5173', cookie: teacherCookie },
      payload: {
        name: 'Traversal ZIP',
        fileName: 'traversal.zip',
        contentBase64: traversalZip.toString('base64'),
      },
    });
    assert.equal(traversalRes.statusCode, 400);

    // 5. Upload valid multi-file ZIP (with common top-level directory)
    const validZip = await makeZip({
      'project/index.html':
        '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head><body><div id="app">0</div><script src="app.js"></script></body></html>',
      'project/style.css': 'body { color: rgb(10, 20, 30); }',
      'project/app.js': "document.getElementById('app').textContent = '42';",
    });
    const createZip = await app.inject({
      method: 'POST',
      url: `/api/v1/classrooms/${room.id}/sandbox`,
      headers: { origin: 'http://localhost:5173', cookie: teacherCookie },
      payload: {
        name: 'ZIP App',
        fileName: 'project.zip',
        contentBase64: validZip.toString('base64'),
      },
    });
    assert.equal(createZip.statusCode, 201);
    const zipBoard = createZip.json();

    // 6. Switch shared classroom workspace to the ZIP sandbox board
    const switchWs = await app.inject({
      method: 'POST',
      url: `/api/v1/classrooms/${room.id}/workspace`,
      headers: { origin: 'http://localhost:5173', cookie: teacherCookie },
      payload: {
        kind: 'sandbox',
        sandboxId: zipBoard.id,
        expectedRevision: 0,
      },
    });
    assert.equal(switchWs.statusCode, 200, switchWs.body);
    assert.equal(switchWs.json().kind, 'sandbox');
    assert.equal(switchWs.json().sandboxId, zipBoard.id);

    // 7. Fetch board and verify srcDoc isolation & inlining
    const fetchedHtml = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/classrooms/${room.id}/sandbox/${htmlBoard.id}`,
        headers: { cookie: studentCookie },
      })
    ).json();
    const isolatedHtml = buildSandboxSrcDoc(fetchedHtml.bundle);
    assert.ok(isolatedHtml.includes("connect-src 'none'"));
    assert.ok(isolatedHtml.includes("default-src 'none'"));
    assert.equal(isolatedHtml.includes('evil.example'), false);
    assert.equal(isolatedHtml.includes('default-src *'), false);

    const fetchedZip = (
      await app.inject({
        method: 'GET',
        url: `/api/v1/classrooms/${room.id}/sandbox/${zipBoard.id}`,
        headers: { cookie: studentCookie },
      })
    ).json();
    const isolatedZip = buildSandboxSrcDoc(fetchedZip.bundle);
    assert.ok(isolatedZip.includes('<style>body { color: rgb(10, 20, 30); }</style>'));
    assert.ok(
      isolatedZip.includes("<script>document.getElementById('app').textContent = '42';</script>"),
    );

    // 8. Delete board
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/classrooms/${room.id}/sandbox/${htmlBoard.id}`,
      headers: { origin: 'http://localhost:5173', cookie: teacherCookie },
    });
    assert.equal(delRes.statusCode, 200);
  } finally {
    await app.close();
    await db.cleanup();
  }
});
