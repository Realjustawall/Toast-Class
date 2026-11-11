import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import {
  BoardReplica,
  BoardReplacementRequired,
  type BoardElement,
} from '../apps/web/src/board-replica';
const rectangle = (id: string): BoardElement => ({
  id,
  type: 'rectangle',
  x: 10,
  y: 20,
  width: 100,
  height: 80,
  angle: 0,
  strokeColor: '#000000',
  backgroundColor: 'transparent',
  fillStyle: 'solid',
  strokeWidth: 1,
  strokeStyle: 'solid',
  roughness: 1,
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
});
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
};

test('restoring object property order does not enqueue an edit, while actual nested changes do', () => {
  const replica = new BoardReplica(storage(), 'order'),
    server = new Y.Doc();
  try {
    replica.receive({
      generation: crypto.randomUUID(),
      revision: 0,
      canEdit: true,
      state: Buffer.from(Y.encodeStateAsUpdate(server)).toString('base64'),
    });
    const original = { ...rectangle('shape'), roundness: { type: 3, value: 0.5 } };
    assert.equal(replica.edit([original]), true);
    const count = replica.pending.length;
    const reordered = Object.fromEntries(Object.entries(original).reverse()) as BoardElement;
    reordered.roundness = { value: 0.5, type: 3 };
    assert.equal(replica.edit([reordered]), false);
    assert.equal(replica.pending.length, count);
    assert.equal(replica.edit([{ ...reordered, roundness: { type: 3, value: 0.75 } }]), true);
    assert.equal(replica.pending.length, count + 1);
  } finally {
    replica.destroy();
    server.destroy();
  }
});
test('board replicas converge across concurrent edits, durable refresh, duplicate receipts and revoked permissions', () => {
  const disk = storage(),
    a = new BoardReplica(disk, 'a'),
    b = new BoardReplica(disk, 'b');
  const server = new Y.Doc(),
    generation = crypto.randomUUID();
  const snapshot = (canEdit = true) => ({
    generation,
    revision: 2,
    canEdit,
    state: Buffer.from(Y.encodeStateAsUpdate(server)).toString('base64'),
  });
  try {
    a.receive(snapshot());
    b.receive(snapshot());
    assert.equal(a.edit([rectangle('teacher')]), true);
    assert.equal(b.edit([rectangle('learner')]), true);
    const refreshed = new BoardReplica(disk, 'a');
    try {
      refreshed.receive(snapshot());
      assert.equal(refreshed.pending[0].id, a.pending[0].id);
      assert.equal(refreshed.scene()[0].id, 'teacher');
      for (const replica of [refreshed, b]) {
        const item = replica.pending[0];
        Y.applyUpdate(server, Buffer.from(item.update, 'base64'));
        Y.applyUpdate(server, Buffer.from(item.update, 'base64'));
        replica.acknowledge(item.id);
      }
      refreshed.receive(snapshot());
      b.receive(snapshot());
      assert.deepEqual(refreshed.scene(), b.scene());
      assert.equal(b.scene().length, 2);
      assert.equal(refreshed.edit(refreshed.scene()), false);
      b.receive(snapshot(false));
      assert.equal(b.edit([...b.scene(), rectangle('forbidden')]), false);
      assert.equal(b.pending.length, 0);
      const replacement = { ...snapshot(), generation: crypto.randomUUID() };
      assert.equal(b.receive(replacement), true);
      assert.equal(b.generation, replacement.generation);
      assert.equal(refreshed.pending.length, 0);
    } finally {
      refreshed.destroy();
    }
  } finally {
    a.destroy();
    b.destroy();
    server.destroy();
  }
});
test('invalid objects and failed durable storage never poison a board causal history', () => {
  const disk = storage(),
    replica = new BoardReplica(disk, 'board');
  replica.receive({ generation: crypto.randomUUID(), revision: 0, canEdit: true });
  try {
    assert.throws(() => replica.edit([{ ...rectangle('bad'), type: 'image', fileId: 'external' }]));
    assert.equal(replica.elements.size, 0);
    assert.equal(replica.pending.length, 0);
    disk.setItem = () => {
      throw new Error('quota exceeded');
    };
    assert.throws(() => replica.edit([rectangle('valid')]), /quota/);
    assert.equal(replica.elements.size, 0);
    assert.equal(replica.pending.length, 0);
  } finally {
    replica.destroy();
  }
});
test('live samples merge durably, preserve causal state on retry and recover after a storage failure', () => {
  const disk = storage(),
    a = new BoardReplica(disk, 'batch'),
    server = new Y.Doc(),
    generation = crypto.randomUUID();
  const snapshot = () => ({
    generation,
    revision: 1,
    canEdit: true,
    state: Buffer.from(Y.encodeStateAsUpdate(server)).toString('base64'),
  });
  try {
    a.receive(snapshot());
    for (let i = 1; i <= 30; i++)
      a.edit([{ ...rectangle('stroke'), x: i, version: i, versionNonce: i }]);
    assert.equal(a.pending.length, 30);
    const before = a.scene();
    a.compactPending();
    assert.equal(a.pending.length, 1);
    const receipt = a.pending[0];
    Y.applyUpdate(server, Buffer.from(receipt.update, 'base64'));
    // The acknowledgement is lost; a new sample can be merged and replayed safely.
    a.edit([{ ...before[0], x: 31, version: 31, versionNonce: 31 }]);
    const oldPending = a.pending,
      save = disk.setItem;
    disk.setItem = () => {
      throw Error('quota');
    };
    assert.throws(() => a.compactPending(), /quota/);
    assert.equal(a.pending, oldPending);
    disk.setItem = save;
    a.compactPending();
    const refreshed = new BoardReplica(disk, 'batch');
    try {
      refreshed.receive(snapshot());
      assert.equal(refreshed.pending.length, 1);
      assert.equal(refreshed.pending[0].id, a.pending[0].id);
      const update = Buffer.from(refreshed.pending[0].update, 'base64');
      Y.applyUpdate(server, update);
      Y.applyUpdate(server, update);
      assert.equal(server.getMap<BoardElement>('elements').size, 1);
      assert.equal(server.getMap<BoardElement>('elements').get('stroke')?.x, 31);
      refreshed.acknowledge(refreshed.pending[0].id);
      assert.equal(refreshed.pending.length, 0);
    } finally {
      refreshed.destroy();
    }
  } finally {
    a.destroy();
    server.destroy();
  }
});

