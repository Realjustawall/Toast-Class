# Presentation API and operation

Implemented and tested: durable preparation jobs, PDF/TXT/DOCX conversion, separate worker, private outputs, output scanning state, teacher-controlled pages, thumbnails, zoom/fit/scroll/fullscreen, original/PDF downloads, optional independent browsing, refresh recovery, English/Persian and mobile RTL. This is not full feature parity: slide annotations, exports with annotations, snapshots, board import, additional format fidelity, operational recovery/security stress tests and clean deployment are pending.

## Enable and run

1. Apply migrations: `npm run migrate`.
2. On a Linux Docker host, build the image and run the real converter checks in [CONVERSION.md](CONVERSION.md).
3. Configure API and worker with `PRESENTATIONS_ENABLED=true`, identical PostgreSQL/private storage settings and a scanner. `CONVERSION_IMAGE` defaults to `toaster-converter`; `CONVERSION_WORK_DIR` chooses private staging.
4. Run the API normally and `npm run dev -w apps/worker` as a separate trusted process. The worker requires Docker CLI/daemon access; the API service user must have no Docker socket/group access. Production service units and distribution remain pending.
5. Upload a resource in a classroom's Files panel, choose Prepare presentation, wait for its actual state to become Ready, start the classroom session and choose Present document.

Shared environment parsing rejects unscanned production bypasses. In explicit development mode, outputs may be released with the **unscanned** label. Actual end-to-end tests use this mode and do not certify antivirus deployment. Source files and generated assets remain private. Derived files cannot be corrupted through public file rename/copy/delete actions; original sources are protected against deletion while active/ready presentations reference them.

The content route itself checks that a derived asset belongs to the current generation of a ready presentation. Knowing an output UUID cannot bypass whole-presentation publication, even when that individual file has already finished scanning. Original resource downloads retain their normal classroom/organization permissions.

Each request transactionally reserves 100 MiB of output quota. Assets convert this reservation to actual file bytes; completion releases unused reservation. Physical cleanup retains used bytes until storage confirms removal. Jobs claim exclusively and refresh a three-minute lease every 30 seconds. Stale claims/generations cannot publish. Lost leases and exhausted scan attempts become visible failures; managers can retry after active blobs are removed. A still-live final scan retains its lease, and an already-removed infected asset does not permanently block retry. Every attempt gets a fresh generation.

## API

Prefix: `/api/v1/classrooms/:id`. Existing cookie, tenant/object, Origin and child-room assignment guards apply. Teacher/owner mutations are enforced server-side. Source files must be released resources in the same classroom or organization.

| Method | Suffix                                | Contract                                                                                                                                   |
| ------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| GET    | `/presentations`                      | Capability, role, latest 100 visible jobs, sessionId, monotonic revision and current page/policy; students see ready jobs only             |
| POST   | `/presentations`                      | `{fileId,name?}` -> 202 persistent queued job                                                                                              |
| GET    | `/presentations/:presentation`        | Authorized metadata, original-download route and asset file IDs; pending jobs are hidden from students                                     |
| POST   | `/presentations/:presentation/retry`  | Failed jobs only; requires confirmed prior cleanup and available quota                                                                     |
| POST   | `/presentations/:presentation/delete` | Clears current views and queues actual output deletion; a processing job must finish/expire first                                          |
| POST   | `/presentations/control`              | Show: `{action:'show',sessionId,presentationId,page,independentView,expectedRevision}`; hide: `{action:'hide',sessionId,expectedRevision}` |

Readiness, page bounds, active session and revision are authoritative. Hide retains a revision tombstone, preventing stale hide/show resets. Commands from an ended session cannot control a new session whose revision starts at zero. Privileged changes are audited. Disabling independent browsing immediately restores the teacher's page. Teacher control permissions remain limited to the current three-role foundation; full contextual RBAC is still pending.

## Verification

- `tests/presentations.test.ts`: real PostgreSQL authorization, isolation, quota, claims, publication, scan failure/lease state, stale command rejection, deletion and retry. Control fixtures are explicitly seeded test raster assets, not evidence of conversion.
- `scripts/test_converter.py`: actual isolated PDF/TXT/DOCX conversion, integrity checks and malformed/excessive-page rejection.
- `tests/conversion.test.ts`: hostile manifest rejection plus actual PDF/DOCX worker, storage, API and failed-input workflow; enable `TEST_CONVERSION_DOCKER=true` with a dedicated PostgreSQL test database.
- `tests/e2e/presentations.spec.ts`: actual converter and two independent users, page sync, reload, independent browsing and revocation, exact original download, DOCX presentation and Persian mobile. [English screenshot](screenshots/presentations-en.png), [Persian mobile screenshot](screenshots/presentations-mobile-fa.png).

Browser fixtures spawn a separate worker restricted to their generated test schema. Containerized trusted test runners need the Docker CLI/socket and a staging mount visible at the same absolute path to the daemon; this is test infrastructure, not an API deployment recommendation. The native Linux CI equivalent is defined in `.github/workflows/conversion.yml`; it has not run remotely. Action versions were checked against the official checkout/setup-node/upload-artifact release pages on 2026-11-06.

Automatic conversion backoff/retry, orphan-workspace retention, garbage collection for uncertain late provider writes, queue fairness/pagination beyond current bounds, worker operational metrics and resource-exhaustion testing remain open. An explicit teacher retry is available and audited. Distribution-provided Noto/DejaVu/Liberation fonts do not guarantee fidelity to arbitrary source fonts/layouts.
