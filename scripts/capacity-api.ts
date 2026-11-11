// Owned API child for the isolated native MySQL/media capacity benchmark.
import { MySqlDatabase } from '../apps/api/src/database';
import { buildApp } from '../apps/api/src/app';

const pool = new MySqlDatabase(process.env.DATABASE_URL!);
const app = await buildApp(pool, {
  origin: process.env.APP_ORIGIN!,
  production: false,
  mediaUrl: process.env.LIVEKIT_URL!,
  mediaKey: process.env.LIVEKIT_API_KEY!,
  mediaSecret: process.env.LIVEKIT_API_SECRET!,
});
app.addHook('onError', async (_request, _reply, error) => {
  const detail = error as Error & { code?: string; sqlState?: string };
  console.error(
    'Capacity API error:',
    JSON.stringify({
      name: detail.name,
      code: detail.code,
      sqlState: detail.sqlState,
      message: /queue|connection|timeout|deadlock/i.test(detail.message)
        ? detail.message.slice(0, 180)
        : undefined,
    }),
  );
});
await app.listen({ host: '127.0.0.1', port: Number(process.env.PORT) });
process.send?.({ type: 'ready' });
let stopping = false;
process.on('message', async (message) => {
  if (
    !message ||
    typeof message !== 'object' ||
    !('type' in message) ||
    message.type !== 'shutdown' ||
    stopping
  )
    return;
  stopping = true;
  await app.close();
  await pool.end();
  process.exit(0);
});
