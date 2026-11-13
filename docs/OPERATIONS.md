# Operations

The foundation is not production-certified. Native WSL PostgreSQL and LiveKit tests have run, but no clean production deployment, TURN-only test, capacity benchmark or recovery drill has run.

## Environment

| Variable            | Purpose                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| DATABASE_URL        | MySQL application-user connection string, required                     |
| APP_ORIGIN          | Exact browser origin for mutation CSRF checks                          |
| PORT                | API port, default 3001                                                 |
| LIVEKIT_URL         | Private API-to-SFU ws/wss endpoint; the browser uses TOASTER's gateway |
| LIVEKIT_API_KEY     | LiveKit server key ID                                                  |
| LIVEKIT_API_SECRET  | Matching secret, at least 32 characters                                |
| NODE_ENV            | production enables Secure cookie                                       |
| MYSQL_PASSWORD      | Compose MySQL application-user password                                |
| MYSQL_ROOT_PASSWORD | Separate MySQL bootstrap root password; never use in application URL   |

## Ubuntu deployment candidate

Install Node 24, Docker/Compose and Caddy. Configure firewall: HTTPS 443; LiveKit TCP 7881 and UDP 50000–50100. Restrict MySQL and SFU signaling (7880) to localhost or the private application network. Clone source, `npm ci`, create secrets, start infrastructure, migrate, build web. Serve dist through Caddy using the example config. Run `npm exec tsx apps/api/src/main.ts` under a dedicated system service with a working directory at repository root and environment file readable only by that account. Set APP_ORIGIN=https://learn.example.org and LIVEKIT_URL=ws://127.0.0.1:7880. Set NODE_ENV=production. Ensure API port 3001 and signaling port 7880 are accessible only through the reverse proxy. A TLS reverse proxy alone does not relay UDP media.

The basic development Compose does not enable TURN. The offline draft and local SFU test configuration include embedded TURN, but relay-only verification remains pending. Restrictive networks will fail without TURN; follow LiveKit official deployment instructions to add authenticated TURN/TLS and test relay-only connections. The compose file intentionally remains development infrastructure. Private filesystem/S3 and isolated presentation workers are implemented. Production Docker definitions exist, but the app image must be rebuilt after MySQL changes; Redis, recording, metrics, backup automation and clean installation remain pending.

## Database migration / backup

`npm run migrate` selects the native MySQL migration runner from DATABASE_URL. It serializes with GET_LOCK and verifies migration checksums. DDL commits implicitly: applying/failed status stops for operator repair rather than pretending rollback. The retained PostgreSQL regression runner uses its original transactional advisory lock. Back up before changing schema. The runner discovers numbered SQL migrations; rollback means restore, not a destructive down migration. Never edit an already-applied migration; add a new numbered migration.

Use MySQL 8.4 client tools and a private `--defaults-extra-file` outside source control; never put passwords in command-line arguments. Quiesce schema changes, then take a `mysqldump --single-transaction --no-tablespaces --set-gtid-purged=OFF --hex-blob --column-statistics=0` backup of the application schema. Encrypt and checksum it, store off-host and retain the matching private storage snapshot/configuration. Restore into a separate empty schema with the MySQL client, verify all table inventories/contents, constraints, migration checksums and authenticated application behavior before switching any connection. Do not overwrite a live schema.

`tests/mysql-recovery.test.ts` passed this dump/restore pattern against generated isolated databases, including canonical hashes for every table, Persian/Yjs/JSON fixtures and foreign-key checks. It uses a locally cached client container with `--pull=never`. Production automation, encryption/retention, a populated installation and matching storage recovery remain unverified. The local PostgreSQL source and its private pre-cutover dump remain retained; the empty-preview cutover did not discard application data.

## Troubleshooting

- Missing DATABASE_URL: copy `.env.example` and configure credentials.
- Missing relations: run migrations before API.
- 403 on POST: APP_ORIGIN must match protocol, host and port of the frontend.
- 503 on join: configure matching media key and secret.
- Signaling connects but no audio: check UDP routing, advertised external IP, HTTPS device permissions and TURN configuration.
- Cannot add member: account must already exist; invitation onboarding is pending.
- Multiple API replicas: not supported until shared rate limits/realtime coordination are implemented.

Use readiness for database health, liveness only for process health. Rotate media keys in both API and SFU during a coordinated maintenance window. Rotate database passwords in the server and API together. Avoid deleting PostgreSQL volumes during upgrades.

## Test environment: native WSL alternative

The implementation environment now has PostgreSQL 16 and LiveKit 1.13.11 in an Ubuntu 24.04 WSL distribution, with random test-only credentials under ignored .local/. This is not the documented production installation and does not certify Compose. Use TEST_DATABASE_URL with a dedicated database whose name ends in _test; tests create randomized schemas and clean them on graceful exit. Forced Windows process termination may leave isolated test schemas behind; remove them only from the dedicated test database.

Browser test API defaults to port 33001 and Vite proxies to it through TOASTER_API_TARGET. Development still defaults to API port 3001. On Windows, inspect excluded TCP port ranges if binding returns EACCES; set PORT and TOASTER_API_TARGET to an available port. Do not change system port reservations.

Media test command: set TEST_MEDIA_URL to the reachable ws/wss endpoint, TEST_MEDIA_KEY and TEST_MEDIA_SECRET to the matching temporary SFU credentials, then run npm run test:media. Physical remote devices require trusted HTTPS/WSS; private WSL IP addresses are only a local test setup.

For signed attendance callbacks, set LiveKit webhook.api_key to the configured API key and webhook.urls to the externally reachable /api/v1/media/webhook URL. The receiver expects application/webhook+json with the original raw body. In the WSL integration test only, TEST_API_HOST=0.0.0.0 allowed the Linux SFU to contact the temporary Windows test API, and TEST_MEDIA_WEBHOOKS=true enabled actual callback assertions. No firewall rules were changed. Use trusted HTTPS in production.

Media signaling now uses the same-origin application gateway. Never expose a reverse proxy directly to SFU port 7880, because doing so bypasses fresh membership/session/policy checks. The Compose/Caddy examples enforce this at their documented boundary; clean deployment/firewall validation remains pending. Media command status and failed-command retry are available in Participants. See MEDIA_CONTROL.md for the durable command and revocation protocol.

## Files and presentation worker

Configure private storage/scanning with [FILES.md](FILES.md). SeaweedFS 4.52 has passed the actual S3 operations contract, but cluster durability/restore and container deployment have not been certified. The deployment key must be restricted to its private bucket; filer/master/volume endpoints must remain inaccessible to end users. Never serve the filesystem storage directory directly.

For [presentations](PRESENTATIONS.md), apply migrations, build `infrastructure/docker/Dockerfile.converter`, set `PRESENTATIONS_ENABLED=true` in API and worker, and run `npm run dev -w apps/worker` on a Linux Docker host. Both processes need the same database/storage configuration. `CONVERSION_IMAGE` defaults to `toaster-converter`; `CONVERSION_WORK_DIR` is private staging. Separate service users so the API has no Docker group/socket permissions. Only the trusted worker can orchestrate containers; the untrusted document container receives no network, credentials or Docker socket. Production units and a clean installation/update/recovery drill remain pending.

Each queued conversion reserves 100 MiB. Output scanning must finish before presentation release. Lost processing leases and exhausted scanning attempts become visible failures; authorized retry requires prior physical cleanup. Production rejects `FILE_ALLOW_UNSCANNED=true`; development tests using that flag do not certify a deployed scanner. Retain package notices and meet corresponding-source obligations before redistributing converter images.
