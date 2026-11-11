# Security boundaries and verification

Browser controls are convenience controls; server-side authorization is the permission boundary.

Implemented controls include salted scrypt password hashes, random session tokens stored as digests, production HttpOnly/Secure/SameSite cookies, exact Origin checks on mutations, schema/body limits, parameterized SQL, transactional row locks, conflicting-edit revision checks, per-user request budgets and scoped audit events.

Classroom roles, enrollment, removal and interaction permissions are checked on protected requests. Public/private chat have independent persisted switches. Private queries are restricted to the authenticated sender/recipient pair; socket notifications target those identities without message content. Only the sender may edit/delete a private message. Public messages retain sender/moderator deletion. Disabling writing preserves readable history. Private messages are stored server-side, not end-to-end encrypted; host/database administrators are trusted.

Student image messages require an explicit grant. Uploads validate type/size, pass antivirus scanning and require scoped attachment permissions; production refuses unscanned files. Scanning failures reject uploads. The installer keeps database, scanner, API and upstream SFU signaling on loopback. Only the authenticated application gateway exposes signaling; media grants/revocations depend on this boundary. The SFU can access media: no E2EE claim is made.

The installer creates separate runtime/migration/root credentials and a one-time administrator before public startup. It closes registration, refuses to hijack existing non-administrator accounts and never rotates existing administrator passwords. Only the optional trusted conversion worker receives Docker socket access. That worker has host-level trust; web/API containers must never receive that socket.

Rich text uses a bounded Markdown/React renderer: raw HTML becomes text and links restrict schemes. Formula rendering disables KaTeX trust and bounds expansion/size. Production Caddy applies a CSP. GeoGebra runs on an isolated origin with checked frame/source/token messages; its origin does not proxy authenticated APIs. Input hints are retained because they are real form guidance, not mock functions.

Tests cover cross-tenant requests, message ownership/isolation, CSRF, stale revisions, concurrent sends, queued requests during revocation, scoped files and media lock enforcement. Browser tests cover public/private controls, unread behavior, formatting, responsive overflow and compact layouts. Tests do not prove the absence of all vulnerabilities.

Limits: no external penetration-test certification, no certified 800-user media capacity, no E2EE and no centrally coordinated rate limiter across API processes. Use one API instance unless coordinated limits/fanout are supplied. Download controls cannot stop an authorized recipient from retaining displayed content; they are not DRM. Operators must define retention, backup, account recovery and access policies. Restrictive networks can require separate TURN/TLS configuration.

Run `npm audit --audit-level=high` on a network-enabled machine; CI includes dependency auditing. An unavailable registry check is not a clean audit. Release inventory excludes local credentials, databases, caches and browser binaries. Never publish private installation files or unredacted Compose output.
