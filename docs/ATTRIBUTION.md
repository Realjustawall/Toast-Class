# Attribution and component licenses

Original TOASTER code is distributed under the root MIT LICENSE. Component-specific licenses below remain applicable; the root license does not relicense upstream code or user-supplied designs.

## BigBlueButton layout adaptation

Classroom framing adapts LGPL-3.0-only BigBlueButton layout source. The scoped stylesheet carries its license identifier. Unmodified references, reviewed upstream blob IDs, modification notes and LGPL/GPL texts are in [third_party/bigbluebutton](../third_party/bigbluebutton/NOTICE.md). The web image includes those notices and the unminified modified stylesheet at `/licenses/bigbluebutton/`. No BigBlueButton logos or Skyroom proprietary code/assets are included. UI adaptation does not imply API compatibility.

## Editor, fonts and math

Excalidraw 0.18.1 is MIT licensed. Fonts are served locally from `/excalidraw/fonts/`. TOASTER's build removes the editor's public font fallback; the small version-checked transform is in `apps/web/offline-excalidraw.ts`.

Manrope and Vazirmatn use SIL Open Font License 1.1. Their notices are preserved in `apps/web/public/licenses/`. The user-supplied `toaster-works.html` and login scene retain their embedded Three.js MIT header and font data.

GeoGebra Classic 5.4.934.0 is downloaded from the official distribution and verified against its pinned SHA-256. Preserve the upstream distribution notices and review [GeoGebra's licensing terms](https://www.geogebra.org/license); do not assume the application's MIT license applies to that runtime. The upstream source is [geogebra/geogebra](https://github.com/geogebra/geogebra).

The background processor uses LiveKit track processors and MediaPipe under their upstream Apache-2.0 terms. Local license texts and the model/runtime source inventory are in `apps/web/public/licenses/` and `apps/web/public/media-effects/SOURCES.json`.

## Runtime dependencies and infrastructure

React, Vite, Fastify/plugins, Yjs, ws, mysql2, node-postgres, Zod and i18next integrations retain their upstream MIT terms. LiveKit SDKs/server use Apache-2.0. Caddy uses Apache-2.0. Verify exact licenses against the lockfile and installed package notices.

The Docker web build runs `scripts/collect-notices.mjs`, collecting installed dependency license/notice files under `/licenses/dependencies/`. Retain those files when redistributing the web build. The source repository includes attribution and upstream source references; it does not include dependency binaries or container images.

The optional converter image installs Ubuntu LibreOffice, Poppler, Python and font packages. Its Dockerfile preserves `/usr/share/doc` notices and package metadata. Before redistributing an image, retain the exact package/version/source inventory and meet the applicable corresponding-source obligations. MySQL Community images retain Oracle/MySQL licensing and their own distribution requirements. Separate storage services retain their upstream licenses. These servers are independently installed components, not relicensed TOASTER code.
