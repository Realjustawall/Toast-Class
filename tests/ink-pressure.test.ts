import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { inkPressure } from '../packages/whiteboard/ink';
import { validateBoard } from '../packages/whiteboard/schema';
test('normal ink has constant width while pen pressure and sensitivity remain finite and bounded', () => {
  for (const value of [0, 0.1, 0.5, 0.9, 1, NaN])
    assert.equal(inkPressure('pen', value, 'pen', 1), 0.5);
  assert.equal(inkPressure('pressurePen', 0.1, 'pen', 1), 0.1);
  assert.equal(inkPressure('pressurePen', 0.9, 'pen', 1), 0.9);
  assert.equal(inkPressure('pressurePen', 0.1, 'mouse', 1), 0.5);
  assert.ok(inkPressure('pressurePen', 0.25, 'pen', 2) > 0.25);
  assert.equal(inkPressure('pressurePen', -1, 'pen', 1), 0);
  assert.equal(inkPressure('pressurePen', 2, 'pen', 1), 1);
});
test('new ink strokes require a valid pressure sample for every persisted point', () => {
  const doc = new Y.Doc();
  try {
    const element = {
      id: 'ink',
      type: 'freedraw',
      x: 0,
      y: 0,
      width: 100,
      height: 10,
      angle: 0,
      strokeColor: '#123456',
      backgroundColor: 'transparent',
      fillStyle: 'solid',
      strokeWidth: 2,
      strokeStyle: 'solid',
      roughness: 0,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 1,
      version: 1,
      versionNonce: 1,
      isDeleted: false,
      boundElements: null,
      updated: 1,
      link: null,
      locked: false,
      points: [
        [0, 0],
        [100, 10],
      ],
      pressures: [0.1, 0.9],
      simulatePressure: false,
      customData: { inkMode: 'pressurePen' },
    };
    doc.getMap('elements').set('ink', element);
    assert.doesNotThrow(() => validateBoard(doc));
    doc.getMap('elements').set('ink', { ...element, pressures: [0.1] });
    assert.throws(() => validateBoard(doc), /pressure/i);
    doc.getMap('elements').set('ink', { ...element, pressures: [0.1, 2] });
    assert.throws(() => validateBoard(doc));
  } finally {
    doc.destroy();
  }
});
