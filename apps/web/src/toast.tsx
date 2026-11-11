import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type ToastItem = {
  id: number;
  kind: 'error' | 'success' | 'info';
  title: string;
  message: string;
  durationMs: number;
};

type Listener = (toast: ToastItem) => void;
const listeners = new Set<Listener>();
let nextId = 1;
let lastMsg = '';
let lastTime = 0;

export function pushToast(
  message: string,
  kind: 'error' | 'success' | 'info' = 'error',
  title?: string,
  durationMs = 5500,
) {
  const clean = message.trim();
  if (!clean) return;
  const now = Date.now();
  if (clean === lastMsg && now - lastTime < durationMs) return;
  lastMsg = clean;
  lastTime = now;
  const item: ToastItem = {
    id: nextId++,
    kind,
    title: title ?? '',
    message: clean,
    durationMs,
  };
  for (const fn of listeners) fn(item);
  if (typeof window !== 'undefined')
    window.dispatchEvent(new CustomEvent('classroom-feedback', { detail: { tone: kind } }));
}

export function ToastViewport() {
  const { t } = useTranslation();
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const onToast: Listener = (item) => {
      setItems((prev) => [item, ...prev].slice(0, 4));
      setTimeout(() => {
        setItems((prev) => prev.filter((x) => x.id !== item.id));
      }, item.durationMs);
    };
    listeners.add(onToast);
    return () => {
      listeners.delete(onToast);
    };
  }, []);

  if (!items.length) return null;

  return (
    <div className="toaster-toast-viewport" aria-live="polite">
      {items.map((item) => {
        const defaultTitle =
          item.kind === 'error'
            ? t('toastErrorTitle')
            : item.kind === 'success'
              ? t('toastSuccessTitle')
              : t('toastInfoTitle');
        return (
          <div
            key={item.id}
            className={`toaster-toast-card is-${item.kind}`}
            style={{ '--toast-duration': `${item.durationMs}ms` } as React.CSSProperties}
          >
            <div className="toaster-toast-icon" aria-hidden="true">
              {item.kind === 'error' ? '⚠️' : item.kind === 'success' ? '✅' : 'ℹ️'}
            </div>
            <div className="toaster-toast-body">
              <strong>{item.title || defaultTitle}</strong>
              <p>{item.message}</p>
            </div>
            <button
              type="button"
              className="toaster-toast-close"
              aria-label={t('classClosePanel')}
              onClick={() => setItems((prev) => prev.filter((x) => x.id !== item.id))}
            >
              ×
            </button>
            <span className="toaster-toast-progress" aria-hidden="true" />
          </div>
        );
      })}
    </div>
  );
}

export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode; onReset?: () => void },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode; onReset?: () => void }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error) {
    pushToast(error.message || 'خطای غیرمنتظره در رابط کاربری رخ داد.', 'error');
  }
  override render() {
    if (this.state.error) {
      return (
        <div className="toaster-crash-fallback" role="alert">
          <div className="toaster-crash-card">
            <span className="toaster-crash-badge">⚠️ خطای بارگذاری بخش</span>
            <h2>مشکلی در نمایش این بخش رخ داد</h2>
            <p>{this.state.error.message}</p>
            <div className="actions">
              <button
                type="button"
                className="primary"
                onClick={() => {
                  this.setState({ error: null });
                  this.props.onReset?.();
                }}
              >
                تلاش مجدد / بازگشت
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
