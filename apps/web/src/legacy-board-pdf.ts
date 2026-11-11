import { PDFDocument } from 'pdf-lib';
/** Render the existing basic board through the browser's SVG implementation. */
export async function legacyBoardPdf(source: SVGSVGElement, signal: AbortSignal) {
  signal.throwIfAborted();
  await document.fonts.ready;
  const clone = source.cloneNode(true) as SVGSVGElement;
  clone.querySelectorAll('[data-draft]').forEach((node) => node.remove());
  const group = source.querySelector('g'),
    bounds = group?.getBBox(),
    width = Math.max(100, bounds?.width ?? 1000) + 40,
    height = Math.max(100, bounds?.height ?? 650) + 40;
  clone.querySelector('g')?.removeAttribute('transform');
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute(
    'viewBox',
    `${(bounds?.x ?? 0) - 20} ${(bounds?.y ?? 0) - 20} ${width} ${height}`,
  );
  const scale = Math.min(2, 4096 / Math.max(width, height)),
    w = Math.max(1, Math.round(width * scale)),
    h = Math.max(1, Math.round(height * scale));
  clone.setAttribute('width', String(w));
  clone.setAttribute('height', String(h));
  const url = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' }),
  );
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const stop = () => finish(signal.reason),
        timer = setTimeout(() => finish(Error('Board image rendering timed out')), 10000);
      const finish = (error?: unknown) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', stop);
        image.onload = image.onerror = null;
        error ? reject(error) : resolve();
      };
      image.onload = () => finish();
      image.onerror = () => finish(Error('Board image could not be rendered'));
      signal.addEventListener('abort', stop, { once: true });
      image.src = url;
      if (signal.aborted) stop();
    });
    signal.throwIfAborted();
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    try {
      const ctx = canvas.getContext('2d');
      if (!ctx) throw Error('Canvas is unavailable');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(image, 0, 0, w, h);
      const png = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (blob) => (blob ? resolve(blob) : reject(Error('Board image encoding failed'))),
          'image/png',
        ),
      );
      signal.throwIfAborted();
      const pdf = await PDFDocument.create(),
        embedded = await pdf.embedPng(await png.arrayBuffer()),
        page = pdf.addPage([w, h]);
      page.drawImage(embedded, { x: 0, y: 0, width: w, height: h });
      return new Blob([new Uint8Array(await pdf.save())], { type: 'application/pdf' });
    } finally {
      canvas.width = canvas.height = 0;
    }
  } finally {
    URL.revokeObjectURL(url);
  }
}
