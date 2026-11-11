import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import ClassIcon from './classroom-icons';
import ClassroomLockDialog from './classroom-lock-dialog';
import {
  DEFAULT_CLASSROOM_PERMISSIONS,
  type ClassroomPermissions,
  type ClassroomTheme,
  type UserPermissionOverride,
} from './classroom-types';

export type ThemeMeta = {
  id: ClassroomTheme;
  isDefault?: boolean;
  swatches: [string, string, string, string];
};

export const CLASSROOM_THEMES: ThemeMeta[] = [
  {
    id: 'classic-bbb',
    isDefault: true,
    swatches: ['#06172a', '#0f70d7', '#ffffff', '#10b981'],
  },
  {
    id: 'modular-skyroom',
    swatches: ['#eef2f6', '#0284c7', '#ffffff', '#0ea5e9'],
  },
  {
    id: 'immersive-glass',
    swatches: ['#090d16', '#6366f1', '#1e293b', '#ec4899'],
  },
  {
    id: 'studio-hybrid',
    swatches: ['#0f172a', '#f59e0b', '#1e293b', '#3b82f6'],
  },
];

export function themeLabel(theme: ClassroomTheme, t: (k: string) => string) {
  switch (theme) {
    case 'classic-bbb':
      return t('theme_classic_bbb');
    case 'modular-skyroom':
      return t('theme_modular_skyroom');
    case 'immersive-glass':
      return t('theme_immersive_glass');
    case 'studio-hybrid':
      return t('theme_studio_hybrid');
  }
}

export function themeDescription(theme: ClassroomTheme, t: (k: string) => string) {
  switch (theme) {
    case 'classic-bbb':
      return t('themeDesc_classic_bbb');
    case 'modular-skyroom':
      return t('themeDesc_modular_skyroom');
    case 'immersive-glass':
      return t('themeDesc_immersive_glass');
    case 'studio-hybrid':
      return t('themeDesc_studio_hybrid');
  }
}

export function ThemeLivePreview({
  theme,
  permissions = DEFAULT_CLASSROOM_PERMISSIONS,
  roomName,
  onSelectTheme,
}: {
  theme: ClassroomTheme;
  permissions?: ClassroomPermissions;
  roomName?: string;
  onSelectTheme?: (theme: ClassroomTheme) => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (expanded && !dialog.current?.open) dialog.current?.showModal();
  }, [expanded]);
  const image = (
    <img src={'/classroom-previews/' + theme + '.png'} alt={themeLabel(theme, t)} loading="lazy" />
  );
  return (
    <div
      className="classroom-type-preview"
      data-testid="theme-live-preview"
      data-preview-theme={theme}
    >
      <header>
        <strong>{roomName?.trim() || themeLabel(theme, t)}</strong>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-label={t('themePreviewExpand')}
        >
          <ClassIcon name="expand" />
          {t('themePreviewExpand')}
        </button>
      </header>
      {image}
      <div className="type-preview-policies">
        <span>
          {t('chat')}: {t(permissions.chatEnabled ? 'permEnabled' : 'permDisabled')}
        </span>
        <span>
          {t('board')}: {t(permissions.studentWhiteboardEnabled ? 'permEnabled' : 'permDisabled')}
        </span>
      </div>
      {expanded && (
        <dialog
          ref={dialog}
          className="theme-preview-modal-backdrop"
          aria-label={t('themePreviewModalTitle')}
          onCancel={() => setExpanded(false)}
          onClose={() => setExpanded(false)}
        >
          <div className="theme-preview-modal-card">
            <div className="theme-preview-modal-head">
              <strong>{t('themePreviewModalTitle')}</strong>
              {onSelectTheme && (
                <div className="theme-preview-quick-pills">
                  {CLASSROOM_THEMES.map((item) => (
                    <button
                      type="button"
                      key={item.id}
                      aria-pressed={item.id === theme}
                      onClick={() => onSelectTheme(item.id)}
                    >
                      {themeLabel(item.id, t)}
                    </button>
                  ))}
                </div>
              )}
              <button type="button" onClick={() => setExpanded(false)}>
                {t('themePreviewCloseFull')}
              </button>
            </div>
            {image}
          </div>
        </dialog>
      )}
    </div>
  );
}

