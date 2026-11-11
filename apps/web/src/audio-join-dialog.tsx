import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import ClassIcon from './classroom-icons';
export type AudioPolicy = {
  microphone: boolean;
  camera: boolean;
  screen_share: boolean;
  blocked: boolean;
  version: number;
};
export default function AudioJoinDialog({
  open,
  policy,
  busy,
  error,
  onChoose,
  onCancel,
}: {
  open: boolean;
  policy?: AudioPolicy;
  busy: boolean;
  error?: string;
  onChoose: (microphone: boolean) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (open && !dialog.current?.open) dialog.current?.showModal();
    else if (!open) dialog.current?.close();
  }, [open]);
  return (
    <dialog
      ref={dialog}
      className="audio-join-dialog"
      aria-labelledby="audio-join-title"
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
    >
      <div className="audio-join-heading">
        <h2 id="audio-join-title">{t('audioJoinTitle')}</h2>
        <button type="button" aria-label={t('cancel')} onClick={onCancel}>
          <ClassIcon name="close" />
        </button>
      </div>
      <p>{t('audioJoinDescription')}</p>
      <div className="audio-join-options">
        <button
          type="button"
          disabled={busy || !policy?.microphone || policy.blocked}
          onClick={() => onChoose(true)}
        >
          <ClassIcon name={policy && !policy.microphone ? 'lock' : 'mic'} />
          <strong>{t('audioUseMicrophone')}</strong>
          <span>
            {t(
              policy && !policy.microphone ? 'microphoneLockedByModerator' : 'audioMicrophoneHint',
            )}
          </span>
        </button>
        <button
          type="button"
          disabled={busy || !policy || policy.blocked}
          onClick={() => onChoose(false)}
        >
          <ClassIcon name="headphones" />
          <strong>{t('audioListenOnly')}</strong>
          <span>{t('audioListenHint')}</span>
        </button>
      </div>
      {policy && !policy.camera && (
        <p className="audio-lock-note">
          <ClassIcon name="lock" />
          {t('cameraLockedByModerator')}
        </p>
      )}
      {busy && <p role="status">{t('audioCheckingPermissions')}</p>}
      {error && <p role="alert">{error}</p>}
    </dialog>
  );
}
