export type SandboxBundleFile = {
  kind: 'text' | 'data';
  mime: string;
  content: string;
};

export type SandboxBundle = {
  entry: string;
  files: Record<string, SandboxBundleFile>;
};

const STRICT_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob: data:; style-src 'unsafe-inline' blob: data:; img-src blob: data:; font-src blob: data:; media-src blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';";

function resolveRelativePath(baseFile: string, ref: string): string | null {
  const clean = ref.split(/[?#]/)[0]?.trim() ?? '';
  if (
    !clean ||
    clean.startsWith('#') ||
    /^(?:https?:|data:|blob:|javascript:|vbscript:|\/\/)/i.test(clean)
  ) {
    return null;
  }
  const baseParts = baseFile.includes('/') ? baseFile.split('/').slice(0, -1) : [];
  const rawParts = clean.startsWith('/')
    ? clean.slice(1).split('/')
    : [...baseParts, ...clean.split('/')];
  const resolved: string[] = [];
  for (const part of rawParts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!resolved.length) return null;
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }
  return resolved.join('/');
}

function findFile(files: Record<string, SandboxBundleFile>, baseFile: string, ref: string) {
  const path = resolveRelativePath(baseFile, ref);
  if (!path) return null;
  if (files[path]) return { path, file: files[path]! };
  const lower = path.toLowerCase();
  const match = Object.entries(files).find(([k]) => k.toLowerCase() === lower);
  return match ? { path: match[0], file: match[1] } : null;
}

function inlineCssUrls(
  css: string,
  cssPath: string,
  files: Record<string, SandboxBundleFile>,
): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (full, _quote, ref: string) => {
    const found = findFile(files, cssPath, ref);
    if (!found) return full;
    const dataUri =
      found.file.kind === 'data'
        ? found.file.content
        : `data:${found.file.mime};charset=utf-8,${encodeURIComponent(found.file.content)}`;
    return `url("${dataUri}")`;
  });
}

function escapeInlineScript(code: string): string {
  return code.replace(/<\/(script)/gi, '<\\/$1');
}

function escapeInlineStyle(code: string): string {
  return code.replace(/<\/(style)/gi, '<\\/$1');
}

export function buildSandboxSrcDoc(bundle: SandboxBundle): string {
  const entryPath = bundle.entry;
  const entryFile = bundle.files[entryPath];
  if (!entryFile || entryFile.kind !== 'text') {
    return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${STRICT_CSP}"></head><body><p>Empty sandbox board</p></body></html>`;
  }

  let html = entryFile.content;

  // Strip any user-supplied CSP meta tags or <base> tags so they cannot weaken isolation.
  html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*['"]?content-security-policy['"]?[^>]*>/gi, '');
  html = html.replace(/<base\b[^>]*>/gi, '');

  // Inline local <link rel="stylesheet" href="...">
  html = html.replace(
    /<link\b([^>]*\bhref\s*=\s*['"]([^'"]+)['"][^>]*)>/gi,
    (full, attrs: string, href: string) => {
      if (!/\brel\s*=\s*['"]?stylesheet['"]?/i.test(attrs)) return full;
      const found = findFile(bundle.files, entryPath, href);
      if (!found || found.file.kind !== 'text') return full;
      const css = inlineCssUrls(found.file.content, found.path, bundle.files);
      return `<style>${escapeInlineStyle(css)}</style>`;
    },
  );

  // Rewrite <style>...</style> url(...) references
  html = html.replace(
    /<style\b([^>]*)>([\s\S]*?)<\/style>/gi,
    (_full, attrs: string, css: string) => {
      return `<style${attrs}>${escapeInlineStyle(inlineCssUrls(css, entryPath, bundle.files))}</style>`;
    },
  );

  // Inline local <script src="..."></script>
  html = html.replace(
    /<script\b([^>]*)\bsrc\s*=\s*['"]([^'"]+)['"]([^>]*)><\/script>/gi,
    (full, before: string, src: string, after: string) => {
      const found = findFile(bundle.files, entryPath, src);
      if (!found || found.file.kind !== 'text') return full;
      return `<script${(before + after).trimEnd()}>${escapeInlineScript(found.file.content)}</script>`;
    },
  );

  // Rewrite local asset src="..." (img, audio, video, source) to data URIs
  html = html.replace(
    /(<(?:img|audio|video|source)\b[^>]*?\bsrc\s*=\s*)(['"])([^'"]+)\2/gi,
    (full, prefix: string, quote: string, src: string) => {
      const found = findFile(bundle.files, entryPath, src);
      if (!found) return full;
      const uri =
        found.file.kind === 'data'
          ? found.file.content
          : `data:${found.file.mime};charset=utf-8,${encodeURIComponent(found.file.content)}`;
      return `${prefix}${quote}${uri}${quote}`;
    },
  );

  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${STRICT_CSP}">`;
  if (/<head\b[^>]*>/i.test(html)) {
    html = html.replace(/<head\b([^>]*)>/i, `<head$1>${cspMeta}`);
  } else if (/<html\b[^>]*>/i.test(html)) {
    html = html.replace(/<html\b([^>]*)>/i, `<html$1><head>${cspMeta}</head>`);
  } else {
    html = `<!doctype html><html><head>${cspMeta}</head><body>${html}</body></html>`;
  }
  return html;
}
