import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabase, hasRealDatabase } from './database';
import { buildApp } from '../apps/api/src/app';
import { defaultUserPreferences } from '../packages/user-preferences';
test('personal tool and sound preferences persist per account, enforce fresh revisions and reject unauthorized settings', async () => {
  const { pool, cleanup } = await testDatabase(),
    origin = 'http://localhost:5173',
    app = await buildApp(pool, {
      origin,
      production: false,
      mediaUrl: '',
      mediaKey: '',
      mediaSecret: '',
    });
  const post = (path: string, payload: object, cookie = '') =>
      app.inject({ method: 'POST', url: '/api/v1' + path, headers: { origin, cookie }, payload }),
    get = (cookie = '') =>
      app.inject({ method: 'GET', url: '/api/v1/account/preferences', headers: { cookie } });
  try {
    const account = async (name: string) => {
      const email = name + '@preferences.test';
      assert.equal(
        (await post('/auth/register', { name, email, password: '123456' })).statusCode,
        201,
      );
      const login = await post('/auth/login', { email, password: '123456' });
      return String(login.headers['set-cookie']).split(';')[0];
    };
    assert.equal((await get()).statusCode, 401);
    const owner = await account('Owner'),
      other = await account('Other');
    const initial = (await get(owner)).json();
    assert.equal(initial.revision, 0);
    const preferences = structuredClone(defaultUserPreferences);
    preferences.tools.pen.width = 7.3;
    preferences.tools.eraserSize = 83;
    preferences.tools.text.fontSize = 41.5;
    preferences.tools.text.fontFamily = 6;
    preferences.layouts = {
      'classic-bbb': { people: 240, chat: 280, mediaHeight: 144, mediaWidth: 208, text: 18 },
    };
    preferences.tools.text.color = '#b91c1c';
    preferences.sounds.volume = 0.37;
    preferences.sounds.devices = false;
    preferences.language = 'en';
    const saved = await post('/account/preferences', { revision: 0, preferences }, owner);
    assert.equal(saved.statusCode, 200);
    assert.equal(saved.json().revision, 1);
    assert.deepEqual((await get(owner)).json().preferences, preferences);
    assert.deepEqual((await get(other)).json().preferences, defaultUserPreferences);
    assert.equal(
      (
        await post(
          '/account/preferences',
          { revision: 0, preferences: defaultUserPreferences },
          owner,
        )
      ).statusCode,
      409,
    );
    assert.deepEqual((await get(owner)).json().preferences, preferences);
    assert.equal(
      (
        await post(
          '/account/preferences',
          { revision: 1, preferences, userId: 'another-user' },
          owner,
        )
      ).statusCode,
      400,
    );
    const invalid = structuredClone(preferences);
    invalid.tools.eraserSize = 0;
    assert.equal(
      (await post('/account/preferences', { revision: 1, preferences: invalid }, owner)).statusCode,
      400,
    );
    invalid.tools.eraserSize = 201;
    assert.equal(
      (await post('/account/preferences', { revision: 1, preferences: invalid }, owner)).statusCode,
      400,
    );
    assert.equal(
      (
        await app.inject({
          method: 'POST',
          url: '/api/v1/account/preferences',
          headers: { origin: 'https://evil.example', cookie: owner },
          payload: { revision: 1, preferences },
        })
      ).statusCode,
      403,
    );
    const next = await post(
      '/account/preferences',
      {
        revision: 1,
        preferences: {
          ...preferences,
          tools: { ...preferences.tools, pen: { ...preferences.tools.pen, color: '#2563eb' } },
        },
      },
      owner,
    );
    assert.equal(next.statusCode, 200);
    assert.equal((await get(owner)).json().revision, 2);
    assert.equal(
      (
        await post(
          '/account/preferences',
          {
            revision: 2,
            preferences: {
              ...preferences,
              tools: { ...preferences.tools, text: { ...preferences.tools.text, fontFamily: 4 } },
            },
          },
          owner,
        )
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await post(
          '/account/preferences',
          {
            revision: 2,
            preferences: {
              ...preferences,
              layouts: {
                'unknown-theme': {
                  people: 240,
                  chat: 280,
                  mediaHeight: 144,
                  mediaWidth: 208,
                  text: 18,
                },
              },
            },
          },
          owner,
        )
      ).statusCode,
      400,
    );
    if (hasRealDatabase) {
      const saves = await Promise.all([
        post('/account/preferences', { revision: 2, preferences }, owner),
        post(
          '/account/preferences',
          {
            revision: 2,
            preferences: { ...preferences, sounds: { ...preferences.sounds, volume: 0.81 } },
          },
          owner,
        ),
      ]);
      assert.deepEqual(saves.map((r) => r.statusCode).sort(), [200, 409]);
      const winner = saves.find((r) => r.statusCode === 200)!;
      assert.deepEqual((await get(owner)).json().preferences, winner.json().preferences);
      assert.equal((await get(owner)).json().revision, 3);
    }
  } finally {
    await app.close();
    await cleanup();
  }
});
