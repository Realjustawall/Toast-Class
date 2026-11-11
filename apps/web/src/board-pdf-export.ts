import * as Y from 'yjs';
import { exportToBlob, restoreElements, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import { PDFDocument, degrees } from 'pdf-lib';
import { request } from './api';
import { pageBackground, type BoardPage } from './board-page-background';
import { allBoardImages } from './board-assets';
import { readPdfSource } from './pdf-source';
import { authorizeBoardDownload } from './classroom-downloads';

export async function exportBoardPages(
  roomId: string,
  pages: BoardPage[],
  signal: AbortSignal,
  progress: (page: number) => void,
) {
  const roots = [...new Set(pages.map((p) => p.board_book_id ?? p.id))];
  for (const root of roots) await authorizeBoardDownload(roomId, root, 'pdf', signal);
  const pdf = await PDFDocument.create();
  const sources = new Map<string, PDFDocument>();
  for (let index = 0; index < pages.length; index++) {
    signal.throwIfAborted();
    progress(index + 1);
    const page = pages[index],
      state = await request<{ state?: string }>(
        '/classrooms/' + roomId + '/documents/' + page.id + '/board',
        undefined,
        { signal },
      );
    const doc = new Y.Doc();
    try {
      if (state.state)
        Y.applyUpdate(
          doc,
          Uint8Array.from(atob(state.state), (c) => c.charCodeAt(0)),
        );
      const elements = restoreElements(
        [...pageBackground(page), ...doc.getMap('elements').values()] as never,
        null,
      ).filter((e) => !e.isDeleted);
      const annotations = restoreElements(
        [...doc.getMap('elements').values()] as never,
        null,
      ).filter((e) => !e.isDeleted);
      const files = await allBoardImages(roomId, page, elements, signal);
      if (page.pdf_source_file_id && page.pdf_source_page) {
        let source = sources.get(page.pdf_source_file_id);
        if (!source) {
          const bytes = await readPdfSource(roomId, page.pdf_source_file_id, page.id, signal);
          source = await PDFDocument.load(bytes);
          sources.set(page.pdf_source_file_id, source);
        }
        const original = source.getPage(page.pdf_source_page - 1),
          [output] = await pdf.copyPages(source, [page.pdf_source_page - 1]);
        pdf.addPage(output);
        const rotation = (original.getRotation().angle + (page.page_rotation ?? 0)) % 360;
        output.setRotation(degrees(rotation));
        if (annotations.length) {
          const turn = (page.page_rotation ?? 0) % 180 !== 0,
            w = Number(page.background_width ?? 1000),
            h = Number(page.background_height ?? 1400),
            width = turn ? h : w,
            height = turn ? w : h;
          const [template] = convertToExcalidrawElements([
            {
              type: 'frame',
              children: [],
              x: 1,
              y: 1,
              width,
              height,
              strokeColor: 'transparent',
              backgroundColor: 'transparent',
              opacity: 0,
            },
          ]);
          if (template.type !== 'frame') throw Error('Invalid PDF annotation frame');
          const frame = { ...template, x: 0, y: 0, width, height };
          const blob = await exportToBlob({
            elements: [frame, ...annotations],
            exportingFrame: frame,
            files: Object.fromEntries(files.map((file) => [file.id, file])) as never,
            appState: { exportBackground: false, exportEmbedScene: false },
            exportPadding: 0,
            maxWidthOrHeight: 4096,
          });
          const image = await pdf.embedPng(await blob.arrayBuffer()),
            ow = output.getWidth(),
            oh = output.getHeight(),
            quarter = rotation % 180 !== 0;
          output.drawImage(image, {
            width: quarter ? oh : ow,
            height: quarter ? ow : oh,
            rotate: degrees(rotation),
            x: rotation === 90 || rotation === 180 ? ow : 0,
            y: rotation === 180 || rotation === 270 ? oh : 0,
          });
        }
        continue;
      }
      if (!elements.length) {
        pdf.addPage([595, 842]);
        continue;
      }
      const blob = await exportToBlob({
        elements,
        files: Object.fromEntries(files.map((file) => [file.id, file])) as never,
        appState: {
          viewBackgroundColor: String(doc.getMap('settings').get('backgroundColor') ?? '#ffffff'),
          exportBackground: true,
          exportEmbedScene: false,
        },
        maxWidthOrHeight: 4096,
      });
      const image = await pdf.embedPng(await blob.arrayBuffer()),
        output = pdf.addPage([image.width, image.height]);
      output.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
    } finally {
      doc.destroy();
    }
  }
  signal.throwIfAborted();
  for (const root of roots) await authorizeBoardDownload(roomId, root, 'pdf', signal);
  return new Blob([new Uint8Array(await pdf.save())], { type: 'application/pdf' });
}
