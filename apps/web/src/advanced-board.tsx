import { useEffect, useRef, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import OverflowMenu from './overflow-menu';
import {
  Excalidraw,
  CaptureUpdateAction,
  restoreElements,
  exportToSvg,
  exportToBlob,
  MainMenu,
} from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import '@excalidraw/excalidraw/index.css';
import { request } from './api';
import BoardHistory from './board-history';
import BoardToolDock, { type BoardToolState } from './board-tool-dock';
import { useBoardPresence } from './board-presence';
import { useBoardPresenter } from './board-presenter';
import { useClassroomEvents } from './live';
import { pageBackground, pageImage, type BoardPage } from './board-page-background';
import { loadBoardImages } from './board-assets';
import BoardAnnotationTools from './board-annotation-tools';
import BoardEraser from './board-eraser';
import { useBoardInk, type InkMode } from './board-ink';
import { useUserPreferences } from './user-preferences';
import {
  useClassroomDownloads,
  DownloadToggle,
  authorizeBoardDownload,
} from './classroom-downloads';
import {
  BoardReplica,
  BoardReplacementRequired,
  type BoardState,
  type BoardElement,
} from './board-replica';
type CollaboratorMap = NonNullable<
  Parameters<ExcalidrawImperativeAPI['updateScene']>[0]['collaborators']
>;
type CursorId = Parameters<CollaboratorMap['set']>[0];

export default function AdvancedBoard({
  roomId,
  document,
  userId,
  manager,
  pages,
  onSynchronize,
  canPresent = false,
}: {
  roomId: string;
  document: BoardPage;
  pages?: BoardPage[];
  userId: string;
  manager: boolean;
  onSynchronize?: (fn: (() => Promise<void>) | null) => void;
  canPresent?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const { preferences } = useUserPreferences();
  const downloads = useClassroomDownloads(roomId),
    downloadRoot = document.board_book_id ?? document.id,
    canDownload = downloads.canDownload('board', downloadRoot);
  const [eraserActive, setEraserActive] = useState(false);
  const [inkMode, setInkMode] = useState<InkMode>('pen');
  const [replica] = useState(
    () => new BoardReplica(localStorage, 'toaster-board:' + userId + ':' + document.id),
  );
  const [api, setApi] = useState<ExcalidrawImperativeAPI>();
  const editorRef = useRef<ExcalidrawImperativeAPI | undefined>(undefined);
  const canvasRef = useRef<HTMLDivElement>(null);
  const initializeEditor = useCallback((instance: ExcalidrawImperativeAPI) => {
    editorRef.current = instance;
    setApi(instance);
  }, []);
  const [loaded, setLoaded] = useState(false),
    [editable, setEditable] = useState(false);
  const [pending, setPending] = useState(0),
    [error, setError] = useState('');
  const [replacement, setReplacement] = useState<BoardState>();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [generation, setGeneration] = useState('');
  const [displayedZoom, setDisplayedZoom] = useState(100);
  const pointerActive = useRef(false),
    pointerFinishTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    deferredScene = useRef(false),
    lastEditorVersions = useRef(new Map<string, string>());
  const fingerprint = (element: {
    version?: unknown;
    versionNonce?: unknown;
    updated?: unknown;
    isDeleted?: unknown;
  }) => [element.version, element.versionNonce, element.updated, element.isDeleted].join(':');
  const [toolState, setToolState] = useState<BoardToolState>({
    tool: 'selection',
    color: '#1f2937',
    width: 2,
    opacity: 100,
    fontSize: 20,
    fontFamily: 2,
    textAlign: 'left',
    background: '#ffffff',
  });
  const [exportProgress, setExportProgress] = useState(0);
  const exportController = useRef<AbortController | null>(null);
  useEffect(() => () => exportController.current?.abort(), []);
  useEffect(() => {
    if (downloads.ready && !canDownload) exportController.current?.abort();
  }, [canDownload, downloads.ready]);
  const background = useRef<Record<string, unknown>[]>([]);
  const imageAbort = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    imageAbort.current = controller;
    return () => controller.abort();
  }, []);
  const backgroundId = document.background_file_id
    ? 'background_' + document.background_file_id
    : '';
  const [backgroundReady, setBackgroundReady] = useState(!document.background_file_id);
  useBoardInk(
    api,
    canvasRef,
    loaded && editable && backgroundReady && !eraserActive && toolState.tool === 'freedraw',
    inkMode,
    preferences.tools.pressurePen.sensitivity,
  );
  useEffect(() => {
    background.current = [];
    if (!document.background_file_id || !api) {
      setBackgroundReady(!document.background_file_id);
      return;
    }
    const controller = new AbortController();
    setBackgroundReady(false);
    void (async () => {
      const files = await pageImage(roomId, document, controller.signal);
      if (controller.signal.aborted) return;
      api.addFiles(files as never);
      background.current = pageBackground(document);
      refreshScene();
      setBackgroundReady(true);
      requestAnimationFrame(() =>
        api.scrollToContent(api.getSceneElements(), { fitToContent: true, animate: false }),
      );
    })().catch((e) => {
      if (!controller.signal.aborted) setError((e as Error).message);
    });
    return () => controller.abort();
  }, [api, document.background_file_id, document.page_rotation]);
  const running = useRef(false),
    flushWaiters = useRef<(() => void)[]>([]),
    nextLiveFlush = useRef(0),
    mounted = useRef(true),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const syncing = useRef(false),
    again = useRef(false);
  const syncWaiters = useRef<(() => void)[]>([]);
  const base = '/classrooms/' + roomId + '/documents/' + document.id + '/board';
  const presence = useBoardPresence(base, generation, loaded && !replacement, editable);
  const presenter = useBoardPresenter(
    base,
    generation,
    presence.viewTick,
    userId,
    canPresent && editable,
  );
  const followKey = 'toaster-board-follow:' + userId + ':' + document.id;
  const [following, setFollowing] = useState(() => localStorage.getItem(followKey) !== 'false');
  useEffect(() => {
    if (
      !api ||
      !backgroundReady ||
      !document.background_file_id ||
      !canvasRef.current ||
      (following && presenter.view?.active)
    )
      return;
    let frame = 0,
      settle = 0,
      width = 0,
      height = 0;
    const observer = new ResizeObserver(([entry]) => {
      const next = entry.contentRect;
      if (
        next.width < 20 ||
        next.height < 20 ||
        (Math.abs(next.width - width) < 20 && Math.abs(next.height - height) < 50)
      )
        return;
      width = next.width;
      height = next.height;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(settle);
      frame = requestAnimationFrame(() => {
        settle = requestAnimationFrame(() =>
          api.scrollToContent(api.getSceneElements(), { fitToContent: true, animate: false }),
        );
      });
    });
    observer.observe(canvasRef.current);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(settle);
    };
  }, [api, backgroundReady, document.background_file_id, following, presenter.view?.active]);
  const viewport = (state = editorRef.current?.getAppState()) => {
    if (!state) return { centerX: 0, centerY: 0, zoom: 1 };
    return {
      centerX: state.width / (2 * state.zoom.value) - state.scrollX,
      centerY: state.height / (2 * state.zoom.value) - state.scrollY,
      zoom: state.zoom.value,
    };
  };
  useEffect(() => {
    const view = presenter.view;
    if (
      !api ||
      !loaded ||
      replacement ||
      !following ||
      !view?.active ||
      !view.viewport ||
      view.actorId === userId ||
      view.generation !== generation
    )
      return;
    const apply = () => {
      const state = api.getAppState(),
        v = view.viewport!;
      api.updateScene({
        appState: {
          scrollX: state.width / (2 * v.zoom) - v.centerX,
          scrollY: state.height / (2 * v.zoom) - v.centerY,
          zoom: { value: v.zoom as typeof state.zoom.value },
        },
        captureUpdate: CaptureUpdateAction.NEVER,
      });
    };
    apply();
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(apply);
    };
    const observer = new ResizeObserver(schedule);
    if (canvasRef.current) observer.observe(canvasRef.current);
    window.addEventListener('resize', schedule);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
    };
  }, [api, loaded, replacement, following, presenter.view, generation, userId]);
  useEffect(() => {
    const colors = ['#1d4ed8', '#047857', '#9333ea', '#be123c', '#b45309'];
    const collaborators = new Map(
      presence.peers.map((peer) => {
        const index =
          [...peer.userId].reduce((sum, char) => sum + char.charCodeAt(0), 0) % colors.length;
        return [
          peer.id as CursorId,
          {
            id: peer.userId,
            username: peer.name,
            pointer: peer.pointer,
            button: peer.button,
            color: { background: '#ffffff', stroke: colors[index] },
          },
        ] as const;
      }),
    );
    api?.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER });
  }, [api, presence.peers]);
  const refreshScene = () => {
    if (
      pointerActive.current ||
      window.document.activeElement?.classList.contains('excalidraw-wysiwyg')
    ) {
      deferredScene.current = true;
      return;
    }
    deferredScene.current = false;
    const elements = restoreElements([...background.current, ...replica.scene()] as never, null);
    lastEditorVersions.current = new Map(
      elements.map((element) => [element.id, fingerprint(element)]),
    );
    editorRef.current?.updateScene({
      elements,
      appState: { viewBackgroundColor: replica.backgroundColor() },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  };
  useEffect(() => {
    const finish = () => {
      clearTimeout(pointerFinishTimer.current);
      pointerFinishTimer.current = setTimeout(() => {
        pointerFinishTimer.current = undefined;
        pointerActive.current = false;
        if (deferredScene.current) refreshScene();
      }, 0);
    };
    const focusout = () => {
      if (!pointerActive.current) finish();
    };
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    window.addEventListener('blur', finish);
    window.addEventListener('focusout', focusout);
    return () => {
      clearTimeout(pointerFinishTimer.current);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('blur', finish);
      window.removeEventListener('focusout', focusout);
    };
  }, [api]);
  async function flush() {
    if (running.current) return new Promise<void>((resolve) => flushWaiters.current.push(resolve));
    if (!replica.canEdit || !mounted.current) return;
    if (pointerActive.current && Date.now() < nextLiveFlush.current) {
      if (!timer.current)
        timer.current = setTimeout(() => {
          timer.current = undefined;
          void flush();
        }, nextLiveFlush.current - Date.now());
      return;
    }
    if (pointerActive.current) nextLiveFlush.current = Date.now() + 30;
    running.current = true;
    try {
      while (replica.pending.length && mounted.current && replica.canEdit) {
        replica.compactPending();
        const item = replica.pending[0];
        await request(base + '/updates', item);
        if (item.generation !== replica.generation) break;
        replica.acknowledge(item.id);
        if (mounted.current) setPending(replica.pending.length);
        if (pointerActive.current) break;
      }
      if (mounted.current) setError('');
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      running.current = false;
      for (const resolve of flushWaiters.current.splice(0)) resolve();
      if (replica.pending.length && pointerActive.current && !timer.current && mounted.current)
        timer.current = setTimeout(() => {
          timer.current = undefined;
          void flush();
        }, 30);
    }
  }
  async function sync() {
    if (syncing.current) {
      again.current = true;
      return new Promise<void>((resolve) => syncWaiters.current.push(resolve));
    }
    syncing.current = true;
    try {
      do {
        again.current = false;
        let result = await request<BoardState>(
          base + (replica.generation ? '?since=' + replica.revision : ''),
        );
        if (!mounted.current) return;
        if (
          replica.generation &&
          replica.generation !== result.generation &&
          result.state === undefined
        )
          result = await request<BoardState>(base);
        if (replica.receive(result)) editorRef.current?.history.clear();
        setGeneration(result.generation);
        setReplacement(undefined);
        setLoaded(true);
        setEditable(result.canEdit);
        setPending(replica.pending.length);
        const files = await loadBoardImages(
          roomId,
          document,
          replica.scene(),
          imageAbort.current.signal,
          new Set(Object.keys(editorRef.current?.getFiles() ?? {})),
        );
        if (!mounted.current) return;
        if (files.length) editorRef.current?.addFiles(files as never);
        refreshScene();
        await flush();
      } while (again.current && mounted.current);
    } catch (e) {
      if (mounted.current) {
        if (e instanceof BoardReplacementRequired) {
          setReplacement(e.replacement);
          setEditable(false);
        }
        setError((e as Error).message);
      }
    } finally {
      syncing.current = false;
      for (const resolve of syncWaiters.current.splice(0)) resolve();
    }
  }
  useClassroomEvents(
    roomId,
    (events) => {
      const ev = events?.find((e) => e.type === 'board_changed');
      if (
        events?.length === 1 &&
        ev &&
        ev.documentId === document.id &&
        typeof ev.generation === 'string' &&
        typeof ev.revision === 'number' &&
        ev.generation === replica.generation
      ) {
        if (ev.revision <= replica.revision) return;
        if (ev.revision === replica.revision + 1 && typeof ev.update === 'string') {
          if (
            replica.receive({
              generation: ev.generation,
              revision: ev.revision,
              canEdit: editable,
              updates: [{ revision: ev.revision, update: ev.update }],
            })
          )
            editorRef.current?.history.clear();
          const knownFiles = new Set(Object.keys(editorRef.current?.getFiles() ?? {}));
          const needsImages = replica
            .scene()
            .some(
              (el) =>
                el.type === 'image' &&
                !el.isDeleted &&
                typeof el.fileId === 'string' &&
                !knownFiles.has(el.fileId),
            );
          if (needsImages) {
            void loadBoardImages(
              roomId,
              document,
              replica.scene(),
              imageAbort.current.signal,
              knownFiles,
            ).then((files) => {
              if (!mounted.current) return;
              if (files.length) editorRef.current?.addFiles(files as never);
              refreshScene();
            });
          } else {
            refreshScene();
          }
          return;
        }
      }
      void sync();
    },
    ['board_changed', 'locks_changed'],
  );
  useEffect(() => {
    if (!api) return;
    onSynchronize?.(async () => {
      await flush();
      await sync();
      if (replica.pending.length) throw Error(t('boardPending', { count: replica.pending.length }));
    });
    return () => onSynchronize?.(null);
  }, [api, document.id]);
  useEffect(() => {
    mounted.current = true;
    void sync();
    const online = () => void sync();
    const unload = (event: BeforeUnloadEvent) => {
      if (replica.pending.length) event.preventDefault();
    };
    window.addEventListener('online', online);
    window.addEventListener('beforeunload', unload);
    return () => {
      mounted.current = false;
      clearTimeout(timer.current);
      window.removeEventListener('online', online);
      window.removeEventListener('beforeunload', unload);
      queueMicrotask(() => {
        if (!mounted.current) replica.destroy();
      });
    };
  }, [replica, api]);
  async function download(format: 'svg' | 'png' | 'pdf') {
    if (!api) return;
    setError('');
    try {
      await authorizeBoardDownload(roomId, downloadRoot, format);
      const options = {
        elements: api.getSceneElements(),
        appState: { ...api.getAppState(), exportEmbedScene: false },
        files: api.getFiles(),
        maxWidthOrHeight: 4096,
      };
      let blob: Blob;
      if (format === 'pdf') {
        await flush();
        await sync();
        if (replica.pending.length)
          throw Error(t('boardPending', { count: replica.pending.length }));
        const { exportBoardPages } = await import('./board-pdf-export');
        blob = await exportBoardPages(roomId, [document], new AbortController().signal, () => {});
      } else
        blob =
          format === 'png'
            ? await exportToBlob(options)
            : new Blob([new XMLSerializer().serializeToString(await exportToSvg(options))], {
                type: 'image/svg+xml',
              });
      await authorizeBoardDownload(roomId, downloadRoot, format);
      const url = URL.createObjectURL(blob),
        link = window.document.createElement('a');
      link.href = url;
      link.download = document.name + '.' + format;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function downloadBook() {
    if (exportController.current) return;
    const controller = (exportController.current = new AbortController());
    setExportProgress(1);
    setError('');
    try {
      await flush();
      await sync();
      controller.signal.throwIfAborted();
      if (replica.pending.length) throw Error(t('boardPending', { count: replica.pending.length }));
      const { exportBoardPages } = await import('./board-pdf-export');
      const book = pages?.length ? pages : [document];
      const blob = await exportBoardPages(roomId, book, controller.signal, setExportProgress);
      controller.signal.throwIfAborted();
      if (!mounted.current) return;
      const url = URL.createObjectURL(blob),
        link = window.document.createElement('a');
      link.href = url;
      link.download = book[0].name + '.pdf';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (e) {
      if (!controller.signal.aborted && mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setExportProgress(0);
      if (exportController.current === controller) exportController.current = null;
    }
  }
  return (
    <section className="advanced-board" aria-label={document.name}>
      <div className="board-status">
        <strong>{document.name}</strong>
        <span role="status">
          {!loaded
            ? t('loading')
            : pending
              ? t('boardPending', { count: pending })
              : t('boardSaved')}
        </span>
        {!editable && loaded && (
          <span className="board-read-only-status">{t('boardReadOnly')}</span>
        )}
        <button onClick={() => void sync()} aria-label={t('retry')} title={t('retry')}>
          <span aria-hidden="true">↻</span>
        </button>
        <button
          disabled={!loaded}
          onClick={() => api?.scrollToContent(undefined, { fitToContent: true, animate: false })}
        >
          {t('boardFit')}
        </button>
        <output aria-label={t('boardZoom')}>{displayedZoom}%</output>
        <DownloadToggle
          state={downloads}
          kind="board"
          targetId={downloadRoot}
          name={document.name}
        />
        <button
          className="board-download-pdf"
          dir="ltr"
          aria-label={t('boardDownloadPdf')}
          title={t('boardDownloadPdf')}
          disabled={!loaded || !backgroundReady || !canDownload || !!exportProgress}
          onClick={() => void downloadBook()}
        >
          PDF ↓
        </button>
        {!!exportProgress && (
          <button onClick={() => exportController.current?.abort()}>{t('cancel')}</button>
        )}
        {api && loaded && editable && (
          <BoardAnnotationTools
            api={api}
            roomId={roomId}
            page={document}
            settings={() => replica.settings()}
            onSettings={async (values) => {
              if (replica.edit(replica.scene(), undefined, values)) {
                setPending(replica.pending.length);
                await flush();
              }
            }}
          />
        )}
        <OverflowMenu>
          {manager && (
            <button
              onClick={() =>
                void request(base + '/access', { teacherOnly: !document.teacher_only })
                  .then(sync)
                  .catch((e) => setError(e.message))
              }
            >
              {t(document.teacher_only ? 'boardAllowEditing' : 'boardRestrictEditing')}
            </button>
          )}
          <button disabled={!loaded || !canDownload} onClick={() => void download('svg')}>
            SVG
          </button>
          {manager && (
            <button aria-expanded={historyOpen} onClick={() => setHistoryOpen(!historyOpen)}>
              {t('boardHistory')}
            </button>
          )}
          <button disabled={!loaded || !canDownload} onClick={() => void download('png')}>
            PNG
          </button>
          <button
            disabled={!loaded || !backgroundReady || !canDownload}
            onClick={() => void download('pdf')}
          >
            PDF
          </button>
          <button
            disabled={!loaded || !backgroundReady || !canDownload}
            onClick={async () => {
              const output = window.open('about:blank', '_blank');
              if (!output) {
                setError(t('annotationPopupBlocked'));
                return;
              }
              try {
                await flush();
                await sync();
                if (replica.pending.length)
                  throw Error(t('boardPending', { count: replica.pending.length }));
                const { exportBoardPages } = await import('./board-pdf-export');
                const blob = await exportBoardPages(
                  roomId,
                  pages?.length ? pages : [document],
                  new AbortController().signal,
                  () => {},
                );
                const url = URL.createObjectURL(blob);
                output.location.href = url;
                setTimeout(() => URL.revokeObjectURL(url), 120000);
              } catch (error) {
                output.close();
                setError((error as Error).message);
              }
            }}
          >
            {t('annotationPrint')}
          </button>
          {!!pages?.length && (
            <button
              disabled={!loaded || !!exportProgress || !canDownload}
              onClick={() => void downloadBook()}
            >
              {t('boardExportPagesPdf')}
            </button>
          )}
          {presenter.view?.canPresent && (
            <button
              disabled={!loaded || !!replacement || presenter.busy || !presenter.view?.canPresent}
              aria-pressed={!!presenter.view?.active && presenter.view.actorId === userId}
              onClick={() => void presenter.toggle(viewport())}
            >
              {t(
                presenter.view?.active && presenter.view.actorId === userId
                  ? 'boardStopPresenting'
                  : 'boardPresentView',
              )}
            </button>
          )}
        </OverflowMenu>
        {presenter.view?.active && presenter.view.actorId !== userId && (
          <button
            aria-pressed={following}
            onClick={() => {
              setFollowing(!following);
              localStorage.setItem(followKey, String(!following));
            }}
          >
            {t(following ? 'boardFollowingView' : 'boardIndependentView')}
          </button>
        )}
      </div>
      {presenter.error && (
        <p role="alert">
          {presenter.error}
          <button disabled={presenter.busy} onClick={() => void presenter.toggle(viewport())}>
            {t('boardRetryView')}
          </button>
        </p>
      )}
      {downloads.error && <p role="alert">{downloads.error}</p>}
      {downloads.ready && !canDownload && (
        <small role="status">{t('downloadDisabledNotice')}</small>
      )}
      {manager && historyOpen && (
        <BoardHistory
          base={base}
          roomId={roomId}
          synchronize={sync}
          current={() => ({
            generation: replica.generation,
            revision: replica.revision,
            canEdit: replica.canEdit,
            pending: replica.pending.length,
          })}
        />
      )}
      {error && <p role="alert">{error}</p>}
      {!!exportProgress && (
        <output role="status">
          {t('boardPdfExportProgress', { page: exportProgress, total: pages?.length ?? 1 })}
        </output>
      )}
      <div className="board-presence" aria-label={t('boardCollaborators')}>
        <span role="status">
          {t(presence.connected ? 'boardPointersConnected' : 'boardPointersDisconnected')}
        </span>
        {presence.peers.map((peer) => (
          <span key={peer.id} className="board-peer">
            {peer.name}
          </span>
        ))}
      </div>
      {replacement && (
        <div className="board-recovery">
          <p>{t('boardReplacementNotice')}</p>
          <button
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([replica.recoveryData()], { type: 'application/json' }),
              );
              const link = window.document.createElement('a');
              link.href = url;
              link.download = 'toaster-pending-board-recovery.json';
              link.click();
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            {t('boardDownloadRecovery')}
          </button>
          <button
            onClick={() => {
              if (!window.confirm(t('boardDiscardConfirm'))) return;
              try {
                replica.replace(replacement, true);
                replica.receive(replacement);
                editorRef.current?.history.clear();
                refreshScene();
                setReplacement(undefined);
                setPending(0);
                setLoaded(true);
                setGeneration(replacement.generation);
                setEditable(false);
                setError('');
                void sync();
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            {t('boardLoadRestored')}
          </button>
        </div>
      )}
      <div
        ref={canvasRef}
        className="advanced-board-canvas"
        dir="ltr"
        onPointerLeave={() => presence.send(null)}
        onPointerDownCapture={() => {
          // An earlier pointer-up may still be queued when a new stroke starts.
          // Keep remote scene replacement deferred throughout the new gesture.
          clearTimeout(pointerFinishTimer.current);
          pointerActive.current = true;
        }}
      >
        {api && editable && loaded && backgroundReady && (
          <BoardToolDock
            api={api}
            state={toolState}
            eraserActive={eraserActive}
            onEraserChange={setEraserActive}
            onInkModeChange={setInkMode}
            preferenceKey={'board-tools-v1:' + userId + ':' + roomId}
          />
        )}
        <Excalidraw
          excalidrawAPI={initializeEditor}
          langCode={i18n.language.startsWith('fa') ? 'fa-IR' : 'en'}
          viewModeEnabled={!loaded || !editable || !backgroundReady}
          isCollaborating
          validateEmbeddable={false}
          onPointerUpdate={({ pointer, button }) => presence.send(pointer, button)}
          initialData={{ elements: [], appState: { currentItemFontFamily: 1 } }}
          UIOptions={{
            tools: { image: false },
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              saveAsImage: false,
              export: false,
            },
          }}
          onPaste={() => false}
          onChange={(elements, appState) => {
            setToolState((current) => {
              const next = {
                tool: appState.activeTool.type,
                color: appState.currentItemStrokeColor,
                width: appState.currentItemStrokeWidth,
                opacity: appState.currentItemOpacity,
                fontSize: appState.currentItemFontSize,
                fontFamily: appState.currentItemFontFamily,
                textAlign: appState.currentItemTextAlign,
                background: appState.viewBackgroundColor,
              };
              return Object.keys(next).every(
                (key) => next[key as keyof BoardToolState] === current[key as keyof BoardToolState],
              )
                ? current
                : next;
            });
            setDisplayedZoom(Math.round(appState.zoom.value * 100));
            if (loaded && !replacement) presenter.move(viewport(appState));
            if (!loaded || !editable) return;
            try {
              const latest = new Map(replica.scene().map((element) => [element.id, element]));
              const local = elements.filter((element) => element.id !== backgroundId);
              const merged = local.map((element) =>
                lastEditorVersions.current.get(element.id) === fingerprint(element)
                  ? (latest.get(element.id) ?? element)
                  : element,
              );
              for (const element of local)
                lastEditorVersions.current.set(element.id, fingerprint(element));
              if (replica.edit(merged as unknown as BoardElement[], appState.viewBackgroundColor)) {
                setPending(replica.pending.length);
                if (!timer.current)
                  timer.current = setTimeout(() => {
                    timer.current = undefined;
                    void flush();
                  }, 30);
              }
              if (
                backgroundReady &&
                backgroundId &&
                !elements.some((element) => element.id === backgroundId)
              )
                queueMicrotask(refreshScene);
            } catch (e) {
              setError((e as Error).message);
              refreshScene();
            }
          }}
        >
          <MainMenu>
            <MainMenu.DefaultItems.ToggleTheme />
            <MainMenu.DefaultItems.ChangeCanvasBackground />
          </MainMenu>
        </Excalidraw>
        {api && editable && loaded && backgroundReady && eraserActive && (
          <BoardEraser
            api={api}
            size={preferences.tools.eraserSize}
            onExit={() => setEraserActive(false)}
          />
        )}
      </div>
    </section>
  );
}
