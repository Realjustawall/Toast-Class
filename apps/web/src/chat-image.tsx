import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ClassIcon from './classroom-icons';
export default function ChatImage({ roomId, fileId }: { roomId: string; fileId: string }) {
  const { t } = useTranslation(),
    dialog = useRef<HTMLDialogElement>(null),
    [failed, setFailed] = useState(false),
    [open, setOpen] = useState(false),
    [attempt, setAttempt] = useState(0),
    src =
      '/api/v1/classrooms/' +
      roomId +
      '/files/' +
      fileId +
      '/content' +
      (attempt ? '?retry=' + attempt : '');
  if (failed)
    return (
      <div className="chat-image-unavailable">
        <small role="status">{t('chatImageUnavailable')}</small>
        <button
          type="button"
          onClick={() => {
            setAttempt((value) => value + 1);
            setFailed(false);
          }}
        >
          {t('chatRetryImage')}
        </button>
      </div>
    );
  return (
    <>
      <button
        type="button"
        className="chat-image-thumbnail"
        aria-label={t('chatOpenImage')}
        onClick={() => {
          setOpen(true);
          dialog.current?.showModal();
        }}
      >
        <img
          src={src}
          alt={t('chatImage')}
          loading="lazy"
          onError={() => {
            setOpen(false);
            setFailed(true);
          }}
        />
      </button>
      <dialog
        ref={dialog}
        className="chat-image-dialog"
        aria-label={t('chatImage')}
        onClose={() => setOpen(false)}
      >
        <header>
          <a href={src} download>
            {t('chatDownloadImage')}
          </a>
          <button
            type="button"
            className="quiet"
            aria-label={t('classClosePanel')}
            onClick={() => dialog.current?.close()}
          >
            <ClassIcon name="close" />
          </button>
        </header>
        {open && <img src={src} alt={t('chatImage')} />}
      </dialog>
    </>
  );
}
