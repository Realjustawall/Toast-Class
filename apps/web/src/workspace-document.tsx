import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as Y from 'yjs';
import { request } from './api';
import { useClassroomEvents } from './live';
import { FormattedText } from './formatted-text';
import RichTextEditor from './rich-text-editor';
import OverflowMenu from './overflow-menu';
import {
  useClassroomDownloads,
  DownloadToggle,
  authorizeBoardDownload,
} from './classroom-downloads';
type DocInfo = { id: string; name: string; kind: 'notes' | 'board'; teacher_only: boolean };
type Shape = {
  type: 'pen' | 'rectangle' | 'ellipse' | 'text';
  points: [number, number][];
  color: string;
  text?: string;
};
type Update = { id: string; update: string };
const encode = (b: Uint8Array) => btoa(Array.from(b, (v) => String.fromCharCode(v)).join(''));
const decode = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export default function CollaborativeDocument({
  roomId,
  document: info,
  readOnly,
  userId,
}: {
  roomId: string;
  document: DocInfo;
  readOnly: boolean;
  userId: string;
}) {
  const { t } = useTranslation();
  const downloads = useClassroomDownloads(info.kind === 'board' ? roomId : undefined),
    [exporting, setExporting] = useState(false),
    exportAbort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => exportAbort.current?.abort(), []);
  useEffect(() => {
    if (downloads.ready && info.kind === 'board' && !downloads.canDownload('board', info.id))
      exportAbort.current?.abort();
  }, [downloads.ready, downloads.canDownload('board', info.id), info.id]);
  const [ydoc] = useState(() => new Y.Doc());
  const [text, setText] = useState('');
  const [shapes, setShapes] = useState<[string, Shape][]>([]);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const [preview, setPreview] = useState(false);
  const [tool, setTool] = useState<Shape['type'] | 'erase' | 'pan'>('pen');
  const [color, setColor] = useState('#292c29');
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });
  const [draft, setDraft] = useState<Shape>();
  const svg = useRef<SVGSVGElement>(null);
  const queue = useRef<Update[]>([]);
  const sending = useRef(false);
  const flushWaiters = useRef<(() => void)[]>([]);
  const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const seen = useRef(new Set<string>());
  const base = '/classrooms/' + roomId + '/documents/' + info.id;
  const undo = useRef<Y.UndoManager | null>(null);
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | undefined>(undefined);
  const cacheKey = 'toaster-outbox:' + userId + ':' + info.id;
  const restored = useRef(false);
  const persist = () => {
    try {
      if (queue.current.length) localStorage.setItem(cacheKey, JSON.stringify(queue.current));
      else localStorage.removeItem(cacheKey);
    } catch {
      setError(t('outboxError'));
    }
  };
  const ytext = ydoc.getText('content');
  const board = ydoc.getMap<Shape>('shapes');
  async function flush() {
    if (sending.current) return new Promise<void>((resolve) => flushWaiters.current.push(resolve));
    if (!queue.current.length) return;
    sending.current = true;
    try {
      while (queue.current.length && mounted.current) {
        const item = queue.current[0];
        await request(base + '/updates', item, { silent: true });
        seen.current.add(item.id);
        queue.current.shift();
        persist();
        if (mounted.current) {
          setPending(queue.current.length);
          setError('');
        }
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      sending.current = false;
      for (const resolve of flushWaiters.current.splice(0)) resolve();
    }
  }
  async function sync() {
    try {
      const result = await request<{ updates: { id: string; update_base64: string }[] }>(base);
      if (!mounted.current) return;
      for (const update of result.updates) {
        if (!seen.current.has(update.id)) {
          Y.applyUpdate(ydoc, decode(update.update_base64), 'remote');
          seen.current.add(update.id);
        }
      }
      if (!restored.current) {
        restored.current = true;
        try {
          const cached = JSON.parse(localStorage.getItem(cacheKey) ?? '[]') as Update[];
          if (Array.isArray(cached))
            for (const u of cached) {
              if (
                typeof u.id === 'string' &&
                typeof u.update === 'string' &&
                !seen.current.has(u.id)
              ) {
                Y.applyUpdate(ydoc, decode(u.update), 'remote');
                queue.current.push(u);
              }
            }
          setPending(queue.current.length);
          persist();
        } catch {
          setError(t('outboxError'));
        }
      }
      setLoaded(true);
      await flush();
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    }
  }
  useClassroomEvents(
    roomId,
    (events) => {
      const ev = events?.find((e) => e.type === 'document_changed');
      if (
        events?.length === 1 &&
        ev &&
        ev.documentId === info.id &&
        typeof ev.updateId === 'string' &&
        typeof ev.update === 'string'
      ) {
        if (!seen.current.has(ev.updateId)) {
          Y.applyUpdate(ydoc, decode(ev.update), 'remote');
          seen.current.add(ev.updateId);
        }
        return;
      }
      void sync();
    },
    ['document_changed'],
  );
  useEffect(() => {
    mounted.current = true;
    undo.current = new Y.UndoManager([ytext, board], { trackedOrigins: new Set(['local']) });
    const changed = () => {
      setText(ytext.toString());
      setShapes(Array.from(board.entries()));
    };
    const update = (bytes: Uint8Array, origin: unknown) => {
      changed();
      if (origin === 'local' || origin === undo.current) {
        queue.current.push({ id: crypto.randomUUID(), update: encode(bytes) });
        persist();
        setPending(queue.current.length);
        clearTimeout(debounce.current);
        debounce.current = setTimeout(() => void flush(), 30);
      }
    };
    ydoc.on('update', update);
    void sync();
    const retry = setInterval(() => void flush(), 3000);
    const beforeUnload = (e: BeforeUnloadEvent) => {
      if (queue.current.length) e.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      mounted.current = false;
      clearInterval(retry);
      clearTimeout(debounce.current);
      window.removeEventListener('beforeunload', beforeUnload);
      ydoc.off('update', update);
      undo.current?.destroy();
    };
  }, [ydoc]);
  const point = (e: React.PointerEvent<SVGSVGElement>): [number, number] => {
    const p = svg.current!.createSVGPoint();
    p.x = e.clientX;
    p.y = e.clientY;
    const local = p.matrixTransform(svg.current!.getScreenCTM()!.inverse());
    return [(local.x - view.x) / view.scale, (local.y - view.y) / view.scale];
  };
  function saveShape(shape: Shape) {
    ydoc.transact(() => board.set(crypto.randomUUID(), shape), 'local');
  }
  function updateText(next: string) {
    const old = ytext.toString();
    let start = 0,
      end = 0;
    while (start < old.length && start < next.length && old[start] === next[start]) start++;
    while (
      end < old.length - start &&
      end < next.length - start &&
      old[old.length - 1 - end] === next[next.length - 1 - end]
    )
      end++;
    ydoc.transact(() => {
      if (old.length - start - end) ytext.delete(start, old.length - start - end);
      const inserted = next.slice(start, next.length - end);
      if (inserted) ytext.insert(start, inserted);
    }, 'local');
  }
  async function download(format: 'svg' | 'pdf' = 'svg') {
    if (exportAbort.current) return;
    setError('');
    const controller = (exportAbort.current = new AbortController());
    setExporting(true);
    try {
      if (info.kind === 'notes') {
        const blob = new Blob([ytext.toString()], { type: 'text/markdown;charset=utf-8' });
        save(blob, '.md');
      } else {
        await authorizeBoardDownload(roomId, info.id, format, controller.signal);
        if (format === 'pdf') {
          await flush();
          if (queue.current.length) throw Error(t('saving'));
          const { legacyBoardPdf } = await import('./legacy-board-pdf');
          const blob = await legacyBoardPdf(svg.current!, controller.signal);
          await authorizeBoardDownload(roomId, info.id, format, controller.signal);
          controller.signal.throwIfAborted();
          save(blob, '.pdf');
          return;
        }
        const clone = svg.current!.cloneNode(true) as SVGSVGElement;
        clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
        clone.querySelectorAll('[data-draft]').forEach((n) => n.remove());
        const blob = new Blob([new XMLSerializer().serializeToString(clone)], {
          type: 'image/svg+xml',
        });
        await authorizeBoardDownload(roomId, info.id, 'svg', controller.signal);
        controller.signal.throwIfAborted();
        save(blob, '.svg');
      }
    } catch (e) {
      if (!controller.signal.aborted && mounted.current) setError((e as Error).message);
    } finally {
      exportAbort.current = undefined;
      if (mounted.current) setExporting(false);
    }
  }
  function save(blob: Blob, suffix: string) {
    const url = URL.createObjectURL(blob);
    const a = window.document.createElement('a');
    a.href = url;
    a.download = info.name + suffix;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  const render = (s: Shape, id: string) => {
    const a = s.points[0];
    const b = s.points[s.points.length - 1];
    if (!a || !b) return null;
    const common = {
      stroke: s.color,
      strokeWidth: 3,
      fill: 'none',
      onPointerDown: (e: React.PointerEvent) => {
        if (tool === 'erase' && !readOnly) {
          e.stopPropagation();
          ydoc.transact(() => board.delete(id), 'local');
        }
      },
    };
    return s.type === 'text' ? (
      <text
        key={id}
        x={a[0]}
        y={a[1]}
        fill={s.color}
        fontSize={24}
        style={{ whiteSpace: 'pre' }}
        onPointerDown={common.onPointerDown}
      >
        {s.text}
      </text>
    ) : s.type === 'pen' ? (
      <polyline key={id} {...common} points={s.points.map((p) => p.join(',')).join(' ')} />
    ) : s.type === 'rectangle' ? (
      <rect
        key={id}
        {...common}
        x={Math.min(a[0], b[0])}
        y={Math.min(a[1], b[1])}
        width={Math.abs(a[0] - b[0])}
        height={Math.abs(a[1] - b[1])}
      />
    ) : (
      <ellipse
        key={id}
        {...common}
        cx={(a[0] + b[0]) / 2}
        cy={(a[1] + b[1]) / 2}
        rx={Math.abs(a[0] - b[0]) / 2}
        ry={Math.abs(a[1] - b[1]) / 2}
      />
    );
  };
  return (
    <section className="document-editor">
      <header>
        <h2>{info.name}</h2>
        <span role="status">{t(!loaded ? 'loading' : pending ? 'saving' : 'saved')}</span>
        {info.kind === 'board' && (
          <>
            <DownloadToggle state={downloads} kind="board" targetId={info.id} name={info.name} />
            <button
              disabled={!loaded || exporting || !downloads.canDownload('board', info.id)}
              onClick={() => void download('pdf')}
            >
              {t('boardDownloadPdf')}
            </button>
          </>
        )}
        <OverflowMenu>
          {info.kind === 'notes' && (
            <button aria-pressed={preview} onClick={() => setPreview(!preview)}>
              {t(preview ? 'editNotes' : 'previewNotes')}
            </button>
          )}
          <button
            disabled={
              exporting || (info.kind === 'board' && !downloads.canDownload('board', info.id))
            }
            onClick={() => void download()}
          >
            {t(info.kind === 'notes' ? 'exportMarkdown' : 'exportSvg')}
          </button>
        </OverflowMenu>
      </header>
      {readOnly && <p className="notice-light">{t('readOnly')}</p>}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {info.kind === 'board' && (
        <div className="board-toolbar">
          <button disabled={readOnly || !loaded} onClick={() => undo.current?.undo()}>
            {t('undo')}
          </button>
          <button disabled={readOnly || !loaded} onClick={() => undo.current?.redo()}>
            {t('redo')}
          </button>
          {info.kind === 'board' && (
            <>
              {(['pen', 'rectangle', 'ellipse', 'text', 'erase', 'pan'] as const).map((v) => (
                <button key={v} aria-pressed={tool === v} onClick={() => setTool(v)}>
                  {t(v)}
                </button>
              ))}
              <label>
                {t('color')}
                <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
              </label>
              <button
                onClick={() => setView((v) => ({ ...v, scale: Math.min(4, v.scale * 1.25) }))}
                aria-label={t('zoomIn')}
              >
                +
              </button>
              <button
                onClick={() => setView((v) => ({ ...v, scale: Math.max(0.2, v.scale / 1.25) }))}
                aria-label={t('zoomOut')}
              >
                −
              </button>
              <button onClick={() => setView({ x: 0, y: 0, scale: 1 })}>{t('resetView')}</button>
            </>
          )}
        </div>
      )}
      {info.kind === 'notes' ? (
        <>
          {preview ? (
            <div className="shared-notes-preview">
              <FormattedText text={text} />
            </div>
          ) : (
            <RichTextEditor
              label={t('notes')}
              value={text}
              onChange={updateText}
              disabled={!loaded || readOnly}
              maxLength={10000}
              onUndo={() => undo.current?.undo()}
              onRedo={() => undo.current?.redo()}
            />
          )}
        </>
      ) : (
        <svg
          ref={svg}
          className="whiteboard"
          viewBox="0 0 1000 650"
          role="img"
          aria-label={t('board')}
          onPointerDown={(e) => {
            if (!loaded) return;
            if (tool === 'pan') {
              pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
              e.currentTarget.setPointerCapture(e.pointerId);
              return;
            }
            if (readOnly || tool === 'erase') return;
            const p = point(e);
            if (tool === 'text') {
              const text = window.prompt(t('text'));
              if (text && text.length <= 500) saveShape({ type: 'text', points: [p], color, text });
              return;
            }
            e.currentTarget.setPointerCapture(e.pointerId);
            setDraft({ type: tool, points: [p], color });
          }}
          onPointerMove={(e) => {
            if (pan.current) {
              const ratio = 1000 / e.currentTarget.getBoundingClientRect().width;
              setView((v) => ({
                ...v,
                x: pan.current!.vx + (e.clientX - pan.current!.x) * ratio,
                y: pan.current!.vy + (e.clientY - pan.current!.y) * ratio,
              }));
            } else if (draft) {
              const p = point(e);
              setDraft((s) =>
                s
                  ? {
                      ...s,
                      points: s.type === 'pen' ? [...s.points.slice(-255), p] : [s.points[0], p],
                    }
                  : s,
              );
            }
          }}
          onPointerUp={() => {
            pan.current = undefined;
            if (draft && !readOnly) {
              saveShape(draft);
              setDraft(undefined);
            }
          }}
          onPointerCancel={() => {
            pan.current = undefined;
            setDraft(undefined);
          }}
        >
          <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
            {shapes.map(([id, s]) => render(s, id))}
            {draft && <g data-draft="true">{render(draft, 'draft')}</g>}
          </g>
        </svg>
      )}
    </section>
  );
}
