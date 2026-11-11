import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CaptureUpdateAction, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type {
  ExcalidrawElement,
  ExcalidrawTextElement,
} from '@excalidraw/excalidraw/element/types';
import { uploadBoardAsset } from './board-assets';
import { request } from './api';
import type { BoardPage } from './board-page-background';
import { changeBoardStyle } from './board-style';
import { cloneAnnotations as clone } from './annotation-elements';
type Stamp = { id: string; name: string; elements: ExcalidrawElement[] };
type Measurement = { pixelsPerUnit: number; unit: 'px' | 'mm' | 'cm' | 'm' | 'in' | 'ft' };
const revised = (element: ExcalidrawElement, changes: object) =>
  ({
    ...element,
    ...changes,
    version: element.version + 1,
    versionNonce: Math.floor(Math.random() * 2147483647),
    updated: Date.now(),
  }) as ExcalidrawElement;

export default function BoardAnnotationTools({
  api,
  roomId,
  page,
  settings,
  onSettings,
}: {
  api: ExcalidrawImperativeAPI;
  roomId: string;
  page: BoardPage;
  settings: () => Record<string, unknown>;
  onSettings: (value: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useTranslation(),
    [open, setOpen] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [text, setText] = useState(''),
    [stamps, setStamps] = useState<Stamp[]>([]),
    [scale, setScale] = useState<Measurement>({ pixelsPerUnit: 1, unit: 'px' }),
    [fill, setFill] = useState('#fff6c2'),
    [chosenIds, setChosenIds] = useState<string[] | null>(null),
    [annotationSearch, setAnnotationSearch] = useState(''),
    [annotationLimit, setAnnotationLimit] = useState(100),
    dialog = useRef<HTMLDialogElement>(null),
    input = useRef<HTMLInputElement>(null),
    abort = useRef(new AbortController());
  useEffect(() => {
    const controller = new AbortController();
    abort.current = controller;
    return () => controller.abort();
  }, []);
  useEffect(() => {
    if (!open) return;
    if (!dialog.current?.open) dialog.current?.showModal();
    const measurement = settings().measurement as Measurement | undefined;
    if (measurement) setScale(measurement);
    void request<Stamp[]>('/classrooms/' + roomId + '/annotation-stamps')
      .then(setStamps)
      .catch((e) => setError(e.message));
  }, [open]);
  const selected = () => {
    const ids = chosenIds ? new Set(chosenIds) : null;
    return api
      .getSceneElements()
      .filter(
        (element) =>
          (ids ? ids.has(element.id) : api.getAppState().selectedElementIds[element.id]) &&
          !element.isDeleted &&
          !element.id.startsWith('background_'),
      );
  };
  const center = () => {
    const state = api.getAppState();
    return {
      x: state.width / (2 * state.zoom.value) - state.scrollX,
      y: state.height / (2 * state.zoom.value) - state.scrollY,
    };
  };
  const style = (value: Parameters<typeof changeBoardStyle>[1]) =>
    changeBoardStyle(api, value, chosenIds ?? undefined);
  const update = (elements: readonly ExcalidrawElement[], selection?: Record<string, true>) =>
    api.updateScene({
      elements,
      appState: { selectedElementIds: selection ?? api.getAppState().selectedElementIds },
      captureUpdate: CaptureUpdateAction.IMMEDIATELY,
    });
  const insert = (elements: ExcalidrawElement[]) => {
    update(
      [...api.getSceneElements(), ...elements],
      Object.fromEntries(elements.map((element) => [element.id, true])),
    );
    api.setActiveTool({ type: 'selection' });
    setOpen(false);
  };
  const label = (value: string, kind = 'stamp') => {
    const { x, y } = center();
    insert(
      convertToExcalidrawElements([
        {
          type: 'text',
          x,
          y,
          text: value,
          fontSize: kind === 'note' ? 20 : 32,
          fontFamily: 2,
          strokeColor: api.getAppState().currentItemStrokeColor,
          customData: { annotationKind: kind },
        },
      ]),
    );
  };
  const selectionAction = (kind: string) => {
    const items = selected(),
      ids = new Set(items.map((element) => element.id));
    if (!items.length) {
      setError(t('annotationSelectFirst'));
      return;
    }
    const unlocked = items.filter((element) => !element.locked),
      group = crypto.randomUUID(),
      left = Math.min(...items.map((element) => element.x)),
      right = Math.max(...items.map((element) => element.x + element.width)),
      top = Math.min(...items.map((element) => element.y)),
      bottom = Math.max(...items.map((element) => element.y + element.height));
    if (kind === 'duplicate') {
      insert(clone(items));
      return;
    }
    if (kind === 'front' || kind === 'back') {
      const others = api.getSceneElements().filter((element) => !ids.has(element.id));
      update(
        (kind === 'front' ? [...others, ...items] : [...items, ...others]).map((element) =>
          revised(element, { index: null }),
        ),
      );
      setOpen(false);
      return;
    }
    update(
      api.getSceneElements().map((element) => {
        if (!ids.has(element.id)) return element;
        if (element.locked && kind !== 'unlock') return element;
        return revised(
          element,
          kind === 'delete'
            ? { isDeleted: true }
            : kind === 'lock'
              ? { locked: true }
              : kind === 'unlock'
                ? { locked: false }
                : kind === 'group'
                  ? { groupIds: [...element.groupIds, group] }
                  : kind === 'ungroup'
                    ? { groupIds: [] }
                    : kind === 'left'
                      ? { x: left }
                      : kind === 'right'
                        ? { x: right - element.width }
                        : kind === 'top'
                          ? { y: top }
                          : kind === 'bottom'
                            ? { y: bottom - element.height }
                            : kind === 'center'
                              ? { x: (left + right - element.width) / 2 }
                              : { y: (top + bottom - element.height) / 2 },
        );
      }),
    );
    if (!unlocked.length && kind !== 'unlock') setError(t('annotationSelectionLocked'));
    else setOpen(false);
  };
  const measure = async (kind: 'length' | 'area') => {
    const items = selected();
    if (items.length !== 1) throw Error(t('annotationSelectFirst'));
    const element = items[0];
    let value = 0;
    if (kind === 'length') {
      if (element.type === 'line' || element.type === 'arrow' || element.type === 'freedraw')
        for (let i = 1; i < element.points.length; i++)
          value += Math.hypot(
            element.points[i][0] - element.points[i - 1][0],
            element.points[i][1] - element.points[i - 1][1],
          );
      else if (element.type === 'ellipse') {
        const a = element.width / 2,
          b = element.height / 2;
        value = Math.PI * (3 * (a + b) - Math.sqrt((3 * a + b) * (a + 3 * b)));
      } else value = 2 * (element.width + element.height);
      value /= scale.pixelsPerUnit;
    } else {
      if ((element.type === 'line' || element.type === 'freedraw') && element.points.length >= 3) {
        for (let i = 0; i < element.points.length; i++) {
          const a = element.points[i],
            b = element.points[(i + 1) % element.points.length];
          value += a[0] * b[1] - b[0] * a[1];
        }
        value = Math.abs(value) / 2;
      } else if (['rectangle', 'ellipse', 'diamond', 'image'].includes(element.type))
        value =
          element.width *
          element.height *
          (element.type === 'ellipse' ? Math.PI / 4 : element.type === 'diamond' ? 0.5 : 1);
      else throw Error(t('annotationAreaShape'));
      value /= scale.pixelsPerUnit ** 2;
    }
    await onSettings({ measurement: scale });
    const text =
      new Intl.NumberFormat(undefined, { maximumFractionDigits: 3 }).format(value) +
      ' ' +
      scale.unit +
      (kind === 'area' ? '²' : '');
    insert(
      convertToExcalidrawElements([
        {
          type: 'text',
          x: element.x,
          y: element.y + element.height + 8,
          text,
          fontSize: 18,
          fontFamily: 2,
          strokeColor: '#1d4ed8',
          customData: {
            annotationKind: 'measurement',
            targetId: element.id,
            measurementKind: kind,
            value,
            ...scale,
          },
        },
      ]),
    );
  };
  const image = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      if (file.size > 20 * 1024 * 1024) throw Error(t('boardPdfSize'));
      const bitmap = await createImageBitmap(file),
        ratio = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height)),
        canvas = document.createElement('canvas');
      canvas.width = Math.ceil(bitmap.width * ratio);
      canvas.height = Math.ceil(bitmap.height * ratio);
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob(
          (value) => (value ? resolve(value) : reject(Error('Image conversion failed'))),
          'image/png',
        ),
      );
      if (blob.size > 5 * 1024 * 1024) throw Error(t('chatImageSize', { size: 5 }));
      const id = await uploadBoardAsset(
          roomId,
          new File([blob], 'annotation.png', { type: 'image/png' }),
          'annotation',
          abort.current.signal,
        ),
        dataURL = canvas.toDataURL('image/png');
      api.addFiles([{ id, dataURL, mimeType: 'image/png', created: Date.now() }] as never);
      const { x, y } = center(),
        width = Math.min(Math.max(canvas.width, 32), 500),
        height = (width * canvas.height) / canvas.width;
      insert(
        convertToExcalidrawElements([
          {
            type: 'image',
            x,
            y,
            width,
            height,
            fileId: id as never,
            status: 'saved',
            scale: [1, 1],
          },
        ]),
      );
      canvas.width = canvas.height = 0;
    } catch (e) {
      if (!abort.current.signal.aborted) setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const paper = (kind: string) => {
    const rotated = (page.page_rotation ?? 0) % 180 !== 0,
      width = Number(
        (rotated ? page.background_height : page.background_width) ?? (rotated ? 1400 : 1000),
      ),
      height = Number(
        (rotated ? page.background_width : page.background_height) ?? (rotated ? 1000 : 1400),
      ),
      lines = [];
    if (kind !== 'plain')
      for (let y = 0; y <= height; y += 40)
        lines.push({
          type: 'line' as const,
          x: 0,
          y,
          width,
          height: 0,
          points: [
            [0, 0],
            [width, 0],
          ] as [number, number][],
          strokeColor: '#94a3b8',
          strokeWidth: 1,
          opacity: 35,
          roughness: 0,
          locked: true,
          customData: { annotationKind: 'paper' },
        });
    if (kind === 'grid')
      for (let x = 0; x <= width; x += 40)
        lines.push({
          type: 'line' as const,
          x,
          y: 0,
          width: 0,
          height,
          points: [
            [0, 0],
            [0, height],
          ] as [number, number][],
          strokeColor: '#94a3b8',
          strokeWidth: 1,
          opacity: 35,
          roughness: 0,
          locked: true,
          customData: { annotationKind: 'paper' },
        });
    const others = api
      .getSceneElements()
      .map((element) =>
        element.customData?.annotationKind === 'paper'
          ? revised(element, { isDeleted: true })
          : element,
      );
    update([...convertToExcalidrawElements(lines), ...others]);
    setOpen(false);
  };
  const selectedIds = new Set(selected().map((element) => element.id));
  return (
    <>
      <button
        type="button"
        title={t('annotationTools')}
        aria-label={t('annotationTools')}
        onClick={() => {
          setError('');
          setChosenIds(null);
          setAnnotationSearch('');
          setAnnotationLimit(100);
          setOpen(true);
        }}
      >
        ✎+
      </button>
      <input
        type="file"
        hidden
        style={{ display: 'none' }}
        accept="image/png,image/jpeg,image/webp,image/gif"
        ref={input}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void image(file);
        }}
      />
      {open && (
        <dialog
          ref={dialog}
          className="annotation-tools-dialog"
          aria-label={t('annotationTools')}
          onClose={() => setOpen(false)}
          onCancel={(e) => {
            if (busy) e.preventDefault();
          }}
        >
          <header>
            <h2>{t('annotationTools')}</h2>
            <button
              type="button"
              disabled={busy}
              aria-label={t('classClosePanel')}
              onClick={() => setOpen(false)}
            >
              ×
            </button>
          </header>
          <fieldset disabled={busy}>
            <section>
              <h3>{t('annotationInsert')}</h3>
              <label>
                {t('annotationText')}
                <textarea
                  aria-label={t('annotationText')}
                  maxLength={1000}
                  rows={2}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                />
              </label>
              <div className="annotation-command-grid">
                <button disabled={!text.trim()} onClick={() => label(text, 'note')}>
                  {t('annotationNote')}
                </button>
                <button disabled={!text.trim()} onClick={() => label(text)}>
                  {t('annotationTextStamp')}
                </button>
                <button onClick={() => input.current?.click()}>{t('annotationImage')}</button>
                <button
                  onClick={() =>
                    label(
                      new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date()),
                    )
                  }
                >
                  {t('annotationDateStamp')}
                </button>
                {['✓', '✗', '★', '!', '?'].map((symbol) => (
                  <button
                    key={symbol}
                    aria-label={t('annotationStamp') + ' ' + symbol}
                    onClick={() => label(symbol)}
                  >
                    {symbol}
                  </button>
                ))}
              </div>
              <div className="annotation-stamps">
                {stamps.map((stamp) => (
                  <div key={stamp.id}>
                    <button
                      onClick={() => {
                        const elements = clone(stamp.elements),
                          { x, y } = center(),
                          minX = Math.min(...elements.map((e) => e.x)),
                          minY = Math.min(...elements.map((e) => e.y));
                        insert(
                          elements.map((element) =>
                            revised(element, { x: element.x - minX + x, y: element.y - minY + y }),
                          ),
                        );
                      }}
                    >
                      {stamp.name}
                    </button>
                    <button
                      aria-label={t('delete') + ' ' + stamp.name}
                      onClick={() =>
                        void request(
                          '/classrooms/' + roomId + '/annotation-stamps/' + stamp.id + '/delete',
                          {},
                        )
                          .then(() =>
                            setStamps((values) => values.filter((value) => value.id !== stamp.id)),
                          )
                          .catch((e) => setError(e.message))
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
              <button
                disabled={!text.trim()}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const elements = selected();
                    if (!elements.length) throw Error(t('annotationSelectFirst'));
                    await request('/classrooms/' + roomId + '/annotation-stamps', {
                      name: text.slice(0, 80),
                      elements,
                    });
                    setStamps(await request('/classrooms/' + roomId + '/annotation-stamps'));
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t('annotationSaveStamp')}
              </button>
              <button
                disabled={!text.trim()}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    const { formulaImage } = await import('./formula-image');
                    await image(await formulaImage(text));
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {t('annotationFormula')}
              </button>
            </section>
            <section>
              <h3>{t('annotationSelection')}</h3>
              <details className="annotation-object-list">
                <summary>{t('annotationObjects')}</summary>
                <label>
                  {t('annotationObjectSearch')}
                  <input
                    type="search"
                    value={annotationSearch}
                    onChange={(e) => {
                      setAnnotationSearch(e.target.value);
                      setAnnotationLimit(100);
                    }}
                  />
                </label>
                {api
                  .getSceneElements()
                  .filter(
                    (element) =>
                      !element.isDeleted &&
                      !element.id.startsWith('background_') &&
                      element.customData?.annotationKind !== 'paper' &&
                      (element.type + ' ' + ('text' in element ? element.text : ''))
                        .toLocaleLowerCase()
                        .includes(annotationSearch.toLocaleLowerCase()),
                  )
                  .slice(0, annotationLimit)
                  .map((element) => (
                    <label key={element.id}>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(element.id)}
                        onChange={(event) =>
                          setChosenIds(
                            event.target.checked
                              ? [...selected().map((item) => item.id), element.id]
                              : selected()
                                  .filter((item) => item.id !== element.id)
                                  .map((item) => item.id),
                          )
                        }
                      />
                      <span>
                        {('text' in element
                          ? element.text
                          : t('annotationObject_' + element.type)
                        ).slice(0, 100)}
                        {element.locked ? ' 🔒' : ''}
                      </span>
                      <button
                        type="button"
                        aria-label={t('annotationLocate')}
                        onClick={() => {
                          api.scrollToContent(element, { fitToContent: true, maxZoom: 1 });
                          setOpen(false);
                        }}
                      >
                        {t('annotationLocate')}
                      </button>
                    </label>
                  ))}
                {api.getSceneElements().length > annotationLimit && (
                  <button type="button" onClick={() => setAnnotationLimit((value) => value + 100)}>
                    {t('annotationMoreObjects')}
                  </button>
                )}
              </details>
              <div className="annotation-command-grid">
                {[
                  'duplicate',
                  'delete',
                  'group',
                  'ungroup',
                  'lock',
                  'unlock',
                  'front',
                  'back',
                  'left',
                  'center',
                  'right',
                  'top',
                  'middle',
                  'bottom',
                ].map((kind) => (
                  <button key={kind} onClick={() => selectionAction(kind)}>
                    {t('annotationCommand_' + kind)}
                  </button>
                ))}
              </div>
              <div className="annotation-command-grid">
                {([1, 2, 3] as const).map((fontFamily) => (
                  <button
                    key={fontFamily}
                    onClick={() => {
                      style({ fontFamily });
                      setOpen(false);
                    }}
                  >
                    {t('annotationFont_' + fontFamily)}
                  </button>
                ))}
                {(['left', 'center', 'right'] as const).map((textAlign) => (
                  <button
                    key={textAlign}
                    onClick={() => {
                      style({ textAlign });
                      setOpen(false);
                    }}
                  >
                    {t('annotationTextAlign_' + textAlign)}
                  </button>
                ))}
              </div>
              <label>
                {t('annotationFill')}
                <input
                  type="color"
                  value={fill}
                  onChange={(e) => {
                    setFill(e.target.value);
                    style({ backgroundColor: e.target.value, fillStyle: 'solid' });
                  }}
                />
              </label>
              <button
                onClick={() => {
                  style({ backgroundColor: 'transparent' });
                  setOpen(false);
                }}
              >
                {t('annotationNoFill')}
              </button>
              <div className="annotation-command-grid">
                {(['solid', 'dashed', 'dotted'] as const).map((strokeStyle) => (
                  <button
                    key={strokeStyle}
                    onClick={() => {
                      style({ strokeStyle });
                      setOpen(false);
                    }}
                  >
                    {t('annotationStroke_' + strokeStyle)}
                  </button>
                ))}
              </div>
            </section>
            <section>
              <h3>{t('annotationMeasure')}</h3>
              <label>
                {t('annotationScale')}
                <input
                  type="number"
                  min="0.000001"
                  max="1000000000"
                  step="any"
                  value={scale.pixelsPerUnit}
                  onChange={(e) => setScale({ ...scale, pixelsPerUnit: Number(e.target.value) })}
                />
              </label>
              <label>
                {t('annotationUnit')}
                <select
                  aria-label={t('annotationUnit')}
                  value={scale.unit}
                  onChange={(e) =>
                    setScale({ ...scale, unit: e.target.value as Measurement['unit'] })
                  }
                >
                  {['px', 'mm', 'cm', 'm', 'in', 'ft'].map((unit) => (
                    <option key={unit}>{unit}</option>
                  ))}
                </select>
              </label>
              <div className="annotation-command-grid">
                <button onClick={() => void measure('length').catch((e) => setError(e.message))}>
                  {t('annotationLength')}
                </button>
                <button onClick={() => void measure('area').catch((e) => setError(e.message))}>
                  {t('annotationArea')}
                </button>
              </div>
            </section>
            <section>
              <h3>{t('annotationPaper')}</h3>
              <div className="annotation-command-grid">
                {['plain', 'ruled', 'grid'].map((kind) => (
                  <button key={kind} onClick={() => paper(kind)}>
                    {t('annotationPaper_' + kind)}
                  </button>
                ))}
              </div>
            </section>
          </fieldset>
          {error && <p role="alert">{error}</p>}
        </dialog>
      )}
    </>
  );
}
