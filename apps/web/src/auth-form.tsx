import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import ConnectionStatus from './connection-status';
import ApplicationSettings from './application-settings';
import { usePlatformOptions } from './platform-options';

export default function AuthForm({
  onSignedIn,
}: {
  onSignedIn: (user: { id: string; name: string; email: string }) => void;
}) {
  const { t, i18n } = useTranslation();
  const { options } = usePlatformOptions();
  const [register, setRegister] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [created, setCreated] = useState(false),
    [visible, setVisible] = useState(false),
    [password, setPassword] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [theme, setTheme] = useState<'dark' | 'light'>(() =>
    localStorage.getItem('login-theme') === 'light' ? 'light' : 'dark',
  );
  const form = useRef<HTMLFormElement>(null);
  const [registrationOpen, setRegistrationOpen] = useState<boolean | null>(null);
  useEffect(() => {
    let active = true;
    const load = () => {
      void request<{ open: boolean }>('/auth/registration')
        .then((v) => {
          if (active) {
            setRegistrationOpen(v.open);
            if (!v.open) setRegister(false);
          }
        })
        .catch((e) => {
          if (active) setError(e.message);
        });
    };
    load();
    const timer = setInterval(load, 30000);
    window.addEventListener('focus', load);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, []);
  const valid = () => {
    const node = form.current!,
      data = new FormData(node),
      next: Record<string, string> = {};
    const name = String(data.get('name') ?? '').trim(),
      email = String(data.get('email') ?? '').trim(),
      pwd = String(data.get('password') ?? '');
    if (register && (name.length < 2 || name.length > 120)) next.name = t('authNameHelp');
    if (!email || !(node.elements.namedItem('email') as HTMLInputElement).validity.valid)
      next.email = t('authEmailHelp');
    if (pwd.length < 6 || pwd.length > 128) next.password = t('authPasswordLength');
    if (register && data.get('passwordConfirmation') !== pwd)
      next.passwordConfirmation = t('authPasswordMismatch');
    setFields(next);
    const first = Object.keys(next)[0];
    if (first) {
      (node.elements.namedItem(first) as HTMLInputElement)?.focus();
    }
    return !first;
  };
  async function submit() {
    if (busy || !valid()) return;
    const data = new FormData(form.current!);
    setBusy(true);
    setError('');
    const credentials = {
      email: String(data.get('email')).trim(),
      password: String(data.get('password')),
      remember: data.get('remember') === 'on',
    };
    try {
      if (register) {
        await request('/auth/register', {
          ...credentials,
          name: String(data.get('name')).trim(),
          passwordConfirmation: data.get('passwordConfirmation'),
          locale: i18n.language === 'fa' ? 'fa' : 'en',
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        });
        setCreated(true);
        setRegister(false);
      }
      onSignedIn(await request('/auth/login', credentials));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const fieldError = (key: string) =>
    fields[key] ? (
      <span id={'auth-' + key + '-error'} className="field-error">
        {fields[key]}
      </span>
    ) : null;
  const changeMode = (next: boolean) => {
    if (busy || (next && registrationOpen !== true)) return;
    setRegister(next);
    setFields({});
    setError('');
    setCreated(false);
  };
  return (
    <main
      className={'login-design' + (register ? ' is-register' : '')}
      data-theme={theme}
      dir={i18n.language.startsWith('fa') ? 'rtl' : 'ltr'}
    >
      <div className={'portal-shell' + (register ? ' is-register' : '')}>
        <section
          className={'form-pane ' + (register ? 'pane-register' : 'pane-login')}
          aria-label={t(register ? 'register' : 'signIn')}
        >
          <div className="pane-topbar">
            <ConnectionStatus />
            <div className="utility-actions">
              <button
                type="button"
                className="util-btn"
                aria-label={t('authToggleTheme')}
                onClick={() => {
                  const next = theme === 'dark' ? 'light' : 'dark';
                  setTheme(next);
                  localStorage.setItem('login-theme', next);
                }}
              >
                ◐ {t('authToggleTheme')}
              </button>
              <ApplicationSettings />
            </div>
          </div>
          <div className="form-center">
            <nav className="mode-pills" aria-label={t('account')}>
              <button
                type="button"
                className={'mode-pill' + (!register ? ' active' : '')}
                aria-pressed={!register}
                onClick={() => changeMode(false)}
                disabled={busy}
              >
                {t('signIn')}
              </button>
              {registrationOpen !== false && (
                <button
                  type="button"
                  className={'mode-pill' + (register ? ' active' : '')}
                  aria-pressed={register}
                  onClick={() => changeMode(true)}
                  disabled={busy || registrationOpen === null}
                >
                  {t('register')}
                </button>
              )}
            </nav>
            <form
              ref={form}
              className="auth-form"
              noValidate
              aria-busy={busy}
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <span className="eyebrow">{t('account')}</span>
              <h2>{t(register ? 'register' : 'signIn')}</h2>
              <p className="auth-description">
                {options.welcomeText || t(register ? 'authRegisterIntro' : 'authSignInIntro')}
              </p>
              {created && (
                <p className="notice" role="status">
                  {t('authAccountCreated')}
                </p>
              )}
              {register && (
                <>
                  <label>
                    {t('name')}
                    <input
                      name="name"
                      required
                      minLength={2}
                      maxLength={120}
                      autoComplete="name"
                      aria-invalid={!!fields.name}
                      aria-describedby={fields.name ? 'auth-name-error' : undefined}
                    />
                  </label>
                  {fieldError('name')}
                </>
              )}
              <label>
                {t('email')}
                <input
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  dir="ltr"
                  aria-invalid={!!fields.email}
                  aria-describedby={fields.email ? 'auth-email-error' : undefined}
                />
              </label>
              {fieldError('email')}
              <label>
                {t('password')}
                <input
                  name="password"
                  type={visible ? 'text' : 'password'}
                  minLength={6}
                  maxLength={128}
                  autoComplete={register ? 'new-password' : 'current-password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-invalid={!!fields.password}
                  aria-describedby={fields.password ? 'auth-password-error' : undefined}
                />
              </label>
              {fieldError('password')}
              <div className="password-details">
                <button
                  type="button"
                  className="quiet"
                  aria-pressed={visible}
                  onClick={() => setVisible((v) => !v)}
                >
                  {t(visible ? 'authHidePassword' : 'authShowPassword')}
                </button>
              </div>
              {register && (
                <>
                  <label>
                    {t('authConfirmPassword')}
                    <input
                      name="passwordConfirmation"
                      required
                      type={visible ? 'text' : 'password'}
                      autoComplete="new-password"
                      maxLength={128}
                      aria-invalid={!!fields.passwordConfirmation}
                      aria-describedby={
                        fields.passwordConfirmation ? 'auth-passwordConfirmation-error' : undefined
                      }
                    />
                  </label>
                  {fieldError('passwordConfirmation')}
                </>
              )}
              <label className="checkbox">
                <input name="remember" type="checkbox" defaultChecked />
                {t('authRemember')}
              </label>
              {error && (
                <p role="alert" className="error">
                  {error}
                </p>
              )}
              {registrationOpen === false && (
                <p role="status" className="notice">
                  {t('registrationClosed')}
                </p>
              )}
              {Object.keys(fields).length > 0 && (
                <p role="alert" className="field-error">
                  {t('invalidForm')}
                </p>
              )}
              <button disabled={busy} className="primary">
                {t(busy ? 'loading' : register ? 'register' : 'signIn')}
              </button>
              {registrationOpen !== false && (
                <p className="auth-switch">
                  {t(register ? 'authHaveAccount' : 'authNeedAccount')}{' '}
                  <button
                    className="quiet"
                    type="button"
                    disabled={busy || registrationOpen === null}
                    onClick={() => {
                      changeMode(!register);
                    }}
                  >
                    {t(register ? 'signIn' : 'register')}
                  </button>
                </p>
              )}
            </form>
            {options.supportUrl && (
              <a
                className="auth-support-link"
                href={options.supportUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('platformSupport')}
              </a>
            )}
          </div>
          <div />
        </section>
        <aside className="kinetic-stage-curtain" aria-label="TOASTER">
          <iframe
            className="stage-3d-mount"
            title="TOASTER 3D"
            src={'/intro/login-scene.html#' + theme}
            sandbox="allow-scripts"
            tabIndex={-1}
            aria-hidden="true"
          />
          <div className="curtain-top-bar">
            <span className="brand-glass-pill">{options.siteName}</span>
          </div>
          {registrationOpen !== false && (
            <div className="curtain-bottom-bar">
              <button
                type="button"
                className="curtain-slide-btn"
                disabled={busy || registrationOpen === null}
                onClick={() => changeMode(!register)}
              >
                {t(register ? 'signIn' : 'register')} ⇄
              </button>
            </div>
          )}
        </aside>
      </div>
    </main>
  );
}
