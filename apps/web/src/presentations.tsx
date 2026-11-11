import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import { useClassroomDownloads, DownloadToggle } from './classroom-downloads';

type Presentation = {
  id: string;
  name: string;
  status: string;
  pageCount: number | null;
  failureCode: string | null;
  sourceFileId: string;
  attempts: number;
};
export type PresentationState = {
  sessionId: string | null;
  enabled: boolean;
  canManage: boolean;
  presentations: Presentation[];
  revision: number;
  current: { presentationId: string; page: number; independentView: boolean } | null;
};
type Details = Presentation & {
  originalUrl?: string;
  assets: { fileId: string; page: number; width: number | null; height: number | null }[];
};

export default function Presentations({
  roomId,
  state,
  sessionActive,
  refresh,
}: {
  roomId: string;
  state?: PresentationState;
  sessionActive: boolean;
  refresh: () => Promise<void>;
}) {
  const { t, i18n } = useTranslation(),
    base = '/classrooms/' + roomId + '/presentations';
  const downloads = useClassroomDownloads(roomId);
  const [details, setDetails] = useState<Details>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [following, setFollowing] = useState(true),
    [pendingIndependent, setPendingIndependent] = useState<{ value: boolean; revision: number }>(),
    [localPage, setLocalPage] = useState(1),
    [zoom, setZoom] = useState(100);
  const stage = useRef<HTMLDivElement>(null),
    current = state?.current,
    manager = !!state?.canManage;
  const scroll = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<{ width: number; height: number }>();
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    const controller = new AbortController();
    setDetails(undefined);
    setFollowing(true);
    setPendingIndependent(undefined);
    setLocalPage(1);
    setZoom(100);
    if (current)
      void fetch('/api/v1' + base + '/' + current.presentationId, {
        credentials: 'same-origin',
        signal: controller.signal,
      })
        .then(async (response) => {
          const value = await response.json();
          if (!response.ok) throw new Error(value.error ?? t('error'));
          if (!controller.signal.aborted) setDetails(value);
        })
        .catch((e) => {
          if (e.name !== 'AbortError') setError(e.message);
        });
    return () => controller.abort();
  }, [roomId, current?.presentationId]);
  useEffect(() => {
    const interval = setInterval(() => void refreshRef.current(), 2500);
    return () => clearInterval(interval);
  }, [roomId]);
  const number = (n: number) => new Intl.NumberFormat(i18n.language).format(n);
  useEffect(() => {
    if (pendingIndependent && state && state.revision > pendingIndependent.revision)
      setPendingIndependent(undefined);
  }, [state?.revision, pendingIndependent]);
  const page =
    current && (manager || !current.independentView || following) ? current.page : localPage;
  const selected = details?.assets.find((a) => a.page === page),
    pdf = details?.assets.find((a) => a.page === 0);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const update = () => setViewport({ width: element.clientWidth, height: element.clientHeight });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    update();
    return () => observer.disconnect();
  }, [selected?.fileId]);
  async function act(path: string, data: unknown) {
    setBusy(true);
    setError('');
    try {
      await request(
        base + path,
        path === '/control'
          ? { ...(data as Record<string, unknown>), sessionId: state?.sessionId }
          : data,
      );
      await refresh();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  function change(page: number) {
    if (!current || !details || page < 1 || page > (details.pageCount ?? 0)) return;
    if (manager)
      void act('/control', {
        action: 'show',
        presentationId: current.presentationId,
        page,
        independentView: current.independentView,
        expectedRevision: state!.revision,
      });
    else if (current.independentView && !following) setLocalPage(page);
  }
  if (!state) return <p role="status">{t('loading')}</p>;
  return (
    <section className="presentations" aria-label={t('presentationLibrary')}>
      <header className="presentation-heading">
        <div>
          <h2>{t('presentationLibrary')}</h2>
          <p>{t('presentationIntro')}</p>
        </div>
        <button onClick={() => void refresh()}>{t('refresh')}</button>
      </header>
      {(error || downloads.error) && (
        <p role="alert" className="error">
          {error || downloads.error}
        </p>
      )}
      {!state.enabled && <p role="status">{t('presentationUnavailable')}</p>}
      {current ? (
        <div className="presentation-viewer" ref={stage}>
          <header>
            <h3>
              <bdi>{details?.name ?? t('loading')}</bdi>
            </h3>
            {details && (
              <span aria-live="polite">
                {t('presentationPageCount', {
                  page: number(page),
                  total: number(details.pageCount ?? 0),
                })}
              </span>
            )}
          </header>
          {details ? (
            <>
              <div className="presentation-controls">
                <button
                  disabled={
                    busy || page <= 1 || (!manager && (!current.independentView || following))
                  }
                  onClick={() => change(page - 1)}
                >
                  {t('presentationPrevious')}
                </button>
                <button
                  disabled={
                    busy ||
                    page >= (details.pageCount ?? 0) ||
                    (!manager && (!current.independentView || following))
                  }
                  onClick={() => change(page + 1)}
                >
                  {t('presentationNext')}
                </button>
                <label>
                  {t('presentationZoom')}
                  <input
                    aria-label={t('presentationZoom')}
                    type="range"
                    min="30"
                    max="200"
                    value={zoom}
                    onChange={(e) => setZoom(Number(e.target.value))}
                  />
                  <span>{number(zoom)}%</span>
                </label>
                <button onClick={() => setZoom(100)}>{t('presentationFit')}</button>
                {document.fullscreenEnabled && (
                  <button
                    onClick={() => {
                      const operation =
                        document.fullscreenElement === stage.current
                          ? document.exitFullscreen()
                          : stage.current?.requestFullscreen();
                      void operation?.catch(() => setError(t('presentationFullscreenError')));
                    }}
                  >
                    {t(
                      document.fullscreenElement === stage.current
                        ? 'presentationExitFullscreen'
                        : 'presentationFullscreen',
                    )}
                  </button>
                )}
                <DownloadToggle
                  state={downloads}
                  kind="presentation"
                  targetId={details.id}
                  name={details.name}
                />
                {pdf &&
                  downloads.canDownload('presentation', details.id) &&
                  downloads.canDownload('file', details.sourceFileId) && (
                    <a
                      className="quiet"
                      href={'/api/v1/classrooms/' + roomId + '/files/' + pdf.fileId + '/content'}
                    >
                      {t('presentationDownloadPdf')}
                    </a>
                  )}
                {details.originalUrl &&
                  downloads.canDownload('presentation', details.id) &&
                  downloads.canDownload('file', details.sourceFileId) && (
                    <a className="quiet" href={details.originalUrl}>
                      {t('presentationDownloadOriginal')}
                    </a>
                  )}
                {manager ? (
                  <>
                    <label>
                      <input
                        type="checkbox"
                        checked={pendingIndependent?.value ?? current.independentView}
                        disabled={busy || !!pendingIndependent}
                        onChange={(e) => {
                          const value = e.target.checked;
                          setPendingIndependent({ value, revision: state.revision });
                          void act('/control', {
                            action: 'show',
                            presentationId: current.presentationId,
                            page: current.page,
                            independentView: value,
                            expectedRevision: state.revision,
                          }).then((ok) => {
                            if (!ok) setPendingIndependent(undefined);
                          });
                        }}
                      />
                      {t('presentationAllowIndependent')}
                    </label>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act('/control', { action: 'hide', expectedRevision: state.revision })
                      }
                    >
                      {t('presentationHide')}
                    </button>
                  </>
                ) : current.independentView ? (
                  <label>
                    <input
                      type="checkbox"
                      checked={following}
                      onChange={(e) => {
                        setFollowing(e.target.checked);
                        setLocalPage(current.page);
                      }}
                    />
                    {t('presentationFollow')}
                  </label>
                ) : (
                  <p>{t('presentationFollowing')}</p>
                )}
              </div>
              <div className="presentation-slide-scroll" ref={scroll}>
                {selected ? (
                  <img
                    key={selected.fileId}
                    style={{
                      width:
                        viewport && selected.width && selected.height
                          ? (Math.min(
                              viewport.width,
                              (viewport.height * selected.width) / selected.height,
                            ) *
                              zoom) /
                            100
                          : zoom + '%',
                      maxWidth: 'none',
                    }}
                    src={'/api/v1/classrooms/' + roomId + '/files/' + selected.fileId + '/content'}
                    alt={t('presentationSlideAlt', {
                      page: number(page),
                      total: number(details.pageCount ?? 0),
                    })}
                    onError={() => setError(t('presentationImageError'))}
                  />
                ) : (
                  <p role="status">{t('loading')}</p>
                )}
              </div>
              {(manager || (current.independentView && !following)) && (
                <nav className="presentation-thumbnails" aria-label={t('presentationSlides')}>
                  {details.assets
                    .filter((a) => a.page > 0)
                    .map((a) => (
                      <button
                        key={a.fileId}
                        aria-label={t('presentationGoTo', { page: number(a.page) })}
                        aria-current={a.page === page ? 'page' : undefined}
                        disabled={busy}
                        onClick={() => change(a.page)}
                      >
                        <img
                          loading="lazy"
                          src={'/api/v1/classrooms/' + roomId + '/files/' + a.fileId + '/content'}
                          alt=""
                        />
                        <span>{number(a.page)}</span>
                      </button>
                    ))}
                </nav>
              )}
            </>
          ) : (
            <p role="status">{t('loading')}</p>
          )}
        </div>
      ) : (
        <div className="presentation-empty">
          <h3>{t('presentationNoActive')}</h3>
          <p>{t(manager ? 'presentationPrepareHelp' : 'presentationWaitForTeacher')}</p>
        </div>
      )}
      {manager && (
        <div className="presentation-library-list">
          {state.presentations.length === 0 ? (
            <p>{t('presentationEmptyLibrary')}</p>
          ) : (
            state.presentations.map((p) => (
              <article key={p.id}>
                <div>
                  <h3>
                    <bdi>{p.name}</bdi>
                  </h3>
                  <p>{t('presentationStatus_' + p.status)}</p>
                  {p.failureCode && (
                    <p className="error">
                      {t('presentationFailure_' + p.failureCode, {
                        defaultValue: t('presentationFailureGeneric'),
                      })}
                    </p>
                  )}
                </div>
                <div className="presentation-library-actions">
                  {p.status === 'ready' && (
                    <button
                      disabled={busy || !sessionActive}
                      onClick={() =>
                        void act('/control', {
                          action: 'show',
                          presentationId: p.id,
                          page: 1,
                          independentView: false,
                          expectedRevision: state.revision,
                        })
                      }
                    >
                      {t('presentationShow')}
                    </button>
                  )}
                  {p.status === 'failed' && state.enabled && (
                    <button disabled={busy} onClick={() => void act('/' + p.id + '/retry', {})}>
                      {t('presentationRetry')}
                    </button>
                  )}
                  {p.status !== 'processing' && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(t('presentationDeleteQuestion', { name: p.name })))
                          void act('/' + p.id + '/delete', {});
                      }}
                    >
                      {t('presentationDelete')}
                    </button>
                  )}
                </div>
              </article>
            ))
          )}
        </div>
      )}
      {manager && !sessionActive && <p>{t('presentationStartSession')}</p>}
    </section>
  );
}