test('restoration quarantines pending edits through refresh until explicit discard and preserves a recovery export', () => {
  const disk = storage(),
    a = new BoardReplica(disk, 'board'),
    server = new Y.Doc();
  const initial = {
    generation: crypto.randomUUID(),
    revision: 0,
    canEdit: true,
    state: Buffer.from(Y.encodeStateAsUpdate(server)).toString('base64'),
  };
  a.receive(initial);
  a.edit([rectangle('unsent')]);
  const replacement = { ...initial, generation: crypto.randomUUID(), revision: 1 };
  try {
    assert.throws(() => a.receive(replacement), BoardReplacementRequired);
    assert.equal(a.canEdit, false);
    assert.equal(a.pending.length, 1);
    const recovery = JSON.parse(a.recoveryData());
    assert.equal(recovery.pending[0].id, a.pending[0].id);
    const refreshed = new BoardReplica(disk, 'board');
    try {
      assert.throws(() => refreshed.receive(replacement), BoardReplacementRequired);
      assert.equal(refreshed.pending[0].id, a.pending[0].id);
      assert.throws(() => refreshed.replace(replacement, false), BoardReplacementRequired);
      refreshed.replace(replacement, true);
      refreshed.receive(replacement);
      assert.equal(refreshed.pending.length, 0);
      assert.equal(refreshed.scene().length, 0);
      assert.equal(refreshed.canEdit, true);
      assert.equal(disk.getItem('board'), null);
    } finally {
      refreshed.destroy();
    }
  } finally {
    a.destroy();
    server.destroy();
  }
});
