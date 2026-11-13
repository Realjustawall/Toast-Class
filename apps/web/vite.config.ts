import { defineConfig } from 'vite';
import type { Connect } from 'vite';
import { fileURLToPath } from 'node:url';
import { localExcalidrawFonts } from './offline-excalidraw';

const isolatedAssetsMiddleware: Connect.NextHandleFunction = (req, res, next) => {
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
  } catch {
    res.statusCode = 400;
    res.end('Invalid URL');
    return;
  }
  const mathAsset = path.startsWith('/vendor/geogebra/') || path.startsWith('/geogebra/');
  if (
    path.startsWith('/@fs/') &&
    /(?:^|\/)(?:\.env(?:\.|$)|\.git(?:\/|$)|\.local(?:\/|$)|\.aws(?:\/|$))/i.test(path)
  ) {
    res.statusCode = 403;
    res.end('Forbidden');
    return;
  }
  const mathHost = req.headers.host?.split(':')[0] === 'geogebra.localhost';
  if ((mathHost && !mathAsset) || (!mathHost && mathAsset)) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }
  if (mathAsset) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  }
  next();
};

export default defineConfig({
  plugins: [
    {
      name: 'local-excalidraw-fonts',
      enforce: 'pre',
      transform: localExcalidrawFonts,
    },
    {
      name: 'isolated-geogebra-assets',
      configureServer(server) {
        server.middlewares.use(isolatedAssetsMiddleware);
      },
      configurePreviewServer(server) {
        server.middlewares.use(isolatedAssetsMiddleware);
      },
    },
  ],
  resolve: { dedupe: ['react', 'react-dom'] },
  optimizeDeps: {
    include: [
      'livekit-client',
      '@livekit/components-react',
      '@livekit/components-core',
      'react',
      'react-dom/client',
      'i18next',
      'react-i18next',
      'yjs',
      '@excalidraw/excalidraw',
      'pdfjs-dist',
      'pdf-lib',
    ],
  },
  server: {
    fs: {
      strict: true,
      allow: [
        fileURLToPath(new URL('.', import.meta.url)),
        fileURLToPath(new URL('../../node_modules/', import.meta.url)),
        fileURLToPath(new URL('../../packages/whiteboard/', import.meta.url)),
        fileURLToPath(new URL('../../packages/classroom-settings/', import.meta.url)),
      ],
      deny: [
        '**/.local/**',
        '**/.git/**',
        '**/.aws/**',
        '**/.codex/**',
        '**/.agents/**',
        '**/.env',
        '**/.env.*',
        '**/*.env',
        '**/*.{crt,pem,key}',
      ],
    },
    proxy: {
      '/api': { target: process.env.TOASTER_API_TARGET ?? 'http://127.0.0.1:3001', ws: true },
    },
  },
});
