# Native MySQL: application cutover and verification

MySQL supersedes the original PostgreSQL recommendation. The full existing API, separate presentation worker and trusted administrator CLI now use the native MySQL backend selected by DATABASE_URL. The persistent local preview switched to MySQL 8.4.13 on 2026-11-06; its address remains http://localhost:5173. This is a database milestone, not completion of the platform or production security certification.

Implemented native foundation:

- `mysql2/promise` pool with UTF-8, UTC server/client time, exact bigint strings, bounded pool queue, optional verified TLS CA/server identity and `multipleStatements:false`. Remote production TLS remains untested.
- Prepared `execute` helpers; no string-based PostgreSQL translation layer.
- Explicit READ COMMITTED transaction helper with commit/rollback and connection release.
- Six native migrations in `packages/database/mysql` cover all currently implemented identity, organizations, classroom/media sessions, teaching/CRDT, breakout, file and presentation tables. Foreign keys, tenant composite keys, unique active keys and checks preserve existing invariants. UUIDs are supplied by application code. Future recording/LMS/event schemas remain pending their feature implementations.
- `scripts/migrate-mysql.ts`: namespaced GET_LOCK, checksummed migration records and durable applying/complete/failed states. MySQL DDL commits implicitly; partial failure deliberately requires operator repair rather than pretending a transaction rolled it back. Trusted migration files use `-- statement` separators. App data queries use prepared execution, not this DDL path.

`npm run migrate` dispatches by DATABASE_URL protocol. `npm run migrate:mysql` also supports MYSQL_DATABASE_URL. Explicit dialect branches replace RETURNING/upsert/ILIKE/cast differences; the numbered-binding compiler does not translate SQL semantics. Millisecond CURRENT_TIMESTAMP(3) fixes a real outbox timing failure found during native testing. Applied migrations must not be edited.

## Actual evidence

Official `mysql:8.4` was pulled at digest `sha256:a81d043930e51745522bd5c430961cf8286f0a23f0a9a2a6e0108f7ea71b0902` and runs locally as **MySQL 8.4.13** on loopback 13306. It is a separate test server, not the preview database. Credentials are generated into ignored .local files and never printed.

`tests/mysql.test.ts` passed against that real server: native migration and idempotent rerun, prepared SQL-shaped Unicode/emoji data, hostile login-shaped value isolation, multi-statement rejection, rollback, foreign-key enforcement and migration checksum drift rejection. Each run creates/drops only its validated generated test database. Set TEST_MYSQL_ADMIN_URL to a dedicated administration database ending in `_test` to enable it. It is skipped without real MySQL, not replaced by a simulator.

## Cutover and recovery evidence

The preview API was stopped, a PostgreSQL custom-format backup was saved and the source database retained. Complete source/target table inventories were compared; every application table was confirmed empty under source locks, then registration settings were copied transactionally. Only then was the local connection changed and the API restarted. Any populated table would have refused this restricted cutover. There was no user/classroom content to transfer. Original configuration and backup remain private ignored files. Health and registration status passed through the original origin after switching. Preview MySQL is separate from disposable test databases. A general populated PostgreSQL-to-MySQL data-transfer tool is not implemented; never repoint a populated installation and call it migration.

Additional executed native gates: actual S3/isolated converter contracts, independent-browser synchronized presentation, real-SFU classroom and breakout isolation. Concurrent migration runners serialize; a deliberately interrupted DDL migration retains its first table, records failure and refuses automatic rerun. Registration waits behind an in-flight closure without stale-open signup or orphan security events.

`tests/mysql-recovery.test.ts` passed an actual dump/restore drill using the locally cached official client image with `--pull=never`. It restores into another generated database, compares canonical SHA-256 contents of every table and the complete table inventory, then rechecks foreign keys and injection boundaries. Fixtures include Persian/emoji/SQL-shaped strings, nested JSON, registration state and actual Yjs bytes. This does not certify a populated production backup or matching object storage recovery. Enable TEST_MYSQL_RECOVERY_DOCKER=true with the native MySQL test variables on Linux to repeat it.

The Compose definitions now select MySQL. Offline image packaging, internal CA trust, scanner signatures, production least-privilege/TLS validation, retention/recovery automation, load/chaos/security review and clean all-service installation remain required. The initial app image predates this cutover and must be rebuilt. No zero-vulnerability or arbitrary-capacity claim is made. See PROGRESS.md for exact aggregate test results.

Sources: [MySQL 8.4 prepared statements](https://dev.mysql.com/doc/refman/8.4/en/sql-prepared-statements.html), [MySQL2 documentation](https://sidorares.github.io/node-mysql2/docs).

Least-privilege gate: tests/mysql-privileges.test.ts passed with a generated application account holding only SELECT/INSERT/UPDATE/DELETE on its generated schema. Real registration, login, organization and classroom creation work; CREATE TABLE, DROP TABLE and mysql.user credential reads are denied, with original application data preserved. Production migration/runtime role provisioning, remote TLS and worker/storage deployment still require verification. A native MySQL GitHub workflow is added for API/recovery/built-web gates; it has not been remotely executed or pushed.
