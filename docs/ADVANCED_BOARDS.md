# Advanced board protocol — integration in progress

The working legacy SVG/Yjs UI is preserved. Excalidraw 0.18.1 is now connected to the authorized CRDT protocol with local assets, exports and teacher-controlled history. See [editor behavior and remaining gaps](WHITEBOARD.md). Full advanced-board parity is not claimed.

Migration 010 gives board documents a `legacy`/`excalidraw` format discriminator. Existing documents remain legacy. An explicit advanced creation request initializes a generation UUID and authoritative snapshot. Advanced documents cannot be written through the legacy update endpoint. Notes cannot opt into the advanced format.

Routes under `/api/v1/classrooms/:id/documents/:doc/board`:

- GET with optional `since` revision: metadata and either a full Yjs snapshot or contiguous retained deltas. Last 128 delta payloads are retained; receipt hashes/revisions remain for idempotency. Gaps fall back to the snapshot.
- POST `/updates`: `{id,generation,update}` (base64 Yjs). Locks document state, rechecks editing permission, validates full merged scene, atomically saves snapshot/revision/receipt and emits an authorized invalidation. Replayed identical IDs are idempotent; reused IDs/different data or stale generations conflict.
- POST `/access`: `{teacherOnly}`. Teacher/owner authorization, row lock and audit event. Students cannot change access or write when read-only.

The validated root is a Y.Map named `elements`, with independently mergeable JSON objects keyed by object ID. Shapes, text and freehand data have finite coordinates, bounded lengths/counts, safe URL schemes and JSON nesting/type restrictions. Unknown roots, unsupported images/embeds, malformed updates and unresolved causal dependencies are rejected. Binary delta limit is 512 KiB, snapshot 2.5 MB, 5000 objects, 100000 total points, 200000 text characters and 200000 receipt entries per board. These bounds are explicit current limits, not measured scalability claims.

Breakout imports preserve format, copy a source snapshot under its document lock and create an independent destination generation. This path still needs dedicated advanced-board import/concurrency coverage. Snapshot restoration is implemented through the version routes below.

`tests/boards.test.ts` passes against native MySQL and the memory fixture for independent-object merge, persistence, delta sync, retries/conflicts, read-only/tenant denial, hostile CRDT rejection and legacy-route bypass. History tests include true concurrent restore on MySQL, stale generation rejection, snapshot corruption, authorization and protective-snapshot rollback at capacity. Two-context built-web Chrome tests cover the real editor, exports, pending-edit refresh/recovery and history. Physical devices, all-browser behavior, collaborative undo, cursors and large-board load are still unverified.

## Version API

All routes below require current organization teacher/owner membership. Students cannot enumerate or fetch historical content, even if they can read the current board. The server rechecks and locks membership during writes. Version IDs are always scoped to the authorized board.

| Method | Suffix                       | Body or response                                                                   |
| ------ | ---------------------------- | ---------------------------------------------------------------------------------- |
| GET    | `/versions`                  | At most128 metadata entries, newest first; no snapshot payloads                    |
| GET    | `/versions/:version`         | Saved metadata and authenticated private `state_base64`; integrity checked         |
| POST   | `/versions`                  | `{id,label,expectedGeneration,expectedRevision}`; idempotent identical snapshot ID |
| POST   | `/versions/:version/restore` | `{id,expectedGeneration,expectedRevision}`; idempotent restore-operation ID        |

An expected-state mismatch returns409. Wrong role returns403, a version outside this board returns404, history capacity returns413, and modified content with a mismatching digest returns409. Matching duplicate operations return their original result without duplicating audits or protective snapshots. Changed payload/actor with a reused ID conflicts.

Restore serializes against live edits and access changes. It saves the complete current board as `before_restore`, verifies/rebases the selected snapshot into a fresh Yjs causal history, changes generation, increments revision, stores a NULL-delta boundary receipt and audits the operation in one transaction. If the protective snapshot cannot be saved, the whole restore is rejected and current content remains unchanged. Every subsequent update must carry the new generation. Clients spanning that boundary fetch the complete snapshot; they cannot merge old pending updates into it.

Automatic checkpoints run on edits reaching a revision divisible by25 (restores also advance revision), retaining the latest20 automatic entries. Manual and protective entries are not silently evicted. History is bounded at128 entries and32MiB of base64 snapshot payload per board, plus1000 restore operations. Automatic checkpoints may be skipped at the shared budget limit. These are resource bounds, not measured capacity promises; organization-wide history quotas and user-managed retention remain future work.

The integration supplies local licensed assets and disables unsupported images, embeds and clipboard imports. Collaborative undo, cursors, presenter viewport and load testing remain open. Dependency overrides are retained; earlier advisory results are historical evidence, not a fresh audit of every deployed artifact.
