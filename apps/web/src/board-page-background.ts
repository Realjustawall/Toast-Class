export type BoardPage = {
  id: string;
  name: string;
  teacher_only: boolean;
  board_book_id?: string | null;
  board_page_index?: number;
  page_archived?: boolean;
  page_bookmark?: string;
  page_rotation?: number;
  pdf_source_file_id?: string | null;
  pdf_source_page?: number | null;
  background_file_id?: string | null;
  background_width?: number | null;
  background_height?: number | null;
};
export function pageBackground(page: BoardPage): Record<string, unknown>[] {
  if (!page.background_file_id) return [];
  const width = page.background_width ?? 1000,
    height = page.background_height ?? 1400,
    rotation = page.page_rotation ?? 0,
    turned = rotation % 180 !== 0;
  return [
    {
      id: 'background_' + page.background_file_id,
      type: 'image',
      fileId: page.background_file_id,
      status: 'saved',
      x: turned ? (height - width) / 2 : 0,
      y: turned ? (width - height) / 2 : 0,
      width: page.background_width ?? 1000,
      height: page.background_height ?? 1400,
      angle: (rotation * Math.PI) / 180,
      strokeColor: 'transparent',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 0,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: true,
      scale: [1, 1],
      crop: null,
    },
  ];
}
export async function pageImage(roomId: string, page: BoardPage, signal: AbortSignal) {
  if (!page.background_file_id) return [];
  const response = await fetch(
    '/api/v1/classrooms/' +
      roomId +
      '/files/' +
      page.background_file_id +
      '/content?documentId=' +
      page.id,
    { credentials: 'same-origin', signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]) },
  );
  if (!response.ok) throw Error('Page image is unavailable');
  const blob = await response.blob();
  if (blob.size > 5 * 1024 * 1024 || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type))
    throw Error('Invalid page image');
  const dataURL = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  signal.throwIfAborted();
  return [{ id: page.background_file_id, dataURL, mimeType: blob.type, created: Date.now() }];
}
