import { useTranslation } from 'react-i18next';

/** Inline feedback only. Classroom transitions never block the page or mount the intro. */
export default function ClassroomLoading({
  error,
  onRetry,
  onLeave,
}: {
  error?: string;
  onRetry?: () => void;
  onLeave?: () => void;
  overlay?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <section className="classroom-inline-state" aria-busy={!error}>
      <p role={error ? 'alert' : 'status'}>{error || t('classroomPreparingDetail')}</p>
      <div>
        {error && onRetry && <button onClick={onRetry}>{t('retry')}</button>}
        {onLeave && <button onClick={onLeave}>{t('leave')}</button>}
      </div>
    </section>
  );
}
