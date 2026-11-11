import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
import ClassIcon from './classroom-icons';

export type ChatCategory = { id: string; name: string };
export default function ChatCategories({
  roomId,
  categories,
  onChanged,
  onClose,
}: {
  roomId: string;
  categories: ChatCategory[];
  onChanged: () => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation(),
    dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="chat-categories-dialog"
      onClose={onClose}
      aria-labelledby="chat-categories-title"
      aria-describedby="chat-categories-help"
    >
      <header>
        <h2 id="chat-categories-title">{t('chatManageCategories')}</h2>
        <button
          type="button"
          className="quiet"
          aria-label={t('classClosePanel')}
          onClick={() => dialog.current?.close()}
        >
          <ClassIcon name="close" />
        </button>
      </header>
      <p id="chat-categories-help">{t('chatCategoryDeleteHint')}</p>
      <ul>
        <li>
          <strong>{t('chatPublic')}</strong>
          <small>{t('chatCategoryDefault')}</small>
        </li>
        {categories.map((category) => (
          <li key={category.id}>
            <strong title={category.name}>{category.name}</strong>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              aria-label={t('chatDeleteCategory') + ': ' + category.name}
              title={t('chatDeleteCategory')}
              onClick={async () => {
                setBusy(true);
                setError('');
                try {
                  await request(
                    '/classrooms/' + roomId + '/chat-categories/' + category.id + '/delete',
                    {},
                  );
                  await onChanged();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              <ClassIcon name="trash" />
            </button>
          </li>
        ))}
      </ul>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          if (busy || !name.trim()) return;
          setBusy(true);
          setError('');
          try {
            await request('/classrooms/' + roomId + '/chat-categories', { name: name.trim() });
            setName('');
            await onChanged();
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          {t('chatCategoryName')}
          <input
            value={name}
            maxLength={60}
            required
            disabled={busy || categories.length >= 12}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <button disabled={busy || !name.trim() || categories.length >= 12}>
          {t('chatAddCategory')}
        </button>
      </form>
      {categories.length >= 12 && <p role="status">{t('chatCategoryLimit')}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </dialog>
  );
}
