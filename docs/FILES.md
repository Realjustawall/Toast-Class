# Private file library

Implemented scope: organization and classroom libraries with actual private blobs, persisted metadata, folders, upload progress/cancel, Unicode names, search, pagination, rename/move, byte-preserving copy, authenticated download/ranges, image/text preview and durable deletion. Students read released resources; teachers/owners manage them. Breakout access uses the current authoritative assignment. Course storage and expiring public links remain pending. [Presentations](PRESENTATIONS.md) now prepare resources through a separate worker and isolated converter.

## Storage and configuration

Apply migrations through `npm run migrate`. Migration 007 adds storage quotas, folders and file lifecycle metadata; 008/009 add presentation reservations/assets and invariants. The default quota is 1 GiB per organization; its database value counts reserved uploads, conversion reservations, quarantined/ready files and pending physical deletions. Reservations lock the organization row, so concurrent operations cannot spend the same capacity. Failed deletions retain quota until storage confirms removal. Derived presentation assets are hidden from the resource library and cannot be corrupted through file-mutation endpoints. Referenced active/ready originals must be detached by deleting their presentation before file deletion.

`FILE_STORAGE_DRIVER` accepts `filesystem`, `s3` or `disabled`. Development defaults to filesystem at `FILE_STORAGE_DIR=.local/storage`; production defaults to disabled. Do not expose this directory through a web server. Shared production replicas require shared private object storage. The S3 adapter uses path-style SigV4, immutable UUID keys, explicit byte lengths and bounded requests. Configure `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY` in the deployment secret store. SeaweedFS 4.52 passes the actual operations contract; Garage 2.5.0 failed conditional-create and is not certified. See STORAGE_TESTS.md. This is not full provider API, cluster or durability certification.

`FILE_MAX_UPLOAD_BYTES` defaults to 26214400 and permits 1 through 104857600. `CLAMAV_HOST` and optional `CLAMAV_PORT` (3310) connect to a private clamd INSTREAM endpoint. Scanner failure keeps files quarantined. Automatic scan attempts stop at five; an authorized manager may retry. Production rejects `FILE_ALLOW_UNSCANNED=true`. That flag is explicitly development-only and displays **Not scanned**, never a clean verdict. With no scanner or development override, uploading is unavailable.

Relative `FILE_STORAGE_DIR` values resolve from the process working directory, consistently for TypeScript and compiled server launches. Start both services from the repository/application root, or use absolute paths pointing to the same private store. A Linux worker container needs the API's store mounted at its configured path. Converter output artifacts require the worker's supplemental group `65532`, as in the production Compose file.

## HTTP contract

All routes use the existing authenticated cookie, tenant/object authorization and Origin protection for writes. Prefixes are `/api/v1/organizations/:id` and `/api/v1/classrooms/:id`; the two scopes are independent. Ordinary organization members may read organization resources. Student visibility includes ready files only.

| Method | Suffix                         | Input / behavior                                                                                                            |
| ------ | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/files`                       | `folderId`, literal `search`, optional `before` cursor; 100 files/page, folder metadata, actual usage and permissions       |
| POST   | `/files`                       | One multipart `file`, required `X-Toaster-File-Size`, optional `folderId` query; exact streamed size must match declaration |
| GET    | `/files/:file/content`         | Ready file only; private no-store response, Unicode attachment filename; one byte range supported                           |
| POST   | `/files/:file/update`          | Optional `name`, `folderId` (null means root)                                                                               |
| POST   | `/files/:file/copy`            | Optional `name`, `folderId`; actual independent object, quota reservation, source lineage and new scan                      |
| POST   | `/files/:file/delete`          | Durable removal request; authorized retry resets exhausted cleanup attempts                                                 |
| POST   | `/files/:file/retry-scan`      | Retry a quarantined file                                                                                                    |
| POST   | `/file-folders`                | `name`, optional `parentId`                                                                                                 |
| POST   | `/file-folders/:folder/update` | Optional `name`, `parentId`; cycles and excessive depth rejected                                                            |
| POST   | `/file-folders/:folder/delete` | Empty folders only                                                                                                          |

Limits: 1000 folders per scope, depth 32, 200-character names without separators/control/bidi-spoof characters, 60-second upload receive timeout and 10 uploads/minute/IP. All significant changes are audited. Classroom invalidations synchronize independent clients; organization views also poll. Background cleanup is bounded at eight attempts and exposes errors for manual retry. Stale upload reservations are recovered by the worker. Do not run replicas with process-local invalidations as a certified horizontal deployment.

## Validation and previews

Allowlisted signatures/extensions cover PDF, PNG/JPEG/WebP/GIF, legacy DOC/PPT, DOCX/PPTX and UTF-8 TXT. MIME declarations are not trusted. Images require valid dimension metadata with maximum 16000 pixels per dimension and 16 million pixels total. Office ZIP containers reject excessive expansion, large entries, VBA and ActiveX paths; these checks do not replace a scanner or an isolated converter. Legacy office/PDF checks are signature-level, not complete semantic validation.

Text previews render escaped React text, limited to the first 64 KiB. Image previews use authenticated fetched bytes and revoke local blob URLs on close. Office/PDF execution, HTML/SVG uploads and inline active document rendering are not supported. Downloads are sandboxed with nosniff and attachment headers. Original names and conversion metadata must be preserved when the future conversion subsystem is added.

## Verification boundaries

`tests/files.test.ts` exercises the actual filesystem and SQL/API: role/tenant/scope isolation, byte integrity after API restart, quota races (PostgreSQL), ranges, copies, folder cycles, scan leases/stale verdict rejection, bounded cleanup and audit events. `tests/e2e/files.spec.ts` defines the independent-user UI workflow, mixed Persian/English download, previews, mobile RTL and refresh persistence. Consult VERIFICATION.md for actual executed results.

ClamAV protocol tests use a clearly identified local deterministic TCP test daemon. They verify byte framing and fail-closed verdict parsing; they do not certify a deployed antivirus or malware-detection accuracy. The actual SeaweedFS S3 contract and transactional presentation quota tests pass. Garage failed a required conditional-write contract. Deployed ClamAV, production restore, cross-browser accessibility, processing-resource exhaustion and large-file load tests remain open.
