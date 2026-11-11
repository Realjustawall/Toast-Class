import { z } from 'zod';
// Browser validation must work under a CSP that forbids dynamic JavaScript.
z.config({ jitless: true });
// Run before shared schema/editor modules are evaluated.
(window as unknown as { EXCALIDRAW_ASSET_PATH: string }).EXCALIDRAW_ASSET_PATH = '/excalidraw/';
