import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';
type Member = { id: string; name: string; email: string };
export default function MemberChooser({
  organizationId,
  onReady,
}: {
  organizationId: string;
  onReady: (ready: boolean) => void;
}) {
  const { t } = useTranslation(),
    [search, setSearch] = useState(''),
    [offset, setOffset] = useState(0),
    [items, setItems] = useState<Member[]>([]),
    [hasMore, setHasMore] = useState(false),
    [selected, setSelected] = useState<Member>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  useEffect(() => {
    setOffset(0);
  }, [search]);
  useEffect(() => {
    const controller = new AbortController();
    setBusy(true);
    const timer = setTimeout(
      () =>
        void request<{ items: Member[]; hasMore: boolean }>(
          '/platform/users?organizationId=' +
            organizationId +
            '&search=' +
            encodeURIComponent(search) +
            '&offset=' +
            offset,
          undefined,
          { signal: controller.signal },
        )
          .then((result) => {
            setItems(result.items);
            setHasMore(result.hasMore);
            setError('');
          })
          .catch((e) => {
            if (!controller.signal.aborted) setError(e.message);
          })
          .finally(() => {
            if (!controller.signal.aborted) setBusy(false);
          }),
      150,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [organizationId, search, offset]);
  useEffect(() => {
    onReady(Boolean(selected));
  }, [selected]);
  return (
    <section className="member-chooser" aria-label={t('memberChoose')}>
      <label>
        {t('memberSearch')}
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
      </label>
      <input type="hidden" name="userId" value={selected?.id ?? ''} />
      <div role="listbox" aria-label={t('memberChoose')} aria-busy={busy}>
        {items.map((item) => (
          <button
            type="button"
            role="option"
            aria-selected={selected?.id === item.id}
            key={item.id}
            onClick={() => setSelected(item)}
          >
            <span>{item.name}</span>
            {selected?.id === item.id && <small dir="ltr">{item.email}</small>}
          </button>
        ))}
      </div>
      {selected && (
        <p role="status">
          {t('memberSelected')}: <strong>{selected.name}</strong>
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="actions">
        <button
          type="button"
          disabled={busy || offset === 0}
          onClick={() => setOffset((value) => Math.max(0, value - 50))}
        >
          ‹
        </button>
        <button
          type="button"
          disabled={busy || !hasMore}
          onClick={() => setOffset((value) => value + 50)}
        >
          ›
        </button>
      </div>
    </section>
  );
}
