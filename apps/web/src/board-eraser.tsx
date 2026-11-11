import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { eraserHits } from './board-eraser-geometry';
export default function BoardEraser({
  api,
  size,
  onExit,
}: {
  api: ExcalidrawImperativeAPI;
  size: number;
  onExit: () => void;
}) {
  const { t } = useTranslation(),
    last = useRef<{ x: number; y: number } | undefined>(undefined),
    [cursor, setCursor] = useState<{ x: number; y: number }>(),
    pressed = useRef(false);
  const move = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect(),
      x = event.clientX - box.left,
      y = event.clientY - box.top;
    setCursor({ x, y });
    const state = api.getAppState(),
      point = {
        x: (event.clientX - state.offsetLeft) / state.zoom.value - state.scrollX,
        y: (event.clientY - state.offsetTop) / state.zoom.value - state.scrollY,
      };
    if (pressed.current) {
      let changed = false;
      const elements = api.getSceneElements().map((element) => {
        if (!eraserHits(element, last.current ?? point, point, size / 2 / state.zoom.value))
          return element;
        changed = true;
        return {
          ...element,
          isDeleted: true,
          version: element.version + 1,
          versionNonce: Math.floor(Math.random() * 2147483647),
          updated: Date.now(),
        };
      });
      if (changed) api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    }
    last.current = point;
  };
  return (
    <div
      className="board-eraser-surface"
      role="application"
      tabIndex={0}
      aria-label={t('boardEraser')}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          pressed.current = false;
          onExit();
        }
      }}
      onPointerDown={(e) => {
        e.preventDefault();
        e.currentTarget.focus();
        e.currentTarget.setPointerCapture(e.pointerId);
        pressed.current = true;
        last.current = undefined;
        move(e);
      }}
      onPointerMove={move}
      onPointerUp={(e) => {
        move(e);
        pressed.current = false;
        last.current = undefined;
      }}
      onPointerCancel={() => {
        pressed.current = false;
        last.current = undefined;
      }}
      onPointerLeave={() => {
        if (!pressed.current) setCursor(undefined);
      }}
    >
      {cursor && (
        <span
          className="board-eraser-cursor"
          style={{ left: cursor.x, top: cursor.y, width: size, height: size }}
        />
      )}
    </div>
  );
}
