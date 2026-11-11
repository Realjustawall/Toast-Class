import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readJsonResponse, ResponseError } from '../apps/web/src/http-response';
test('rate limits carry a bounded Retry-After and a localizable error code', async () => {
  await assert.rejects(
    readJsonResponse(
      new Response('{"error":"Rate limit exceeded"}', {
        status: 429,
        headers: { 'Retry-After': '7' },
      }),
    ),
    (error: unknown) =>
      error instanceof ResponseError &&
      error.message === 'requestRateLimited' &&
      error.retryAfterMs === 7000,
  );
});

test('empty, proxy HTML and truncated responses produce actionable errors without blind mutation retry', async () => {
  for (const body of ['', '<html>Bad gateway</html>', '{"error":']) {
    await assert.rejects(
      readJsonResponse(new Response(body, { status: 502 })),
      (e: unknown) =>
        e instanceof ResponseError &&
        e.code === 'serverUnavailable' &&
        !e.message.includes('<html>'),
    );
  }
  await assert.rejects(
    readJsonResponse(new Response('', { status: 201 })),
    (e: unknown) => e instanceof ResponseError && e.code === 'incompleteResponse',
  );
  await assert.rejects(
    readJsonResponse(new Response('{"error":"Invalid credentials"}', { status: 401 })),
    /Invalid credentials/,
  );
  assert.deepEqual(await readJsonResponse(new Response('{"id":"persisted"}', { status: 201 })), {
    id: 'persisted',
  });
  assert.equal(await readJsonResponse(new Response(null, { status: 204 })), undefined);
});
