import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cloneAnnotations } from '../apps/web/src/annotation-elements';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
test('reusable annotations remap arrow, label and group references without binding to the original page', () => {
  const source = [
      {
        id: 'box',
        type: 'rectangle',
        x: 0,
        y: 0,
        groupIds: ['group'],
        frameId: null,
        locked: true,
        boundElements: [
          { id: 'arrow', type: 'arrow' },
          { id: 'label', type: 'text' },
          { id: 'outside', type: 'arrow' },
        ],
      },
      {
        id: 'arrow',
        type: 'arrow',
        x: 50,
        y: 0,
        groupIds: ['group'],
        frameId: null,
        locked: false,
        boundElements: null,
        startBinding: { elementId: 'box', focus: 0, gap: 0 },
        endBinding: { elementId: 'outside', focus: 0, gap: 5 },
      },
      {
        id: 'label',
        type: 'text',
        text: 'Label',
        x: 10,
        y: 10,
        groupIds: ['group'],
        frameId: null,
        locked: false,
        boundElements: null,
        containerId: 'box',
      },
    ] as unknown as ExcalidrawElement[],
    original = structuredClone(source),
    [box, arrow, label] = cloneAnnotations(source);
  assert.notEqual(box.id, 'box');
  assert.notEqual(arrow.id, 'arrow');
  assert.notEqual(box.groupIds[0], 'group');
  assert.equal(box.groupIds[0], arrow.groupIds[0]);
  assert.equal(box.groupIds[0], label.groupIds[0]);
  assert.equal(arrow.type, 'arrow');
  if (arrow.type !== 'arrow') throw Error('Invalid arrow');
  assert.equal(arrow.startBinding?.elementId, box.id);
  assert.equal(arrow.endBinding, null);
  assert.equal((arrow.startBinding as { gap?: number })?.gap, 0);
  assert.equal(label.type, 'text');
  if (label.type !== 'text') throw Error('Invalid label');
  assert.equal(label.containerId, box.id);
  assert.deepEqual(
    box.boundElements?.map((item) => item.id),
    [arrow.id, label.id],
  );
  assert.equal(box.locked, false);
  assert.deepEqual(source, original);
});
