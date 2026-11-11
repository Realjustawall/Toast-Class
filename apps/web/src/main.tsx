import './runtime-config';
import React, { useEffect, useState, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { useTranslation } from 'react-i18next';
const Teaching = lazy(() => import('./teaching'));
const Files = lazy(() => import('./files'));
const Admin = lazy(() => import('./admin'));
const Account = lazy(() => import('./account'));
const PlatformSettings = lazy(() => import('./platform-settings'));
import '@livekit/components-styles';
import '@fontsource/manrope/latin-400.css';
import '@fontsource/manrope/latin-600.css';
import '@fontsource/manrope/latin-700.css';
import '@fontsource/vazirmatn/arabic-400.css';
import '@fontsource/vazirmatn/arabic-600.css';
import '@fontsource/vazirmatn/arabic-700.css';
import i18n from './i18n';
import './style.css';
import './classroom-shell.css';
import './classroom-layouts.css';
import './classroom-comfort.css';
import './classroom-bbb.css';
import './classroom-density.css';
import './geogebra.css';
import './chat-images.css';
import './login-design.css';
import './classroom-rebuild.css';
import ClassroomEnrollment, { type Enrollment } from './classroom-enrollment';
import AuthForm from './auth-form';
import MemberChooser from './member-chooser';
import { PlatformOptionsProvider, usePlatformOptions } from './platform-options';
import { request as api } from './api';
import ClassroomLoading from './classroom-loading';
import ApplicationSettings, { ApplicationSettingsHost } from './application-settings';
import { setPreferenceIdentity } from './user-preferences';
import './settings-page.css';
import './board-tool-controls.css';
import './pdf-display-controls.css';
import './settings-controls.css';
import {
  DEFAULT_CLASSROOM_PERMISSIONS,
  type ClassroomPermissions,
  type ClassroomTheme,
  type ClassroomView,
} from './classroom-types';
import {
  ClassroomPermissionsEditor,
  ThemeLivePreview,
  ThemeSelectorGrid,
  themeLabel,
} from './theme-preview';
import { AppErrorBoundary, ToastViewport } from './toast';
import ConnectionStatus from './connection-status';
type User = { id: string; name: string; email: string; isPlatformAdmin?: boolean };
type Org = {
  id: string;
  name: string;
  role: 'owner' | 'teacher' | 'student';
  default_classroom_theme?: ClassroomTheme;
};
type Room = {
  id: string;
  name: string;
  theme?: ClassroomTheme;
  permissions?: ClassroomPermissions;
};
type Join = { token: string; url: string; room: Room };
type Message = { id: string; body: string; name: string; created_at: string };
function Logo() {
  const { options } = usePlatformOptions();
  return (
    <span className="brand">
      <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
        <rect x="3" y="9" width="26" height="20" rx="6" fill="currentColor" />
        <path
          d="M9 9V6a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3M11 17h10M12 22h8"
          stroke="var(--logo-line,#fff)"
          strokeWidth="2.5"
          fill="none"
          strokeLinecap="round"
        />
      </svg>{' '}
      {options.siteName}
      <span className="brand-dot">.</span>
    </span>
  );
}
function App() {
  const { options } = usePlatformOptions();
  const { t } = useTranslation();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [orgId, setOrgId] = useState('');
  const [rooms, setRooms] = useState<Room[]>([]);
  const [workspaceView, setWorkspaceView] = useState<
    'classrooms' | 'files' | 'admin' | 'account' | 'platform'
  >('classrooms');
  const [teaching, setTeaching] = useState<ClassroomView | null>(null);
  const teachingRef = React.useRef(teaching);
  teachingRef.current = teaching;
  useEffect(() => {
    void setPreferenceIdentity(user?.id);
  }, [user?.id]);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState('');
  function navigateClassroom(room: ClassroomView | null) {
    history.pushState(
      null,
      '',
      room ? '#classroom/' + room.id : location.pathname + location.search,
    );
    setTeaching(room);
    setRestoring(false);
    setRestoreError('');
  }
  useEffect(() => {
    if (!user) return;
    let generation = 0;
    const restore = async () => {
      const current = ++generation;
      const targetHash = location.hash;
      if (targetHash.startsWith('#settings')) return;
      const match = /^#classroom\/([a-f0-9-]{36})$/i.exec(targetHash);
      if (match && teachingRef.current?.id === match[1]) return;
      if (!match) {
        setTeaching(null);
        setRestoring(false);
        setRestoreError('');
        return;
      }
      setRestoring(true);
      setRestoreError('');
      try {
        const room = await api<ClassroomView>('/classrooms/' + match[1]);
        if (current === generation && location.hash === targetHash) {
          setTeaching(room);
          setRestoring(false);
        }
      } catch (e) {
        if (current === generation && location.hash === targetHash) {
          setRestoreError((e as Error).message);
          setTeaching(null);
        }
      }
    };
    void restore();
    window.addEventListener('popstate', restore);
    window.addEventListener('hashchange', restore);
    return () => {
      generation++;
      window.removeEventListener('popstate', restore);
      window.removeEventListener('hashchange', restore);
    };
  }, [user]);
  const [modal, setModal] = useState<'' | 'org' | 'room' | 'member'>('');
  const [memberReady, setMemberReady] = useState(false);
  const org = orgs.find((o) => o.id === orgId);
  const [roomTheme, setRoomTheme] = useState<ClassroomTheme>('classic-bbb');
  const [roomPerms, setRoomPerms] = useState<ClassroomPermissions>(DEFAULT_CLASSROOM_PERMISSIONS);
  const [roomDraftName, setRoomDraftName] = useState('');
  const [roomEnrollment, setRoomEnrollment] = useState<Enrollment>({
    enrollmentMode: 'assigned',
    memberIds: [],
  });
  const [enrollmentReady, setEnrollmentReady] = useState(false);
  const lastModal = React.useRef('');
  useEffect(() => {
    if (modal !== 'room' || lastModal.current === 'room') {
      lastModal.current = modal;
      return;
    }
    lastModal.current = modal;
    if (org?.default_classroom_theme) setRoomTheme(org.default_classroom_theme);
    else setRoomTheme(options.defaultTheme);
    if (modal === 'room') setRoomPerms(options.defaultPermissions);
  }, [org?.default_classroom_theme, modal, options.defaultTheme, options.defaultPermissions]);
  useEffect(() => {
    const direction = i18n.language.startsWith('fa') ? 'rtl' : 'ltr';
    const sync = () => {
      if (document.documentElement.dir !== direction) document.documentElement.dir = direction;
      document.documentElement.lang = i18n.language;
    };
    sync();
    // Embedded editors may initialize their locale asynchronously; the app owns page direction.
    const observer = new MutationObserver(sync);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['dir'] });
    return () => observer.disconnect();
  }, [i18n.language]);
  useEffect(() => {
    api<User>('/me')
      .then(setUser)
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);
  async function loadOrgs() {
    const data = await api<Org[]>('/organizations');
    setOrgs(data);
    setOrgId((old) => (data.some((o) => o.id === old) ? old : (data[0]?.id ?? '')));
  }
  useEffect(() => {
    if (user) void loadOrgs().catch((e) => setError(e.message));
  }, [user]);
  useEffect(() => {
    setRooms([]);
    if (!orgId) return;
    let active: AbortController | undefined;
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      active?.abort();
      const controller = new AbortController();
      active = controller;
      void api<Room[]>('/organizations/' + orgId + '/classrooms', undefined, {
        signal: controller.signal,
        silent: true,
      })
        .then((value) => {
          if (!controller.signal.aborted) setRooms(value);
        })
        .catch((e) => {
          if (!controller.signal.aborted) setError(e.message);
        });
    };
    refresh();
    const timer = setInterval(refresh, 15000);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    return () => {
      active?.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [orgId]);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const language = <ApplicationSettings />;
  if (loading) if (location.hash.startsWith('#classroom/')) return <ClassroomLoading />;
  if (user && restoring)
    return (
      <ClassroomLoading
        error={restoreError}
        onRetry={() => window.dispatchEvent(new Event('hashchange'))}
        onLeave={() => {
          navigateClassroom(null);
          window.dispatchEvent(new Event('hashchange'));
        }}
      />
    );
  if (loading)
    return (
      <main className="loading" role="status">
        {t('loading')}
      </main>
    );
  if (user && teaching)
    return (
      <>
        <ToastViewport />
        <AppErrorBoundary onReset={() => navigateClassroom(null)}>
          <Suspense fallback={<ClassroomLoading onLeave={() => navigateClassroom(null)} />}>
            <Teaching
              key={teaching.id}
              room={teaching}
              onNavigate={navigateClassroom}
              onLeave={() => navigateClassroom(null)}
            />
          </Suspense>
        </AppErrorBoundary>
      </>
    );
  return (
    <>
      <ToastViewport />
      {!user ? (
        <AuthForm onSignedIn={setUser} />
      ) : (
        <div className="shell">
          <aside className="sidebar">
            <Logo />
            <div className="org-picker">
              <label htmlFor="org">{t('organization')}</label>
              <select id="org" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
                {orgs.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              {(options.allowOrgCreation || user.isPlatformAdmin) && (
                <button className="quiet" onClick={() => setModal('org')}>
                  + {t('newOrg')}
                </button>
              )}
            </div>
            <nav>
              <span className="eyebrow">{t('workspace')}</span>
              <a
                className={workspaceView === 'classrooms' ? 'nav-active' : ''}
                href="#classrooms"
                onClick={() => setWorkspaceView('classrooms')}
              >
                <span aria-hidden="true">▦</span>
                {t('classrooms')}
              </a>
              <button
                className={workspaceView === 'files' ? 'nav-active' : ''}
                disabled={!org}
                onClick={() => setWorkspaceView('files')}
              >
                {t('fileLibrary')}
              </button>
              {org?.role === 'owner' && (
                <button
                  className={workspaceView === 'admin' ? 'nav-active' : ''}
                  onClick={() => setWorkspaceView('admin')}
                >
                  {t('adminTitle')}
                </button>
              )}
              <button
                className={workspaceView === 'account' ? 'nav-active' : ''}
                onClick={() => setWorkspaceView('account')}
              >
                {t('accountPanel')}
              </button>
              {user.isPlatformAdmin && (
                <button
                  className={workspaceView === 'platform' ? 'nav-active' : ''}
                  onClick={() => setWorkspaceView('platform')}
                >
                  {t('platformSettings')}
                </button>
              )}
            </nav>
            <div className="sidebar-bottom">
              <span className="avatar">{user.name.slice(0, 1)}</span>
              <div>
                <strong>{user.name}</strong>
                <small>{user.email}</small>
              </div>
            </div>
            <button
              className="quiet"
              onClick={() =>
                void act(async () => {
                  await api('/auth/logout', {});
                  setUser(null);
                  setOrgId('');
                  setOrgs([]);
                  setWorkspaceView('classrooms');
                })
              }
            >
              {t('logout')}
            </button>
          </aside>
          <div className="workspace">
            <header>
              <span>
                {t('workspace')} /{' '}
                <strong>
                  {t(
                    workspaceView === 'files'
                      ? 'fileLibrary'
                      : workspaceView === 'platform'
                        ? 'platformSettings'
                        : workspaceView === 'account'
                          ? 'accountPanel'
                          : workspaceView === 'admin'
                            ? 'adminTitle'
                            : 'classrooms',
                  )}
                </strong>
              </span>
              {language}
            </header>
            <main id="classrooms">
              {workspaceView === 'platform' && user.isPlatformAdmin ? (
                <Suspense fallback={<p role="status">{t('loading')}</p>}>
                  <PlatformSettings />
                </Suspense>
              ) : workspaceView === 'account' ? (
                <Suspense fallback={<p role="status">{t('loading')}</p>}>
                  <Account onUpdate={(profile) => setUser({ ...user, ...profile })} />
                </Suspense>
              ) : workspaceView === 'admin' && org?.role === 'owner' ? (
                <Suspense fallback={<p role="status">{t('loading')}</p>}>
                  <Admin key={org.id} id={org.id} onOpen={navigateClassroom} />
                </Suspense>
              ) : workspaceView === 'files' && org ? (
                <Suspense fallback={<p role="status">{t('loading')}</p>}>
                  <Files key={org.id} resource="organizations" id={org.id} />
                </Suspense>
              ) : (
                <>
                  <div className="page-heading">
                    <div>
                      <span className="eyebrow">
                        {new Intl.DateTimeFormat(i18n.language, { dateStyle: 'long' }).format(
                          new Date(),
                        )}
                      </span>
                      <h1>{t('welcome')}</h1>
                      <p>{t('subtitle')}</p>
                    </div>
                    {org?.role === 'owner' && (
                      <button className="primary" onClick={() => setModal('room')}>
                        + {t('newRoom')}
                      </button>
                    )}
                  </div>
                  {error && (
                    <p className="error" role="alert">
                      {error}
                    </p>
                  )}
                  <div className="overview">
                    <div>
                      <span>{t('roomCount')}</span>
                      <strong>{new Intl.NumberFormat(i18n.language).format(rooms.length)}</strong>
                    </div>
                    <div>
                      <span>{t('members')}</span>
                      <strong>{org ? t(org.role) : '—'}</strong>
                    </div>
                    <div>
                      <span>{t('organization')}</span>
                      <strong>{org?.name ?? '—'}</strong>
                    </div>
                  </div>
                  <div className="section-heading">
                    <h2>{t('classrooms')}</h2>
                    {org?.role === 'owner' && (
                      <button onClick={() => setModal('member')}>{t('invite')}</button>
                    )}
                  </div>
                  {rooms.length ? (
                    <div className="room-grid">
                      {rooms.map((r, index) => (
                        <article className="room-card" key={r.id}>
                          <div className="room-cover">
                            <span className="room-number">
                              {String(index + 1).padStart(2, '0')}
                            </span>
                            <svg width="70" height="70" viewBox="0 0 70 70" aria-hidden="true">
                              <path
                                d="M12 45V20h46v25M8 50h54M35 45v14"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="3"
                              />
                              <path
                                d="m25 35 7-7 7 5 8-9"
                                stroke="currentColor"
                                fill="none"
                                strokeWidth="3"
                              />
                            </svg>
                          </div>
                          <div className="room-body">
                            <div className="room-meta-row">
                              <small>{org?.name}</small>
                              <span className="theme-chip">
                                {themeLabel(r.theme ?? 'classic-bbb', t)}
                              </span>
                              {r.permissions?.locked && (
                                <span className="theme-chip is-danger">{t('permLockedBadge')}</span>
                              )}
                            </div>
                            <h3>{r.name}</h3>
                            <button onClick={() => navigateClassroom(r)}>
                              {t('join')} <span aria-hidden="true">↗</span>
                            </button>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <section className="empty">
                      <div className="empty-icon" aria-hidden="true">
                        ▦
                      </div>
                      <h2>{t('empty')}</h2>
                      <p>{t(org ? 'emptyBody' : 'noOrg')}</p>
                      {((!org && (options.allowOrgCreation || user.isPlatformAdmin)) ||
                        org?.role === 'owner') && (
                        <button className="primary" onClick={() => setModal(org ? 'room' : 'org')}>
                          {t(org ? 'newRoom' : 'newOrg')}
                        </button>
                      )}
                    </section>
                  )}
                </>
              )}
              <footer>
                <ConnectionStatus /> <span>TOASTER · 0.1</span>
              </footer>
            </main>
          </div>
        </div>
      )}
      {modal && (
        <dialog
          className={modal === 'room' ? 'room-create-dialog' : undefined}
          ref={(node) => {
            if (node && !node.open) node.showModal();
          }}
          onCancel={() => setModal('')}
          aria-labelledby="dialog-title"
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              void act(async () => {
                if (modal === 'org') {
                  await api('/organizations', { name: f.get('name') });
                  await loadOrgs();
                } else if (modal === 'room') {
                  await api('/organizations/' + orgId + '/classrooms', {
                    name: f.get('name'),
                    theme: roomTheme,
                    permissions: roomPerms,
                    ...roomEnrollment,
                  });
                  setRooms(await api<Room[]>('/organizations/' + orgId + '/classrooms'));
                  setRoomDraftName('');
                  setRoomPerms(DEFAULT_CLASSROOM_PERMISSIONS);
                  setRoomEnrollment({ enrollmentMode: 'assigned', memberIds: [] });
                } else
                  await api('/organizations/' + orgId + '/members', {
                    ...(user?.isPlatformAdmin
                      ? { userId: f.get('userId') }
                      : { email: f.get('email') }),
                    role: f.get('role'),
                  });
                setModal('');
              });
            }}
          >
            <h2 id="dialog-title">
              {t(modal === 'org' ? 'newOrg' : modal === 'room' ? 'newRoom' : 'invite')}
            </h2>
            {modal === 'member' ? (
              <>
                {user?.isPlatformAdmin ? (
                  <MemberChooser organizationId={orgId} onReady={setMemberReady} />
                ) : (
                  <label>
                    {t('email')}
                    <input name="email" type="email" required autoFocus />
                  </label>
                )}
                <label>
                  {t('members')}
                  <select name="role">
                    <option value="student">{t('student')}</option>
                    <option value="teacher">{t('teacher')}</option>
                  </select>
                </label>
              </>
            ) : modal === 'room' ? (
              <div className="room-create-wizard">
                <label>
                  {t('name')}
                  <input
                    name="name"
                    minLength={2}
                    maxLength={120}
                    required
                    autoFocus
                    value={roomDraftName}
                    onChange={(e) => setRoomDraftName(e.target.value)}
                  />
                </label>
                <div className="wizard-section">
                  <h3>{t('classroomThemeSelect')}</h3>
                  <ThemeSelectorGrid value={roomTheme} onChange={setRoomTheme} />
                  <ThemeLivePreview
                    theme={roomTheme}
                    permissions={roomPerms}
                    roomName={roomDraftName}
                    onSelectTheme={setRoomTheme}
                  />
                </div>
                <details className="wizard-security-details">
                  <summary>{t('classroomSecurityPermissions')}</summary>
                  <ClassroomPermissionsEditor permissions={roomPerms} onChange={setRoomPerms} />
                </details>
                <ClassroomEnrollment
                  orgId={orgId}
                  value={roomEnrollment}
                  onChange={setRoomEnrollment}
                  onReady={setEnrollmentReady}
                />
              </div>
            ) : (
              <label>
                {t('name')}
                <input name="name" minLength={2} maxLength={120} required autoFocus />
              </label>
            )}
            {error && (
              <p role="alert" className="error">
                {error}
              </p>
            )}
            <div className="actions">
              <button type="button" onClick={() => setModal('')}>
                {t('cancel')}
              </button>
              <button
                disabled={
                  busy ||
                  (modal === 'room' && !enrollmentReady) ||
                  (modal === 'member' && user?.isPlatformAdmin && !memberReady)
                }
                className="primary"
              >
                {t(busy ? 'loading' : 'create')}
              </button>
            </div>
          </form>
        </dialog>
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <PlatformOptionsProvider>
        <ApplicationSettingsHost />
        <App />
      </PlatformOptionsProvider>
    </AppErrorBoundary>
  </React.StrictMode>,
);
