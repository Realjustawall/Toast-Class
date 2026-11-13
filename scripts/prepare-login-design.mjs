import { readFile, writeFile, mkdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url),
  output = new URL('apps/web/public/intro/', root);
await mkdir(output, { recursive: true });
const source = await readFile(new URL('LOGIN DESIGN/toaster-3d.js', root), 'utf8');
const files = {
  'login-toaster-3d.js': source
    .replace(
      'const duration = 17.8;',
      "const duration = 17.8;\n  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');\n  const reduceMotion = motionQuery.matches;\n  window.playing = !reduceMotion;",
    )
    .replace(
      'let origin = performance.now();',
      "let origin = performance.now() - (reduceMotion ? duration * 1000 : 0);\n  motionQuery.addEventListener('change', (event) => {\n    if (event.matches) {\n      currentElapsed = duration;\n      animationFinished = true;\n      window.playing = false;\n      renderAt(duration);\n    }\n  });",
    )
    .replace('function loop(now) {', 'function loop(now) {\n    if (animationFinished) return;')
    .replace(
      'animationFinished = true;',
      'animationFinished = true;\n      window.playing = false;',
    ),
  'login-scene-config.js':
    "document.documentElement.dataset.theme = location.hash === '#light' ? 'light' : 'dark';\n",
  'login-scene.html':
    '<!doctype html><html data-theme="dark"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'self\'; style-src \'unsafe-inline\'; img-src data: blob:; connect-src \'none\'; base-uri \'none\'"><title>TOASTER</title><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}#toaster-3d-mount{width:100%;height:100%}canvas{display:block;width:100%;height:100%}</style><div id="toaster-3d-mount"></div><script src="/intro/login-scene-config.js"></script><script src="/intro/login-toaster-3d.js"></script></html>',
};
for (const [name, value] of Object.entries(files)) {
  const target = new URL(name, output);
  let old;
  try {
    old = await readFile(target, 'utf8');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  if (old !== value) await writeFile(target, value);
}
