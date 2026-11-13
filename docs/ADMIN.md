# Organization administration

The current panel is an owner-only operations subset. It does not fulfill all 27 required administrative sections.

Open **Administration / مدیریت سازمان** from the organization sidebar. Operations shows persisted member/classroom/session counts, storage committed by files plus presentation reservations, and current file/conversion states. Active sessions are limited to the latest 100 and can be opened through the normal authorized classroom route. There are no invented connection counts, CPU metrics or engagement scores. Refresh explicitly requests fresh data and displays the collection time.

Members lists only this organization's users (25 per page). Audit lists operational identifiers, actor names, resource IDs and timestamps (25 per page), with an optional exact action filter. It deliberately excludes event details, private messages, media and file contents. It does not bypass classroom/recording authorization.

All endpoints recheck the cookie session and require the organization's existing `owner` role. Teachers, students, anonymous users and owners of other organizations are rejected. Platform-owner/school/support roles and contextual role administration remain outstanding. No user role mutation control is shown until safe live media/session revocation is integrated.

## API

- `GET /api/v1/organizations/:id/admin/overview`
- `GET /api/v1/organizations/:id/admin/members?offset=0&limit=25`
- `GET /api/v1/organizations/:id/admin/audit?offset=0&limit=25&action=session.started`

Limits: 1–100 rows; offset 0–100000. Audit action is an exact identifier, at most 120 lowercase ASCII letters/digits/underscores/dots. Pages return `{items,hasMore}`. Offset pagination can shift if records change during navigation. Overview comprises independently collected server queries, not a transactionally frozen monitoring snapshot. A collection timestamp is provided. Database migration 011 adds tenant/time and tenant/action/time indexes.

`tests/admin.test.ts` passes with real PostgreSQL and pg-mem: actual session start/end, persisted counts, role/tenant/anonymous denial, bounded pagination, filtering and absence of password/details exposure. `tests/e2e/admin.spec.ts` passed in installed Windows Chrome for operations, members, exact audit filtering, session end/refresh and Persian mobile. Actual screenshots: [English](screenshots/admin-operations-en.png), [Persian mobile](screenshots/admin-operations-mobile-fa.png).

Remaining: contextual RBAC and role changes, tenant lifecycle, schedules, course/event management, recordings, security/device controls, actual node/queue health, integrations, notifications, API keys, backups and all other unimplemented master sections. Payments/billing are excluded by the user's latest scope update.
