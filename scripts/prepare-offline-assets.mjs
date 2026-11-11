import { readFile, writeFile, mkdir, cp, readdir } from 'node:fs/promises';
import { prepareGeoGebra } from './prepare-geogebra.mjs';
import './prepare-login-design.mjs';
await prepareGeoGebra();
// The PDF renderer uses only local workers, CMaps, fonts and WASM assets.
for (const folder of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  const source = new URL('../node_modules/pdfjs-dist/' + folder + '/', import.meta.url);
  const target = new URL('../apps/web/public/pdfjs/' + folder + '/', import.meta.url);
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const bytes = await readFile(new URL(entry.name, source)),
      destination = new URL(entry.name, target);
    let old;
    try {
      old = await readFile(destination);
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (!old?.equals(bytes)) await writeFile(destination, bytes);
  }
}

const root = new URL('../', import.meta.url);
await mkdir(new URL('apps/web/public/media-effects/', root), { recursive: true });
const visionSource = new URL('node_modules/@mediapipe/tasks-vision/wasm/', root);
const visionOutput = new URL('apps/web/public/media-effects/wasm/', root);
await mkdir(visionOutput, { recursive: true });
for (const file of await readdir(visionSource, { withFileTypes: true })) {
  if (!file.isFile()) continue;
  const source = await readFile(new URL(file.name, visionSource));
  const target = new URL(file.name, visionOutput);
  let current;
  try {
    current = await readFile(target);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  // Rewriting identical public assets reloads every live Vite classroom and
  // interrupts active WebRTC captures when another preview/test starts.
  if (!current?.equals(source)) await writeFile(target, source);
}
await mkdir(new URL('apps/web/public/excalidraw/', root), { recursive: true });
await cp(
  new URL('node_modules/@excalidraw/excalidraw/dist/prod/fonts/', root),
  new URL('apps/web/public/excalidraw/fonts/', root),
  { recursive: true, force: false },
);
const output = new URL('apps/web/public/intro/', root);
await mkdir(output, { recursive: true });
const original = await readFile(new URL('toaster-works.html', root), 'utf8');
const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; base-uri 'none'; form-action 'none'">`;
const bridge = `<style>.chrome,.status,.progress{display:none!important}body{pointer-events:none}</style><script>
// Loader integration: no audio initialization, no synthetic loading progress.
muted=true;lastCue=cues.length;elapsed=0;origin=performance.now();
const reduced=matchMedia('(prefers-reduced-motion: reduce)');
playing=!reduced.matches;renderAt(reduced.matches?16.5:0);
reduced.addEventListener('change',()=>{playing=!reduced.matches;origin=performance.now();elapsed=0;renderAt(reduced.matches?16.5:0)});
addEventListener('pagehide',()=>{playing=false;stopSounds();renderer.dispose()});
</script>`;
const target = new URL('toaster-works.html', output);
const generated = original
  // This intro runs beside connection recovery on mobile and software GPUs.
  // Bound drawing cost while retaining the original scene and time-based motion.
  .replace(
    'renderer.setPixelRatio(Math.min(devicePixelRatio,2))',
    'renderer.setPixelRatio(Math.min(devicePixelRatio,1.25))',
  )
  .replace('key.shadow.mapSize.set(2048,2048)', 'key.shadow.mapSize.set(1024,1024)')
  .replace(
    'if(!playing)return;elapsed=',
    'if(!playing||now-lastFrame<1000/30)return;lastFrame=now;elapsed=',
  )
  .replace(/<head>/i, '<head>' + policy)
  .replace(/<\/body>/i, bridge + '</body>');
let existing;
try {
  existing = await readFile(target, 'utf8');
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
// Avoid interrupting a user's preview when another build/test prepares identical assets.
if (existing !== generated) await writeFile(target, generated);
console.log('Prepared local TOASTER WORKS animation.');
