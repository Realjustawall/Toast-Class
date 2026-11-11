import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import ClassIcon from './classroom-icons';
import { userFontFamilies, type UserFontFamily } from '../../../packages/user-preferences';
import {
  useUserPreferences,
  updateUserPreferences,
  saveUserPreferences,
  reloadUserPreferences,
} from './user-preferences';
import {
  playClassroomSound,
  unlockClassroomSounds,
  installApplicationSounds,
} from './classroom-sounds';
let activeOwner: symbol | undefined;
const owners = new Map<symbol, ReactNode>();
export default function ApplicationSettings({ children }: { children?: ReactNode }) {
  const owner = useRef(Symbol('settings-owner'));
  useEffect(
    () => () => {
      owners.delete(owner.current);
      if (activeOwner === owner.current) {
        activeOwner = undefined;
        window.dispatchEvent(new CustomEvent('open-application-settings', { detail: undefined }));
      }
    },
    [],
  );
  useEffect(() => {
    owners.set(owner.current, children);
    if (activeOwner === owner.current && location.hash.startsWith('#settings'))
      window.dispatchEvent(new CustomEvent('open-application-settings', { detail: children }));
  }, [children]);
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className="application-settings-trigger"
      aria-label={t('applicationSettings')}
      title={t('applicationSettings')}
      onClick={() => {
        activeOwner = owner.current;
        if (!location.hash.startsWith('#settings'))
          history.pushState(
            { toasterSettings: true },
            '',
            '#settings?return=' + encodeURIComponent(location.hash),
          );
        window.dispatchEvent(new CustomEvent('open-application-settings', { detail: children }));
      }}
    >
      <ClassIcon name="settings" />
      <span>{t('applicationSettings')}</span>
    </button>
  );
}
export function ApplicationSettingsHost() {
  useEffect(installApplicationSounds, []);
  const { t, i18n } = useTranslation(),
    [open, setOpen] = useState(location.hash.startsWith('#settings')),
    [content, setContent] = useState<ReactNode>(),
    dialog = useRef<HTMLDialogElement>(null),
    state = useUserPreferences(),
    p = state.preferences;
  useEffect(() => {
    const show = (event: Event) => {
        setContent((event as CustomEvent).detail);
        setOpen(true);
      },
      route = () => {
        const settings = location.hash.startsWith('#settings');
        if (!settings) activeOwner = undefined;
        else if (!activeOwner) {
          const context = [...owners].reverse().find(([, value]) => value !== undefined);
          activeOwner = context?.[0];
          setContent(context?.[1]);
        }
        setOpen(settings);
      };
    window.addEventListener('open-application-settings', show);
    window.addEventListener('hashchange', route);
    window.addEventListener('popstate', route);
    return () => {
      window.removeEventListener('open-application-settings', show);
      window.removeEventListener('hashchange', route);
      window.removeEventListener('popstate', route);
    };
  }, []);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
  }, [open]);
  useEffect(() => {
    if (p.language && p.language !== i18n.language) {
      localStorage.setItem('language', p.language);
      void i18n.changeLanguage(p.language);
    }
  }, [p.language]);
  const close = () => {
    activeOwner = undefined;
    if (history.state?.toasterSettings) {
      history.back();
    } else {
      const target = new URLSearchParams(location.hash.split('?')[1] ?? '').get('return') ?? '';
      history.replaceState(
        null,
        '',
        location.pathname +
          location.search +
          (/^#classroom\/[a-f0-9-]{36}$/i.test(target) ? target : ''),
      );
      window.dispatchEvent(new Event('hashchange'));
    }
    setOpen(false);
  };
  if (!open) return null;
  return createPortal(
    <dialog
      ref={dialog}
      className="application-settings-page"
      aria-label={t('applicationSettings')}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <header>
        <div>
          <h1>{t('applicationSettings')}</h1>
          <p role="status">
            {!state.authenticated
              ? t('preferencesGuest')
              : !state.ready
                ? t('loading')
                : state.saving || state.pending
                  ? t('preferencesSaving')
                  : state.error
                    ? t('preferencesNotSaved')
                    : t('preferencesSaved')}
          </p>
        </div>
        <button type="button" onClick={close}>
          {t('preferencesBack')}
        </button>
      </header>
      <main>
        <section>
          <h2>{t('applicationLanguage')}</h2>
          <label>
            {t('applicationLanguage')}
            <select
              aria-label={t('applicationLanguage')}
              data-setting="language"
              value={p.language ?? (i18n.language.startsWith('fa') ? 'fa' : 'en')}
              onChange={(event) => {
                localStorage.setItem('language', event.target.value);
                void i18n.changeLanguage(event.target.value);
                updateUserPreferences({ language: event.target.value as 'fa' | 'en' });
              }}
            >
              <option value="fa">فارسی</option>
              <option value="en">English</option>
            </select>
          </label>
          {content}
        </section>
        <section>
          <h2>{t('classroomSounds')}</h2>
          <label className="settings-check">
            <input
              type="checkbox"
              checked={p.sounds.enabled}
              onChange={(e) => updateUserPreferences({ sounds: { enabled: e.target.checked } })}
            />
            {t('classroomSounds')}
          </label>
          <label>
            {t('soundVolume')}
            <input
              aria-label={t('soundVolume')}
              type="range"
              min="0"
              max="100"
              value={Math.round(p.sounds.volume * 100)}
              onChange={(e) =>
                updateUserPreferences({ sounds: { volume: Number(e.target.value) / 100 } })
              }
            />
          </label>
          {(['actions', 'devices', 'notifications', 'classroom'] as const).map((key) => (
            <label key={key} className="settings-check">
              <input
                type="checkbox"
                checked={p.sounds[key]}
                onChange={(e) => updateUserPreferences({ sounds: { [key]: e.target.checked } })}
              />
              {t('soundCategory_' + key)}
            </label>
          ))}
          <button
            type="button"
            disabled={!p.sounds.enabled || !p.sounds.volume}
            onClick={() =>
              void unlockClassroomSounds().then(() => playClassroomSound('connected', true))
            }
          >
            {t('soundPreview')}
          </button>
        </section>
        <section>
          <h2>{t('boardToolStyle')}</h2>
          {(['pen', 'pressurePen', 'highlighter'] as const).map((key) => (
            <fieldset key={key}>
              <legend>
                {t(
                  key === 'pen'
                    ? 'boardPen'
                    : key === 'pressurePen'
                      ? 'boardPressurePen'
                      : 'boardHighlighter',
                )}
              </legend>
              {key === 'pressurePen' && (
                <label>
                  {t('boardPressureSensitivity')}
                  <input
                    aria-label={t('boardPressureSensitivity')}
                    type="number"
                    min="0.25"
                    max="3"
                    step="0.05"
                    value={p.tools.pressurePen.sensitivity}
                    onChange={(event) => {
                      const sensitivity = Number(event.target.value);
                      if (sensitivity >= 0.25 && sensitivity <= 3)
                        updateUserPreferences({ tools: { pressurePen: { sensitivity } } });
                    }}
                  />
                </label>
              )}
              <label>
                {t('boardInkColor')}
                <input
                  type="color"
                  value={p.tools[key].color}
                  onChange={(e) =>
                    updateUserPreferences({ tools: { [key]: { color: e.target.value } } })
                  }
                />
              </label>
              <label>
                {t('boardStrokeWidth')}
                <input
                  type="number"
                  min="0.1"
                  max="100"
                  step="0.1"
                  value={p.tools[key].width}
                  onChange={(e) => {
                    const width = Number(e.target.value);
                    if (width >= 0.1 && width <= 100)
                      updateUserPreferences({ tools: { [key]: { width } } });
                  }}
                />
              </label>
              <label>
                {t('boardOpacity')}
                <input
                  type="number"
                  min="1"
                  max="100"
                  value={p.tools[key].opacity}
                  onChange={(e) => {
                    const opacity = Number(e.target.value);
                    if (opacity >= 1 && opacity <= 100)
                      updateUserPreferences({ tools: { [key]: { opacity } } });
                  }}
                />
              </label>
            </fieldset>
          ))}
          <label>
            {t('boardEraserSize')}
            <input
              type="number"
              min="2"
              max="200"
              value={p.tools.eraserSize}
              onChange={(e) => {
                const eraserSize = Number(e.target.value);
                if (eraserSize >= 2 && eraserSize <= 200)
                  updateUserPreferences({ tools: { eraserSize } });
              }}
            />
          </label>
          <fieldset>
            <legend>{t('boardTextTool')}</legend>
            <label>
              {t('boardInkColor')}
              <input
                aria-label={t('boardTextColor')}
                type="color"
                value={p.tools.text.color}
                onChange={(e) =>
                  updateUserPreferences({ tools: { text: { color: e.target.value } } })
                }
              />
            </label>
            <label>
              {t('boardFontSize')}
              <input
                aria-label={t('boardFontSize')}
                type="number"
                min="8"
                max="256"
                step="0.5"
                value={p.tools.text.fontSize}
                onChange={(e) => {
                  const fontSize = Number(e.target.value);
                  if (fontSize >= 8 && fontSize <= 256)
                    updateUserPreferences({ tools: { text: { fontSize } } });
                }}
              />
            </label>
            <label>
              {t('boardFontFamily')}
              <select
                aria-label={t('boardFontFamily')}
                value={p.tools.text.fontFamily}
                onChange={(e) =>
                  updateUserPreferences({
                    tools: { text: { fontFamily: Number(e.target.value) as UserFontFamily } },
                  })
                }
              >
                {userFontFamilies.map((id) => (
                  <option key={id} value={id}>
                    {t('annotationFont_' + id)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {t('boardTextAlign')}
              <select
                aria-label={t('boardTextAlign')}
                value={p.tools.text.textAlign}
                onChange={(e) =>
                  updateUserPreferences({
                    tools: { text: { textAlign: e.target.value as 'left' | 'center' | 'right' } },
                  })
                }
              >
                {['left', 'center', 'right'].map((id) => (
                  <option key={id} value={id}>
                    {t('annotationTextAlign_' + id)}
                  </option>
                ))}
              </select>
            </label>
          </fieldset>
        </section>
      </main>
      {state.error && <p role="alert">{state.error}</p>}
      <footer>
        <button
          disabled={!state.authenticated || state.saving}
          onClick={() =>
            void saveUserPreferences()
              .then(() => playClassroomSound('success'))
              .catch(() => {})
          }
        >
          {t('save')}
        </button>
        <button
          disabled={!state.authenticated || state.saving}
          onClick={() => void reloadUserPreferences()}
        >
          {t('reload')}
        </button>
        <button onClick={close}>{t('preferencesBack')}</button>
      </footer>
    </dialog>,
    document.body,
  );
}
