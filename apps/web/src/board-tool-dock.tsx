import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { changeBoardStyle } from './board-style';
import { useUserPreferences, updateUserPreferences } from './user-preferences';
import { userFontFamilies, type UserFontFamily } from '../../../packages/user-preferences';
import type { InkMode } from './board-ink';
export type BoardToolState = {
  tool: string;
  color: string;
  width: number;
  opacity: number;
  fontSize: number;
  fontFamily: number;
  textAlign: string;
  background: string;
};
const tools = [
  ['selection', 'boardSelect', 'M5 3 20 14l-7 1-3 7z'],
  ['pen', 'boardPen', 'm4 20 4-1L20 7l-3-3L5 16z'],
  ['pressurePen', 'boardPressurePen', 'm4 20 4-1L20 7l-3-3L5 16z M3 7v5 M1 10l2 2 2-2'],
  ['highlighter', 'boardHighlighter', 'm5 16 8-12 6 4-8 12z M3 21h10'],
  ['text', 'boardTextTool', 'M4 5h16 M12 5v15 M8 20h8'],
  ['eraser', 'boardEraser', 'm4 14 9-10 7 6-9 11H7z M9 9l7 6'],
  ['rectangle', 'boardRectangle', 'M4 5h16v14H4z'],
  ['ellipse', 'boardEllipse', 'M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0'],
  ['arrow', 'boardArrow', 'M4 20 20 4 M10 4h10v10'],
  ['line', 'boardLine', 'M4 20 20 4'],
  ['diamond', 'boardDiamond', 'm12 3 9 9-9 9-9-9z'],
  [
    'hand',
    'boardPan',
    'M6 12V7a2 2 0 0 1 4 0V4a2 2 0 0 1 4 0v3a2 2 0 0 1 4 0v5l2-2 2 2-5 9H9l-6-7 2-2 3 3',
  ],
] as const;
export function ExactNumber({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value)),
    committed = useRef(value);
  useEffect(() => {
    if (value !== committed.current) {
      setDraft(String(value));
      committed.current = value;
    }
  }, [value]);
  return (
    <label>
      {label}
      <div className="board-number-control">
        <input
          aria-label={label}
          type="number"
          min={min}
          max={max}
          step={step}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            const next = Number(event.target.value);
            if (event.target.value !== '' && Number.isFinite(next) && next >= min && next <= max) {
              committed.current = next;
              onChange(next);
            }
          }}
          onBlur={() => {
            const next = Number(draft);
            if (draft === '' || !Number.isFinite(next) || next < min || next > max)
              setDraft(String(value));
          }}
        />
        <input
          aria-label={label + ' — slider'}
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(event) => {
            const next = Number(event.target.value);
            setDraft(String(next));
            committed.current = next;
            onChange(next);
          }}
        />
      </div>
    </label>
  );
}
export default function BoardToolDock({
  api,
  state,
  onEraserChange,
  eraserActive = false,
  onInkModeChange,
}: {
  api: ExcalidrawImperativeAPI;
  state: BoardToolState;
  preferenceKey?: string;
  eraserActive?: boolean;
  onEraserChange: (active: boolean) => void;
  onInkModeChange: (mode: InkMode) => void;
}) {
  const { t } = useTranslation(),
    { preferences } = useUserPreferences(),
    [drawing, setDrawing] = useState<InkMode>('pen');
  const active = eraserActive ? 'eraser' : state.tool === 'freedraw' ? drawing : state.tool;
  useEffect(() => {
    if (eraserActive) return;
    const current = api.getAppState();
    if (state.tool === 'freedraw') {
      const profile = preferences.tools[drawing];
      if (
        current.currentItemStrokeColor !== profile.color ||
        current.currentItemStrokeWidth !== profile.width ||
        current.currentItemOpacity !== profile.opacity
      )
        api.updateScene({
          appState: {
            currentItemStrokeColor: profile.color,
            currentItemStrokeWidth: profile.width,
            currentItemOpacity: profile.opacity,
          },
        });
    } else if (state.tool === 'text') {
      const profile = preferences.tools.text;
      if (
        current.currentItemStrokeColor !== profile.color ||
        current.currentItemFontSize !== profile.fontSize ||
        current.currentItemFontFamily !== profile.fontFamily ||
        current.currentItemTextAlign !== profile.textAlign ||
        current.currentItemOpacity !== profile.opacity
      )
        api.updateScene({
          appState: {
            currentItemStrokeColor: profile.color,
            currentItemFontSize: profile.fontSize,
            currentItemFontFamily: profile.fontFamily,
            currentItemTextAlign: profile.textAlign,
            currentItemOpacity: profile.opacity,
          },
        });
    }
  }, [api, preferences.tools, state.tool, drawing, eraserActive]);
  const dock = useRef<HTMLElement>(null);
  useEffect(() => {
    const parent = dock.current?.parentElement;
    if (!parent) return;
    const resize = () =>
      dock.current?.style.setProperty(
        '--board-controls-height',
        Math.max(80, parent.clientHeight - 20) + 'px',
      );
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(parent);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        !target.closest?.('.advanced-board-canvas') ||
        target.closest('input,textarea,[contenteditable=true]')
      )
        return;
      const id: Record<string, string> = {
        p: 'pen',
        b: 'pressurePen',
        m: 'highlighter',
        t: 'text',
        e: 'eraser',
        v: 'selection',
        r: 'rectangle',
        o: 'ellipse',
        a: 'arrow',
        l: 'line',
        d: 'diamond',
        h: 'hand',
      };
      const tool = id[event.key.toLowerCase()];
      if (!tool) return;
      event.preventDefault();
      event.stopPropagation();
      dock.current?.querySelector<HTMLButtonElement>('[data-board-tool="' + tool + '"]')?.click();
    };
    window.addEventListener('keydown', shortcut, true);
    return () => window.removeEventListener('keydown', shortcut, true);
  }, []);
  const selectedText = api
    .getSceneElements()
    .find((element) => element.type === 'text' && api.getAppState().selectedElementIds[element.id]);
  const style = (value: Parameters<typeof changeBoardStyle>[1]) => {
    changeBoardStyle(api, value);
    if (active === 'pen' || active === 'pressurePen' || active === 'highlighter')
      updateUserPreferences({
        tools: {
          [active]: {
            ...(value.strokeColor ? { color: value.strokeColor } : {}),
            ...(value.strokeWidth !== undefined ? { width: value.strokeWidth } : {}),
            ...(value.opacity !== undefined ? { opacity: value.opacity } : {}),
          },
        },
      });
    if (active === 'text' || selectedText || value.fontSize || value.fontFamily || value.textAlign)
      updateUserPreferences({
        tools: {
          text: {
            ...(value.strokeColor ? { color: value.strokeColor } : {}),
            ...(value.opacity !== undefined ? { opacity: value.opacity } : {}),
            ...(value.fontSize ? { fontSize: value.fontSize } : {}),
            ...(value.fontFamily ? { fontFamily: value.fontFamily } : {}),
            ...(value.textAlign ? { textAlign: value.textAlign } : {}),
          },
        },
      });
  };
  return (
    <aside ref={dock} className="board-tool-dock" aria-label={t('boardAnnotationTools')}>
      <div
        className="board-tool-buttons"
        role="toolbar"
        aria-label={t('boardAnnotationTools')}
        aria-orientation="vertical"
      >
        {tools.map(([id, label, path]) => (
          <button
            key={id}
            data-board-tool={id}
            type="button"
            title={t(label)}
            aria-label={t(label)}
            aria-pressed={active === id}
            onClick={() => {
              onEraserChange(id === 'eraser');
              if (id === 'eraser') {
                api.setActiveTool({ type: 'selection' });
                return;
              }
              api.setActiveTool({
                type:
                  id === 'pen' || id === 'pressurePen' || id === 'highlighter' ? 'freedraw' : id,
              });
              if (id === 'pen' || id === 'pressurePen' || id === 'highlighter') {
                setDrawing(id);
                onInkModeChange(id);
                const p = preferences.tools[id];
                api.updateScene({
                  appState: {
                    currentItemStrokeColor: p.color,
                    currentItemStrokeWidth: p.width,
                    currentItemOpacity: p.opacity,
                    currentItemRoughness: 0,
                  },
                });
              }
              if (id === 'text') {
                const p = preferences.tools.text;
                api.updateScene({
                  appState: {
                    currentItemStrokeColor: p.color,
                    currentItemFontSize: p.fontSize,
                    currentItemFontFamily: p.fontFamily,
                    currentItemTextAlign: p.textAlign,
                    currentItemOpacity: p.opacity,
                  },
                });
              }
            }}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d={path} />
            </svg>
          </button>
        ))}
      </div>
      <details className="board-tool-options" open={eraserActive || undefined}>
        <summary title={t('boardToolStyle')} aria-label={t('boardToolStyle')}>
          <span style={{ backgroundColor: state.color }} />
        </summary>
        <div>
          {active === 'pressurePen' && (
            <>
              <small>{t('boardPressureHint')}</small>
              <ExactNumber
                label={t('boardPressureSensitivity')}
                value={preferences.tools.pressurePen.sensitivity}
                min={0.25}
                max={3}
                step={0.05}
                onChange={(sensitivity) =>
                  updateUserPreferences({ tools: { pressurePen: { sensitivity } } })
                }
              />
            </>
          )}
          {eraserActive ? (
            <ExactNumber
              label={t('boardEraserSize')}
              value={preferences.tools.eraserSize}
              min={2}
              max={200}
              onChange={(eraserSize) => updateUserPreferences({ tools: { eraserSize } })}
            />
          ) : (
            <>
              <label>
                {t('boardInkColor')}
                <input
                  aria-label={t('boardInkColor')}
                  type="color"
                  value={selectedText?.strokeColor ?? state.color}
                  onChange={(e) => style({ strokeColor: e.target.value })}
                />
              </label>
              <ExactNumber
                label={t('boardStrokeWidth')}
                value={state.width}
                min={0.1}
                max={100}
                step={0.1}
                onChange={(strokeWidth) => style({ strokeWidth })}
              />
              <ExactNumber
                label={t('boardOpacity')}
                value={state.opacity}
                min={1}
                max={100}
                onChange={(opacity) => style({ opacity })}
              />
              <ExactNumber
                label={t('boardFontSize')}
                value={selectedText?.type === 'text' ? selectedText.fontSize : state.fontSize}
                min={8}
                max={256}
                step={0.5}
                onChange={(fontSize) => style({ fontSize })}
              />
              <label>
                {t('boardFontFamily')}
                <select
                  aria-label={t('boardFontFamily')}
                  value={selectedText?.type === 'text' ? selectedText.fontFamily : state.fontFamily}
                  onChange={(e) => style({ fontFamily: Number(e.target.value) as UserFontFamily })}
                >
                  {userFontFamilies.map((id) => (
                    <option key={id} value={id}>
                      {t('annotationFont_' + id)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('boardTextAlign')}
                <select
                  aria-label={t('boardTextAlign')}
                  value={selectedText?.type === 'text' ? selectedText.textAlign : state.textAlign}
                  onChange={(e) =>
                    style({ textAlign: e.target.value as 'left' | 'center' | 'right' })
                  }
                >
                  {['left', 'center', 'right'].map((id) => (
                    <option key={id} value={id}>
                      {t('annotationTextAlign_' + id)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t('boardBackgroundColor')}
                <input
                  aria-label={t('boardBackgroundColor')}
                  type="color"
                  value={state.background}
                  onChange={(e) =>
                    api.updateScene({ appState: { viewBackgroundColor: e.target.value } })
                  }
                />
              </label>
            </>
          )}
        </div>
      </details>
    </aside>
  );
}
