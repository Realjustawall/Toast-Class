import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
GlobalWorkerOptions.workerSrc = workerUrl;

export async function* renderPdfPages(file: File, signal: AbortSignal) {
  const loading = getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    enableXfa: false,
    maxImageSize: 16777216,
    cMapUrl: '/pdfjs/cmaps/',
    cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
    iccUrl: '/pdfjs/iccs/',
  });
  const abort = () => void loading.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    const pdf = await loading.promise;
    if (pdf.numPages > 30) throw Error('PDF: maximum 30 pages per import');
    for (let number = 1; number <= pdf.numPages; number++) {
      signal.throwIfAborted();
      const page = await pdf.getPage(number),
        original = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 2048 / Math.max(original.width, original.height));
      const viewport = page.getViewport({ scale }),
        canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      try {
        await page.render({ canvas, viewport, background: '#ffffff' }).promise;
        signal.throwIfAborted();
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) => (value ? resolve(value) : reject(Error('PDF rendering failed'))),
            'image/png',
          ),
        );
        yield { number, total: pdf.numPages, blob, width: canvas.width, height: canvas.height };
      } finally {
        canvas.width = canvas.height = 0;
        page.cleanup();
      }
    }
  } finally {
    signal.removeEventListener('abort', abort);
    await loading.destroy();
  }
}
