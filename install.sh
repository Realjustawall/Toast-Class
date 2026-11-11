#!/bin/sh
set -eu
command -v node >/dev/null 2>&1 || { printf '%s\n' 'Install Node.js 24 or newer, Docker Engine and Docker Compose v2 first. See docs/INSTALL.md.'; exit 1; }
TOASTER_SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$TOASTER_SOURCE_DIR/scripts/install.mjs" "$@"
