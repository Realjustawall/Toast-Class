# TOASTER Classroom

A self-hosted online classroom with MySQL, LiveKit audio/video, synchronized boards and PDF annotations, GeoGebra, shared notes, moderated chat and Persian/English interfaces.

## Install on your domain

Use a Linux server with Node.js 24+, Docker Engine and Compose 2.24+. Point both `class.example.com` and `math.class.example.com` directly to the server's public IPv4. Follow the firewall and DNS requirements in [INSTALL.md](docs/INSTALL.md).

```sh
git clone https://github.com/Realjustawall/Toast-Class.git /opt/toaster/source
cd /opt/toaster/source
sh install.sh install --directory /opt/toaster/instance \
  --domain class.example.com --media-ip YOUR_SERVER_PUBLIC_IPV4 \
  --email admin@example.com
```

Omit the options for English prompts. The installer creates separate database/media credentials, an initial administrator, upload scanning and automatic HTTPS. Public registration starts closed. Passwords require 6–128 characters; use a private `--password-file` or the generated random password. Existing secrets and databases are preserved when resuming:

```sh
sh install.sh start --directory /opt/toaster/instance
sh install.sh doctor --directory /opt/toaster/instance
```

Office conversion is optional (`--documents`), so the default installation does not download LibreOffice or give a worker Docker access. The [English installation guide](docs/INSTALL.md) covers configuration, domains, diagnostics, Redis and updates.

## Features and boundaries

- Public/private text chats have independent moderator switches, persistent history, formatting, sender edits/deletion and unread counts. Private threads are restricted to their participants through the classroom API.
- Public image messages are locked for students until granted. Private image attachments are not supported.
- Server-enforced locks, presenter delegation, microphone, camera and screen-sharing permissions use fresh authorization.
- Shared multipage boards, normal/pressure-sensitive pens, PDF import/annotations/export, per-file download controls and synchronized workspace changes.
- Shared notes, polls, hand queue, timers, attendance, breakout rooms and platform administration.
- Self-hosted GeoGebra on an isolated origin. Review [attribution and upstream licensing](docs/ATTRIBUTION.md), including GeoGebra licensing, before commercial use.

This is an independent application. Full BigBlueButton/PDF Annotator parity and 800 simultaneous media users are not certified. See [security boundaries](docs/SECURITY.md) and [feature status](docs/FEATURE_PARITY.md).

## Development and verification

```sh
npm ci
# Configure MySQL, local media and application origin using .env.example.
npm run migrate
npm run dev
```

```sh
npm run typecheck
npm run build:server
npm test
npm run build
npm audit --audit-level=high
npx playwright install chromium
npm run test:e2e
```

MySQL tests use `TEST_DATABASE_ENGINE=mysql` and `TEST_MYSQL_ADMIN_URL` pointing to a dedicated administration database ending in `_test`. Each test creates and cleans its own database. PostgreSQL regression coverage remains available. Production images contain no test accounts or preview databases.

## Small source release

`node scripts/pack-release.mjs` creates a source ZIP with a SHA-256 checksum and per-file manifest. It excludes dependencies, browser binaries, local databases, secrets, generated vendor bundles, screenshots and build outputs. Images and required scanner signatures are separate installation downloads. GeoGebra is pinned and hash-verified during the build.

Original code is MIT; [component-specific terms](docs/ATTRIBUTION.md) and [LICENSE](LICENSE) apply.
