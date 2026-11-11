import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export default function ConnectionStatus() {
  const { t } = useTranslation();
  const [state, setState] = useState('connecting');
  useEffect(() => {
    let stopped = false;
    let active: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout>;
    async function check() {
      clearTimeout(timer);
      active?.abort();
      active = new AbortController();
      const current = active;
      if (!navigator.onLine) {
        setState('offline');
        return;
      }
      try {
        const response = await fetch('/api/v1/connection', {
          cache: 'no-store',
          credentials: 'same-origin',
          signal: AbortSignal.any([current.signal, AbortSignal.timeout(8000)]),
        });
        const data = await response.json();
        if (!stopped && !current.signal.aborted)
          setState(response.ok && data.status === 'ready' ? 'server' : 'unavailable');
      } catch {
        if (!stopped && !current.signal.aborted)
          setState(navigator.onLine ? 'unavailable' : 'offline');
      } finally {
        if (!stopped && !current.signal.aborted) timer = setTimeout(check, 10000);
      }
    }
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
  return (
    <span className="connection-status" data-state={state} role="status">
      {t('connection_' + state)}
    </span>
  );
}
