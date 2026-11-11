import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import type { BoardPage } from './board-page-background';
export default function AnnotationPageManager({
  roomId,
  pages,
  selectedId,
  canManage,
  onBeforeChange,
  onChange,
  onSelect,
}: {
  roomId: string;
  pages: BoardPage[];
  selectedId: string;
  canManage: boolean;
  onBeforeChange: () => Promise<void>;
  onChange: () => Promise<void>;
  onSelect: (id: string) => Promise<void>;
}) {
  const { t } = useTranslation(),
    [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [selected, setSelected] = useState(selectedId),
    [name, setName] = useState(''),
    [bookmark, setBookmark] = useState(''),
    dialog = useRef<HTMLDialogElement>(null),
    [search, setSearch] = useState(''),
    [textMatches, setTextMatches] = useState<Set<string>>(new Set());
  const textCache = useRef(new Map<string, string[]>());
  const pageSignature = pages
    .map((page) => page.id + ':' + page.pdf_source_file_id + ':' + page.pdf_source_page)
    .join('|');
  useEffect(() => {
    if (!open || search.trim().length < 2) {
      setTextMatches(new Set());
      return;
    }
    const controller = new AbortController(),
      timer = setTimeout(() => {
        void (async () => {
          const { pdfPageText } = await import('./pdf-text-search'),
            matched = new Set<string>(),
            sources = [
              ...new Set(pages.map((page) => page.pdf_source_file_id).filter(Boolean)),
            ] as string[];
          for (const id of sources) {
            let texts = textCache.current.get(id);
            if (!texts) {
              texts = await pdfPageText(
                roomId,
                id,
                pages.find((page) => page.pdf_source_file_id === id)!.id,
                controller.signal,
              );
              textCache.current.set(id, texts);
            }
            for (const page of pages)
              if (
                page.pdf_source_file_id === id &&
                page.pdf_source_page &&
                texts[page.pdf_source_page - 1]?.includes(search.toLocaleLowerCase())
              )
                matched.add(page.id);
          }
          if (!controller.signal.aborted) setTextMatches(matched);
        })().catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        });
      }, 250);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search, open, pageSignature, roomId]);
  const ordered = [...pages].sort((a, b) => (a.board_page_index ?? 1) - (b.board_page_index ?? 1)),
    current = ordered.find((page) => page.id === selected) ?? ordered[0];
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
  }, [open]);
  useEffect(() => {
    setName(current?.name ?? '');
    setBookmark(current?.page_bookmark ?? '');
  }, [current?.id, current?.name, current?.page_bookmark]);
  const act = async (action: object) => {
    if (!current || busy) return;
    setBusy(true);
    setError('');
    try {
      await onBeforeChange();
      const result = await request<{ id: string }>(
        '/classrooms/' + roomId + '/documents/' + current.id + '/page-action',
        action,
      );
      await onChange();
      if ('kind' in action && (action.kind === 'duplicate' || action.kind === 'archive')) {
        setSelected(result.id);
        await onSelect(result.id);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setSelected(selectedId);
          setOpen(true);
        }}
      >
        {t('annotationPages')}
      </button>
      {open && (
        <dialog
          ref={dialog}
          className="annotation-pages-dialog"
          aria-label={t('annotationPages')}
          onClose={() => setOpen(false)}
          onCancel={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <header>
            <h2>{t('annotationPages')}</h2>
            <button
              type="button"
              disabled={busy}
              aria-label={t('classClosePanel')}
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </header>
          <label className="annotation-page-search">
            {t('annotationSearch')}
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <div className="annotation-pages-content">
            <nav aria-label={t('boardPages')}>
              {ordered
                .filter(
                  (page) =>
                    !search.trim() ||
                    (page.name + ' ' + (page.page_bookmark ?? ''))
                      .toLocaleLowerCase()
                      .includes(search.toLocaleLowerCase()) ||
                    textMatches.has(page.id),
                )
                .map((page) => (
                  <button
                    type="button"
                    key={page.id}
                    aria-pressed={current?.id === page.id}
                    onClick={() => setSelected(page.id)}
                  >
                    <span className="page-thumbnail">
                      {page.background_file_id ? (
                        <img
                          loading="lazy"
                          src={
                            '/api/v1/classrooms/' +
                            roomId +
                            '/files/' +
                            page.background_file_id +
                            '/content?documentId=' +
                            page.id
                          }
                          alt=""
                        />
                      ) : (
                        <span>{ordered.indexOf(page) + 1}</span>
                      )}
                    </span>
                    <span>
                      {page.page_bookmark ? '★ ' : ''}
                      {page.name}
                      {page.page_archived ? ' · ' + t('annotationArchived') : ''}
                    </span>
                  </button>
                ))}
            </nav>
            {current && (
              <section>
                <p>{t('boardPageNumber', { number: ordered.indexOf(current) + 1 })}</p>
                <button
                  disabled={busy || !!current.page_archived || !canManage}
                  onClick={() => {
                    void onSelect(current.id).then(() => setOpen(false));
                  }}
                >
                  {t('annotationOpenPage')}
                </button>
                {canManage && (
                  <fieldset disabled={busy}>
                    <label>
                      {t('name')}
                      <input
                        value={name}
                        maxLength={120}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </label>
                    <button
                      disabled={!name.trim()}
                      onClick={() => void act({ kind: 'rename', name })}
                    >
                      {t('annotationRename')}
                    </button>
                    <label>
                      {t('annotationBookmark')}
                      <input
                        value={bookmark}
                        maxLength={120}
                        onChange={(e) => setBookmark(e.target.value)}
                      />
                    </label>
                    <button onClick={() => void act({ kind: 'bookmark', label: bookmark })}>
                      {t('save')}
                    </button>
                    <div className="annotation-page-actions">
                      <button onClick={() => void act({ kind: 'duplicate' })}>
                        {t('annotationDuplicate')}
                      </button>
                      <button onClick={() => void act({ kind: 'rotate', clockwise: true })}>
                        {t('annotationRotateRight')}
                      </button>
                      <button onClick={() => void act({ kind: 'rotate', clockwise: false })}>
                        {t('annotationRotateLeft')}
                      </button>
                      <button
                        disabled={ordered.indexOf(current) === 0}
                        onClick={() => {
                          const ids = ordered.map((p) => p.id),
                            i = ids.indexOf(current.id);
                          [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]];
                          void act({ kind: 'reorder', ids });
                        }}
                      >
                        {t('annotationMoveBefore')}
                      </button>
                      <button
                        disabled={ordered.indexOf(current) === ordered.length - 1}
                        onClick={() => {
                          const ids = ordered.map((p) => p.id),
                            i = ids.indexOf(current.id);
                          [ids[i], ids[i + 1]] = [ids[i + 1], ids[i]];
                          void act({ kind: 'reorder', ids });
                        }}
                      >
                        {t('annotationMoveAfter')}
                      </button>
                      <button
                        onClick={() =>
                          void act({ kind: 'archive', archived: !current.page_archived })
                        }
                      >
                        {t(
                          current.page_archived ? 'annotationRestorePage' : 'annotationArchivePage',
                        )}
                      </button>
                    </div>
                  </fieldset>
                )}
                {error && <p role="alert">{error}</p>}
              </section>
            )}
          </div>
        </dialog>
      )}
    </>
  );
}
