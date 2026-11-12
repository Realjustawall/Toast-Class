import { fileURLToPath } from 'node:url';
import { build, preview } from 'vite';

// Exercise the built offline runtime, avoiding development HMR during recovery tests.
const port = Number(process.env.TEST_WEB_PORT ?? 4175);
if (!Number.isInteger(port) || port <= 1024 || port > 65535)
  throw new Error('Invalid test web port');
await import(new URL('./prepare-offline-assets.mjs', import.meta.url).href);
process.chdir(fileURLToPath(new URL('../apps/web/', import.meta.url)));
await build(
  process.env.TEST_MEDIA_URL
    ? {
        build: {
          rollupOptions: {
            // Test-only instrumentation; normal npm run build never includes this entry.
            input: { app: 'index.html', probe: 'media-probe.html' },
          },
        },
      }
    : {},
);
const server = await preview({ preview: { host: '127.0.0.1', port, strictPort: true } });
server.printUrls();
for (const signal of ['SIGTERM', 'SIGINT'])
  process.on(signal, () => {
    server.httpServer.close(() => process.exit(0));
  });
