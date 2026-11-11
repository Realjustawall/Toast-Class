import { useEffect, type RefObject } from 'react';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { inkPressure, type InkMode } from '../../../packages/whiteboard/ink';
export type { InkMode } from '../../../packages/whiteboard/ink';
/** Keep the native editor's gestures and undo history. Excalidraw treats exactly
 * 0.5 on pointer-down as a request to simulate pressure; offset that sentinel
 * by one millionth so real stylus samples (including a 0.5 start) stay enabled. */
export function useBoardInk(
  api: ExcalidrawImperativeAPI | undefined,
  canvas: RefObject<HTMLDivElement | null>,
  enabled: boolean,
  mode: InkMode,
  sensitivity: number,
) {
  useEffect(() => {
    if (!api || !canvas.current || !enabled) return;
    const active = new Set<number>(),
      transformed = new WeakSet<PointerEvent>();
    const transform = (event: PointerEvent) => {
      if (transformed.has(event)) return;
      transformed.add(event);
      const value = inkPressure(mode, event.pressure, event.pointerType, sensitivity);
      Object.defineProperty(event, 'pressure', {
        configurable: true,
        value: value === 0.5 ? 0.500001 : value,
      });
    };
    const handle = (event: PointerEvent) => {
      if (event.type === 'pointerdown') {
        if (
          event.button !== 0 ||
          !(event.target instanceof HTMLCanvasElement) ||
          !event.target.classList.contains('interactive') ||
          !canvas.current?.contains(event.target)
        )
          return;
        active.add(event.pointerId);
      }
      if (!active.has(event.pointerId)) return;
      const coalesced = event.getCoalescedEvents?.();
      if (coalesced?.length) {
        for (const sample of coalesced) transform(sample);
        Object.defineProperty(event, 'getCoalescedEvents', {
          configurable: true,
          value: () => coalesced,
        });
      }
      transform(event);
      if (event.type === 'pointerup' || event.type === 'pointercancel')
        active.delete(event.pointerId);
    };
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const)
      window.addEventListener(type, handle, true);
    return () => {
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel'] as const)
        window.removeEventListener(type, handle, true);
      active.clear();
    };
  }, [api, canvas, enabled, mode, sensitivity]);
}
