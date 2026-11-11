import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import ClassIcon from './classroom-icons';
export const LOCK_FIELDS = [
  'microphone',
  'camera',
  'screenShare',
  'chat',
  'chatImages',
  'whiteboard',
  'sharedNotes',
  'raiseHand',
] as const;
export type LockPolicy = Record<(typeof LOCK_FIELDS)[number], boolean>;
export type LockSettings = { locks: LockPolicy; revision: number };
const empty = () => Object.fromEntries(LOCK_FIELDS.map((key) => [key, false])) as LockPolicy;
const permissions = {
  microphone: 'canMicrophone',
  camera: 'canCamera',
  screenShare: 'canScreenShare',
  chat: 'canChat',
  chatImages: 'canChatImages',
  whiteboard: 'canWhiteboard',
  sharedNotes: 'canSharedNotes',
  raiseHand: 'canRaiseHand',
} as const;
export default function ClassroomLockDialog({
  roomId,
  target,
  onClose,
  onSaved,
}: {
  roomId: string;
  target?: { id: string; name: string };
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation(),
    dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<LockPolicy>(empty),
    [revision, setRevision] = useState(0),
    [exempt, setExempt] = useState(false),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const [inherited, setInherited] = useState<LockPolicy>(empty);
  const load = async () => {
    setLoaded(false);
    setError('');
    try {
      if (target) {
        const classLocks = await request<LockSettings>('/classrooms/' + roomId + '/locks');
        setInherited(classLocks.locks);
        const data = await request<{
          members: {
            userId: string;
            revision: number;
            interactionLocked: boolean;
            lockExempt: boolean;
            effective: { overrides: Record<string, boolean | null> } & Record<string, unknown>;
          }[];
        }>('/classrooms/' + roomId + '/user-permissions');
        const user = data.members.find((user) => user.userId === target.id);
        if (!user) throw Error(t('errNotFound'));
        setDraft(
          Object.fromEntries(
            LOCK_FIELDS.map((key) => [key, !user.effective[permissions[key]]]),
          ) as LockPolicy,
        );
        setExempt(user.lockExempt);
        setRevision(user.revision);
      } else {
        const result = await request<LockSettings>('/classrooms/' + roomId + '/locks');
        setDraft(result.locks);
        setRevision(result.revision);
      }
      setLoaded(true);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    void load();
  }, [roomId, target?.id]);
  return (
    <dialog
      ref={dialog}
      className="classroom-lock-dialog classroom-dialog"
      aria-labelledby="class-lock-title"
      onCancel={(e) => {
        if (busy) e.preventDefault();
      }}
      onClose={onClose}
    >
      <header>
        <h2 id="class-lock-title">
          {t(target ? 'lockParticipantTitle' : 'lockClassTitle', { name: target?.name })}
        </h2>
        <button disabled={busy} aria-label={t('classClosePanel')} onClick={onClose}>
          <ClassIcon name="close" />
        </button>
      </header>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!loaded || busy) return;
          setBusy(true);
          setError('');
          try {
            const body = target
              ? {
                  expectedRevision: revision,
                  interactionLocked: LOCK_FIELDS.every((key) => draft[key]),
                  lockExempt: exempt,
                  ...Object.fromEntries(LOCK_FIELDS.map((key) => [permissions[key], !draft[key]])),
                }
              : { locks: draft, expectedRevision: revision };
            await request(
              '/classrooms/' + roomId + (target ? '/user-permissions/' + target.id : '/locks'),
              body,
            );
            await onSaved();
            onClose();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <p>{t(target ? 'lockParticipantHelp' : 'lockClassHelp')}</p>
        {error && (
          <p role="alert" className="error">
            {error}
            <button type="button" disabled={busy} onClick={() => void load()}>
              {t('retry')}
            </button>
          </p>
        )}
        {!loaded ? (
          <p role="status">{t('loading')}</p>
        ) : (
          <>
            <div className="lock-selection-actions">
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  setDraft(Object.fromEntries(LOCK_FIELDS.map((key) => [key, true])) as LockPolicy)
                }
              >
                {t('lockSelectAll')}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setDraft(empty());
                  if (target && Object.values(inherited).some(Boolean)) setExempt(true);
                }}
              >
                {t('lockClearAll')}
              </button>
            </div>
            <div className="lock-options">
              {LOCK_FIELDS.map((key) => (
                <label key={key}>
                  <span>
                    <strong>{t('lockFeature_' + key)}</strong>
                    <small>{t('lockDescription_' + key)}</small>
                  </span>
                  <input
                    type="checkbox"
                    role="switch"
                    checked={draft[key]}
                    disabled={busy}
                    onChange={(e) => {
                      setDraft({ ...draft, [key]: e.target.checked });
                      if (target && !e.target.checked && inherited[key]) setExempt(true);
                    }}
                    aria-label={t('lockFeature_' + key)}
                  />
                </label>
              ))}
            </div>
            {target && (
              <label className="lock-exemption">
                <input
                  type="checkbox"
                  checked={exempt}
                  disabled={busy}
                  onChange={(e) => setExempt(e.target.checked)}
                />
                {t('lockExemption')}
              </label>
            )}
            {target && (
              <button
                type="button"
                disabled={busy}
                className="lock-reset-defaults"
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    await request('/classrooms/' + roomId + '/user-permissions/' + target.id, {
                      expectedRevision: revision,
                      interactionLocked: false,
                      lockExempt: false,
                      ...Object.fromEntries(LOCK_FIELDS.map((key) => [permissions[key], null])),
                    });
                    await onSaved();
                    await load();
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t('lockRestoreDefaults')}
              </button>
            )}
          </>
        )}
        <footer>
          <button type="button" disabled={busy} onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="primary" disabled={!loaded || busy}>
            {t(busy ? 'saving' : 'lockApply')}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