export function ClassroomPermissionsEditor({
  permissions,
  onChange,
}: {
  permissions: ClassroomPermissions;
  onChange: (next: ClassroomPermissions) => void;
}) {
  const { t } = useTranslation();
  const toggle = (key: keyof ClassroomPermissions) =>
    onChange({ ...permissions, [key]: !permissions[key] });

  const items: Array<{
    key: keyof ClassroomPermissions;
    label: string;
    hint: string;
    dangerWhenTrue?: boolean;
  }> = [
    {
      key: 'locked',
      label: t('permLockClassroomLabel'),
      hint: t('permLockClassroomHint'),
      dangerWhenTrue: true,
    },
    {
      key: 'chatEnabled',
      label: t('permChatEnabledLabel'),
      hint: t('permChatEnabledHint'),
    },
    {
      key: 'handRaiseEnabled',
      label: t('permHandRaiseLabel'),
      hint: t('permHandRaiseHint'),
    },
    {
      key: 'studentWhiteboardEnabled',
      label: t('permWhiteboardLabel'),
      hint: t('permWhiteboardHint'),
    },
    {
      key: 'defaultMicrophone',
      label: t('permDefaultMicLabel'),
      hint: t('permDefaultMicHint'),
    },
    {
      key: 'defaultCamera',
      label: t('permDefaultCamLabel'),
      hint: t('permDefaultCamHint'),
    },
    {
      key: 'defaultScreenShare',
      label: t('permDefaultScreenLabel'),
      hint: t('permDefaultScreenHint'),
    },
  ];

  return (
    <div
      className="permissions-editor-grid"
      role="group"
      aria-label={t('classroomSecurityPermissions')}
    >
      {items.map((item) => {
        const checked = Boolean(permissions[item.key]);
        return (
          <label
            key={item.key}
            className={`permission-toggle-card${checked ? ' is-checked' : ''}${
              item.dangerWhenTrue && checked ? ' is-danger' : ''
            }`}
          >
            <input type="checkbox" checked={checked} onChange={() => toggle(item.key)} />
            <div className="permission-toggle-copy">
              <strong>{item.label}</strong>
              <small>{item.hint}</small>
            </div>
          </label>
        );
      })}
    </div>
  );
}

export function ThemeSelectorGrid({
  value,
  onChange,
}: {
  value: ClassroomTheme;
  onChange: (theme: ClassroomTheme) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="theme-selector-grid" role="radiogroup" aria-label={t('classroomThemeSelect')}>
      {CLASSROOM_THEMES.map((item) => {
        const selected = item.id === value;
        return (
          <button
            key={item.id}
            type="button"
            role="radio"
            aria-checked={selected}
            className={`theme-option-card${selected ? ' is-selected' : ''}`}
            onClick={() => onChange(item.id)}
          >
            <div className="theme-option-top">
              <div className="theme-swatches" aria-hidden="true">
                {item.swatches.map((color, idx) => (
                  <span key={idx} style={{ background: color }} />
                ))}
              </div>
              {item.isDefault && (
                <span className="theme-default-pill">{t('themeDefaultBadge')}</span>
              )}
            </div>
            <strong>{themeLabel(item.id, t)}</strong>
            <small>{themeDescription(item.id, t)}</small>
          </button>
        );
      })}
    </div>
  );
}

