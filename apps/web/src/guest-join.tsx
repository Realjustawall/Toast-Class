import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request as api } from './api';
import type { ClassroomView } from './classroom-types';

type GuestInfo = {
  id: string;
  name: string;
  enabled: boolean;
  locked: boolean;
  maxCapacity: number;
  currentGuests: number;
};

type GuestJoinResponse = {
  user: { id: string; name: string; email: string; isGuest?: boolean };
  classroom: ClassroomView;
};

function getOrCreateDeviceId() {
  const key = 'toaster_guest_device_id';
  try {
    const existing = localStorage.getItem(key);
    if (existing && existing.length >= 8) return existing;
    const generated =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
    localStorage.setItem(key, generated);
    return generated;
  } catch {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }
}

export default function GuestJoin({
  roomId,
  onJoined,
  onCancel,
}: {
  roomId: string;
  onJoined: (user: { id: string; name: string; email: string }, classroom: ClassroomView) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [info, setInfo] = useState<GuestInfo | null>(null);
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    api<GuestInfo>(`/classrooms/${roomId}/guest-info`)
      .then((data) => {
        if (active) setInfo(data);
      })
      .catch((e) => {
        if (active) setError((e as Error).message);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [roomId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const deviceId = getOrCreateDeviceId();
      const result = await api<GuestJoinResponse>(`/classrooms/${roomId}/guest-join`, {
        name: name.trim(),
        deviceId,
      });
      onJoined(result.user, result.classroom);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth-layout">
      <section className="auth-card" aria-label={t('guestJoinTitle')}>
        <div className="auth-head">
          <h1>{t('guestJoinTitle')}</h1>
          {info && <p>{info.name}</p>}
        </div>
        {loading ? (
          <p>{t('loading')}</p>
        ) : error && !info ? (
          <>
            <p className="error" role="alert">
              {error}
            </p>
            <button type="button" className="quiet" onClick={onCancel}>
              {t('backToLogin')}
            </button>
          </>
        ) : info && !info.enabled ? (
          <>
            <p className="error" role="alert">
              {t('guestEntryDisabledMsg')}
            </p>
            <button type="button" className="quiet" onClick={onCancel}>
              {t('backToLogin')}
            </button>
          </>
        ) : (
          <form onSubmit={(e) => void submit(e)} className="auth-form">
            {info && (
              <p className="auth-sub">
                {t('guestCapacityStatus', {
                  current: info.currentGuests,
                  max: info.maxCapacity,
                })}
              </p>
            )}
            <label>
              {t('guestDisplayName')}
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                minLength={2}
                maxLength={80}
                required
                placeholder={t('guestNamePlaceholder')}
              />
            </label>
            {error && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <div className="actions">
              <button type="button" className="quiet" onClick={onCancel} disabled={busy}>
                {t('backToLogin')}
              </button>
              <button type="submit" className="primary" disabled={busy || name.trim().length < 2}>
                {busy ? t('loading') : t('guestJoinAction')}
              </button>
            </div>
          </form>
        )}
      </section>
    </main>
  );
}
