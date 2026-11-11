import { getDocument } from 'pdfjs-dist';
import './pdf-pages';
import { readPdfSource } from './pdf-source';
export async function pdfPageText(
  roomId: string,
  fileId: string,
  documentId: string,
  signal: AbortSignal,
) {
  const bytes = await readPdfSource(roomId, fileId, documentId, signal);
  return pdfBytesText(bytes, signal);
}
export async function pdfBytesText(bytes: Uint8Array, signal: AbortSignal) {
  const task = getDocument({
      data: bytes,
      enableXfa: false,
      cMapUrl: '/pdfjs/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/pdfjs/standard_fonts/',
      wasmUrl: '/pdfjs/wasm/',
      iccUrl: '/pdfjs/iccs/',
    }),
    abort = () => void task.destroy();
  signal.addEventListener('abort', abort, { once: true });
  try {
    const doc = await task.promise;
    if (doc.numPages > 100) throw Error('PDF page limit exceeded');
    const text = [];
    for (let number = 1; number <= doc.numPages; number++) {
      signal.throwIfAborted();
      const page = await doc.getPage(number),
        content = await page.getTextContent();
      text.push(
        content.items
          .map((item) => ('str' in item ? item.str : ''))
          .join(' ')
          .slice(0, 100000)
          .toLocaleLowerCase(),
      );
      page.cleanup();
    }
    return text;
  } finally {
    signal.removeEventListener('abort', abort);
    await task.destroy();
  }
}
