import { request } from './api';
import { readJsonResponse } from './http-response';
import { pageImage, type BoardPage } from './board-page-background';

export async function uploadBoardAsset(
  roomId: string,
  file: File,
  kind: 'annotation' | 'source',
  signal: AbortSignal,
) {
  const body = new FormData();
  body.append('file', file);
  let stored = await readJsonResponse<{ id: string; status: string }>(
    await fetch(
      '/api/v1/classrooms/' +
        roomId +
        '/files' +
        (kind === 'annotation' ? '?annotationImage=1' : ''),
      {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'x-toaster-file-size': String(file.size) },
        body,
        signal: AbortSignal.any([signal, AbortSignal.timeout(65000)]),
      },
    ),
  );
  const deadline = Date.now() + 60000;
  while (stored.status === 'quarantined' && Date.now() < deadline) {
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
          clearTimeout(timer);
          reject(signal.reason);
        },
        timer = setTimeout(() => {
          signal.removeEventListener('abort', stop);
          resolve();
        }, 500);
      signal.addEventListener('abort', stop, { once: true });
      if (signal.aborted) stop();
    });
    stored = await request('/classrooms/' + roomId + '/files/' + stored.id + '/status', undefined, {
      signal,
    });
  }
  if (stored.status !== 'ready') throw Error('Image or PDF is awaiting a successful security scan');
  return stored.id;
}
export async function loadBoardImages(
  roomId: string,
  page: BoardPage,
  elements: readonly { type?: unknown; fileId?: unknown }[],
  signal: AbortSignal,
  known: ReadonlySet<string> = new Set(),
) {
  const ids = [
    ...new Set(
      elements
        .filter(
          (value) =>
            value.type === 'image' &&
            typeof value.fileId === 'string' &&
            value.fileId !== page.background_file_id &&
            !known.has(value.fileId),
        )
        .map((value) => String(value.fileId)),
    ),
  ];
  const images = [];
  for (let offset = 0; offset < ids.length; offset += 4) {
    const group = await Promise.all(
      ids.slice(offset, offset + 4).map(async (id) => {
        const response = await fetch(
          '/api/v1/classrooms/' + roomId + '/files/' + id + '/content?documentId=' + page.id,
          {
            credentials: 'same-origin',
            signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
          },
        );
        if (!response.ok) throw Error('Annotation image is unavailable');
        const blob = await response.blob();
        if (blob.type !== 'image/png' || blob.size > 5 * 1024 * 1024)
          throw Error('Invalid annotation image');
        const dataURL = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
        return { id, dataURL, mimeType: 'image/png', created: Date.now() };
      }),
    );
    images.push(...group);
  }
  return images;
}
export async function allBoardImages(
  roomId: string,
  page: BoardPage,
  elements: readonly { type?: unknown; fileId?: unknown }[],
  signal: AbortSignal,
) {
  return [
    ...(await pageImage(roomId, page, signal)),
    ...(await loadBoardImages(roomId, page, elements, signal)),
  ];
}
