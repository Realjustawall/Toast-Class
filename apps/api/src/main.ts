import { config as loadEnv } from 'dotenv';
import { databaseFromEnvironment } from './database.js';
import { buildApp } from './app.js';
import { fileConfigFromEnvironment } from './file-config.js';
loadEnv({ path: new URL('../../../.env', import.meta.url) });
if (!process.env.DATABASE_URL)
  throw new Error('DATABASE_URL is required; copy .env.example and migrate first');
const pool = await databaseFromEnvironment();
const app = await buildApp(pool, {
  origin: process.env.APP_ORIGIN ?? 'http://localhost:5173',
  redisUrl:
    process.env.REDIS_URL === 'false'
      ? undefined
      : process.env.REDIS_URL || 'redis://127.0.0.1:6379',
  production: process.env.NODE_ENV === 'production',
  trustLocalProxy: process.env.TRUST_LOCAL_PROXY === 'true',
  mediaUrl: process.env.LIVEKIT_URL ?? 'ws://localhost:7880',
  mediaKey: process.env.LIVEKIT_API_KEY ?? '',
  mediaSecret: process.env.LIVEKIT_API_SECRET ?? '',
  files: fileConfigFromEnvironment(),
  presentationsEnabled: process.env.PRESENTATIONS_ENABLED === 'true',
});
await app.listen({
  port: Number(process.env.PORT ?? 3001),
  host: process.env.API_BIND_ADDRESS ?? '0.0.0.0',
});
console.log('TOASTER API listening on port ' + (process.env.PORT ?? 3001));
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
