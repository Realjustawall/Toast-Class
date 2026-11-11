import * as Y from 'yjs';
import { validateBoard } from '../../../packages/whiteboard/schema';

export type BoardElement = {
  id: string;
  index?: string | null;
  type?: string;
  fileId?: string;
  [key: string]: unknown;
};
export type BoardUpdate = { id: string; generation: string; update: string };
export type BoardState = {
  generation: string;
  revision: number;
  canEdit: boolean;
  state?: string;
  updates?: { revision: number; update: string }[];
};
export class BoardReplacementRequired extends Error {
  constructor(readonly replacement: BoardState) {
    super('Board was restored; pending edits belong to the previous version');
  }
}
const encode = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''));
const decode = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));

/** One replica per account/document. Receipts are persisted before network submission. */
export class BoardReplica {
  doc = new Y.Doc();
  elements = this.doc.getMap<BoardElement>('elements');
  generation = '';
  revision = 0;
  canEdit = false;
  pending: BoardUpdate[] = [];
  constructor(
    readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>,
    readonly key: string,
  ) {}
  private persist() {
    if (this.pending.length) this.storage.setItem(this.key, JSON.stringify(this.pending));
    else this.storage.removeItem(this.key);
  }
  receive(result: BoardState) {
    let replaced = false;
    if (!this.generation) {
      const cached = JSON.parse(this.storage.getItem(this.key) ?? '[]') as BoardUpdate[];
      if (
        !Array.isArray(cached) ||
        cached.length > 1000 ||
        cached.some(
          (item) =>
            typeof item.id !== 'string' ||
            typeof item.update !== 'string' ||
            item.update.length > 700000 ||
            typeof item.generation !== 'string',
        )
      )
        throw new Error('Saved board edits need recovery before continuing');
      this.pending = cached;
      this.generation = cached[0]?.generation ?? result.generation;
    }
    if (this.generation !== result.generation) {
      this.canEdit = false;
      if (this.pending.length) throw new BoardReplacementRequired(result);
      this.replace(result, false);
      replaced = true;
    }
    if (result.state) Y.applyUpdate(this.doc, decode(result.state), 'server');
    for (const item of result.updates ?? []) Y.applyUpdate(this.doc, decode(item.update), 'server');
    for (const item of this.pending) Y.applyUpdate(this.doc, decode(item.update), 'outbox');
    this.revision = result.revision;
    this.canEdit = result.canEdit;
    return replaced;
  }
  replace(result: BoardState, discardPending: boolean) {
    if (this.pending.length && !discardPending) throw new BoardReplacementRequired(result);
    if (result.state === undefined)
      throw new Error('Full board state is required after restoration');
    // Clear durable storage first. If storage is unavailable, the old receipt stays recoverable.
    this.storage.removeItem(this.key);
    this.doc.destroy();
    this.doc = new Y.Doc();
    this.elements = this.doc.getMap<BoardElement>('elements');
    this.pending = [];
    this.generation = result.generation;
    this.revision = 0;
    this.canEdit = false;
  }
  recoveryData() {
    return JSON.stringify(
      {
        format: 'toaster-pending-board-recovery',
        version: 1,
        generation: this.generation,
        state: encode(Y.encodeStateAsUpdate(this.doc)),
        pending: this.pending,
      },
      null,
      2,
    );
  }
  scene() {
    const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
    return [...this.elements.values()].sort(
      (a, b) => compare(a.index ?? '', b.index ?? '') || compare(a.id, b.id),
    );
  }
  backgroundColor() {
    return String(this.doc.getMap('settings').get('backgroundColor') ?? '#ffffff');
  }
  settings() {
    return this.doc.getMap('settings').toJSON() as Record<string, unknown>;
  }
  edit(
    scene: readonly BoardElement[],
    backgroundColor?: string,
    settings?: Record<string, unknown>,
  ) {
    if (!this.generation || !this.canEdit) return false;
    const next = scene.map((element) => JSON.parse(JSON.stringify(element)) as BoardElement);
    // Restoring an editor scene may reorder object properties. That is not an edit and
    // must not create CRDT receipts/checkpoints whenever the user pans or zooms.
    const equal = (left: unknown, right: unknown): boolean => {
      if (left === right) return true;
      if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
      if (Array.isArray(left) !== Array.isArray(right)) return false;
      const a = left as Record<string, unknown>,
        b = right as Record<string, unknown>;
      const keys = Object.keys(a);
      return (
        keys.length === Object.keys(b).length &&
        keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key]))
      );
    };
    const changed = next.filter((element) => !equal(this.elements.get(element.id), element));
    const backgroundChanged =
      backgroundColor !== undefined && backgroundColor !== this.backgroundColor();
    const settingChanges = Object.entries(settings ?? {}).filter(
      ([key, value]) => !equal(this.doc.getMap('settings').get(key), value),
    );
    if (!changed.length && !backgroundChanged && !settingChanges.length) return false;
    // Stage first: oversized edits must not poison the local causal history.
    const staging = new Y.Doc();
    try {
      Y.applyUpdate(staging, Y.encodeStateAsUpdate(this.doc));
      const vector = Y.encodeStateVector(staging);
      staging.transact(() => {
        for (const element of changed) staging.getMap('elements').set(element.id, element);
        if (backgroundChanged) staging.getMap('settings').set('backgroundColor', backgroundColor);
        for (const [key, value] of settingChanges) staging.getMap('settings').set(key, value);
      });
      validateBoard(staging);
      const bytes = Y.encodeStateAsUpdate(staging, vector);
      if (bytes.length > 512 * 1024 || this.pending.length >= 1000)
        throw new Error('Board edit limit reached; synchronize before continuing');
      const item = { id: crypto.randomUUID(), generation: this.generation, update: encode(bytes) };
      this.pending.push(item);
      try {
        this.persist();
      } catch (error) {
        this.pending.pop();
        throw error;
      }
      Y.applyUpdate(this.doc, bytes, 'local');
      return true;
    } finally {
      staging.destroy();
    }
  }
  /** Call only between network submissions: merge queued samples into one durable
   * receipt so a long live stroke does not send a request for every point. */
  compactPending() {
    if (this.pending.length < 2) return;
    let bytes: Uint8Array = decode(this.pending[0].update),
      count = 1;
    for (const item of this.pending.slice(1, 64)) {
      if (item.generation !== this.pending[0].generation) break;
      const merged = Y.mergeUpdates([bytes, decode(item.update)]);
      if (merged.length > 512 * 1024) break;
      bytes = merged;
      count++;
    }
    if (count < 2) return;
    const previous = this.pending;
    this.pending = [
      { id: crypto.randomUUID(), generation: previous[0].generation, update: encode(bytes) },
      ...previous.slice(count),
    ];
    try {
      this.persist();
    } catch (error) {
      this.pending = previous;
      throw error;
    }
  }
  acknowledge(id: string) {
    if (this.pending[0]?.id !== id) throw new Error('Board receipt order changed');
    const first = this.pending.shift()!;
    try {
      this.persist();
    } catch (error) {
      this.pending.unshift(first);
      throw error;
    }
  }
  destroy() {
    this.doc.destroy();
  }
}
