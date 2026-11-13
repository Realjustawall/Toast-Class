import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import ClassroomEnrollment, { type Enrollment } from './classroom-enrollment';
import {
  DEFAULT_CLASSROOM_PERMISSIONS,
  type ClassroomPermissions,
  type ClassroomTheme,
  type ClassroomView,
} from './classroom-types';
import {
  ClassroomPermissionsEditor,
  IndividualUserPermissionsManager,
  ThemeLivePreview,
  ThemeSelectorGrid,
  themeLabel,
} from './theme-preview';

type AdminClassroom = {
  id: string;
  name: string;
  theme: ClassroomTheme;
  permissions: ClassroomPermissions;
  guestEntryEnabled?: boolean;
  guestMaxCapacity?: number;
  guestCount?: number;
  created_at: string;
};
type Overview = {
  organization: {
    name: string;
    storage_quota_bytes: string;
    default_classroom_theme?: ClassroomTheme;
  };
  asOf: string;
  members: { role: string; count: string }[];
  classroomCount: number;
  activeSessionCount: number;
  files: { status: string; count: string; bytes: string }[];
  presentations: { status: string; count: string; reserved_bytes: string }[];
  activeSessions: { id: string; classroom_id: string; name: string; started_at: string }[];
  classrooms?: AdminClassroom[];
};
type Member = { id: string; name: string; email: string; role: string };
type Audit = {
  id: string;
  action: string;
  resource_id: string | null;
  actor_kind: string;
  actor_name: string | null;
  created_at: string;
};
type Page<T> = { items: T[]; hasMore: boolean };

