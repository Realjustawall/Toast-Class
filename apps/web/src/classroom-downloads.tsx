import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import { useClassroomConnection } from './live';
export type DownloadKind = 'file' | 'board' | 'presentation';
type Policy = { kind: DownloadKind; targetId: string; enabled: boolean; revision: number };
type State = { canManage: boolean; defaultEnabled: boolean; items: Policy[] };
export function useClassroomDownloads(roomId?: string) {
  const [data, setData] = useState<State>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    controller = useRef(new AbortController()),
    job = useRef<Promise<void> | undefined>(undefined),
    again = useRef(false),
    operation = useRef(false),
    loadRef = useRef<() => Promise<void>>(async () => {});
  async function load() {
    if (!roomId) return;
    if (job.current) {
      again.current = true;
      return job.current;
    }
    again.current = false;
    const signal = controller.current.signal;
    const pending = (async () => {
      try {
        const next = await request<State>('/classrooms/' + roomId + '/downloads', undefined, {
          signal,
          silent: true,
        });
        if (!signal.aborted) {
          setData((previous) => {
            const items = next.items.map((item) => {
              const old = previous?.items.find(
                (p) => p.kind === item.kind && p.targetId === item.targetId,
              );
              return old && old.revision > item.revision ? old : item;
            });
            for (const old of previous?.items ?? [])
              if (!items.some((item) => item.kind === old.kind && item.targetId === old.targetId))
                items.push(old);
            return { ...next, items };
          });
          setError('');
        }
      } catch (e) {
        if (!signal.aborted) setError((e as Error).message);
      } finally {
        if (!signal.aborted) {
          job.current = undefined;
          if (again.current) queueMicrotask(() => void loadRef.current());
        }
      }
    })();
    job.current = pending;
    await pending;
  }
  loadRef.current = load;
  useClassroomConnection(roomId ?? '', () => void loadRef.current(), [
    'downloads_changed',
    'locks_changed',
  ]);
  useEffect(() => {
    controller.current = new AbortController();
    job.current = undefined;
    operation.current = false;
    setBusy(false);
    again.current = false;
    setData(undefined);
    void loadRef.current();
    return () => controller.current.abort();
  }, [roomId]);
  const policy = (kind: DownloadKind, id: string) =>
    data?.items.find((p) => p.kind === kind && p.targetId === id) ?? {
      kind,
      targetId: id,
      enabled: data?.defaultEnabled ?? false,
      revision: 0,
    };
  return {
    error,
    busy,
    ready: !roomId || !!data,
    canManage: !!data?.canManage,
    policy,
    canDownload: (kind: DownloadKind, id: string) =>
      !roomId || (!!data && (data.canManage || policy(kind, id).enabled)),
    toggle: async (kind: DownloadKind, id: string) => {
      if (!roomId || !data?.canManage || operation.current) return;
      operation.current = true;
      setBusy(true);
      const current = policy(kind, id);
      const signal = controller.current.signal;
      try {
        const saved = await request<Policy>(
          '/classrooms/' + roomId + '/downloads',
          { kind, targetId: id, enabled: !current.enabled, expectedRevision: current.revision },
          { signal, silent: true },
        );
        if (signal.aborted) return;
        setData((previous) =>
          previous
            ? {
                ...previous,
                items: [
                  ...previous.items.filter((p) => p.kind !== kind || p.targetId !== saved.targetId),
                  saved,
                ],
              }
            : previous,
        );
        await load();
      } catch (e) {
        if (signal.aborted) return;
        await load();
        if (!controller.current.signal.aborted) setError((e as Error).message);
      } finally {
        operation.current = false;
        if (!signal.aborted) setBusy(false);
      }
    },
  };
}
export function DownloadToggle({
  state,
  kind,
  targetId,
  name,
}: {
  state: ReturnType<typeof useClassroomDownloads>;
  kind: DownloadKind;
  targetId: string;
  name: string;
}) {
  const { t } = useTranslation();
  if (!state.canManage) return null;
  const enabled = state.policy(kind, targetId).enabled;
  return (
    <button
      type="button"
      className="quiet download-access-toggle"
      role="switch"
      aria-checked={enabled}
      aria-label={t('downloadAllowParticipants') + ' — ' + name}
      title={t(enabled ? 'downloadDisable' : 'downloadEnable')}
      disabled={state.busy}
      onClick={() => void state.toggle(kind, targetId)}
    >
      <span className="download-switch-indicator" aria-hidden="true">
        {enabled ? '✓' : '×'}
      </span>
      <span>{t('downloadSharing')}</span>
    </button>
  );
}
export async function authorizeBoardDownload(
  roomId: string,
  targetId: string,
  format: 'pdf' | 'png' | 'svg',
  signal?: AbortSignal,
) {
  await request(
    '/classrooms/' + roomId + '/downloads/authorize',
    { targetId, format },
    { signal, silent: true },
  );
}
