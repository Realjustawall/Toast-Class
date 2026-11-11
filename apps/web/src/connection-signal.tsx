import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ConnectionState } from './live';

export default function ConnectionSignal({ state }: { state: ConnectionState }) {
  const { t, i18n } = useTranslation();
  const [latency, setLatency] = useState<number | null>(null);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    let active: AbortController | undefined;
    const check = async () => {
      clearTimeout(timer);
      active?.abort();
      if (!navigator.onLine) {
        setLatency(null);
        return;
      }
      const controller = (active = new AbortController());
      const start = performance.now();
      try {
        const response = await fetch('/api/v1/connection', {
          credentials: 'same-origin',
          cache: 'no-store',
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
        });
        const data = await response.json();
        if (!stopped && !controller.signal.aborted)
          setLatency(
            response.ok && data.status === 'ready' ? Math.round(performance.now() - start) : null,
          );
      } catch {
        if (!stopped && !controller.signal.aborted) setLatency(null);
      } finally {
        if (!stopped && !controller.signal.aborted) timer = setTimeout(check, 10000);
      }
    };
    const visible = () => {
      if (document.visibilityState === 'visible') void check();
    };
    void check();
    window.addEventListener('online', check);
    window.addEventListener('offline', check);
    document.addEventListener('visibilitychange', visible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      active?.abort();
      window.removeEventListener('online', check);
      window.removeEventListener('offline', check);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  const level =
    state !== 'connected' || latency === null
      ? 0
      : latency < 150
        ? 4
        : latency < 400
          ? 3
          : latency < 1000
            ? 2
            : 1;
  const label = t(state === 'connected' ? 'liveConnected' : 'connection_' + state);
  const detail =
    latency === null || state !== 'connected'
      ? label
      : label +
        ' · ' +
        t('connectionRoundTrip', { ms: new Intl.NumberFormat(i18n.language).format(latency) });
  return (
    <span
      className={'connection-signal ' + state}
      role="status"
      data-testid="classroom-connection"
      data-level={level}
      title={detail}
      aria-label={detail}
    >
      <svg
        viewBox="0 0 24 24"
        aria-hidden="true"
        width="22"
        height="22"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      >
        <path opacity={level >= 4 ? 1 : 0.2} d="M2 8a16 16 0 0 1 20 0" />
        <path opacity={level >= 3 ? 1 : 0.2} d="M5 11a11 11 0 0 1 14 0" />
        <path opacity={level >= 2 ? 1 : 0.2} d="M8 14a6 6 0 0 1 8 0" />
        <circle opacity={level >= 1 ? 1 : 0.2} cx="12" cy="18" r="1" fill="currentColor" />
        {level === 0 && <path d="m4 3 16 18" />}
      </svg>
      <span>{label}</span>
    </span>
  );
}
