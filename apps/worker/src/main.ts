import { config as loadEnv } from 'dotenv';
import { databaseFromEnvironment } from '../../api/src/database.js';
import { setTimeout as delay } from 'node:timers/promises';
import { fileConfigFromEnvironment } from '../../api/src/file-config.js';
import { DockerDocumentConverter } from './conversion.js';
import { PresentationWorker } from './presentation-worker.js';

loadEnv({ path: new URL('../../../.env', import.meta.url) });
if (process.platform !== 'linux')
  throw new Error('Run the trusted conversion worker on a Linux Docker host');
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
if (process.env.PRESENTATIONS_ENABLED !== 'true')
  throw new Error('Set PRESENTATIONS_ENABLED=true after configuring the converter image');
const files = fileConfigFromEnvironment();
if (!files.storage || (!files.scanner && !files.allowUnscanned))
  throw new Error(
    'Private storage and a scanner are required (development may explicitly allow unscanned files)',
  );
const pool = await databaseFromEnvironment();
const converter = new DockerDocumentConverter(
  process.env.CONVERSION_IMAGE ?? 'toaster-converter',
  process.env.CONVERSION_WORK_DIR,
);
const worker = new PresentationWorker(pool, files, converter);
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    stopping = true;
  });
console.log(JSON.stringify({ level: 'info', event: 'presentation_worker.started' }));
try {
  while (!stopping) {
    let processed = false;
    try {
      processed = await worker.once();
    } catch {
      console.error(
        JSON.stringify({ level: 'error', event: 'presentation_worker.operation_failed' }),
      );
    }
    if (!processed && !stopping) await delay(2000);
  }
} finally {
  await pool.end();
  files.storage.close?.();
}
