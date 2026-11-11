import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';

type Profile = {
  id: string;
  name: string;
  email: string;
  locale: 'fa' | 'en';
  timezone: string;
  created_at: string;
};
type Session = {
  id: string;
  current: boolean;
  user_agent: string;
  created_at: string;
  expires_at: string;
};
type SecurityEvent = { id: string; action: string; created_at: string };
export default function Account({ onUpdate }: { onUpdate: (profile: Profile) => void }) {
  const { t, i18n } = useTranslation();
  const [profile, setProfile] = useState<Profile>(),
    [sessions, setSessions] = useState<Session[]>([]),
    [events, setEvents] = useState<SecurityEvent[]>([]),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [version, setVersion] = useState(0);
  useEffect(() => {
    let active = true;
    void Promise.all([
      request<Profile>('/account'),
      request<Session[]>('/account/sessions'),
      request<SecurityEvent[]>('/account/security'),
    ])
      .then(([p, s, e]) => {
        if (active) {
          setProfile(p);
          setSessions(s);
          setEvents(e);
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [version]);
  const action = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const date = (value: string) =>
    new Intl.DateTimeFormat(i18n.language, {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: profile?.timezone,
    }).format(new Date(value));
  return (
    <section className="account-panel" aria-busy={busy}>
      <div className="page-heading">
        <div>
          <span className="eyebrow">TOASTER / {t('account')}</span>
          <h1>{t('accountPanel')}</h1>
          <p>{t('accountPanelIntro')}</p>
        </div>
      </div>
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
      {!profile ? (
        <p role="status">{t('loading')}</p>
      ) : (
        <>
          <div className="account-columns">
            <section className="account-section">
              <h2>{t('accountProfile')}</h2>
              <form
                key={profile.name + profile.locale + profile.timezone}
                onSubmit={(e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  void action(async () => {
                    const next = await request<Profile>('/account/profile', {
                      name: f.get('name'),
                      locale: f.get('locale'),
                      timezone: f.get('timezone'),
                    });
                    onUpdate(next);
                    localStorage.setItem('language', next.locale);
                    await i18n.changeLanguage(next.locale);
                    setNotice(t('accountSaved'));
                  });
                }}
              >
                <label>
                  {t('name')}
                  <input
                    name="name"
                    defaultValue={profile.name}
                    required
                    minLength={2}
                    maxLength={120}
                    autoComplete="name"
                  />
                </label>
                <label>
                  {t('email')}
                  <input value={profile.email} readOnly dir="ltr" type="email" />
                </label>
                <label htmlFor="account-locale">{t('accountLanguage')}</label>
                <select id="account-locale" name="locale" defaultValue={profile.locale}>
                  <option value="fa">فارسی</option>
                  <option value="en">English</option>
                </select>
                <label>
                  {t('accountTimezone')}
                  <input
                    name="timezone"
                    defaultValue={profile.timezone}
                    required
                    maxLength={100}
                    list="account-timezones"
                    dir="ltr"
                  />
                  <datalist id="account-timezones">
                    {[
                      'Asia/Tehran',
                      'UTC',
                      'Europe/London',
                      'Europe/Berlin',
                      'America/New_York',
                      'Asia/Dubai',
                    ].map((v) => (
                      <option key={v} value={v} />
                    ))}
                  </datalist>
                </label>
                <small>{t('accountTimezoneHelp')}</small>
                <button className="primary" disabled={busy}>
                  {t('accountSaveProfile')}
                </button>
              </form>
            </section>
            <section className="account-section">
              <h2>{t('accountPassword')}</h2>
              <p>{t('accountPasswordHelp')}</p>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const node = e.currentTarget,
                    f = new FormData(node);
                  if (f.get('newPassword') !== f.get('confirmation')) {
                    setError(t('authPasswordMismatch'));
                    return;
                  }
                  void action(async () => {
                    await request('/account/password', {
                      currentPassword: f.get('currentPassword'),
                      newPassword: f.get('newPassword'),
                    });
                    node.reset();
                    setNotice(t('accountPasswordSaved'));
                  });
                }}
              >
                <label>
                  {t('accountCurrentPassword')}
                  <input
                    name="currentPassword"
                    type="password"
                    required
                    maxLength={128}
                    autoComplete="current-password"
                  />
                </label>
                <label>
                  {t('accountNewPassword')}
                  <input
                    name="newPassword"
                    type="password"
                    required
                    minLength={6}
                    maxLength={128}
                    autoComplete="new-password"
                  />
                </label>
                <label>
                  {t('authConfirmPassword')}
                  <input
                    name="confirmation"
                    type="password"
                    required
                    minLength={6}
                    maxLength={128}
                    autoComplete="new-password"
                  />
                </label>
                <button disabled={busy}>{t('accountPassword')}</button>
              </form>
            </section>
          </div>
          <section className="account-section">
            <div className="page-heading">
              <div>
                <h2>{t('accountSessions')}</h2>
                <p>{t('accountSessionsHelp')}</p>
              </div>
              <button
                disabled={busy || sessions.filter((s) => !s.current).length === 0}
                onClick={() =>
                  void action(async () => {
                    await request('/account/sessions/revoke-others', {});
                    setNotice(t('accountSessionsRevoked'));
                  })
                }
              >
                {t('accountRevokeOthers')}
              </button>
            </div>
            <ul className="account-sessions">
              {sessions.map((s) => (
                <li key={s.id}>
                  <div>
                    <strong>
                      {s.current ? t('accountCurrentSession') : t('accountOtherSession')}
                    </strong>
                    <p dir="auto">{s.user_agent || t('accountUnknownDevice')}</p>
                    <small>
                      {t('accountSessionStarted')} {date(s.created_at)} ·{' '}
                      {t('accountSessionExpires')} {date(s.expires_at)}
                    </small>
                  </div>
                  {!s.current && (
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await request('/account/sessions/' + s.id + '/revoke', {});
                          setNotice(t('accountSessionsRevoked'));
                        })
                      }
                    >
                      {t('accountRevokeSession')}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <section className="account-section">
            <h2>{t('accountSecurity')}</h2>
            <ul className="account-events">
              {events.map((e) => (
                <li key={e.id}>
                  <span>{t('security_' + e.action.replaceAll('.', '_'))}</span>
                  <time dateTime={e.created_at}>{date(e.created_at)}</time>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </section>
  );
}
