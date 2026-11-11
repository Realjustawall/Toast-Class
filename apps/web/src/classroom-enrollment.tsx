import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from './api';

export type Enrollment = { enrollmentMode: 'assigned' | 'organization'; memberIds: string[] };
type Member = { id: string; name: string; email: string; role: string; assigned?: boolean };
export default function ClassroomEnrollment({
  orgId,
  roomId,
  value,
  onChange,
  onReady,
}: {
  orgId: string;
  roomId?: string;
  value: Enrollment;
  onChange: (value: Enrollment) => void;
  onReady?: (ready: boolean) => void;
}) {
  const { t } = useTranslation();
  const [members, setMembers] = useState<Member[]>([]);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const callbacks = useRef({ onChange, onReady });
  callbacks.current = { onChange, onReady };
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    callbacks.current.onReady?.(false);
    void (async () => {
      if (roomId) {
        const result = await request<{
          enrollmentMode: Enrollment['enrollmentMode'];
          members: Member[];
        }>('/classrooms/' + roomId + '/access', undefined, {
          signal: controller.signal,
          silent: true,
        });
        if (controller.signal.aborted) return;
        setMembers(result.members);
        callbacks.current.onChange({
          enrollmentMode: result.enrollmentMode,
          memberIds: result.members.filter((m) => m.assigned).map((m) => m.id),
        });
      } else {
        const rows: Member[] = [];
        let offset = 0;
        for (;;) {
          const page = await request<{ items: Member[]; hasMore: boolean }>(
            '/organizations/' + orgId + '/admin/members?limit=100&offset=' + offset,
            undefined,
            { signal: controller.signal, silent: true },
          );
          rows.push(...page.items);
          if (!page.hasMore) break;
          offset += page.items.length;
        }
        if (controller.signal.aborted) return;
        setMembers(rows);
      }
      setLoading(false);
      callbacks.current.onReady?.(true);
    })().catch((e) => {
      if (!controller.signal.aborted) {
        setError(e.message);
        setLoading(false);
      }
    });
    return () => controller.abort();
  }, [orgId, roomId, retry]);
  return (
    <fieldset className="classroom-enrollment">
      <legend>{t('classroomEnrollment')}</legend>
      <label className="checkbox">
        <input
          type="checkbox"
          checked={value.enrollmentMode === 'organization'}
          onChange={(e) =>
            onChange({ ...value, enrollmentMode: e.target.checked ? 'organization' : 'assigned' })
          }
        />
        {t('classroomAccessAllMembers')}
      </label>
      <p className="muted">{t('classroomEnrollmentHelp')}</p>
      {loading ? (
        <p role="status">{t('loading')}</p>
      ) : error ? (
        <p role="alert">
          {error}{' '}
          <button type="button" onClick={() => setRetry((v) => v + 1)}>
            {t('retry')}
          </button>
        </p>
      ) : (
        <>
          <label>
            {t('searchMembersPlaceholder')}
            <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <div className="enrollment-members">
            {members
              .filter((m) =>
                (m.name + ' ' + m.email).toLocaleLowerCase().includes(search.toLocaleLowerCase()),
              )
              .map((m) => (
                <label className="enrollment-member" key={m.id}>
                  <input
                    type="checkbox"
                    checked={
                      m.role === 'owner' ||
                      value.enrollmentMode === 'organization' ||
                      value.memberIds.includes(m.id)
                    }
                    disabled={m.role === 'owner' || value.enrollmentMode === 'organization'}
                    onChange={(e) =>
                      onChange({
                        ...value,
                        memberIds: e.target.checked
                          ? [...value.memberIds, m.id]
                          : value.memberIds.filter((id) => id !== m.id),
                      })
                    }
                  />
                  <span>
                    <strong>{m.name}</strong>
                    <small dir="auto">{m.email}</small>
                  </span>
                  <span className="enrollment-role">{t(m.role)}</span>
                </label>
              ))}
          </div>
        </>
      )}
    </fieldset>
  );
}
