import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { localExcalidrawFonts } from '../apps/web/offline-excalidraw';
test('locked Excalidraw build removes its CDN fallback while retaining local font loading', async () => {
  const directory = 'node_modules/@excalidraw/excalidraw/dist/prod/';
  let changed = 0;
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.js')) continue;
    const source = await readFile(directory + file, 'utf8'),
      result = localExcalidrawFonts(source, '/' + directory + file);
    if (result) {
      changed++;
      assert.ok(result.includes('window.EXCALIDRAW_ASSET_PATH'));
      assert.ok(
        !/return (\w+)\.push\(new URL\((\w+),(\w+)\.ASSETS_FALLBACK_URL\)\),\1/.test(result),
      );
    }
  }
  assert.equal(changed, 1, 'Review the offline font transform when upgrading Excalidraw');
  assert.equal(localExcalidrawFonts('unrelated', '/src/app.ts'), undefined);
});
