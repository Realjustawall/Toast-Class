# Offline application installation (local validation in progress)

The bundle contains built Linux application/web/worker/converter images, MySQL, LiveKit and ClamAV with local signatures. It includes original licenses/notices available in those images and public installation scripts, not generated server secrets, classroom data, database dumps or CA private keys. Redistribution source/notice inventory and clean-machine certification are still pending. Do not call this a production release.

Prerequisites on the disconnected Ubuntu host: Docker Engine, Docker Compose v2, a compatible Linux architecture, sufficient disk/RAM, and a working LAN. OS/driver/Docker installation packages are not included. Node/npm, external CDNs, public DNS/STUN/ACME, paid APIs and network package installation are not required by the application installer below. Obtain the bundle manifest/checksum from a trusted channel: hashes detect modification, not an untrusted publisher replacing both data and hashes.

## Prepare on the build host

Build the current app, web, trusted worker and converter Dockerfiles. Cache the selected MySQL/LiveKit/ClamAV images. Export a **new** directory:

```sh
node scripts/offline-bundle.mjs export --directory /srv/toaster-bundle
```

This reads only cached images and an explicit public file allowlist. Transfer the entire directory using your approved offline medium. The manifest records actual immutable image IDs and architecture. Configuration uses IDs rather than relying on mutable tags or preservation of repository digests by docker load.

## Verify and configure without Node on the target

Run from the transferred bundle, after checking its trusted checksum:

```sh
sh bootstrap.sh verify
sh bootstrap.sh load
sudo sh bootstrap.sh configure /opt/toaster-install --host learn.school.test --media-ip 192.168.1.20
sudo install -d -m 0700 -o 1000 -g 1000 /var/lib/toaster/conversion-jobs
```

Replace host/IP with the server name and address reachable by participants. Configure LAN DNS/hosts locally. The configuration step runs bundled Node inside a network-disabled cached image; it never mounts the Docker socket into that initializer. The installation directory must be new; existing configuration/passwords are never overwritten. Host parent directories protect bind-mounted secret files. Keep the generated .env and installation directory private and outside the distributable bundle.

The default ports are HTTPS443, loopback API3001/MySQL3306/signaling7880/scanner3310, RTC TCP7881, UDP50000-50100, TURN UDP3478 and relay UDP40000-41000. Firewall the private service ports and allow only required participant transports. `--port-offset 11000` is available for isolated validation alongside an existing installation; it changes every configured port consistently. Configure an appropriate separate private `--jobs-dir` as needed. No arbitrary participant capacity is promised.

Final converter artifacts use mode0640 and GID65532. The Compose worker has that supplemental group; its host job parent remains mode0700. A native worker deployment must provide the same read group. The API has neither that staging mount nor Docker socket access.

```sh
cd /opt/toaster-install
sudo docker compose --env-file .env -f compose.yaml config --quiet
sudo docker compose --env-file .env -f compose.yaml up -d --pull never --wait --wait-timeout 180
```

Database bootstrap creates separate data-only runtime and schema-migration accounts. Only the one-shot migration uses schema credentials. MySQL and API bind loopback, the SFU signaling endpoint stays private, and browsers use TOASTER's permission-checked gateway. Only the separate trusted conversion worker gets the Docker socket; this is host-level trust. Untrusted converters have no socket/network/credentials. The runtime never downloads antivirus signatures; deploy an authenticated offline signature update process before relying on ongoing malware coverage. The locally tested ClamAV image includes signatures, not a guarantee of detecting all malicious content.

## HTTPS trust and first administrator

Caddy creates its own internal CA without contacting public ACME. Export only its public root certificate:

```sh
sudo docker compose cp web:/data/caddy/pki/authorities/local/root.crt ./root-ca.crt
```

Distribute/install that certificate through your managed client trust policy. Do not copy the CA private key. Validate with `curl --cacert root-ca.crt https://learn.school.test/api/v1/auth/registration`; ignoring TLS errors is not a trust installation. Physical-browser trust and TURN-only policies remain deployment gates.

Register the intended real account, then explicitly grant platform administration:

```sh
sudo docker compose run --rm --no-deps api node scripts/platform-admin.js administrator@example.org
```

Do not fabricate a first account or make organization ownership imply platform administration. Runtime application credentials cannot apply future migrations; use the separate migration service. Never rotate generated database passwords by rerunning bootstrap against an existing volume. Back up matching MySQL, private files and CA/configuration before updates; production retention/encryption/restore automation remains pending. `docker compose down` retains data; do not add `-v` during ordinary maintenance.

Sources: [MySQL image initialization](https://hub.docker.com/_/mysql), [LiveKit 1.13.11 configuration](https://github.com/livekit/livekit/blob/v1.13.11/config-sample.yaml), [Caddy internal TLS](https://caddyserver.com/docs/caddyfile/directives/tls).
