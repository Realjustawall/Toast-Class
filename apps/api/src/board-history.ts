import { createHash, randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import type { DatabaseConnection } from './database.js';
import { fail } from './errors.js';
import { validateBoard } from './board-schema.js';

export type SavedBoard = { generation: string; revision: number; state_base64: string };
export const boardDigest = (state: string) =>
  createHash('sha256').update(Buffer.from(state, 'base64')).digest('hex');
export async function requireBoardManager(
  c: DatabaseConnection,
  organization: string,
  actor: string,
) {
  const row = (
    await c.query(
      'SELECT role FROM memberships WHERE organization_id=$1 AND user_id=$2 FOR UPDATE',
      [organization, actor],
    )
  ).rows[0];
  if (!row || !['owner', 'teacher'].includes(row.role))
    fail(403, 'Board history requires a teacher');
}
export async function saveBoardVersion(
  c: DatabaseConnection,
  documentId: string,
  state: SavedBoard,
  actor: string,
  label: string,
  kind: 'manual' | 'automatic' | 'before_restore',
  versionId: string = randomUUID(),
) {
  // All callers hold the document lock. Manual/recovery versions are never silently evicted.
  if (kind === 'automatic') {
    const old = (
      await c.query(
        "SELECT id FROM board_versions WHERE document_id=$1 AND kind='automatic' ORDER BY created_at DESC,id DESC",
        [documentId],
      )
    ).rows;
    for (const version of old.slice(19))
      await c.query('DELETE FROM board_versions WHERE id=$1 AND document_id=$2', [
        version.id,
        documentId,
      ]);
  }
  const usage = (
    await c.query(
      'SELECT COUNT(*) AS count,COALESCE(SUM(LENGTH(state_base64)),0) AS bytes FROM board_versions WHERE document_id=$1',
      [documentId],
    )
  ).rows[0];
  if (
    Number(usage.count) >= 128 ||
    Number(usage.bytes) + state.state_base64.length > 32 * 1024 * 1024
  ) {
    if (kind === 'automatic') return null;
    fail(413, 'Board history storage limit reached');
  }
  const id = versionId,
    digest = boardDigest(state.state_base64);
  await c.query(
    'INSERT INTO board_versions(id,document_id,generation,revision,label,kind,state_base64,digest,author_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      id,
      documentId,
      state.generation,
      state.revision,
      label,
      kind,
      state.state_base64,
      digest,
      actor,
    ],
  );
  return { id, generation: state.generation, revision: state.revision, label, kind, digest };
}
/** Restoration starts a fresh causal history; old-generation updates can never merge back. */
export function rebaseBoard(state: string, expectedDigest: string) {
  if (boardDigest(state) !== expectedDigest) fail(409, 'Board version integrity check failed');
  const source = new Y.Doc(),
    target = new Y.Doc();
  try {
    if (state) Y.applyUpdate(source, Buffer.from(state, 'base64'));
    if (source.store.pendingStructs || source.store.pendingDs) throw new Error('Incomplete state');
    validateBoard(source);
    for (const [id, element] of source.getMap('elements'))
      target.getMap('elements').set(id, element);
    for (const [key, value] of source.getMap('settings')) target.getMap('settings').set(key, value);
    validateBoard(target);
    return Buffer.from(Y.encodeStateAsUpdate(target)).toString('base64');
  } finally {
    source.destroy();
    target.destroy();
  }
}