export function IndividualUserPermissionsManager({
  roomId,
  onChanged,
}: {
  roomId: string;
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const [members, setMembers] = useState<UserPermissionOverride[]>([]);
  const [search, setSearch] = useState('');
  const [selectedUser, setSelectedUser] = useState<string>();
  const [lockTarget, setLockTarget] = useState<{ id: string; name: string }>();
  const [busyUser, setBusyUser] = useState<string | null>(null);
  const [error, setError] = useState('');

  async function load() {
    try {
      const res = await request<{ members?: UserPermissionOverride[] } | UserPermissionOverride[]>(
        `/classrooms/${roomId}/user-permissions`,
      );
      const list = Array.isArray(res) ? res : (res?.members ?? []);
      setMembers(list);
      setError('');
    } catch (e) {
      setError((e as Error).message);
    }
  }

  useEffect(() => {
    void load();
  }, [roomId]);

  async function patchUser(userId: string, patch: Record<string, boolean | null>) {
    setBusyUser(userId);
    setError('');
    try {
      await request(`/classrooms/${roomId}/user-permissions/${userId}`, patch);
      await load();
      onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusyUser(null);
    }
  }

  const filtered = (members ?? []).filter(
    (m) =>
      !search.trim() ||
      (m.name ?? '').toLowerCase().includes(search.toLowerCase()) ||
      (m.email ?? '').toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="individual-perms-manager" aria-label={t('individualUserPermissionsTitle')}>
      {lockTarget && (
        <ClassroomLockDialog
          roomId={roomId}
          target={lockTarget}
          onClose={() => setLockTarget(undefined)}
          onSaved={async () => {
            await load();
            onChanged?.();
          }}
        />
      )}
      <div className="individual-perms-head">
        <div>
          <h4>{t('individualUserPermissionsTitle')}</h4>
          <p className="muted">{t('individualUserPermissionsHint')}</p>
        </div>
        <input
          type="search"
          className="individual-perms-search"
          placeholder={t('searchMembersPlaceholder')}
          aria-label={t('searchMembersPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      <div className="individual-perms-list">
        {filtered.map((m) => {
          const eff = m.effective ?? {
            canChat: Boolean(m.canChat ?? true),
            canChatImages: Boolean(m.canChatImages),
            interactionLocked: Boolean(m.interactionLocked),
            canWhiteboard: Boolean(m.canWhiteboard ?? m.isPresenter),
            canMicrophone: Boolean(m.canMicrophone ?? true),
            canCamera: Boolean(m.canCamera ?? true),
            canScreenShare: Boolean(m.canScreenShare ?? m.isPresenter ?? true),
            canRaiseHand: Boolean(m.canRaiseHand ?? true),
            isPresenter: Boolean(m.isPresenter),
            kicked: Boolean(m.kicked),
          };
          const isTeacher = m.role !== 'student';
          const busy = busyUser === m.userId;
          return (
            <div
              key={m.userId}
              className={`individual-perm-row${m.kicked ? ' is-kicked' : ''}${
                m.isPresenter ? ' is-presenter' : ''
              }`}
            >
              <button
                type="button"
                className="individual-perm-user"
                aria-expanded={selectedUser === m.userId}
                onClick={() =>
                  setSelectedUser((current) => (current === m.userId ? undefined : m.userId))
                }
              >
                <strong>
                  {m.name}
                  {m.isPresenter && (
                    <span className="perm-badge presenter">
                      <ClassIcon name="presenter" size={12} /> {t('presenterBadge')}
                    </span>
                  )}
                  {m.kicked && (
                    <span className="perm-badge kicked">
                      <ClassIcon name="kick" size={12} /> {t('kickedBadge')}
                    </span>
                  )}
                </strong>
                <small>
                  {t(isTeacher ? 'teacherRole' : 'studentRole')}
                  {selectedUser === m.userId && m.email ? ` · ${m.email}` : ''}
                </small>
              </button>
              {!isTeacher && selectedUser === m.userId && (
                <div className="individual-perm-chips">
                  <button
                    type="button"
                    disabled={busy}
                    className={'perm-chip' + (eff.interactionLocked ? ' active' : '')}
                    title={t(eff.interactionLocked ? 'participantUnlock' : 'participantLock')}
                    aria-label={t(eff.interactionLocked ? 'participantUnlock' : 'participantLock')}
                    onClick={() => setLockTarget({ id: m.userId, name: m.name ?? m.email ?? '' })}
                  >
                    <ClassIcon name={eff.interactionLocked ? 'lock' : 'unlock'} size={13} />
                    {t(eff.interactionLocked ? 'participantUnlock' : 'participantLock')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={'perm-chip' + (eff.canChatImages ? ' active' : ' muted')}
                    title={t('chatImagePermission')}
                    aria-label={t('chatImagePermission')}
                    onClick={() => void patchUser(m.userId, { canChatImages: !eff.canChatImages })}
                  >
                    <ClassIcon name="image" size={13} />
                    {t('chatImagePermission')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={`perm-chip${m.isPresenter ? ' active presenter' : ''}`}
                    title={t('togglePresenterRole')}
                    onClick={() =>
                      void patchUser(m.userId, {
                        isPresenter: !m.isPresenter,
                        ...(!m.isPresenter && m.effective?.overrides?.canWhiteboard === false
                          ? { canWhiteboard: null }
                          : {}),
                        ...(!m.isPresenter && m.effective?.overrides?.canScreenShare === false
                          ? { canScreenShare: null }
                          : {}),
                      })
                    }
                  >
                    <ClassIcon name="presenter" size={13} /> {t('presenterBadge')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={`perm-chip${eff?.canWhiteboard ? ' active' : ' muted'}`}
                    title={t('permUserWhiteboard')}
                    onClick={() => void patchUser(m.userId, { canWhiteboard: !eff?.canWhiteboard })}
                  >
                    <ClassIcon name="pen" size={13} /> {t('board')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={`perm-chip${eff?.canChat ? ' active' : ' muted'}`}
                    title={t('permUserChat')}
                    onClick={() => void patchUser(m.userId, { canChat: !eff?.canChat })}
                  >
                    <ClassIcon name="chat" size={13} /> {t('chat')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={`perm-chip${eff?.canMicrophone ? ' active' : ' muted'}`}
                    title={t('microphone')}
                    onClick={() => void patchUser(m.userId, { canMicrophone: !eff?.canMicrophone })}
                  >
                    <ClassIcon name={eff?.canMicrophone ? 'mic' : 'micOff'} size={13} />{' '}
                    {t('microphone')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={`perm-chip${eff?.canCamera ? ' active' : ' muted'}`}
                    title={t('camera')}
                    onClick={() => void patchUser(m.userId, { canCamera: !eff?.canCamera })}
                  >
                    <ClassIcon name={eff?.canCamera ? 'cam' : 'camOff'} size={13} /> {t('camera')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={`perm-chip${eff?.canScreenShare ? ' active' : ' muted'}`}
                    title={t('shareScreen')}
                    onClick={() =>
                      void patchUser(m.userId, { canScreenShare: !eff?.canScreenShare })
                    }
                  >
                    <ClassIcon name="screen" size={13} /> {t('shareScreen')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={`perm-chip${eff?.canRaiseHand ? ' active' : ' muted'}`}
                    title={t('raiseHand')}
                    onClick={() => void patchUser(m.userId, { canRaiseHand: !eff?.canRaiseHand })}
                  >
                    <ClassIcon name="hand" size={13} /> {t('raiseHand')}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    className={`perm-chip danger${m.kicked ? ' active' : ''}`}
                    title={t('permUserKick')}
                    onClick={() => void patchUser(m.userId, { kicked: !m.kicked })}
                  >
                    <ClassIcon name="kick" size={13} />{' '}
                    {t(m.kicked ? 'permUserRestore' : 'permUserKick')}
                  </button>
                </div>
              )}
            </div>
          );
        })}
        {!filtered.length && <p className="muted">{t('noParticipants')}</p>}
      </div>
    </div>
  );
}
