# TOASTER Classroom

**[English](README.md) | [فارسی](README.fa.md)**

A self-hosted, bilingual (English LTR / Persian RTL) online classroom platform built with **MySQL**, **LiveKit** audio/video, synchronized **Excalidraw & PDF annotation boards**, **Sandboxed Interactive HTML/CSS/JS Boards**, **GeoGebra**, shared notes, moderated public/private chat, breakout rooms, and automated upload scanning.

---

## Preview (English & Persian)

| Feature                          |                            English (LTR)                            |                                        فارسی (RTL)                                         |
| :------------------------------- | :-----------------------------------------------------------------: | :----------------------------------------------------------------------------------------: |
| **Workspace & Classrooms**       |       ![Workspace English](docs/screenshots/workspace-en.png)       |                  ![Workspace Persian](docs/screenshots/workspace-fa.png)                   |
| **Live Classroom & Media**       | ![Classroom English](docs/screenshots/classroom-layout-desktop.png) |               ![Classroom Persian](docs/screenshots/classroom-media-fa.png)                |
| **Whiteboard & Pressure Pen**    |    ![Whiteboard English](docs/screenshots/teaching-board-en.png)    |       ![Whiteboard Persian](docs/screenshots/pressure-pen-desktop-fa-2026-11-11.png)       |
| **Files, Presentations & Locks** |           ![Files English](docs/screenshots/files-en.png)           | ![Download Controls Persian](docs/screenshots/download-controls-desktop-fa-2026-11-11.png) |
| **Breakout Rooms & Mobile**      |       ![Breakouts English](docs/screenshots/breakouts-en.png)       |           ![Breakouts Mobile Persian](docs/screenshots/breakouts-mobile-fa.png)            |

---

## Key Features

- **Live Audio, Video & Moderation:** Self-hosted LiveKit SFU with server-enforced microphone, camera, screen-sharing permissions, presenter delegation, and per-user/room-wide locks.
- **Synchronized Boards & PDF Annotation:** Normal and pressure-sensitive ink pens, multipage boards, PDF import/annotation/export, board history snapshots/restore, and per-file download policies.
- **Sandboxed Interactive HTML/CSS/JS Boards:** Teachers can upload single `.html` files or `.zip` web bundles to launch an isolated interactive board (similar to GeoGebra). Executed inside a strictly sandboxed iframe (`allow-scripts` only, no `allow-same-origin`, strict CSP, no network/storage/parent DOM access, and server-side archive/MIME validation).
- **Self-Hosted GeoGebra:** Runs on an isolated origin (`math.class.example.com`) with pinned, hash-verified assets during build.
- **Moderated Public & Private Chat:** Independent moderator switches, persistent history, message formatting, sender edit/delete, unread counts, and student image upload locks.
- **Teaching Tools:** Shared notes, polls, hand-raise queue, timers, attendance tracking, breakout rooms, and platform administration.
- **Bilingual UI (EN / FA):** Full English (LTR) and Persian (RTL) interface with desktop and mobile responsive layouts (`classic-bbb`, `immersive-glass`, `modular-skyroom`, `studio-hybrid`).

---

## Production Installation (Linux)

### Requirements

- Linux server with **Node.js 24+**, **Docker Engine**, and **Docker Compose 2.24+**
- Two DNS A records pointing directly to your server's public IPv4:
  - `class.example.com` (main application)
  - `math.class.example.com` (isolated GeoGebra / sandboxed origin)
- Open firewall ports per [INSTALL.md](docs/INSTALL.md)

### 1. Clone and Install

```sh
git clone https://github.com/Realjustawall/Toast-Class.git /opt/toaster/source
cd /opt/toaster/source
sh install.sh install --directory /opt/toaster/instance \
  --domain class.example.com --media-ip YOUR_SERVER_PUBLIC_IPV4 \
  --email admin@example.com
```

> **Tip:** Omit the CLI flags to run the interactive installer prompts.  
> The installer generates isolated database and LiveKit credentials, creates an initial administrator account, configures upload scanning (ClamAV), and sets up automatic HTTPS via Caddy. Public registration starts closed. Passwords require 6–128 characters (pass `--password-file` or use the generated random password).

### 2. Optional Document Conversion (LibreOffice)

Office document conversion (`.docx`, `.pptx`, etc. to PDF/images) runs in a locked-down converter container and is **optional**:

```sh
sh install.sh install --directory /opt/toaster/instance \
  --domain class.example.com --media-ip YOUR_SERVER_PUBLIC_IPV4 \
  --email admin@example.com --documents
```

### 3. Manage & Diagnose

Existing secrets and databases are preserved when starting or updating:

```sh
sh install.sh start --directory /opt/toaster/instance
sh install.sh doctor --directory /opt/toaster/instance
```

See the [full installation guide](docs/INSTALL.md) for custom domains, Redis, backups, and upgrades.

---

## Local Development Setup

### 1. Install Dependencies & Configure Environment

```sh
git clone https://github.com/Realjustawall/Toast-Class.git
cd Toast-Class
npm ci
cp .env.example .env
```

Edit `.env` to configure your database (`DATABASE_URL` / MySQL or PostgreSQL), `APP_ORIGIN`, and LiveKit credentials.

### 2. Run Migrations & Start Dev Servers

```sh
# For PostgreSQL:
npm run migrate

# Or for MySQL:
npm run migrate:mysql

# Start API + Vite frontend dev servers concurrently:
npm run dev
```

### 3. Grant Platform Admin (Optional)

```sh
npm run admin:grant -- user@example.com
```

---

## Testing & Verification

Run the full verification suite locally:

```sh
npm run typecheck
npm run format:check
npm run build:server
npm test
npm run build
npm audit --audit-level=high
npx playwright install chromium
npm run test:e2e
```

To run the MySQL test suite:

```sh
TEST_DATABASE_ENGINE=mysql TEST_MYSQL_ADMIN_URL="mysql://root:password@127.0.0.1:3306/toaster_admin_test" npm test
```

> Note: `TEST_MYSQL_ADMIN_URL` must point to a dedicated administration database ending in `_test`. Each test creates and cleans up its own isolated database. Production images contain no test accounts or preview data.

---

## Thin Source Release

Create a clean, checksummed source archive (excluding `node_modules`, build artifacts, secrets, and browser binaries):

```sh
node scripts/pack-release.mjs
```

---

## Security & Licensing

- **Security boundaries:** Full BigBlueButton / PDF Annotator parity and 800 simultaneous media users are not certified. Review [docs/SECURITY.md](docs/SECURITY.md) before production deployment.
- **Licensing:** Original code is licensed under [MIT](LICENSE). Third-party component licenses (including GeoGebra commercial terms) are documented in [docs/ATTRIBUTION.md](docs/ATTRIBUTION.md).
