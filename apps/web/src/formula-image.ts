import katex from 'katex';
import css from 'katex/dist/katex.min.css?inline';
let embeddedCss: Promise<string> | undefined;
async function stylesheet() {
  return (embeddedCss ??= (async () => {
    let result = css;
    const urls = [
      ...new Set(
        [...css.matchAll(/url\(([^)]+)\)/g)]
          .map((match) => match[1].replace(/['"]/g, ''))
          .filter((url) => url.includes('.woff2')),
      ),
    ];
    // Only the local WOFF2 faces are needed in a self-contained, inert image.
    result = result.replace(/src:([^;]+);/g, (_all, sources: string) => {
      const face = sources.match(/url\([^)]*\.woff2[^)]*\)(?:\s*format\([^)]*\))?/);
      return face ? 'src:' + face[0] + ';' : 'src:' + sources + ';';
    });
    for (let offset = 0; offset < urls.length; offset += 4) {
      const group = await Promise.all(
        urls.slice(offset, offset + 4).map(async (url) => {
          const parsed = new URL(url, location.origin);
          if (parsed.origin !== location.origin)
            throw Error('Formula fonts must be hosted locally');
          const response = await fetch(parsed);
          if (!response.ok) throw Error('Formula font unavailable');
          const blob = await response.blob();
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
          });
          return { url, data };
        }),
      );
      for (const { url, data } of group) result = result.split(url).join(data);
    }
    return result;
  })());
}
export async function formulaImage(source: string) {
  if (!source.trim() || source.length > 1000)
    throw Error('Enter a formula of at most 1000 characters');
  const html = katex.renderToString(source, {
    throwOnError: true,
    trust: false,
    strict: 'error',
    output: 'html',
    displayMode: true,
    maxExpand: 1000,
    maxSize: 25,
  });
  const embedded = await stylesheet(),
    host = document.createElement('div');
  host.style.cssText =
    'position:fixed;left:-10000px;top:0;display:inline-block;font-size:32px;white-space:nowrap;padding:8px;';
  host.innerHTML = '<style>' + embedded + '</style>' + html;
  document.body.append(host);
  try {
    await document.fonts.ready;
    const rect = host.getBoundingClientRect(),
      width = Math.ceil(rect.width + 4),
      height = Math.ceil(rect.height + 4);
    if (width > 2048 || height > 1024 || width < 1 || height < 1)
      throw Error('Formula dimensions exceed the limit');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(height));
    const foreign = document.createElementNS(svg.namespaceURI, 'foreignObject');
    foreign.setAttribute('width', '100%');
    foreign.setAttribute('height', '100%');
    const content = document.createElementNS('http://www.w3.org/1999/xhtml', 'div');
    content.setAttribute(
      'style',
      'display:inline-block;font-size:32px;color:#1f2937;white-space:nowrap;padding:8px;',
    );
    content.innerHTML = '<style>' + embedded + '</style>' + html;
    foreign.append(content);
    svg.append(foreign);
    const image = new Image();
    image.src =
      'data:image/svg+xml;charset=utf-8,' +
      encodeURIComponent(new XMLSerializer().serializeToString(svg));
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = width * 2;
    canvas.height = height * 2;
    canvas.getContext('2d')!.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) => (value ? resolve(value) : reject(Error('Formula conversion failed'))),
        'image/png',
      ),
    );
    canvas.width = canvas.height = 0;
    return new File([blob], 'formula.png', { type: 'image/png' });
  } finally {
    host.remove();
  }
}
