import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

// A fresh API and database schema per spec preserves production authentication
// rate limits without test backdoors or making later specs order dependent.
const kind = process.argv[2];
if (kind !== 'media' && kind !== 'e2e') throw new Error('Expected media or e2e');
const files = (await readdir('tests/' + kind)).filter((f) => f.endsWith('.spec.ts')).sort();
if (!files.length) throw new Error('No browser specs found');
let failed = false;
for (const file of files) {
  console.log('Running isolated browser spec: ' + kind + '/' + file);
  const code = await new Promise<number | null>((done, reject) => {
    const child = spawn(
      process.execPath,
      [
        resolve('node_modules/@playwright/test/cli.js'),
        'test',
        ...(kind === 'media' ? ['-c', 'playwright.media.config.ts'] : []),
        'tests/' + kind + '/' + file,
        '--output=test-results/' + kind + '/' + file.replace('.spec.ts', ''),
      ],
      { stdio: 'inherit', env: process.env },
    );
    child.on('error', reject);
    child.on('exit', done);
  });
  if (code !== 0) failed = true;
}
process.exitCode = failed ? 1 : 0;
