import { test } from 'node:test';
import assert from 'node:assert/strict';
import en from '../apps/web/src/locales/en';
import fa from '../apps/web/src/locales/fa';
test('Persian UI translations cover all English keys and contain readable Persian Unicode', () => {
  assert.deepEqual(Object.keys(fa).sort(), Object.keys(en).sort());
  for (const [key, value] of Object.entries(fa)) {
    assert.match(value, /[\u0600-\u06ff]/, 'Missing Persian text: ' + key);
    assert.doesNotMatch(value, /\?{2,}|\ufffd/, 'Corrupted translation: ' + key);
  }
});
