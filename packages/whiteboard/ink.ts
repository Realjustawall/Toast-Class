export type InkMode = 'pen' | 'pressurePen' | 'highlighter';
export function inkPressure(
  mode: InkMode,
  pressure: number,
  pointerType: string,
  sensitivity: number,
) {
  const curve = Math.max(0.25, Math.min(3, Number.isFinite(sensitivity) ? sensitivity : 1));
  return mode === 'pressurePen' && (pointerType === 'pen' || pointerType === 'touch')
    ? Math.pow(Math.max(0, Math.min(1, Number.isFinite(pressure) ? pressure : 0.5)), 1 / curve)
    : 0.5;
}
