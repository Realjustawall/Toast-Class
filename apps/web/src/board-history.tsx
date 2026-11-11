import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Y from 'yjs';
import { exportToSvg, restoreElements } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import { validateBoard } from '../../../packages/whiteboard/schema';
import { request } from './api';
import { ResponseError } from './http-response';
import { useClassroomEvents } from './live';
import type { BoardState } from './board-replica';

type Version = {
  id: string;
  label: string;
  kind: 'manual' | 'automatic' | 'before_restore';
  generation: string;
  revision: number;
  created_at: string;
  state_base64?: string;
};
export default function BoardHistory({
  base,
  roomId,
  synchronize,
  current,
}: {
  base: string;
  roomId: string;
  synchronize: () => Promise<void>;
  current: () => BoardState & { pending: number };
}) {
  const { t, i18n } = useTranslation();
  const [versions, setVersions] = useState<Version[]>([]),
    [label, setLabel] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ url: string; label: string }>();
  const mounted = useRef(true),
    previewRequest = useRef(0);
  const restoreAttempt = useRef<
    | {
        version: string;
        body: { id: string; expectedGeneration: string; expectedRevision: number };
      }
    | undefined
  >(undefined);
  const saveAttempt = useRef<
    { id: string; label: string; expectedGeneration: string; expectedRevision: number } | undefined
  >(undefined);
  const versionLabel = (v: Version) =>
    v.kind === 'manual'
      ? v.label
      : t(v.kind === 'automatic' ? 'boardAutomaticVersion' : 'boardBeforeRestore', {
          revision: new Intl.NumberFormat(i18n.language).format(v.revision),
        });
  async function load() {
    try {
      const data = await request<Version[]>(base + '/versions');
      if (mounted.current) setVersions(data);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  }
  useClassroomEvents(roomId, () => void load(), ['board_changed']);
  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      previewRequest.current++;
    };
  }, [base]);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview.url);
    },
    [preview],
  );
  async function act(operation: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await operation();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setBusy(false);
    }
  }
  async function expected() {
    await synchronize();
    const state = current();
    if (!state.generation || state.pending) throw new Error(t('boardSyncBeforeVersion'));
    return { expectedGeneration: state.generation, expectedRevision: state.revision };
  }
  return (
    <section className="board-history" aria-label={t('boardHistory')}>
      <h3>{t('boardHistory')}</h3>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void act(async () => {
            if (!saveAttempt.current || saveAttempt.current.label !== label)
              saveAttempt.current = { id: crypto.randomUUID(), label, ...(await expected()) };
            try {
              await request(base + '/versions', saveAttempt.current);
            } catch (e) {
              if (e instanceof ResponseError && e.status >= 400 && e.status < 500)
                saveAttempt.current = undefined;
              throw e;
            }
            saveAttempt.current = undefined;
            setLabel('');
            await load();
          });
        }}
      >
        <label>
          {t('boardVersionName')}
          <input
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            required
            maxLength={120}
          />
        </label>
        <button disabled={busy}>{t('boardSaveVersion')}</button>
      </form>
      {error && <p role="alert">{error}</p>}
      {!versions.length && <p>{t('boardNoVersions')}</p>}
      <ul>
        {versions.map((version) => (
          <li key={version.id}>
            <span>
              {versionLabel(version)} ·{' '}
              {new Intl.DateTimeFormat(i18n.language, {
                dateStyle: 'short',
                timeStyle: 'short',
              }).format(new Date(version.created_at))}
            </span>
            <button
              disabled={busy}
              aria-label={t('boardPreviewVersion', { name: versionLabel(version) })}
              onClick={() =>
                void act(async () => {
                  const ticket = ++previewRequest.current;
                  const saved = await request<Version>(base + '/versions/' + version.id),
                    doc = new Y.Doc();
                  try {
                    if (saved.state_base64)
                      Y.applyUpdate(
                        doc,
                        Uint8Array.from(atob(saved.state_base64), (c) => c.charCodeAt(0)),
                      );
                    validateBoard(doc);
                    const svg = await exportToSvg({
                      elements: restoreElements(
                        [...doc.getMap('elements').values()] as ExcalidrawElement[],
                        null,
                      ),
                      appState: {
                        exportBackground: true,
                        viewBackgroundColor: String(
                          doc.getMap('settings').get('backgroundColor') ?? '#ffffff',
                        ),
                      },
                      files: {},
                    });
                    const url = URL.createObjectURL(
                      new Blob([new XMLSerializer().serializeToString(svg)], {
                        type: 'image/svg+xml',
                      }),
                    );
                    if (mounted.current && ticket === previewRequest.current)
                      setPreview({ url, label: versionLabel(version) });
                    else URL.revokeObjectURL(url);
                  } finally {
                    doc.destroy();
                  }
                })
              }
            >
              {t('boardPreview')}
            </button>
            <button
              disabled={busy}
              aria-label={t('boardRestoreVersion', { name: versionLabel(version) })}
              onClick={() => {
                if (!window.confirm(t('boardRestoreConfirm'))) return;
                void act(async () => {
                  if (!restoreAttempt.current || restoreAttempt.current.version !== version.id)
                    restoreAttempt.current = {
                      version: version.id,
                      body: { id: crypto.randomUUID(), ...(await expected()) },
                    };
                  try {
                    await request(
                      base + '/versions/' + version.id + '/restore',
                      restoreAttempt.current.body,
                    );
                  } catch (e) {
                    if (e instanceof ResponseError && e.status >= 400 && e.status < 500)
                      restoreAttempt.current = undefined;
                    throw e;
                  }
                  restoreAttempt.current = undefined;
                  await synchronize();
                  await load();
                });
              }}
            >
              {t('boardRestore')}
            </button>
          </li>
        ))}
      </ul>
      {preview && (
        <figure>
          <img src={preview.url} alt={t('boardVersionPreview', { name: preview.label })} />
          <figcaption>{preview.label}</figcaption>
        </figure>
      )}
    </section>
  );
}