export default function Admin({
  id,
  onOpen,
}: {
  id: string;
  onOpen: (room: ClassroomView) => void;
}) {
  const { t, i18n } = useTranslation();
  const [tab, setTab] = useState<'overview' | 'themes' | 'members' | 'audit'>('overview');
  const [overview, setOverview] = useState<Overview>();
  const [members, setMembers] = useState<Page<Member>>();
  const [audit, setAudit] = useState<Page<Audit>>();
  const [offset, setOffset] = useState(0);
  const [action, setAction] = useState('');
  const [filter, setFilter] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const [defaultTheme, setDefaultTheme] = useState<ClassroomTheme>('classic-bbb');
  const [applyToExisting, setApplyToExisting] = useState(true);
  const [editingRoom, setEditingRoom] = useState<AdminClassroom | null>(null);
  const [creatingRoom, setCreatingRoom] = useState(false);
  const [newRoomName, setNewRoomName] = useState('');
  const [newRoomTheme, setNewRoomTheme] = useState<ClassroomTheme>('classic-bbb');
  const [newRoomPerms, setNewRoomPerms] = useState<ClassroomPermissions>(
    DEFAULT_CLASSROOM_PERMISSIONS,
  );
  const [newRoomGuestEnabled, setNewRoomGuestEnabled] = useState(false);
  const [newRoomGuestCapacity, setNewRoomGuestCapacity] = useState(20);
  const [enrollment, setEnrollment] = useState<Enrollment>({
    enrollmentMode: 'assigned',
    memberIds: [],
  });
  const [enrollmentReady, setEnrollmentReady] = useState(false);

  const base = '/organizations/' + id + '/admin';

  useEffect(() => {
    let active = true;
    setBusy(true);
    setError('');
    setMembers(undefined);
    setAudit(undefined);
    const task =
      tab === 'overview' || tab === 'themes'
        ? request<Overview>(base + '/overview').then((v) => {
            if (active) {
              setOverview(v);
              const orgTheme = v.organization?.default_classroom_theme ?? 'classic-bbb';
              setDefaultTheme(orgTheme);
              setNewRoomTheme(orgTheme);
            }
          })
        : tab === 'members'
          ? request<Page<Member>>(base + '/members?offset=' + offset).then((v) => {
              if (active) setMembers(v);
            })
          : request<Page<Audit>>(
              base + '/audit?offset=' + offset + '&action=' + encodeURIComponent(filter),
            ).then((v) => {
              if (active) setAudit(v);
            });
    void task
      .catch((e) => {
        if (active) setError(e.message);
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [id, tab, offset, filter, refresh, base]);

  const number = (value: number) =>
    new Intl.NumberFormat(i18n.language, { maximumFractionDigits: 1 }).format(value);
  const date = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }).format(
      new Date(value),
    );
  const byteSize = (value: number) => number(value / 1024 / 1024) + ' MiB';
  const used =
    overview?.files.reduce(
      (sum, f) =>
        sum +
        (['uploading', 'quarantined', 'ready', 'deleting'].includes(f.status)
          ? Number(f.bytes)
          : 0),
      0,
    ) ?? 0;
  const reserved =
    overview?.presentations.reduce((sum, p) => sum + Number(p.reserved_bytes), 0) ?? 0;

  async function saveOrganizationTheme() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(base + '/theme', {
        defaultClassroomTheme: defaultTheme,
        applyToExisting,
      });
      setNotice(t('adminThemeSaved'));
      setRefresh((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function saveClassroomSettings() {
    if (!editingRoom || !enrollmentReady) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(base + '/classrooms/' + editingRoom.id + '/settings', {
        name: editingRoom.name,
        theme: editingRoom.theme,
        permissions: editingRoom.permissions,
        guestEntryEnabled: editingRoom.guestEntryEnabled ?? false,
        guestMaxCapacity: editingRoom.guestMaxCapacity ?? 20,
        ...enrollment,
      });
      setEditingRoom(null);
      setNotice(t('adminClassroomSettingsSaved'));
      setRefresh((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function clearRoomGuests(roomId: string) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request('/classrooms/' + roomId + '/guests/clear', {});
      setEditingRoom((prev) => (prev && prev.id === roomId ? { ...prev, guestCount: 0 } : prev));
      setNotice(t('guestsClearedNotice'));
      setRefresh((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function createClassroomWithTheme(e: React.FormEvent) {
    e.preventDefault();
    if (!enrollmentReady) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request('/organizations/' + id + '/classrooms', {
        name: newRoomName,
        theme: newRoomTheme,
        permissions: newRoomPerms,
        guestEntryEnabled: newRoomGuestEnabled,
        guestMaxCapacity: newRoomGuestCapacity,
        ...enrollment,
      });
      setNewRoomName('');
      setNewRoomGuestEnabled(false);
      setNewRoomGuestCapacity(20);
      setCreatingRoom(false);
      setNotice(t('adminClassroomCreated'));
      setRefresh((v) => v + 1);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function changeMemberRole(userId: string, role: 'teacher' | 'student') {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await request(base + '/members/' + userId + '/role', { role });
      setNotice(t('adminMemberRoleUpdated'));
      setRefresh((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="admin-panel" aria-busy={busy}>
      <div className="page-heading">
        <div>
          <span className="eyebrow">TOASTER / {overview?.organization.name}</span>
          <h1>{t('adminTitle')}</h1>
          <p>{t('adminIntro')}</p>
        </div>
        <button className="quiet" disabled={busy} onClick={() => setRefresh((v) => v + 1)}>
          {t('adminRefresh')}
        </button>
      </div>
      <nav className="admin-tabs" aria-label={t('adminTitle')}>
        {(['overview', 'themes', 'members', 'audit'] as const).map((v) => (
          <button
            key={v}
            aria-current={tab === v ? 'page' : undefined}
            onClick={() => {
              setTab(v);
              setOffset(0);
              setNotice('');
            }}
          >
            {t('adminTab_' + v)}
          </button>
        ))}
      </nav>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {busy && <p role="status">{t('loading')}</p>}
      {tab === 'overview' && overview && (
        <>
          <p className="admin-asof">
            {t('adminAsOf')} <time dateTime={overview.asOf}>{date(overview.asOf)}</time>
          </p>
          <dl className="admin-stats">
            <div>
              <dt>{t('adminMembers')}</dt>
              <dd>{number(overview.members.reduce((sum, v) => sum + Number(v.count), 0))}</dd>
            </div>
            <div>
              <dt>{t('classrooms')}</dt>
              <dd>{number(overview.classroomCount)}</dd>
            </div>
            <div>
              <dt>{t('adminActive')}</dt>
              <dd>{number(overview.activeSessionCount)}</dd>
            </div>
            <div>
              <dt>{t('adminStorage')}</dt>
              <dd>{byteSize(used + reserved)}</dd>
              <small>
                {t('adminQuota')} {byteSize(Number(overview.organization.storage_quota_bytes))}
              </small>
            </div>
          </dl>
          <div className="admin-theme-banner">
            <div>
              <strong>{t('adminDefaultThemeLabel')}: </strong>
              <span>
                {themeLabel(overview.organization.default_classroom_theme ?? 'classic-bbb', t)}
              </span>
            </div>
            <button type="button" className="quiet" onClick={() => setTab('themes')}>
              {t('adminManageThemesBtn')}
            </button>
          </div>
          <h2>{t('adminActive')}</h2>
          <p>{t('adminSessionLimit')}</p>
          {overview.activeSessions.length ? (
            <div className="admin-table">
              <table>
                <thead>
                  <tr>
                    <th>{t('classrooms')}</th>
                    <th>{t('adminStarted')}</th>
                    <th>{t('adminOpen')}</th>
                  </tr>
                </thead>
                <tbody>
                  {overview.activeSessions.map((s) => (
                    <tr key={s.id}>
                      <td>{s.name}</td>
                      <td>{date(s.started_at)}</td>
                      <td>
                        <button
                          className="quiet"
                          onClick={() => {
                            void request<ClassroomView>('/classrooms/' + s.classroom_id)
                              .then(onOpen)
                              .catch((e) => setError(e.message));
                          }}
                        >
                          {t('adminOpen')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="notice">{t('adminNoSessions')}</p>
          )}
          <div className="admin-queues">
            {(['files', 'presentations'] as const).map((kind) => (
              <section key={kind}>
                <h2>{t(kind === 'files' ? 'fileLibrary' : 'presentationLibrary')}</h2>
                {overview[kind].length ? (
                  <ul>
                    {overview[kind].map((row) => (
                      <li key={row.status}>
                        <span>{t('adminState_' + row.status)}</span>
                        <strong>{number(Number(row.count))}</strong>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p>{t('adminNoData')}</p>
                )}
              </section>
            ))}
          </div>
        </>
      )}
      {tab === 'themes' && overview && (
        <div className="admin-themes-studio">
          <section className="admin-studio-block">
            <div className="admin-studio-head">
              <div>
                <h2>{t('adminThemeStudioTitle')}</h2>
                <p>{t('adminThemeStudioSubtitle')}</p>
              </div>
              <div className="admin-studio-actions">
                <label className="admin-inline-check">
                  <input
                    type="checkbox"
                    checked={applyToExisting}
                    onChange={(e) => setApplyToExisting(e.target.checked)}
                  />
                  <span>{t('adminApplyThemeToAll')}</span>
                </label>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void saveOrganizationTheme()}
                >
                  {t('adminSaveDefaultTheme')}
                </button>
              </div>
            </div>
            <ThemeSelectorGrid value={defaultTheme} onChange={setDefaultTheme} />
            <ThemeLivePreview theme={defaultTheme} onSelectTheme={setDefaultTheme} />
          </section>

          <section className="admin-studio-block">
            <div className="admin-studio-head">
              <div>
                <h2>{t('adminClassroomPoliciesTitle')}</h2>
                <p>{t('adminClassroomPoliciesSubtitle')}</p>
              </div>
              <button
                type="button"
                className="primary"
                onClick={() => {
                  setCreatingRoom(!creatingRoom);
                  setEditingRoom(null);
                  setEnrollment({ enrollmentMode: 'assigned', memberIds: [] });
                  setEnrollmentReady(false);
                }}
              >
                {creatingRoom ? t('cancel') : '+ ' + t('newRoom')}
              </button>
            </div>

            {creatingRoom && (
              <form
                className="admin-editor-drawer"
                onSubmit={(e) => void createClassroomWithTheme(e)}
              >
                <h3>{t('newRoom')}</h3>
                <label>
                  {t('name')}
                  <input
                    value={newRoomName}
                    onChange={(e) => setNewRoomName(e.target.value)}
                    minLength={2}
                    maxLength={120}
                    required
                  />
                </label>
                <ThemeSelectorGrid value={newRoomTheme} onChange={setNewRoomTheme} />
                <ThemeLivePreview
                  theme={newRoomTheme}
                  permissions={newRoomPerms}
                  roomName={newRoomName}
                  onSelectTheme={setNewRoomTheme}
                />
                <h4>{t('classroomSecurityPermissions')}</h4>
                <ClassroomPermissionsEditor permissions={newRoomPerms} onChange={setNewRoomPerms} />
                <div className="platform-form-grid">
                  <label className="platform-checkbox">
                    <input
                      type="checkbox"
                      checked={newRoomGuestEnabled}
                      onChange={(e) => setNewRoomGuestEnabled(e.target.checked)}
                    />
                    {t('guestEntryEnabledLabel')}
                  </label>
                  <label>
                    {t('guestMaxCapacityLabel')}
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={newRoomGuestCapacity}
                      onChange={(e) => setNewRoomGuestCapacity(Number(e.target.value))}
                    />
                  </label>
                </div>
                <ClassroomEnrollment
                  key="create"
                  orgId={id}
                  value={enrollment}
                  onChange={setEnrollment}
                  onReady={setEnrollmentReady}
                />
                <div className="actions">
                  <button type="button" className="quiet" onClick={() => setCreatingRoom(false)}>
                    {t('cancel')}
                  </button>
                  <button type="submit" className="primary" disabled={busy || !enrollmentReady}>
                    {t('create')}
                  </button>
                </div>
              </form>
            )}

            {editingRoom && (
              <div className="admin-editor-drawer" role="region" aria-label={editingRoom.name}>
                <div className="admin-studio-head">
                  <h3>
                    {t('adminConfigureRoom')}: {editingRoom.name}
                  </h3>
                  <button type="button" className="quiet" onClick={() => setEditingRoom(null)}>
                    {t('cancel')}
                  </button>
                </div>
                <label>
                  {t('name')}
                  <input
                    value={editingRoom.name}
                    onChange={(e) => setEditingRoom({ ...editingRoom, name: e.target.value })}
                    minLength={2}
                    maxLength={120}
                  />
                </label>
                <ThemeSelectorGrid
                  value={editingRoom.theme}
                  onChange={(theme) => setEditingRoom({ ...editingRoom, theme })}
                />
                <ThemeLivePreview
                  theme={editingRoom.theme}
                  permissions={editingRoom.permissions}
                  roomName={editingRoom.name}
                  onSelectTheme={(theme) => setEditingRoom({ ...editingRoom, theme })}
                />
                <h4>{t('classroomSecurityPermissions')}</h4>
                <ClassroomPermissionsEditor
                  permissions={editingRoom.permissions}
                  onChange={(permissions) => setEditingRoom({ ...editingRoom, permissions })}
                />
                <div className="platform-form-grid">
                  <label className="platform-checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(editingRoom.guestEntryEnabled)}
                      onChange={(e) =>
                        setEditingRoom({ ...editingRoom, guestEntryEnabled: e.target.checked })
                      }
                    />
                    {t('guestEntryEnabledLabel')}
                  </label>
                  <label>
                    {t('guestMaxCapacityLabel')}
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={editingRoom.guestMaxCapacity ?? 20}
                      onChange={(e) =>
                        setEditingRoom({
                          ...editingRoom,
                          guestMaxCapacity: Number(e.target.value),
                        })
                      }
                    />
                  </label>
                  {editingRoom.guestEntryEnabled && (
                    <label className="platform-full-row">
                      {t('guestInviteLink')}
                      <div className="actions">
                        <input
                          readOnly
                          dir="ltr"
                          value={`${window.location.origin}/#guest/${editingRoom.id}`}
                          onFocus={(e) => e.currentTarget.select()}
                        />
                        <button
                          type="button"
                          className="quiet"
                          onClick={() => {
                            void navigator.clipboard?.writeText(
                              `${window.location.origin}/#guest/${editingRoom.id}`,
                            );
                            setNotice(t('guestLinkCopied'));
                          }}
                        >
                          {t('copy')}
                        </button>
                      </div>
                    </label>
                  )}
                  {(editingRoom.guestEntryEnabled || (editingRoom.guestCount ?? 0) > 0) && (
                    <div className="platform-full-row actions">
                      <span className="theme-chip">
                        {t('guestCountBadge', {
                          current: editingRoom.guestCount ?? 0,
                          max: editingRoom.guestMaxCapacity ?? 20,
                        })}
                      </span>
                      <button
                        type="button"
                        className="quiet"
                        disabled={busy || (editingRoom.guestCount ?? 0) === 0}
                        onClick={() => void clearRoomGuests(editingRoom.id)}
                      >
                        {t('clearGuestsBtn')}
                      </button>
                    </div>
                  )}
                </div>
                <IndividualUserPermissionsManager roomId={editingRoom.id} />
                <ClassroomEnrollment
                  key={editingRoom.id}
                  orgId={id}
                  roomId={editingRoom.id}
                  value={enrollment}
                  onChange={setEnrollment}
                  onReady={setEnrollmentReady}
                />
                <div className="actions">
                  <button type="button" className="quiet" onClick={() => setEditingRoom(null)}>
                    {t('cancel')}
                  </button>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || !enrollmentReady}
                    onClick={() => void saveClassroomSettings()}
                    aria-disabled={!enrollmentReady}
                  >
                    {t('adminSaveRoomSettings')}
                  </button>
                </div>
              </div>
            )}

            <div className="admin-rooms-list">
              {(overview.classrooms ?? []).map((room) => (
                <div key={room.id} className="admin-room-item">
                  <div>
                    <strong>{room.name}</strong>
                    <div className="admin-room-badges">
                      <span className="theme-chip">{themeLabel(room.theme, t)}</span>
                      {room.permissions.locked && (
                        <span className="theme-chip is-danger">{t('permLockedBadge')}</span>
                      )}
                      <span className="theme-chip">
                        {t('chat')}:{' '}
                        {room.permissions.chatEnabled ? t('permEnabled') : t('permDisabled')}
                      </span>
                      <span className="theme-chip">
                        {room.permissions.defaultMicrophone
                          ? t('permMicAllowed')
                          : t('permMicMuted')}
                      </span>
                      {room.guestEntryEnabled && (
                        <span className="theme-chip">
                          {t('guestCountBadge', {
                            current: room.guestCount ?? 0,
                            max: room.guestMaxCapacity ?? 20,
                          })}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="admin-room-actions">
                    <button
                      type="button"
                      className="quiet"
                      onClick={() => {
                        setCreatingRoom(false);
                        setEditingRoom(room);
                        setEnrollmentReady(false);
                      }}
                    >
                      {t('adminConfigureRoom')}
                    </button>
                    <button
                      type="button"
                      className="quiet"
                      onClick={() =>
                        onOpen({
                          id: room.id,
                          name: room.name,
                          theme: room.theme,
                          permissions: room.permissions,
                        })
                      }
                    >
                      {t('adminOpen')}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
      {tab === 'audit' && (
        <form
          className="admin-filter"
          onSubmit={(e) => {
            e.preventDefault();
            setOffset(0);
            setFilter(action);
          }}
        >
          <label>
            {t('adminAction')}
            <input
              value={action}
              onChange={(e) => setAction(e.target.value)}
              maxLength={120}
              pattern="[a-z0-9_.]*"
              placeholder="session.started"
              dir="ltr"
            />
          </label>
          <button>{t('adminFilter')}</button>
        </form>
      )}
      {tab === 'members' && members && (
        <div className="admin-table">
          <table>
            <thead>
              <tr>
                <th>{t('name')}</th>
                <th>{t('email')}</th>
                <th>{t('adminRole')}</th>
              </tr>
            </thead>
            <tbody>
              {members.items.map((m) => (
                <tr key={m.id}>
                  <td dir="auto">{m.name}</td>
                  <td dir="ltr">{m.email}</td>
                  <td>
                    <span>{t(m.role)}</span>
                    {m.role !== 'owner' && (
                      <button
                        type="button"
                        className="quiet"
                        style={{ marginInlineStart: 8 }}
                        disabled={busy}
                        onClick={() =>
                          void changeMemberRole(m.id, m.role === 'teacher' ? 'student' : 'teacher')
                        }
                      >
                        {m.role === 'teacher' ? t('adminSetStudentRole') : t('adminSetTeacherRole')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === 'audit' && audit && (
        <>
          <p>{t('adminAuditPrivacy')}</p>
          <div className="admin-table">
            <table>
              <thead>
                <tr>
                  <th>{t('adminWhen')}</th>
                  <th>{t('adminActor')}</th>
                  <th>{t('adminAction')}</th>
                  <th>{t('adminResource')}</th>
                </tr>
              </thead>
              <tbody>
                {audit.items.map((a) => (
                  <tr key={a.id}>
                    <td>{date(a.created_at)}</td>
                    <td dir="auto">
                      {a.actor_kind === 'system' ? t('adminSystem') : a.actor_name}
                    </td>
                    <td>
                      <code>{a.action}</code>
                    </td>
                    <td>
                      <code>{a.resource_id ?? '—'}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {audit.items.length === 0 && <p>{t('adminNoData')}</p>}
        </>
      )}
      {(tab === 'members' || tab === 'audit') && (
        <div className="admin-pagination">
          <button
            className="quiet"
            disabled={!offset || busy}
            onClick={() => setOffset((v) => Math.max(0, v - 25))}
          >
            {t('presentationPrevious')}
          </button>
          <span>{number(offset + 1)}</span>
          <button
            className="quiet"
            disabled={
              busy || offset >= 100000 || !(tab === 'members' ? members?.hasMore : audit?.hasMore)
            }
            onClick={() => setOffset((v) => v + 25)}
          >
            {t('presentationNext')}
          </button>
        </div>
      )}
    </section>
  );
}
