import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
  type SetStateAction,
} from 'react';
import { useTranslation } from 'react-i18next';
import type { ClassroomTheme } from './classroom-types';
import ClassIcon from './classroom-icons';
import ApplicationSettings from './application-settings';
import { useUserPreferences, updateUserPreferences } from './user-preferences';

export type LayoutPanel = 'people' | 'chat' | 'media' | 'stage';
type Sizes = {
  people: number;
  chat: number;
  mediaHeight: number;
  mediaWidth: number;
  text: number;
};
const defaults: Sizes = { people: 300, chat: 320, mediaHeight: 160, mediaWidth: 240, text: 15 };
const clamp = (n: number, min: number, max: number) =>
  Math.min(Math.max(n, min), Math.max(min, max));

export function useClassroomPanelLayout(theme: ClassroomTheme, rtl: boolean) {
  const { t } = useTranslation();
  const { preferences: personalPreferences } = useUserPreferences();
  const key = 'classroom-panel-layout-v3:' + theme;
  const readSizes = () => {
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? '{}');
      return Object.fromEntries(
        Object.entries(defaults).map(([name, fallback]) => [
          name,
          typeof saved[name] === 'number' && Number.isFinite(saved[name])
            ? clamp(saved[name], name === 'text' ? 12 : 80, name === 'text' ? 22 : 460)
            : fallback,
        ]),
      ) as Sizes;
    } catch {
      return { ...defaults };
    }
  };
  const [sizes, setLocalSizes] = useState<Sizes>(readSizes);
  const sizesRef = useRef(sizes);
  sizesRef.current = sizes;
  const setSizes = (value: SetStateAction<Sizes>) => {
    const next = typeof value === 'function' ? value(sizesRef.current) : value;
    if (
      Object.keys(defaults).every(
        (key) => next[key as keyof Sizes] === sizesRef.current[key as keyof Sizes],
      )
    )
      return;
    sizesRef.current = next;
    setLocalSizes(next);
    updateUserPreferences({ layouts: { [theme]: next } });
  };
  useEffect(() => {
    const saved = personalPreferences.layouts[theme];
    if (saved) {
      sizesRef.current = saved;
      setLocalSizes(saved);
    }
  }, [theme, personalPreferences.layouts[theme]]);
  const previousTheme = useRef(theme);
  useEffect(() => {
    if (previousTheme.current !== theme) {
      previousTheme.current = theme;
      const next = personalPreferences.layouts[theme] ?? readSizes();
      sizesRef.current = next;
      setLocalSizes(next);
      setExpanded(null);
    }
  }, [theme]);
  const [expanded, setExpanded] = useState<LayoutPanel | null>(null);
  const nativePanel = useRef<LayoutPanel | null>(null);
  const toggleExpanded = async (panel: LayoutPanel) => {
    if (expanded === panel) {
      if (nativePanel.current && document.fullscreenElement)
        await document.exitFullscreen().catch(() => {});
      nativePanel.current = null;
      setExpanded(null);
      return;
    }
    const element = document.querySelector<HTMLElement>(
      '.classroom-shell [data-layout-panel="' + panel + '"]',
    );
    setExpanded(panel);
    if (element?.requestFullscreen) {
      try {
        await element.requestFullscreen();
        nativePanel.current = panel;
      } catch {
        nativePanel.current = null;
      }
    }
  };
  useEffect(() => {
    const changed = () => {
      if (nativePanel.current && !document.fullscreenElement) {
        nativePanel.current = null;
        setExpanded(null);
      }
    };
    document.addEventListener('fullscreenchange', changed);
    return () => document.removeEventListener('fullscreenchange', changed);
  }, []);
  const drag = useRef<{ panel: LayoutPanel; edge: string; start: number; size: number } | null>(
    null,
  );
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(sizes));
    } catch {}
  }, [key, sizes]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(null);
    };
    const resize = () =>
      setSizes((current) => {
        const budget = window.innerWidth - 424;
        if (window.innerWidth < 1100 || current.people + current.chat <= budget) return current;
        const people = clamp(
          (current.people * budget) / (current.people + current.chat),
          220,
          budget - 220,
        );
        return { ...current, people, chat: Math.max(220, budget - people) };
      });
    window.addEventListener('keydown', escape);
    window.addEventListener('resize', resize);
    resize();
    return () => {
      window.removeEventListener('keydown', escape);
      window.removeEventListener('resize', resize);
    };
  }, [theme]);
  const horizontalMedia =
    (theme === 'modular-skyroom' || theme === 'immersive-glass') && window.innerWidth >= 1100;
  const field = (panel: LayoutPanel): keyof Sizes =>
    panel === 'media'
      ? horizontalMedia
        ? 'mediaWidth'
        : 'mediaHeight'
      : panel === 'stage'
        ? 'text'
        : theme === 'modular-skyroom' && panel === 'chat'
          ? 'people'
          : panel;
  const range = (panel: LayoutPanel, current = sizes) => {
    const name = field(panel);
    const max =
      name === 'mediaHeight'
        ? Math.min(420, window.innerHeight * (window.innerWidth < 1100 ? 0.32 : 0.4))
        : theme === 'modular-skyroom'
          ? window.innerWidth - (name === 'mediaWidth' ? current.people : current.mediaWidth) - 432
          : theme === 'immersive-glass'
            ? 460
            : window.innerWidth - 424 - (panel === 'people' ? current.chat : current.people);
    const min = name === 'mediaHeight' ? 80 : name === 'mediaWidth' ? 160 : 220;
    return { min, max: Math.max(min, Math.min(460, max)) };
  };
  const change = (panel: LayoutPanel, value: number) =>
    setSizes((current) => {
      const name = field(panel);
      if (name === 'text') return current;
      const limits = range(panel, current);
      const next = clamp(value, limits.min, limits.max);
      return theme === 'modular-skyroom' && (panel === 'people' || panel === 'chat')
        ? { ...current, people: next, chat: next }
        : { ...current, [name]: next };
    });
  const label = (panel: LayoutPanel) =>
    t(
      panel === 'people'
        ? 'participants'
        : panel === 'chat'
          ? 'chat'
          : panel === 'media'
            ? 'classroomGallery'
            : 'classroomStage',
    );
  const edge = (panel: LayoutPanel) => {
    if (panel === 'media' && !horizontalMedia) return theme === 'studio-hybrid' ? 'top' : 'bottom';
    const atStart = panel === 'media' || (theme === 'studio-hybrid' && panel === 'chat');
    return atStart !== rtl ? 'left' : 'right';
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>, panel: LayoutPanel) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const side = edge(panel);
    drag.current = {
      panel,
      edge: side,
      start: side === 'top' || side === 'bottom' ? event.clientY : event.clientX,
      size: sizes[field(panel)],
    };
  };
  const separator = (panel: LayoutPanel) => {
    if (panel === 'stage' || expanded) return null;
    const side = edge(panel);
    const vertical = side === 'left' || side === 'right';
    return (
      <div
        className={'classroom-panel-resizer is-' + side}
        role="separator"
        tabIndex={0}
        aria-label={t('panelResize') + ': ' + label(panel)}
        aria-orientation={vertical ? 'vertical' : 'horizontal'}
        aria-valuenow={Math.round(sizes[field(panel)])}
        aria-valuemin={range(panel).min}
        aria-valuemax={Math.round(range(panel).max)}
        onDoubleClick={() => change(panel, defaults[field(panel)])}
        onPointerDown={(event) => pointerDown(event, panel)}
        onPointerMove={(event) => {
          const current = drag.current;
          if (!current || current.panel !== panel) return;
          const position = vertical ? event.clientX : event.clientY;
          change(
            panel,
            current.size +
              (position - current.start) * (side === 'left' || side === 'top' ? -1 : 1),
          );
        }}
        onPointerUp={(event) => {
          drag.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onLostPointerCapture={() => {
          drag.current = null;
        }}
        onKeyDown={(event) => {
          const amount = ['ArrowRight', 'ArrowDown'].includes(event.key)
            ? 16
            : ['ArrowLeft', 'ArrowUp'].includes(event.key)
              ? -16
              : 0;
          if (!amount) return;
          event.preventDefault();
          change(
            panel,
            sizes[field(panel)] + amount * (side === 'left' || side === 'top' ? -1 : 1),
          );
        }}
      />
    );
  };
  const controls = (panel: LayoutPanel) => (
    <div className="classroom-panel-tools" role="group" aria-label={label(panel)}>
      {panel !== 'stage' && (
        <>
          <button
            title={t('panelSmaller')}
            disabled={sizes[field(panel)] <= range(panel).min}
            aria-label={t('panelSmaller') + ': ' + label(panel)}
            onClick={() => change(panel, sizes[field(panel)] - 32)}
          >
            −
          </button>
          <button
            title={t('panelLarger')}
            disabled={sizes[field(panel)] >= range(panel).max}
            aria-label={t('panelLarger') + ': ' + label(panel)}
            onClick={() => change(panel, sizes[field(panel)] + 32)}
          >
            +
          </button>
        </>
      )}
      <button
        title={t(expanded === panel ? 'panelRestore' : 'panelExpand')}
        aria-label={t(expanded === panel ? 'panelRestore' : 'panelExpand') + ': ' + label(panel)}
        aria-pressed={expanded === panel}
        onClick={() => void toggleExpanded(panel)}
      >
        <ClassIcon name="expand" size={16} />
      </button>
    </div>
  );
  const preferences = (
    <ApplicationSettings>
      <label>
        {t('classroomTextSize')}
        <select
          aria-label={t('classroomTextSize')}
          value={sizes.text}
          onChange={(event) =>
            setSizes((current) => ({ ...current, text: Number(event.target.value) }))
          }
        >
          {[12, 14, 16, 18, 20, 22].map((size) => (
            <option key={size} value={size}>
              {size}
            </option>
          ))}
        </select>
      </label>
      <button
        onClick={() => {
          setSizes(defaults);
          setExpanded(null);
        }}
      >
        {t('resetLayout')}
      </button>
    </ApplicationSettings>
  );
  return {
    expanded,
    collapse: () => setExpanded(null),
    resize: change,
    controls,
    separator,
    preferences,
    style: {
      '--preferred-people': sizes.people + 'px',
      '--preferred-chat': sizes.chat + 'px',
      '--preferred-media-height': sizes.mediaHeight + 'px',
      '--preferred-media-width': sizes.mediaWidth + 'px',
      '--classroom-font-size': sizes.text + 'px',
    } as CSSProperties,
  };
}
