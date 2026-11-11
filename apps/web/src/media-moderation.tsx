import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import { useClassroomEvents } from './live';
type Policy = {
  microphone: boolean;
  camera: boolean;
  screen_share: boolean;
  blocked: boolean;
  version: number;
};
type Participant = {
  identity: string;
  name: string;
  microphoneMuted: boolean;
  cameraMuted: boolean;
  screenSharing: boolean;
  policy: Policy;
  canModerate?: boolean;
};
type Restriction = Policy & { user_id: string; name: string };
type Command = {
  id: string;
  kind: string;
  status: string;
  attempts: number;
  last_error: string | null;
};
export default function MediaModeration({
  roomId,
  manager,
  userId,
}: {
  roomId: string;
  manager: boolean;
  userId: string;
}) {
  const { t } = useTranslation();
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [restrictions, setRestrictions] = useState<Restriction[]>([]);
  const [commands, setCommands] = useState<Command[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const base = '/classrooms/' + roomId;
  async function load() {
    try {
      const data = await request<{ participants: Participant[]; restrictions: Restriction[] }>(
        base + '/participants',
      );
      setParticipants(data.participants);
      setRestrictions(data.restrictions);
      if (manager) setCommands(await request<Command[]>(base + '/media-commands'));
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useClassroomEvents(roomId, () => void load());
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 3000);
    return () => clearInterval(timer);
  }, [roomId, manager]);
  async function change(id: string, policy: Policy) {
    setBusy(true);
    setError('');
    try {
      await request(base + '/participants/' + id + '/permissions', {
        microphone: policy.microphone,
        camera: policy.camera,
        screenShare: policy.screen_share,
        blocked: policy.blocked,
      });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const offlineRestrictions = restrictions.filter(
    (r) =>
      !participants.some((p) => p.identity === r.user_id) &&
      (!r.microphone || !r.camera || !r.screen_share || r.blocked),
  );
  const pending = commands.filter((c) => c.status === 'pending');
  const failed = commands.filter((c) => c.status === 'failed');
  return (
    <section className="tool-card moderation">
      <div className="moderation-head">
        <div>
          <h2>{t('participants')}</h2>
          <p>{t('moderationHelp')}</p>
        </div>
        {manager && (
          <div className="moderation-bulk-actions">
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await request(base + '/participants/mute-all', { microphone: false });
                  await load();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('muteAllStudents')}
            </button>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await request(base + '/participants/mute-all', { microphone: true });
                  await load();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('allowAllStudentMics')}
            </button>
          </div>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {pending.length > 0 && <p role="status">{t('applyingMediaChanges')}</p>}
      {failed.map((c) => (
        <div className="error" key={c.id}>
          <span>{t(c.kind === 'delete_room' ? 'mediaEndFailed' : 'mediaChangeFailed')}</span>
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await request(base + '/media-commands/' + c.id + '/retry', {});
                await load();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('retry')}
          </button>
        </div>
      ))}
      <div className="moderation-list">
        {participants.map((p) => (
          <article key={p.identity}>
            <div>
              <strong>{p.name}</strong>
              <small>
                {t(p.microphoneMuted ? 'microphoneOff' : 'microphoneOn')} ·{' '}
                {t(p.cameraMuted ? 'cameraOff' : 'cameraOn')}
                {p.screenSharing ? ' · ' + t('sharingScreen') : ''}
              </small>
            </div>
            {manager && p.canModerate && p.identity !== userId && (
              <div className="actions">
                <button
                  disabled={busy}
                  onClick={() =>
                    void change(p.identity, { ...p.policy, microphone: !p.policy.microphone })
                  }
                >
                  {t(p.policy.microphone ? 'revokeMicrophone' : 'allowMicrophone')}
                </button>
                <button
                  disabled={busy}
                  onClick={() => void change(p.identity, { ...p.policy, camera: !p.policy.camera })}
                >
                  {t(p.policy.camera ? 'revokeCamera' : 'allowCamera')}
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    void change(p.identity, { ...p.policy, screen_share: !p.policy.screen_share })
                  }
                >
                  {t(p.policy.screen_share ? 'revokeScreen' : 'allowScreen')}
                </button>
                <button
                  disabled={busy}
                  onClick={() => void change(p.identity, { ...p.policy, blocked: true })}
                >
                  {t('removeAndBlock')}
                </button>
              </div>
            )}
          </article>
        ))}
      </div>
      {participants.length === 0 && !error && <p>{t('noMediaParticipants')}</p>}
      {manager && offlineRestrictions.length > 0 && (
        <>
          <h3>{t('restrictedParticipants')}</h3>
          <div className="moderation-list">
            {offlineRestrictions.map((p) => (
              <article key={p.user_id}>
                <div>
                  <strong>{p.name}</strong>
                  <small>{t(p.blocked ? 'mediaBlocked' : 'mediaRestricted')}</small>
                </div>
                <button
                  disabled={busy}
                  onClick={() =>
                    void change(p.user_id, {
                      microphone: true,
                      camera: true,
                      screen_share: true,
                      blocked: false,
                      version: p.version,
                    })
                  }
                >
                  {t('restoreMediaPermission')}
                </button>
              </article>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
