import { useEffect, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
export default function OverflowMenu({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const element = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (element.current?.open && !element.current.contains(event.target as Node))
        element.current.open = false;
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  return (
    <details
      ref={element}
      className="overflow-menu"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.currentTarget.open = false;
          event.currentTarget.querySelector('summary')?.focus();
        }
      }}
    >
      <summary aria-label={t('moreOptions')} title={t('moreOptions')}>
        ⋯
      </summary>
      <div
        className="overflow-menu-body"
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button') && element.current)
            element.current.open = false;
        }}
      >
        {children}
      </div>
    </details>
  );
}
