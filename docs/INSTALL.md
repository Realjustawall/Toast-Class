# English installation and domain setup

## Requirements

Use a Linux Docker host, Node.js 24+, Docker Engine and the [Compose v2 plugin](https://docs.docker.com/compose/install/linux/) version 2.24+. The installer uses built-in Node modules; application dependencies are installed inside image builds from the lockfile.

Allow at least 4 GiB RAM for the scanner/core services; 8 GiB is recommended. This is an installation minimum, not a classroom-capacity guarantee. Keep approximately 15 GiB free for image builds/signatures, plus uploaded files and database growth. Builds and optional Office conversion need additional resources.

Run with Docker access. Optional conversion also requires permission to set ownership on its host jobs directory. Do not expose the Docker socket over a network.

## DNS and firewall

For application domain `class.example.com`, create DNS-only A records for `class.example.com` and `math.class.example.com`, both pointing directly to the server's public IPv4. GeoGebra uses the second origin. Remove AAAA records for this IPv4 installation. Disable CDN/HTTP proxying during setup; DNS checks require the configured address.

| Public port | Protocol | Purpose                                             |
| ----------- | -------- | --------------------------------------------------- |
| 80          | TCP      | Certificate validation and HTTPS redirect           |
| 443         | TCP      | Application HTTPS and authenticated media signaling |
| 7881        | TCP      | ICE media fallback                                  |
| 50000–50100 | UDP      | Media transport                                     |
| 3478        | UDP      | Embedded STUN/TURN                                  |
| 40000–41000 | UDP      | TURN relay allocation                               |

No existing service may occupy these ports. Restrict administrative SSH separately. Forward media ports to the same host when behind NAT. The configured public IPv4 is advertised to browsers.

MySQL 3306, API 3001, scanner 3310 and upstream SFU signaling 7880 bind to loopback and must stay private. The application proxies signaling at `/api/v1/media/signal`; exposing LiveKit signaling directly bypasses that authorization boundary.

Caddy obtains/renews certificates using [automatic HTTPS](https://caddyserver.com/docs/automatic-https). See [LiveKit's port requirements](https://docs.livekit.io/transport/self-hosting/ports-firewall/). The default includes UDP TURN; networks requiring TURN over TLS/443 need a separately configured TURN/TLS endpoint and certificate. Doctor cannot verify every external media network path.

## Install

Keep source and private state separate:

```sh
git clone https://github.com/Realjustawall/Toast-Class.git /opt/toaster/source
cd /opt/toaster/source
sh install.sh install --directory /opt/toaster/instance \
  --domain class.example.com --media-ip YOUR_SERVER_PUBLIC_IPV4 \
  --email admin@example.com
```

Replace the domain, email and IP. Run `sh install.sh` without options for English prompts. Use `--help` to list commands. Source paths must be absolute Linux paths without spaces or shell interpolation. The installation directory must be new and outside the source tree.

The installer checks prerequisites/DNS, creates separate runtime/migration/root/media secrets, builds images, waits for MySQL, applies checksum-verified migrations, creates the administrator before public startup, starts services and verifies readiness/HTTPS/math isolation. It never deletes volumes or overwrites an existing installation directory.

GeoGebra's pinned download is SHA-256 verified. ClamAV signatures persist in a shared volume and FreshClam updates them; the scanner reloads changed signatures periodically. Uploads fail closed when scanning is unavailable. Dependencies, container images and scanner signatures are necessary installation downloads, separate from the thin source ZIP.

## Initial administrator

The email is the address supplied above. The generated random password is stored locally in `INSTANCE/installation/admin-password`; it is not printed or passed in arguments/environment. Read it with administrative access, store it securely and change it through account settings. The installation parent is private (0700); service-mounted files are readable inside their trusted containers.

To choose a password, create a private single-line file (0600) and pass `--password-file /private/admin-password`. Passwords require 6–128 characters with no mandatory character mix. Do not put passwords directly in shell commands.

An existing administrator makes bootstrap a no-op; retries never rotate credentials. An email belonging to a non-administrator account is not automatically promoted. Use the audited `admin:grant` recovery command for an intentional promotion. Public registration starts closed; enable it in platform administration when ready.

## Optional Office conversion and Redis

Add `--documents` to the initial install/configure command to build LibreOffice/Poppler and start the trusted conversion worker. Only that worker receives the Docker socket. Without this option, those images/services are omitted and the unavailable presentation-library control is hidden. Browser PDF import, annotations/export, boards and regular file uploads remain available.

Redis is optional and is not bundled. Run an authenticated Redis service on loopback/private networking, set `REDIS_URL` in the private `.env`, then recreate the API. Unavailable Redis falls back to database-backed behavior; protected permissions are checked against MySQL. Redis is not the authoritative permission store.

## Configuration-only and resuming

```sh
sh install.sh plan --directory /opt/toaster/instance \
  --domain class.example.com --media-ip YOUR_SERVER_PUBLIC_IPV4 --email admin@example.com
sh install.sh configure --directory /opt/toaster/instance \
  --domain class.example.com --media-ip YOUR_SERVER_PUBLIC_IPV4 --email admin@example.com
sh install.sh start --directory /opt/toaster/instance
sh install.sh doctor --directory /opt/toaster/instance
```

`plan` writes nothing; `configure` only generates private configuration. `start` resumes the existing setup without replacing secrets/data. A failed build/start leaves configuration available for correction/retry. Do not run `install` against an existing directory. `--skip-dns` postpones startup's DNS check; final doctor still checks DNS/HTTPS. Configuration generation alone is not a successful deployment.

## Operations and updates

Always specify the environment and Compose file together:

```sh
docker compose --env-file /opt/toaster/instance/.env \
  -f /opt/toaster/instance/compose.yaml ps
docker compose --env-file /opt/toaster/instance/.env \
  -f /opt/toaster/instance/compose.yaml logs --tail=100 api web scanner signatures livekit
```

Never publish `docker compose config` output without `--quiet`: it expands secrets. Keep the entire installation directory, dumps and backups private. No installer command removes database/files/Caddy volumes.

Before updating, take a tested backup and schedule maintenance. Pull the reviewed revision, then use `start` to rebuild and apply forward migrations. For this source topology, stop API/worker writes, dump MySQL through a protected credentials file using `mysqldump --single-transaction --no-tablespaces`, snapshot the `files` volume/private configuration, encrypt backups and test restoration on an isolated host. Keep backup keys outside the installation directory. Older offline backup/restore scripts target immutable offline bundles; their restore protocol is not certified for mutable production source installs.

To change the application domain during maintenance, update DNS, `APP_HOST`/`APP_ORIGIN` in the private `.env`, and `origin`/`mathOrigin` in `installation.json`, then run `start`. Web builds derive the math origin from `APP_HOST`. A changed media IP also requires updating `rtc.node_ip`, STUN and TURN addresses in `installation/livekit.yaml`. Users sign in again on the new domain.

## Acceptance

After doctor passes, sign in as administrator, configure registration, create an organization/class and use two browsers on different networks to test microphone/listener join, cameras, screen sharing, locks/revocation, public/private policies, private-message isolation, synchronized PDF/board changes and download permissions.

Installer CI builds clean images, validates Compose/Caddy, bootstraps MySQL twice and verifies the protected API. Public DNS, ACME issuance and external media connectivity require the actual deployment. No 800-user media certification is claimed.
