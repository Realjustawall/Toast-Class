import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import {
  DEFAULT_PLATFORM_OPTIONS,
  type PlatformOptions,
} from '../../../packages/classroom-settings/schema';
import { usePlatformOptions } from './platform-options';
import { ThemeSelectorGrid, ClassroomPermissionsEditor } from './theme-preview';
import { LOCK_FIELDS } from './classroom-lock-dialog';
type Settings = { options: PlatformOptions; registrationOpen: boolean; revision: number };
export default function PlatformSettings() {
  const { t } = useTranslation(),
    { reload } = usePlatformOptions();
  const [saved, setSaved] = useState<Settings>(),
    [draft, setDraft] = useState<PlatformOptions>(DEFAULT_PLATFORM_OPTIONS),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const load = async () => {
    try {
      const value = await request<Settings>('/platform/settings');
      setSaved(value);
      setDraft(value.options);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const update = <K extends keyof PlatformOptions>(key: K, value: PlatformOptions[K]) => {
    setDraft((current) => ({ ...current, [key]: value }));
    setNotice('');
  };
  const dirty = !!saved && JSON.stringify(draft) !== JSON.stringify(saved.options);
  const toggleRegistration = async () => {
    if (!saved || busy) return;
    setBusy(true);
    setError('');
    try {
      const value = await request<{ registration_open: boolean; revision: number }>(
        '/platform/registration',
        { open: !saved.registrationOpen, expectedRevision: saved.revision },
      );
      setSaved({ ...saved, registrationOpen: value.registration_open, revision: value.revision });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="account-panel platform-settings" aria-busy={busy}>
      <div className="page-heading">
        <div>
          <span className="eyebrow">{draft.siteName}</span>
          <h1>{t('platformSettings')}</h1>
        </div>
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
          <button type="button" disabled={busy} onClick={() => void load()}>
            {t('reload')}
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {!saved ? (
        <p role="status">{t('loading')}</p>
      ) : (
        <>
          <section className="account-section">
            <h2>{t('platformRegistration')}</h2>
            <p role="status">
              {t(saved.registrationOpen ? 'registrationOpen' : 'registrationClosed')}
            </p>
            <button disabled={busy} onClick={() => void toggleRegistration()}>
              {t(saved.registrationOpen ? 'closeRegistration' : 'openRegistration')}
            </button>
          </section>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (!saved || busy) return;
              setBusy(true);
              setError('');
              setNotice('');
              try {
                const next = await request<Settings>('/platform/settings', {
                  options: draft,
                  registrationOpen: saved.registrationOpen,
                  expectedRevision: saved.revision,
                });
                setSaved(next);
                setDraft(next.options);
                await reload();
                setNotice(t('platformSettingsSaved'));
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <fieldset disabled={busy} className="platform-options-fields">
              <section className="account-section">
                <h2>{t('platformIdentity')}</h2>
                <div className="platform-form-grid">
                  <label>
                    {t('platformSiteName')}
                    <input
                      required
                      maxLength={80}
                      value={draft.siteName}
                      onChange={(e) => update('siteName', e.target.value)}
                    />
                  </label>
                  <label>
                    {t('platformDefaultLanguage')}
                    <select
                      value={draft.defaultLanguage}
                      onChange={(e) => update('defaultLanguage', e.target.value as 'fa' | 'en')}
                    >
                      <option value="fa">فارسی</option>
                      <option value="en">English</option>
                    </select>
                  </label>
                  <label className="platform-full-row">
                    {t('platformWelcomeText')}
                    <textarea
                      maxLength={300}
                      value={draft.welcomeText}
                      onChange={(e) => update('welcomeText', e.target.value)}
                      rows={2}
                    />
                  </label>
                  <label className="platform-full-row">
                    {t('platformSupportUrl')}
                    <input
                      type="url"
                      dir="ltr"
                      maxLength={500}
                      value={draft.supportUrl}
                      onChange={(e) => update('supportUrl', e.target.value)}
                    />
                  </label>
                </div>
              </section>
              <section className="account-section">
                <h2>{t('platformClassDefaults')}</h2>
                <p>{t('platformDefaultsHelp')}</p>
                <label className="platform-checkbox">
                  <input
                    type="checkbox"
                    checked={draft.allowOrgCreation}
                    onChange={(e) => update('allowOrgCreation', e.target.checked)}
                  />
                  {t('platformAllowOrgCreation')}
                </label>
                <ThemeSelectorGrid
                  value={draft.defaultTheme}
                  onChange={(value) => update('defaultTheme', value)}
                />
                <ClassroomPermissionsEditor
                  permissions={draft.defaultPermissions}
                  onChange={(value) => update('defaultPermissions', value)}
                />
                <h3>{t('platformDefaultLocks')}</h3>
                <div className="platform-switch-grid">
                  {LOCK_FIELDS.map((key) => (
                    <label className="platform-checkbox" key={key}>
                      <input
                        type="checkbox"
                        checked={draft.defaultLocks[key]}
                        onChange={(e) =>
                          update('defaultLocks', { ...draft.defaultLocks, [key]: e.target.checked })
                        }
                      />
                      {t('lockFeature_' + key)}
                    </label>
                  ))}
                </div>
              </section>
              <section className="account-section">
                <h2>{t('platformChatLimits')}</h2>
                <div className="platform-form-grid">
                  <label>
                    {t('platformChatHistory')}
                    <input
                      type="number"
                      min={20}
                      max={200}
                      required
                      value={draft.chatHistoryLimit}
                      onChange={(e) => update('chatHistoryLimit', Number(e.target.value))}
                    />
                  </label>
                  <label>
                    {t('platformMessageLength')}
                    <input
                      type="number"
                      min={200}
                      max={2000}
                      required
                      value={draft.chatMessageMaxLength}
                      onChange={(e) => update('chatMessageMaxLength', Number(e.target.value))}
                    />
                  </label>
                  <label>
                    {t('platformImageSize')}
                    <select
                      value={draft.chatImageMaxMiB}
                      onChange={(e) => update('chatImageMaxMiB', Number(e.target.value))}
                    >
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n} MiB
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </section>
              <section className="account-section">
                <h2>{t('platformClassFeatures')}</h2>
                <div className="platform-switch-grid">
                  <label className="platform-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.geoEnabled}
                      onChange={(e) => update('geoEnabled', e.target.checked)}
                    />
                    {t('platformGeoEnabled')}
                  </label>
                  <label className="platform-checkbox">
                    <input
                      type="checkbox"
                      checked={draft.pdfImportEnabled}
                      onChange={(e) => update('pdfImportEnabled', e.target.checked)}
                    />
                    {t('platformPdfEnabled')}
                  </label>
                </div>
              </section>
              <section className="account-section">
                <h2>{t('platformGuestSection')}</h2>
                <p>{t('platformGuestHelp')}</p>
                <div className="platform-form-grid">
                  <label className="platform-checkbox platform-full-row">
                    <input
                      type="checkbox"
                      checked={draft.guestEntryEnabled}
                      onChange={(e) => update('guestEntryEnabled', e.target.checked)}
                    />
                    {t('platformGuestEnabled')}
                  </label>
                  <label>
                    {t('platformGuestMaxCapacity')}
                    <input
                      type="number"
                      min={1}
                      max={500}
                      required
                      value={draft.guestMaxCapacity}
                      onChange={(e) => update('guestMaxCapacity', Number(e.target.value))}
                    />
                  </label>
                </div>
              </section>
            </fieldset>
            <div className="platform-save-bar">
              <span>{dirty ? t('unsavedChanges') : t('platformSettingsCurrent')}</span>
              <button className="primary" disabled={busy || !dirty}>
                {t(busy ? 'saving' : 'save')}
              </button>
            </div>
          </form>
        </>
      )}
    </section>
  );
}
