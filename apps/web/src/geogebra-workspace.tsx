import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import { useClassroomConnection } from './live';
import OverflowMenu from './overflow-menu';

type Worksheet = {
  id: string;
  name: string;
  revision: number;
  state_base64: string;
  canEdit: boolean;
};
type Draft = { revision: number; state: string };
const MAX_FILE = 5 * 1024 * 1024;
const base64 = (bytes: Uint8Array) => {
  let text = '';
  for (let index = 0; index < bytes.length; index += 8192)
    text += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(text);
};
export default function GeoGebraWorkspace({
  roomId,
  userId,
  manager,
  canEdit,
  selectedId,
  canSelect = manager,
  onSelect,
  perspective,
  onPerspective,
}: {
  roomId: string;
  userId: string;
  manager: boolean;
  canEdit: boolean;
  perspective?: string;
  onPerspective?: (value: string) => Promise<void>;
  selectedId?: string | null;
  canSelect?: boolean;
  onSelect?: (id: string) => Promise<void>;
}) {
  const { t, i18n } = useTranslation(),
    base = '/classrooms/' + roomId + '/geogebra';
  const [rows, setRows] = useState<Pick<Worksheet, 'id' | 'name' | 'revision'>[]>([]),
    [selected, setSelected] = useState(''),
    [document, setDocument] = useState<Worksheet | null>(null);
  const [ready, setReady] = useState(false),
    [boot, setBoot] = useState(0),
    [status, setStatus] = useState('saved'),
    [error, setError] = useState(''),
    [creating, setCreating] = useState(false),
    [recovery, setRecovery] = useState<Draft | null>(null);
  const frame = useRef<HTMLIFrameElement>(null),
    upload = useRef<HTMLInputElement>(null),
    doc = useRef(document),
    mounted = useRef(true),
    saving = useRef(false),
    dirty = useRef(false),
    blocked = useRef(false),
    pending = useRef<{ state: string; generation: number } | null>(null),
    generation = useRef(0),
    loadVersion = useRef(0),
    listVersion = useRef(0),
    frameReady = useRef(false);
  useEffect(() => {
    if (selectedId && selectedId !== selected) {
      void flush().finally(() => setSelected(selectedId));
    }
  }, [selectedId]);
  const perspectiveRef = useRef(perspective);
  perspectiveRef.current = perspective;
  useEffect(() => {
    if (ready && perspective) post('perspective', { perspective });
  }, [ready, perspective]);
  doc.current = document;
  const language = i18n.language.startsWith('fa') ? 'fa' : 'en',
    token = useMemo(() => crypto.randomUUID(), [selected, language, boot]);
  const mathOrigin =
    import.meta.env.VITE_GEOGEBRA_ORIGIN ||
    (['localhost', '127.0.0.1'].includes(location.hostname)
      ? location.protocol + '//geogebra.localhost:' + location.port
      : '');
  const cacheKey = 'geogebra-draft:' + userId + ':' + roomId + ':' + selected;
  const writable = Boolean(canEdit && document?.canEdit);
  const post = (type: string, extra: Record<string, unknown> = {}) =>
    frame.current?.contentWindow?.postMessage(
      { channel: 'toaster-geogebra', token, type, ...extra },
      '*',
    );
  const cache = (value: Draft) => {
    try {
      localStorage.setItem(cacheKey, JSON.stringify(value));
    } catch {
      setError(t('geoLocalCacheError'));
    }
  };
  const download = (format: string, data: string) => {
    if (
      !['ggb', 'png', 'svg', 'pdf'].includes(format) ||
      typeof data !== 'string' ||
      data.length > 24 * 1024 * 1024
    )
      return;
    try {
      const mime =
        format === 'ggb'
          ? 'application/vnd.geogebra.file'
          : format === 'png'
            ? 'image/png'
            : format === 'svg'
              ? 'image/svg+xml'
              : 'application/pdf';
      const prefix = 'data:' + mime + ';base64,';
      const encoded = data.startsWith(prefix) ? data.slice(prefix.length) : data;
      const bytes =
        format === 'svg'
          ? data
          : Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: mime })),
        link = window.document.createElement('a');
      link.href = url;
      link.download = (doc.current?.name ?? 'GeoGebra') + '.' + format;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError(t('geoExportFailed'));
    }
  };
  async function load(id = selected, force = false) {
    if (!id) return;
    const version = ++loadVersion.current;
    try {
      const next = await request<Worksheet>(base + '/' + id, undefined, { silent: true });
      if (!mounted.current || version !== loadVersion.current) return;
      if (!force && (dirty.current || saving.current)) {
        if (doc.current && next.revision !== doc.current.revision && !saving.current) {
          blocked.current = true;
          setStatus('conflict');
        }
        return;
      }
      doc.current = next;
      setDocument(next);
      setError('');
      if (frameReady.current)
        post('load', { state: next.state_base64, canEdit: canEdit && next.canEdit });
      try {
        const saved = JSON.parse(localStorage.getItem(cacheKey) ?? 'null');
        if (
          saved &&
          typeof saved.state === 'string' &&
          Number.isInteger(saved.revision) &&
          saved.state.length <= 7000000
        )
          setRecovery(saved);
      } catch {}
    } catch (e) {
      if (mounted.current && version === loadVersion.current) setError((e as Error).message);
    }
  }
  async function refresh() {
    const version = ++listVersion.current;
    try {
      const next = await request<Pick<Worksheet, 'id' | 'name' | 'revision'>[]>(base, undefined, {
        silent: true,
      });
      if (!mounted.current || version !== listVersion.current) return;
      setRows(next);
      if (!selected && next.length) {
        const id = selectedId ?? next[0].id;
        setSelected(id);
        if (canSelect && !selectedId) void onSelect?.(id);
      }
      const current = next.find((row) => row.id === selected);
      if (current && current.revision !== doc.current?.revision) void load(current.id);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  }
  async function flush() {
    if (saving.current || blocked.current || !pending.current || !doc.current || !writable) return;
    saving.current = true;
    setStatus('saving');
    try {
      while (pending.current && mounted.current && !blocked.current) {
        const snapshot = pending.current;
        pending.current = null;
        const current: Worksheet = doc.current!;
        try {
          const result = await request<{ revision: number }>(
            base + '/' + current.id,
            { revision: current.revision, state: snapshot.state },
            { silent: true },
          );
          if (!mounted.current) return;
          const next: Worksheet = {
            ...current,
            revision: result.revision,
            state_base64: snapshot.state,
          };
          doc.current = next;
          setDocument(next);
          if (generation.current === snapshot.generation && !pending.current) {
            dirty.current = false;
            setStatus('saved');
            setError('');
            setRecovery(null);
            try {
              localStorage.removeItem(cacheKey);
            } catch {}
          } else setStatus('pending');
        } catch (e) {
          if (!pending.current) pending.current = snapshot;
          if ((e as { status?: number }).status === 409) {
            blocked.current = true;
            setStatus('conflict');
          } else setStatus('error');
          setError((e as Error).message);
          break;
        }
      }
    } finally {
      saving.current = false;
    }
  }
  useClassroomConnection(roomId, () => void refresh(), ['geogebra_changed']);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      loadVersion.current++;
      listVersion.current++;
    };
  }, [roomId]);
  useEffect(() => {
    frameReady.current = false;
    setReady(false);
    setDocument(null);
    doc.current = null;
    pending.current = null;
    dirty.current = false;
    blocked.current = false;
    setRecovery(null);
    setStatus('saved');
    void load(selected, true);
    return () => {
      loadVersion.current++;
    };
  }, [selected]);
  useEffect(() => {
    if (selected && !dirty.current && !saving.current) void load(selected, true);
    else if (frameReady.current) post('permissions', { canEdit });
  }, [canEdit]);
  useEffect(() => {
    setReady(false);
    frameReady.current = false;
  }, [token]);
  useEffect(() => {
    if (!document || ready) return;
    const timer = setTimeout(() => setError(t('geoLoadFailed')), 45000);
    return () => clearTimeout(timer);
  }, [token, document?.id, ready]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const message = event.data;
      if (
        event.source !== frame.current?.contentWindow ||
        event.origin !== mathOrigin ||
        message?.channel !== 'toaster-geogebra' ||
        message.token !== token
      )
        return;
      if (message.type === 'ready') {
        frameReady.current = true;
        const current = doc.current;
        if (current)
          post('load', { state: current.state_base64, canEdit: canEdit && current.canEdit });
      } else if (message.type === 'loaded') {
        setReady(true);
        if (perspectiveRef.current) post('perspective', { perspective: perspectiveRef.current });
      } else if (message.type === 'dirty' && writable) {
        generation.current++;
        dirty.current = true;
        setStatus(blocked.current ? 'conflict' : 'pending');
      } else if (
        message.type === 'state' &&
        writable &&
        typeof message.state === 'string' &&
        message.state.length <= 7000000
      ) {
        dirty.current = true;
        pending.current = { state: message.state, generation: generation.current };
        cache({ revision: doc.current!.revision, state: message.state });
        void flush();
      } else if (message.type === 'download') download(message.format, message.data);
      else if (message.type === 'error')
        setError(t(message.kind === 'export' ? 'geoExportFailed' : 'geoLoadFailed'));
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [token, writable, selected]);
  useEffect(() => {
    const leaving = (event: BeforeUnloadEvent) => {
      if (dirty.current || saving.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', leaving);
    return () => window.removeEventListener('beforeunload', leaving);
  }, []);
  const reload = async () => {
    blocked.current = false;
    pending.current = null;
    dirty.current = false;
    setRecovery(null);
    try {
      localStorage.removeItem(cacheKey);
    } catch {}
    setStatus('saved');
    await load(selected, true);
  };
  return (
    <section className="geogebra-workspace" aria-label={t('geoTitle')}>
      <header className="geogebra-toolbar">
        <label className="geogebra-worksheet-picker">
          <span className="sr-only">{t('geoWorksheet')}</span>
          <select
            aria-label={t('geoWorksheet')}
            value={selected}
            disabled={!canSelect || !rows.length || dirty.current || saving.current}
            onChange={(event) => {
              const id = event.target.value;
              if (onSelect) void onSelect(id).catch((e) => setError(e.message));
              else setSelected(id);
            }}
          >
            {rows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        </label>
        {manager && (
          <button
            disabled={creating || rows.length >= 40 || dirty.current}
            onClick={async () => {
              setCreating(true);
              setError('');
              try {
                const next = await request<{ id: string }>(base, {
                  name: t('geoWorksheet') + ' ' + (rows.length + 1),
                });
                await refresh();
                if (onSelect) await onSelect(next.id);
                else setSelected(next.id);
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setCreating(false);
              }
            }}
          >
            {t('geoNew')}
          </button>
        )}
        {document && (
          <>
            {writable && (
              <button
                disabled={!ready || status === 'conflict'}
                onClick={() => {
                  dirty.current = true;
                  setStatus('pending');
                  post('snapshot');
                }}
              >
                {t('geoSave')}
              </button>
            )}
            <OverflowMenu>
              {writable && (
                <button
                  disabled={!ready || dirty.current || saving.current || status === 'conflict'}
                  onClick={() => upload.current?.click()}
                >
                  {t('geoImport')}
                </button>
              )}
              {['ggb', 'png', 'svg', 'pdf'].map((format) => (
                <button key={format} disabled={!ready} onClick={() => post('export', { format })}>
                  {t('geoExport')} {format.toUpperCase()}
                </button>
              ))}
            </OverflowMenu>
            <label className="geogebra-view-picker">
              <span className="sr-only">{t('geoView')}</span>
              <select
                aria-label={t('geoView')}
                disabled={!ready || !canSelect}
                value={perspective ?? '1'}
                onChange={(event) => {
                  if (onPerspective)
                    void onPerspective(event.target.value).catch((e) => setError(e.message));
                  else post('perspective', { perspective: event.target.value });
                }}
              >
                {['Algebra', 'Geometry', 'Spreadsheet', 'CAS', '3D', 'Probability'].map(
                  (name, index) => (
                    <option key={name} value={index + 1}>
                      {t('geoView' + name)}
                    </option>
                  ),
                )}
              </select>
            </label>
            <small role="status">{t(writable ? 'geoStatus_' + status : 'geoReadOnly')}</small>
          </>
        )}
      </header>
      {error && (
        <div className="geogebra-notice" role="alert">
          <span>{error}</span>
          <button
            onClick={() => {
              if (!ready) {
                setBoot((value) => value + 1);
                setError('');
              } else if (pending.current && !blocked.current) void flush();
              else void load(selected, true);
            }}
          >
            {t('retry')}
          </button>
        </div>
      )}
      {status === 'conflict' && (
        <div className="geogebra-notice">
          <span>{t('geoConflict')}</span>
          <button onClick={() => post('export', { format: 'ggb' })}>{t('geoExport')} GGB</button>
          <button onClick={() => void reload()}>{t('geoReload')}</button>
        </div>
      )}
      {recovery && status !== 'conflict' && (
        <div className="geogebra-notice">
          <span>{t('geoRecovery')}</span>
          <button
            disabled={!ready || !writable || recovery.revision !== document?.revision}
            onClick={() => {
              post('load', { state: recovery.state, canEdit: true });
              pending.current = { state: recovery.state, generation: ++generation.current };
              dirty.current = true;
              void flush();
            }}
          >
            {t('geoRestore')}
          </button>
          <button onClick={() => download('ggb', recovery.state)}>{t('geoExport')} GGB</button>
          <button
            onClick={() => {
              try {
                localStorage.removeItem(cacheKey);
              } catch {}
              setRecovery(null);
            }}
          >
            {t('chatCancel')}
          </button>
        </div>
      )}
      <input
        className="sr-only"
        ref={upload}
        type="file"
        accept=".ggb"
        aria-label={t('geoImport')}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file || !doc.current) return;
          if (file.size > MAX_FILE) {
            setError(t('geoFileTooLarge'));
            return;
          }
          try {
            const state = base64(new Uint8Array(await file.arrayBuffer()));
            const result = await request<{ revision: number }>(base + '/' + doc.current.id, {
              revision: doc.current.revision,
              state,
            });
            const next = { ...doc.current, revision: result.revision, state_base64: state };
            doc.current = next;
            setDocument(next);
            post('load', { state, canEdit: writable });
            setStatus('saved');
            setError('');
          } catch (e) {
            setError((e as Error).message);
          }
        }}
      />
      {document ? (
        <div className="geogebra-frame-container">
          {!ready && mathOrigin && mathOrigin !== location.origin && (
            <div className="geogebra-loading" role="status">
              {t('geoLoading')}
            </div>
          )}
          {mathOrigin && mathOrigin !== location.origin ? (
            <iframe
              ref={frame}
              key={token}
              title={t('geoTitle')}
              src={
                mathOrigin +
                '/geogebra/frame.html#token=' +
                token +
                '&lang=' +
                language +
                '&edit=1&parent=' +
                encodeURIComponent(location.origin)
              }
              sandbox="allow-scripts allow-same-origin allow-downloads"
              allow="fullscreen"
            />
          ) : (
            <p role="alert">{t('geoOriginRequired')}</p>
          )}
        </div>
      ) : (
        <div className="geogebra-empty">
          <p>{t(manager ? 'geoStart' : 'geoEmpty')}</p>
        </div>
      )}
      <footer>
        <a href="https://www.geogebra.org" target="_blank" rel="noopener noreferrer">
          GeoGebra®
        </a>
      </footer>
    </section>
  );
}
