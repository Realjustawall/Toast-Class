import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eraserHits } from '../apps/web/src/board-eraser-geometry';
test('eraser diameter changes contact, sweeps fast drags and protects locked PDF backgrounds', () => {
  const line = {
    id: 'ink',
    type: 'freedraw',
    x: 10,
    y: 20,
    width: 100,
    height: 0,
    angle: 0,
    strokeWidth: 2,
    backgroundColor: 'transparent',
    points: [
      [0, 0],
      [100, 0],
    ],
  };
  assert.equal(eraserHits(line, { x: 50, y: 30 }, { x: 50, y: 30 }, 2), false);
  assert.equal(eraserHits(line, { x: 50, y: 30 }, { x: 50, y: 30 }, 12), true);
  assert.equal(eraserHits(line, { x: 50, y: -100 }, { x: 50, y: 100 }, 2), true);
  assert.equal(
    eraserHits({ ...line, locked: true }, { x: 50, y: 20 }, { x: 50, y: 20 }, 100),
    false,
  );
  assert.equal(
    eraserHits({ ...line, id: 'background_pdf' }, { x: 50, y: 20 }, { x: 50, y: 20 }, 100),
    false,
  );
  const box = {
    id: 'box',
    type: 'rectangle',
    x: 0,
    y: 0,
    width: 100,
    height: 100,
    angle: 0,
    strokeWidth: 1,
    backgroundColor: 'transparent',
  };
  assert.equal(eraserHits(box, { x: 50, y: 50 }, { x: 50, y: 50 }, 2), false);
  assert.equal(
    eraserHits({ ...box, backgroundColor: '#ffffff' }, { x: 50, y: 50 }, { x: 50, y: 50 }, 2),
    true,
  );
  assert.equal(
    eraserHits({ ...line, angle: Math.PI / 2 }, { x: 60, y: -100 }, { x: 60, y: 100 }, 2),
    true,
  );
});
