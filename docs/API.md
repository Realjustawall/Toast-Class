# API v1

Owner-only organization operations endpoints and pagination are documented in [ADMIN.md](ADMIN.md). The new advanced board format, generation/revision synchronization and server validation are documented in [ADVANCED_BOARDS.md](ADVANCED_BOARDS.md); the legacy board UI is preserved while editor integration continues.

JSON requests/responses. All POST requests require an `Origin` header equal to APP_ORIGIN. Authentication uses the `toaster_session` HttpOnly cookie. No bearer API keys yet. Errors return `{error: string}`; validation adds `issues`. Typical codes: 400 validation, 401 authentication, 403 membership/role/origin, 404 missing object, 409 duplicate, 429 rate limit, 503 unconfigured media.

| Method | Route (prefix /api/v1)         | Body / result                         | Authorization                 |
| ------ | ------------------------------ | ------------------------------------- | ----------------------------- |
| POST   | /auth/register                 | email, password (12–128), name → user | Public; 5/min/IP              |
| POST   | /auth/login                    | email, password → user + cookie       | Public; 10/min/IP             |
| POST   | /auth/logout                   | {} → ok                               | Revokes supplied cookie       |
| GET    | /me                            | user                                  | Session                       |
| GET    | /organizations                 | [{id,name,role}]                      | Current memberships           |
| POST   | /organizations                 | name → organization                   | Session, grants creator owner |
| POST   | /organizations/:org/members    | email, role: teacher/student → ok     | Organization owner            |
| GET    | /organizations/:org/classrooms | [{id,name,created_at}]                | Organization member           |
| POST   | /organizations/:org/classrooms | name → classroom                      | Owner or teacher              |
| POST   | /classrooms/:id/join           | {} → token,url,room                   | Organization member           |
| GET    | /classrooms/:id/messages       | Latest 100 ascending                  | Organization member           |
| POST   | /classrooms/:id/messages       | body (1–2000) → id                    | Organization member           |

Infrastructure: GET /health (liveness), GET /ready (database connectivity). Full OpenAPI, pagination, idempotency keys, API keys, webhooks and external integration contracts are not implemented. The message history limit is not a retention policy; older messages remain stored.

## Teaching API (prefix /api/v1/classrooms/:id)

| Method          | Suffix                  | Body                                                        | Policy                                                        |
| --------------- | ----------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| GET / WebSocket | /live                   | Cookie + allowed Origin                                     | Organization member; read-only invalidations                  |
| GET             | /teaching               | none                                                        | Member; serverTime, role, active session, hands, polls, timer |
| POST            | /session/start          | {}                                                          | Teacher/owner; at most one active session                     |
| POST            | /session/end            | {}                                                          | Teacher/owner; ends polls; preserves documents                |
| POST            | /hand                   | raised, optional userId                                     | Self; teacher can lower another user                          |
| POST            | /polls                  | question, options, optional durationSeconds                 | Teacher; creates open single-choice poll                      |
| POST            | /polls/:poll/vote       | choice index                                                | Member; one response, server deadline                         |
| POST            | /polls/:poll/control    | action: pause/resume/end/publish                            | Teacher; validates transitions                                |
| POST            | /timer                  | action: start/pause/resume/reset, durationSeconds for start | Teacher; server-authoritative                                 |
| GET             | /documents              | none                                                        | Member                                                        |
| POST            | /documents              | name, kind: notes/board, teacherOnly                        | Teacher                                                       |
| GET             | /documents/:doc         | none                                                        | Member; metadata + Yjs update log                             |
| POST            | /documents/:doc/updates | id UUID, update base64                                      | Member unless teacherOnly; bounded validated Yjs              |

WebSocket messages are {type: ready/changed}; clients cannot submit mutation commands through the socket. Private poll counts are omitted for students until published. Rate limits: 600 requests/min/IP global, stricter registration/login limits. Document saves are delayed 250 ms to avoid one request per keystroke; the append-only log still needs compaction and incremental retrieval for large deployments.

## Media attendance

POST /api/v1/media/webhook accepts only raw application/webhook+json with a LiveKit-signed Authorization JWT including the body SHA-256. It is the sole mutation exempt from browser Origin checks; signature validation is mandatory. Event IDs provide transactional replay deduplication. GET /api/v1/classrooms/:id/attendance is teacher/owner-only and returns observed connections plus per-user union durations; no join is inferred from token issuance.

Join now requires an active classroom session. The returned URL points to TOASTER's authenticated signaling gateway, not the upstream SFU. See [media API/control details](MEDIA_CONTROL.md) for permission, participant and command endpoints.

## Breakout API

All routes below use `/api/v1/classrooms/:id` for the main classroom. GET `/api/v1/classrooms/:id` returns authorized room metadata, including `parent: {id,name,groupId}` for child rooms. The child assignment guard applies to all child data routes.

| Method | Suffix                     | Body / response                                                                                                                                             | Policy                                                                 |
| ------ | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| GET    | /breakouts                 | Last 10 groups, authorized rooms, assignments, announcements, destination, serverTime; managers also receive students/documents/live counts                 | Organization member; students see their assignment or selectable rooms |
| POST   | /breakouts                 | rooms: [{name}], durationSeconds, allowSelfSelect, allocation: {mode:'manual',assignments:[{userId,roomIndex}]} or {mode:'balanced-random',userIds:[]} → id | Teacher/owner; active main session                                     |
| POST   | /breakouts/:group/assign   | userId, roomId (null for main)                                                                                                                              | Teacher/owner or self when allowed; self return always allowed         |
| POST   | /breakouts/:group/extend   | seconds (30–86400)                                                                                                                                          | Teacher/owner; active group                                            |
| POST   | /breakouts/:group/close    | {}                                                                                                                                                          | Teacher/owner; idempotent closure                                      |
| POST   | /breakouts/:group/announce | body (1–2000)                                                                                                                                               | Teacher/owner; active group                                            |
| POST   | /breakouts/:group/import   | documentId → new main document id                                                                                                                           | Teacher/owner; source must belong to that group                        |

Parent media command status and retry include child cleanup commands. See [breakout protocol and limits](BREAKOUTS.md).

## Files

Organization and classroom file libraries use authenticated private content routes, multipart uploads with declared sizes, role-controlled folders/copy/delete and real storage quotas. See [the file API contract, configuration and limits](FILES.md). Use the separate presentation API for conversion and shared page control.

The [presentation API](PRESENTATIONS.md) implements preparation jobs and server-authoritative page/policy control. Use sessionId and expectedRevision for every control mutation. Original/private output downloads remain authorized file routes. Annotations and advanced exports remain pending.

## Advanced whiteboard history

The [board protocol and version API](ADVANCED_BOARDS.md) cover generation/revision-fenced CRDT updates, teacher-only snapshot listing/creation/preview, audited restoration and duplicate-operation receipts. Use `expectedGeneration` and `expectedRevision` for saving/restoring, plus a stable request `id` for retries. History reads are stricter than current-board reads. The [editor guide](WHITEBOARD.md) explains pending-change quarantine after a restore.
