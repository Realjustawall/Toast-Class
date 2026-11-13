# Installer and independent chat controls — 2026-11-11

Implemented private participant-to-participant text conversations, targeted unread notifications, sender edits/deletion and independent persisted public/private chat switches. Protected requests recheck membership, policy and interaction locks; stale policy revisions and concurrent duplicate sends are covered. Public categories remain moderator-managed. Private images are deliberately unavailable.

The English Linux installer supports dry-run plans, configuration-only generation, initial setup, resuming and readiness diagnostics. It generates separate secrets, migrates MySQL, bootstraps the first administrator once, closes public registration and configures trusted HTTPS with an isolated math origin. Office conversion is optional. The frontend hides its unavailable presentation-library control when conversion is disabled.

The source distribution uses an allowlist, per-file hashes, a checksum and size budgets. Dependencies, generated vendor/WASM assets, browser binaries, local databases, credentials, logs and test evidence are excluded. Required Dockerfiles and extensionless Caddy configuration are explicitly checked. The extracted ZIP can generate installation configuration without host npm dependencies. Runtime images/signatures remain necessary external downloads.

Validation evidence includes native MySQL authorization/bootstrap tests; public/private and category browser scenarios; four-layout compact chat tests in Persian/English across desktop/mobile/short viewports; source ZIP extraction/configuration; TypeScript and server/web builds. The built application was also served under the production CSP: board and private-chat controls loaded without CSP violations or page errors. Zod browser validation runs without dynamic code generation and the Excalidraw production transform removes its public font fallback.

The preview migration to MySQL version 023 preserved the existing 2 users, 5 classrooms, 5 messages, 11 documents, 1 GeoGebra document and 6 board states. No preview credentials are published.

Environment limits: Docker and public DNS/ACME deployment cannot be exercised on this Windows workspace. Installer CI covers clean image builds, Compose/Caddy validation, repeated bootstrap and protected API startup. The local npm audit request was blocked by network access; this is not a clean dependency-audit result. CI runs dependency auditing. A deployment still requires external audio/video and firewall acceptance. Full PDF Annotator parity and 800-user media capacity remain outside the verified result.

See [INSTALL.md](INSTALL.md), [SECURITY.md](SECURITY.md) and the checked-in tests for exact behavior.
