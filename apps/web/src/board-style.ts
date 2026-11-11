import { CaptureUpdateAction, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { UserFontFamily } from '../../../packages/user-preferences';

/** Update the active tool and the selected annotations in the same undoable edit. */
export function changeBoardStyle(
  api: ExcalidrawImperativeAPI,
  style: {
    strokeColor?: string;
    strokeWidth?: number;
    opacity?: number;
    fontSize?: number;
    fontFamily?: UserFontFamily;
    textAlign?: 'left' | 'center' | 'right';
    backgroundColor?: string;
    fillStyle?: 'solid' | 'hachure';
    strokeStyle?: 'solid' | 'dashed' | 'dotted';
  },
  selectedIds?: readonly string[],
) {
  const state = api.getAppState(),
    selected = selectedIds
      ? Object.fromEntries(selectedIds.map((id) => [id, true]))
      : state.selectedElementIds;
  const elements = api.getSceneElements().map((element) => {
    if (!selected[element.id] || element.locked || element.isDeleted) return element;
    const applicable = { ...style };
    if (element.type !== 'text') {
      delete applicable.fontSize;
      delete applicable.fontFamily;
      delete applicable.textAlign;
    }
    if (!Object.keys(applicable).length) return element;
    // Recalculate the text bounds as well, so larger text does not clip or retain
    // the old selection box. Keep container wrapping for bound text.
    const metrics =
      element.type === 'text' && (style.fontSize || style.fontFamily)
        ? convertToExcalidrawElements(
            [
              {
                ...element,
                ...applicable,
                width: element.containerId || !element.autoResize ? element.width : undefined,
                height: undefined,
              },
            ],
            { regenerateIds: false },
          )[0]
        : element;
    return {
      ...element,
      ...applicable,
      width: metrics.width,
      height: metrics.height,
      version: element.version + 1,
      versionNonce: Math.floor(Math.random() * 2147483647),
      updated: Date.now(),
    };
  });
  api.updateScene({
    elements,
    appState: {
      currentItemStrokeColor: style.strokeColor ?? state.currentItemStrokeColor,
      currentItemStrokeWidth: style.strokeWidth ?? state.currentItemStrokeWidth,
      currentItemOpacity: style.opacity ?? state.currentItemOpacity,
      currentItemFontSize: style.fontSize ?? state.currentItemFontSize,
      currentItemFontFamily: style.fontFamily ?? state.currentItemFontFamily,
      currentItemTextAlign: style.textAlign ?? state.currentItemTextAlign,
      currentItemBackgroundColor: style.backgroundColor ?? state.currentItemBackgroundColor,
      currentItemFillStyle: style.fillStyle ?? state.currentItemFillStyle,
      currentItemStrokeStyle: style.strokeStyle ?? state.currentItemStrokeStyle,
    },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  });
}
