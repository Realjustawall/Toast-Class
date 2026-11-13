# Encrypted installation backup and recovery

This procedure covers generated single-server installations with private filesystem storage. It does **not** migrate populated PostgreSQL installations to MySQL, back up external S3 buckets, or certify the full product for production. MySQL-to-MySQL recovery is tested separately from schema migrations.

## Operator requirements

Use a trusted Linux operator with access to the Docker socket and cached installation images. Docker access is privileged. The maintenance scripts require Node, or the bundled worker image containing Node and the Docker Compose plugin. No remote storage, npm download or image pull is needed by these operations. Keep the installation and backup directories private. Keep the encryption key separately from both backups and installation exports; a lost key makes recovery impossible.

Stop external database writers and admission traffic. Schedule an outage: the backup stops the previously running web, API, worker and SFU services, keeps MySQL and the scanner available, then resumes those same services. It rejects active classroom sessions unless `--allow-live-interruption` is explicitly supplied. That override interrupts live media. This is an offline maintenance snapshot, not a zero-downtime backup.

## Create and authenticate a snapshot

Create a private key directory and private backup directory first, with mode `0700`. Commands below use absolute example paths; choose fresh filenames.

```sh
node scripts/installation-backup.mjs keygen --key-file /secure-keys/installation.key
node scripts/installation-backup.mjs backup \
  --installation /srv/toaster --maintenance \
  --key-file /secure-keys/installation.key \
  --output /secure-backups/snapshot.toaster \
  --report /secure-backups/snapshot.report.json
node scripts/installation-backup.mjs verify \
  --backup /secure-backups/snapshot.toaster \
  --key-file /secure-keys/installation.key
```

Use `--compose compose.isolated.json` only for the dedicated internal-network test deployment. Normal generated installations use `compose.yaml`.

The archive contains exactly configuration, MySQL SQL, private files, Caddy data and Caddy configuration. Configuration includes secrets; never publish this archive or its key. AES-256-GCM authenticates the entire encrypted stream, with a fresh nonce and a format header authenticated as additional data. Each framed part also has a length and SHA-256 digest. A successful creation report is not evidence of successful recovery.

The final filename is published atomically without overwriting an existing file. Failed writes leave no usable final archive. Service resumption is attempted even after failure. If resumption fails, the maintenance lock remains: inspect the installation and restore service operation before considering removal of that marker. Do not delete it blindly.

## Restore into a new installation

For a Docker-only operator, the cached worker image supplies both Node and Compose. Mount the bundle at `/bundle`, the Docker socket, the installation directory, the separate key directory and the backup directory. Mount host directories at **the same absolute paths inside the operator container**, because the Docker daemon resolves Compose bind paths on the host. Use the immutable `WORKER_IMAGE` identity from the verified bundle, `--pull=never --network=none --user=0:0`. For example, with a verified bundle at `/opt/toaster-bundle` and an already generated key:

```sh
docker run --rm --pull=never --network=none --user=0:0 \
  --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
  --mount type=bind,source=/opt/toaster-bundle,target=/bundle,readonly \
  --mount type=bind,source=/srv/toaster,target=/srv/toaster \
  --mount type=bind,source=/secure-keys,target=/secure-keys,readonly \
  --mount type=bind,source=/secure-backups,target=/secure-backups \
  "$WORKER_IMAGE" node /bundle/scripts/installation-backup.mjs backup \
  --installation /srv/toaster --maintenance \
  --key-file /secure-keys/installation.key \
  --output /secure-backups/fresh-snapshot.toaster
```

For Docker-only restoration, mount a private, empty destination **parent** at its identical absolute host path instead of mounting the original installation. Run `/bundle/scripts/installation-restore.mjs` with a new child destination in that parent, the read-only backup and read-only key mounts. The trusted operator has root-equivalent Docker privileges; these mounts are not a sandbox for untrusted code. Do not run Compose startup, updates, migrations or another backup concurrently with maintenance.

```sh
node scripts/installation-restore.mjs \
  --backup /secure-backups/snapshot.toaster \
  --key-file /secure-keys/installation.key \
  --destination /srv/toaster-restored
```

The destination must not exist. Restoration authenticates a private encrypted copy of the complete archive **before** making an installation. It validates the fixed configuration inventory, cached image identities and all volume archives. It rejects links, traversal, devices, sparse members, duplicate members and oversized archives. It never extracts tar using an unrestricted extraction function.

Only a newly created MySQL service starts. Restoration checks project ownership and an empty schema, imports the SQL using the migration account, restores restricted file ownership and permissions, then compares every restored volume's content fingerprint and a deterministic database dump fingerprint. The database comparison ignores only MySQL 8.4's redundant `CHARACTER SET utf8mb4` spelling before `COLLATE utf8mb4_0900_as_cs` in CREATE TABLE column definitions. Data, string literals, constraints and other schema changes remain significant. Foreign-key orphan checks and unique-key duplicate checks run against actual database metadata.

`restore.verified.json` records the archive digest, database comparison rule, integrity counts and volume evidence. A failed restore retains `restore.failed.json` and its incomplete installation for inspection; do not activate it. Do not retry over that destination. Restore to a fresh path after resolving the failure.

## Admission after recovery

Stop the original installation before activating its replacement. Do not run both against the same application identity, media address or ports. Confirm private file access, original TLS trust, tenant denial, database privileges and application health before admitting users. A snapshot restores security state to its backup time, including authentication sessions and secrets. Review session revocation and rotate compromised credentials before reopening admission; restoring a snapshot does not automatically invalidate previously issued sessions.

Retain an untouched backup and record the restore report outside the running installation. Measure recovery duration and backup age on the target hardware; no RPO/RTO or capacity guarantee is claimed. The current drill uses small test data, not a large production dataset. Actual OS/Docker provisioning, off-site key custody, external storage backup and hardware disaster recovery remain separate operational responsibilities.

## Verification evidence and remaining gates

The isolated Linux/MySQL 8.4 drill has restored a real authenticated session, a Persian classroom message, a private scanned file with identical bytes and the original local TLS CA. Anonymous file access remained denied. A deliberate orphan row was detected and removed in the dedicated restored test database. Wrong keys, modified ciphertext and existing destinations were rejected. A real constrained tmpfs produced ENOSPC without publishing a partial final backup; previously running services resumed and the lock cleared. The tests never use the user's preview database.

Unit tests cover framing/chunking, authentication before consumer callbacks, truncated/corrupt archives, no overwrite and protection from changes to the original archive after verification. Python archive tests cover extraction permissions and unsafe member rejection. These gates do not prove high-volume performance, arbitrary schema support or full product completion. Re-run the dedicated recovery workflow after changes to the backup format, schema or deployment images.
