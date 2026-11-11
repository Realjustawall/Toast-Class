import { readdir, readFile, lstat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
const rootFiles = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'tsconfig.server.json',
  'playwright.config.ts',
  'playwright.media.config.ts',
  'playwright.owned.config.ts',
  '.npmrc',
  '.gitignore',
  '.dockerignore',
  '.prettierrc.json',
  '.prettierignore',
  '.env.example',
  'LICENSE',
  'README.md',
  'README.fa.md',
  'toaster-works.html',
  'install.sh',
]);
// Operational histories and local verification reports remain private. Public
// distributions contain only the reviewed deployment/security/license guides.
const releaseDocs = new Set(['INSTALL.md', 'SECURITY.md', 'ATTRIBUTION.md']);
const forbidden =
  /(^|\/)(node_modules|dist|build|\.local|\.git|\.aws|\.codex|\.agents|Saved|output|test-results|playwright-report|installation)(\/|$)|(^|\/)\.env(?!\.example$)|\.(log|pem|key|exe|dll|zip|tar|gz|mp4|webm)$/i;
function checkSensitive(body, name) {
  if (
    /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}/.test(
      body.toString('utf8'),
    )
  )
    throw new Error('Credential-like content found in ' + name);
}
export async function sourceInventory(root, kind = 'repository') {
  if (!['repository', 'release'].includes(kind)) throw new Error('Unknown inventory kind');
  const entries = [];
  const walk = async (path) => {
    for (const item of (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en'),
    )) {
      const absolute = join(path, item.name),
        name = relative(root, absolute).replaceAll('\\', '/');
      if (
        forbidden.test(name) ||
        (name.startsWith('docs/') && !releaseDocs.has(name.slice(5))) ||
        name === 'infrastructure/livekit.yaml' ||
        /^apps\/web\/public\/(vendor|intro|excalidraw|pdfjs)(\/|$)/.test(name) ||
        name.startsWith('apps/web/public/media-effects/wasm/') ||
        name.startsWith('docs/screenshots/')
      )
        continue;
      if (item.isSymbolicLink())
        throw new Error('Source inventory cannot contain symlinks: ' + name);
      if (item.isDirectory()) {
        await walk(absolute);
        continue;
      }
      if (!item.isFile()) throw new Error('Unexpected source entry: ' + name);
      if (
        kind === 'release' &&
        (name.startsWith('tests/') ||
          name.startsWith('.github/') ||
          name.startsWith('design/') ||
          (name.startsWith('docs/') && !releaseDocs.has(name.slice(5))) ||
          name.startsWith('playwright.'))
      )
        continue;
      const runtimeAsset = /^apps\/web\/public\//.test(name);
      if (
        !rootFiles.has(name) &&
        !runtimeAsset &&
        !/(^|\/)(Dockerfile(?:\.[a-z]+)?|Caddyfile(?:\.example)?)$/.test(name) &&
        !/\.(ts|tsx|js|mjs|cjs|json|sql|css|html|md|yml|yaml|sh|ps1|py|txt|svg)$/.test(name) &&
        !/(^|\/)(LICENSE|NOTICE|COPYING)([.-].*)?$/i.test(name)
      )
        continue;
      if (
        name.startsWith('LOGIN DESIGN/') &&
        name !== 'LOGIN DESIGN/toaster-3d.js' &&
        kind === 'release'
      )
        continue;
      const info = await lstat(absolute);
      if (info.size > 2 * 1024 ** 2) throw new Error('Unexpectedly large source file: ' + name);
      const body = await readFile(absolute);
      checkSensitive(body, name);
      entries.push({
        path: name,
        bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        mode: name.endsWith('.sh') ? '100755' : '100644',
      });
    }
  };
  root = resolve(root);
  for (const item of await readdir(root, { withFileTypes: true })) {
    if (
      item.isDirectory() &&
      [
        'apps',
        'packages',
        'scripts',
        'infrastructure',
        'third_party',
        ...(kind === 'repository' ? ['tests', 'design', '.github'] : []),
        'docs',
        'LOGIN DESIGN',
      ].includes(item.name)
    )
      await walk(join(root, item.name));
    else if (item.isFile() && rootFiles.has(item.name)) {
      const body = await readFile(join(root, item.name));
      checkSensitive(body, item.name);
      entries.push({
        path: item.name,
        bytes: body.length,
        sha256: createHash('sha256').update(body).digest('hex'),
        mode: item.name.endsWith('.sh') ? '100755' : '100644',
      });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return entries;
}
