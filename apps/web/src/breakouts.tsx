import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import { useClassroomEvents } from './live';
import type { ClassroomView } from './classroom-types';
type Room = {
  id: string;
  name: string;
  assignedCount: number;
  liveCount: number | null;
  documents: { id: string; name: string; kind: string }[];
};
type Group = {
  id: string;
  status: string;
  endsAt: string;
  allowSelfSelect: boolean;
  rooms: Room[];
  assignments: { user_id: string; room_id: string | null; name: string }[];
  announcements: { id: string; body: string; created_at: string }[];
};
type State = {
  groups: Group[];
  destination: ClassroomView;
  students: { id: string; name: string }[];
  role: string;
  userId: string;
  serverTime: number;
};

export function BreakoutStatus({
  room,
  onNavigate,
  hidden = false,
}: {
  room: ClassroomView;
  onNavigate: (room: ClassroomView) => void;
  hidden?: boolean;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>();
  const [error, setError] = useState('');
  const [returning, setReturning] = useState(false);
  const navigate = useRef(onNavigate);
  navigate.current = onNavigate;
  const loading = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const parent = room.parent ?? room;
  async function load() {
    if (loading.current) return;
    loading.current = true;
    try {
      const next = await request<State>('/classrooms/' + parent.id + '/breakouts');
      if (!mounted.current) return;
      setState(next);
      setError('');
      if (room.parent) {
        const group = next.groups.find((g) => g.id === room.parent!.groupId);
        if (!group || group.status !== 'active')
          navigate.current({ id: parent.id, name: parent.name });
        else if (next.role === 'student' && next.destination.id !== room.id)
          navigate.current(next.destination);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      loading.current = false;
    }
  }
  useClassroomEvents(parent.id, () => void load());
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 2500);
    return () => clearInterval(timer);
  }, [room.id]);
  const group = room.parent
    ? state?.groups.find((g) => g.id === room.parent!.groupId)
    : state?.groups.find((g) => g.status === 'active');
  const assigned =
    state?.destination.id !== room.id && state?.destination.id !== parent.id
      ? state?.destination
      : undefined;
  const announcement = group?.announcements[0];
  async function returnMain() {
    if (returning) return;
    setReturning(true);
    try {
      const current = await request<State>('/classrooms/' + parent.id + '/breakouts');
      const currentGroup = room.parent
        ? current.groups.find((g) => g.id === room.parent!.groupId)
        : current.groups.find((g) => g.status === 'active');
      if (current.role === 'student' && currentGroup?.status === 'active') {
        await request('/classrooms/' + parent.id + '/breakouts/' + currentGroup.id + '/assign', {
          userId: current.userId,
          roomId: null,
        });
      }
      navigate.current({ id: parent.id, name: parent.name });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReturning(false);
    }
  }
  if (hidden || (!room.parent && !assigned && !announcement && !error)) return null;
  return (
    <section className="breakout-banner" aria-label={t('breakoutStatus')}>
      <div>
        {room.parent ? (
          <>
            <strong>
              {t('inBreakoutRoom')}: {room.name}
            </strong>
            <button disabled={returning} onClick={() => void returnMain()}>
              {t('returnMain')}
            </button>
          </>
        ) : assigned ? (
          <>
            <strong>
              {t('assignedBreakout')}: {assigned.name}
            </strong>
            <button className="primary" onClick={() => navigate.current(assigned)}>
              {t('enterAssignedRoom')}
            </button>
            <button disabled={returning} onClick={() => void returnMain()}>
              {t('stayInMain')}
            </button>
          </>
        ) : null}
        {announcement && (
          <p role="status" dir="auto">
            {announcement.body}
          </p>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </div>
    </section>
  );
}

export default function Breakouts({
  room,
  onNavigate,
}: {
  room: ClassroomView;
  onNavigate: (room: ClassroomView) => void;
}) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<State>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [count, setCount] = useState(2);
  const [mode, setMode] = useState<'manual' | 'balanced-random'>('manual');
  const [clock, setClock] = useState(Date.now());
  const [offset, setOffset] = useState(0);
  const loading = useRef(false);
  const base = '/classrooms/' + room.id;
  async function load() {
    if (loading.current) return;
    loading.current = true;
    try {
      const next = await request<State>(base + '/breakouts');
      setState(next);
      setOffset(next.serverTime - Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      loading.current = false;
    }
  }
  useClassroomEvents(room.id, () => void load());
  useEffect(() => {
    void load();
    const timer = setInterval(() => {
      setClock(Date.now());
      void load();
    }, 2500);
    return () => clearInterval(timer);
  }, [room.id]);
  async function action(path: string, body: unknown) {
    setBusy(true);
    setError('');
    try {
      await request(base + path, body);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const manager = !!state && state.role !== 'student';
  const number = (value: number) => new Intl.NumberFormat(i18n.language).format(value);
  const active = state?.groups.find((g) => g.status === 'active');
  const visit = (g: Group, r: Room) =>
    onNavigate({ id: r.id, name: r.name, parent: { id: room.id, name: room.name, groupId: g.id } });
  return (
    <div className="breakouts-panel">
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {!state ? (
        <p role="status">{t('loading')}</p>
      ) : (
        <>
          <div className="section-heading">
            <div>
              <h2>{t('breakoutRooms')}</h2>
              <p>{t('breakoutHelp')}</p>
            </div>
          </div>
          {manager && !active && (
            <form
              className="tool-card breakout-create"
              onSubmit={(e) => {
                e.preventDefault();
                const f = new FormData(e.currentTarget);
                const rooms = Array.from({ length: count }, (_, i) => ({
                  name: String(f.get('room-' + i)),
                }));
                const allocation =
                  mode === 'balanced-random'
                    ? {
                        mode,
                        userIds: state.students
                          .filter((s) => f.get('selected-' + s.id) === 'on')
                          .map((s) => s.id),
                      }
                    : {
                        mode,
                        assignments: state.students
                          .filter((s) => f.get('assignment-' + s.id) !== 'main')
                          .map((s) => ({
                            userId: s.id,
                            roomIndex: Number(f.get('assignment-' + s.id)),
                          })),
                      };
                void action('/breakouts', {
                  rooms,
                  durationSeconds: Number(f.get('duration')),
                  allowSelfSelect: f.get('selfSelect') === 'on',
                  allocation,
                });
              }}
            >
              <h3>{t('createBreakouts')}</h3>
              <div className="breakout-fields">
                <label>
                  {t('roomCountLabel')}
                  <input
                    type="number"
                    value={count}
                    min={2}
                    max={12}
                    onChange={(e) =>
                      setCount(Math.max(2, Math.min(12, Number(e.target.value) || 2)))
                    }
                  />
                </label>
                <label>
                  {t('durationSeconds')}
                  <input
                    name="duration"
                    type="number"
                    min={30}
                    max={86400}
                    defaultValue={900}
                    required
                  />
                </label>
              </div>
              <div className="breakout-fields">
                {Array.from({ length: count }, (_, i) => (
                  <label key={i}>
                    {t('roomName')} {number(i + 1)}
                    <input
                      name={'room-' + i}
                      required
                      maxLength={120}
                      defaultValue={t('group') + ' ' + number(i + 1)}
                    />
                  </label>
                ))}
              </div>
              <label className="checkbox">
                <input type="checkbox" name="selfSelect" />
                {t('allowSelfSelect')}
              </label>
              <label>
                {t('assignmentMode')}
                <select value={mode} onChange={(e) => setMode(e.target.value as typeof mode)}>
                  <option value="manual">{t('manualAssignment')}</option>
                  <option value="balanced-random">{t('balancedRandom')}</option>
                </select>
              </label>
              <div className="breakout-students">
                {state.students.map((s) =>
                  mode === 'manual' ? (
                    <label key={s.id}>
                      {s.name}
                      <select
                        aria-label={t('assignStudent') + ' ' + s.name}
                        name={'assignment-' + s.id}
                        defaultValue="main"
                      >
                        <option value="main">{t('mainClassroom')}</option>
                        {Array.from({ length: count }, (_, i) => (
                          <option value={i} key={i}>
                            {t('group')} {number(i + 1)}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <label key={s.id} className="checkbox">
                      <input type="checkbox" name={'selected-' + s.id} defaultChecked />
                      {s.name}
                    </label>
                  ),
                )}
              </div>
              {state.students.length === 0 && <p>{t('noStudentsToAssign')}</p>}
              <button className="primary" disabled={busy}>
                {t('startBreakouts')}
              </button>
            </form>
          )}
          {state.groups.length === 0 && !manager && (
            <section className="empty">
              <h3>{t('noBreakoutRooms')}</h3>
            </section>
          )}
          {state.groups.map((g) => (
            <section className="breakout-group tool-card" key={g.id}>
              <header className="section-heading">
                <h3>{t(g.status === 'active' ? 'breakoutsActive' : 'breakoutsClosed')}</h3>
                {g.status === 'active' && (
                  <output aria-label={t('breakoutRemaining')}>
                    {number(
                      Math.max(
                        0,
                        Math.ceil((new Date(g.endsAt).getTime() - clock - offset) / 1000),
                      ),
                    )}{' '}
                    {t('secondsRemaining')}
                  </output>
                )}
              </header>
              {g.status === 'active' && manager && (
                <>
                  <div className="actions">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action('/breakouts/' + g.id + '/extend', { seconds: 300 })
                      }
                    >
                      {t('extendFiveMinutes')}
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => void action('/breakouts/' + g.id + '/close', {})}
                    >
                      {t('closeBreakouts')}
                    </button>
                  </div>
                  <form
                    className="breakout-announcement"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void action('/breakouts/' + g.id + '/announce', {
                        body: new FormData(e.currentTarget).get('body'),
                      });
                    }}
                  >
                    <label>
                      {t('broadcastToRooms')}
                      <input name="body" required maxLength={2000} />
                    </label>
                    <button disabled={busy}>{t('sendAnnouncement')}</button>
                  </form>
                </>
              )}
              {g.announcements[0] && (
                <p className="notice-light" dir="auto">
                  {g.announcements[0].body}
                </p>
              )}
              <div className="breakout-room-grid">
                {g.rooms.map((r) => (
                  <article className="breakout-room" key={r.id}>
                    <h4>{r.name}</h4>
                    <p>
                      {t('assignedCount')}: {number(r.assignedCount)} ·{' '}
                      {r.liveCount === null
                        ? t('mediaCountUnavailable')
                        : t('connectedCount') + ': ' + number(r.liveCount)}
                    </p>
                    {g.status === 'active' &&
                      (manager ||
                        g.allowSelfSelect ||
                        g.assignments.some(
                          (a) => a.user_id === state.userId && a.room_id === r.id,
                        )) && (
                        <button
                          disabled={busy}
                          onClick={async () => {
                            if (!manager && g.allowSelfSelect) {
                              setBusy(true);
                              try {
                                await request(base + '/breakouts/' + g.id + '/assign', {
                                  userId: state.userId,
                                  roomId: r.id,
                                });
                                visit(g, r);
                              } catch (e) {
                                setError((e as Error).message);
                              } finally {
                                setBusy(false);
                              }
                            } else visit(g, r);
                          }}
                        >
                          {t(manager ? 'visitRoom' : 'enterBreakoutRoom')}
                        </button>
                      )}
                    {manager &&
                      r.documents.map((d) => (
                        <div className="breakout-document" key={d.id}>
                          <span>{d.name}</span>
                          <button
                            disabled={busy}
                            onClick={() =>
                              void action('/breakouts/' + g.id + '/import', { documentId: d.id })
                            }
                          >
                            {t('importToMain')}
                          </button>
                        </div>
                      ))}
                  </article>
                ))}
              </div>
              {manager && g.status === 'active' && (
                <div className="breakout-students">
                  {state.students.map((s) => (
                    <label key={s.id}>
                      {s.name}
                      <select
                        aria-label={t('moveStudent') + ' ' + s.name}
                        disabled={busy}
                        value={g.assignments.find((a) => a.user_id === s.id)?.room_id ?? 'main'}
                        onChange={(e) =>
                          void action('/breakouts/' + g.id + '/assign', {
                            userId: s.id,
                            roomId: e.target.value === 'main' ? null : e.target.value,
                          })
                        }
                      >
                        <option value="main">{t('mainClassroom')}</option>
                        {g.rooms.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              )}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
