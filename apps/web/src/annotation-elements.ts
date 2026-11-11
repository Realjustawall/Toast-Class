import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';

/** Copy a selection without retaining references to shapes outside that copy. */
export function cloneAnnotations(source: readonly ExcalidrawElement[]) {
  const ids = new Map(source.map((element) => [element.id, crypto.randomUUID()]));
  const groups = new Map<string, string>();
  const binding = (value: { elementId: string } | null) =>
    value && ids.has(value.elementId) ? { ...value, elementId: ids.get(value.elementId)! } : null;
  return source.map((element) => {
    for (const id of element.groupIds) if (!groups.has(id)) groups.set(id, crypto.randomUUID());
    return {
      ...element,
      id: ids.get(element.id)!,
      x: element.x + 20,
      y: element.y + 20,
      index: null,
      version: 1,
      versionNonce: Math.floor(Math.random() * 2147483647),
      updated: Date.now(),
      groupIds: element.groupIds.map((id) => groups.get(id)!),
      ...('containerId' in element
        ? { containerId: element.containerId ? (ids.get(element.containerId) ?? null) : null }
        : {}),
      boundElements:
        element.boundElements
          ?.filter((item) => ids.has(item.id))
          .map((item) => ({ ...item, id: ids.get(item.id)! })) ?? null,
      frameId: element.frameId ? (ids.get(element.frameId) ?? null) : null,
      ...('startBinding' in element
        ? { startBinding: binding(element.startBinding), endBinding: binding(element.endBinding) }
        : {}),
      locked: false,
    } as ExcalidrawElement;
  });
}
