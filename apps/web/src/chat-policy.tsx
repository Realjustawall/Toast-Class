import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import { useClassroomConnection } from './live';
export type ChatPolicy = {
  publicEnabled: boolean;
  privateEnabled: boolean;
  revision: number;
  canManage: boolean;
  canSendPrivate: boolean;
  participants: { id: string; name: string; role: string }[];
  unread: { userId: string; count: number }[];
};
export function useChatPolicy(roomId: string) {
  const [data, setData] = useState<ChatPolicy>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    controller = useRef(new AbortController()),
    job = useRef<Promise<void> | undefined>(undefined),
    again = useRef(false),
    ref = useRef<() => Promise<void>>(async () => {}),
    activeOperation = useRef(false);
  async function load() {
    if (job.current) {
      again.current = true;
      return job.current;
    }
    again.current = false;
    const signal = controller.current.signal;
    const pending = (async () => {
      try {
        const next = await request<ChatPolicy>(
          '/classrooms/' + roomId + '/chat-policy',
          undefined,
          { signal, silent: true },
        );
        if (!signal.aborted) {
          setData(next);
          setError('');
        }
      } catch (e) {
        if (!signal.aborted) setError((e as Error).message);
      } finally {
        if (!signal.aborted) {
          job.current = undefined;
          if (again.current) queueMicrotask(() => void ref.current());
        }
      }
    })();
    job.current = pending;
    await pending;
  }
  ref.current = load;
  useClassroomConnection(roomId, () => void ref.current(), [
    'chat_policy_changed',
    'private_chat_changed',
  ]);
  useEffect(() => {
    controller.current = new AbortController();
    job.current = undefined;
    setData(undefined);
    void ref.current();
    return () => controller.current.abort();
  }, [roomId]);
  return {
    data,
    error,
    busy,
    toggle: async (mode: 'public' | 'private') => {
      if (!data?.canManage || activeOperation.current) return;
      activeOperation.current = true;
      setBusy(true);
      const signal = controller.current.signal;
      try {
        await request(
          '/classrooms/' + roomId + '/chat-policy',
          {
            publicEnabled: mode === 'public' ? !data.publicEnabled : data.publicEnabled,
            privateEnabled: mode === 'private' ? !data.privateEnabled : data.privateEnabled,
            expectedRevision: data.revision,
          },
          { signal, silent: true },
        );
        if (!signal.aborted) {
          await job.current;
          await load();
        }
      } catch (e) {
        if (!signal.aborted) {
          await load();
          setError((e as Error).message);
        }
      } finally {
        activeOperation.current = false;
        if (!signal.aborted) setBusy(false);
      }
    },
  };
}
export function ChatPolicyControls({ policy }: { policy: ReturnType<typeof useChatPolicy> }) {
  const { t } = useTranslation();
  if (!policy.data?.canManage) return null;
  return (
    <details className="chat-policy-controls">
      <summary aria-label={t('chatPermissions')} title={t('chatPermissions')}>
        ⚙
      </summary>
      <div>
        {(['public', 'private'] as const).map((mode) => (
          <label key={mode}>
            <span>{t(mode === 'public' ? 'chatPublicMode' : 'chatPrivateMode')}</span>
            <input
              type="checkbox"
              role="switch"
              aria-label={t(mode === 'public' ? 'chatEnablePublic' : 'chatEnablePrivate')}
              checked={mode === 'public' ? policy.data!.publicEnabled : policy.data!.privateEnabled}
              disabled={policy.busy}
              onChange={() => void policy.toggle(mode)}
            />
          </label>
        ))}
      </div>
    </details>
  );
}
