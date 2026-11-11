import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import { readJsonResponse } from './http-response';
import { uploadBoardAsset } from './board-assets';
import { playClassroomSound } from './classroom-sounds';

export default function BoardPdfImport({
  roomId,
  onImported,
  appendTo,
  ontoPage,
}: {
  roomId: string;
  onImported: (id: string) => Promise<void>;
  appendTo?: string;
  ontoPage?: string;
}) {
  const { t } = useTranslation(),
    input = useRef<HTMLInputElement>(null),
    active = useRef<AbortController | null>(null);
  const [mode, setMode] = useState<'replace' | 'board' | 'append'>('replace');
  const chosenMode = useRef(mode);
  chosenMode.current = mode;
  useEffect(() => {
    if (mode === 'board' && !ontoPage) setMode('replace');
  }, [mode, ontoPage]);
  const [progress, setProgress] = useState(''),
    [error, setError] = useState('');
  useEffect(() => () => active.current?.abort(), []);
  const importPdf = async (file: File) => {
    if (active.current) return;
    if (file.size > 20 * 1024 * 1024) {
      setError(t('boardPdfSize'));
      return;
    }
    const controller = (active.current = new AbortController()),
      signal = controller.signal;
    const boardMode = chosenMode.current === 'board' && !!ontoPage && !!appendTo;
    let root = boardMode || chosenMode.current === 'append' ? (appendTo ?? '') : '',
      completed = 0;
    const appendMode = Boolean(root);
    let firstImported = '';
    let sourceId = '';
    setError('');
    setProgress(t('boardPdfReading'));
    try {
      const { renderPdfPages } = await import('./pdf-pages');
      for await (const page of renderPdfPages(file, signal)) {
        signal.throwIfAborted();
        setProgress(t('boardPdfProgress', { page: page.number, total: page.total }));
        if (!root)
          root = (
            await request<{ id: string }>(
              '/classrooms/' + roomId + '/documents',
              { kind: 'board', boardFormat: 'excalidraw', name: file.name.slice(0, 120) },
              { signal },
            )
          ).id;
        if (!sourceId) sourceId = await uploadBoardAsset(roomId, file, 'source', signal);
        const id =
          page.number === 1 && boardMode
            ? ontoPage!
            : page.number === 1 && !appendMode
              ? root
              : (
                  await request<{ id: string }>(
                    '/classrooms/' + roomId + '/documents/' + root + '/pages',
                    {},
                    { signal },
                  )
                ).id;
        if (!firstImported) firstImported = id;
        const form = new FormData();
        form.append(
          'file',
          page.blob,
          file.name.replace(/\.pdf$/i, '').slice(0, 90) + '-' + page.number + '.png',
        );
        const response = await fetch('/api/v1/classrooms/' + roomId + '/files?boardImage=1', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'x-toaster-file-size': String(page.blob.size) },
          body: form,
          signal: AbortSignal.any([signal, AbortSignal.timeout(65000)]),
        });
        let uploaded = await readJsonResponse<{ id: string; status: string }>(response);
        const deadline = Date.now() + 60000;
        while (uploaded.status === 'quarantined' && Date.now() < deadline) {
          await new Promise<void>((resolve, reject) => {
            const stop = () => {
              clearTimeout(timer);
              reject(signal.reason);
            };
            const timer = setTimeout(() => {
              signal.removeEventListener('abort', stop);
              resolve();
            }, 1000);
            signal.addEventListener('abort', stop, { once: true });
            if (signal.aborted) stop();
          });
          uploaded = await request(
            '/classrooms/' + roomId + '/files/' + uploaded.id + '/status',
            undefined,
            { signal },
          );
        }
        if (uploaded.status !== 'ready') throw Error(t('boardPdfScanPending'));
        await request(
          '/classrooms/' + roomId + '/documents/' + id + '/background',
          { fileId: uploaded.id, width: page.width, height: page.height },
          { signal },
        );
        await request(
          '/classrooms/' + roomId + '/documents/' + id + '/pdf-source',
          { fileId: sourceId, page: page.number },
          { signal },
        );
        completed++;
      }
      if (root) {
        await onImported(firstImported || root);
        playClassroomSound('success');
      }
    } catch (e) {
      if (root && !signal.aborted) await onImported(root).catch(() => {});
      if (!signal.aborted) playClassroomSound('error');
      if (!signal.aborted)
        setError(t('boardPdfFailed', { count: completed }) + ' ' + (e as Error).message);
    } finally {
      if (active.current === controller) {
        active.current = null;
        setProgress('');
      }
    }
  };
  return (
    <>
      <select
        className="pdf-display-mode"
        aria-label={t('pdfDisplayMode')}
        value={mode}
        disabled={!!progress}
        onChange={(event) => setMode(event.target.value as typeof mode)}
      >
        <option value="replace">{t('pdfReplaceBoard')}</option>
        {ontoPage && <option value="board">{t('pdfOntoBoard')}</option>}
        {appendTo && <option value="append">{t('annotationAppendPdf')}</option>}
      </select>
      <input
        ref={input}
        hidden
        style={{ display: 'none' }}
        type="file"
        accept="application/pdf,.pdf"
        aria-label={t('boardImportPdf')}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void importPdf(file);
        }}
      />
      <button
        disabled={!!progress}
        onClick={() => {
          input.current?.click();
        }}
      >
        {t('boardImportPdf')}
      </button>
      {progress && (
        <>
          <output role="status">{progress}</output>
          <button onClick={() => active.current?.abort()}>{t('cancel')}</button>
        </>
      )}
      {error && (
        <span className="error board-import-error" role="alert">
          {error}
        </span>
      )}
    </>
  );
}
