# Verification report - 2026-11-05

**Overall: foundation, initial teaching tools and media-control milestone. The complete platform is not delivered or production-certified. No phase is declared fully complete.**

Environment: Windows / PowerShell, Node v24.11.0, npm 11.6.1, installed Chrome controlled by Playwright. Actual PostgreSQL 16 and LiveKit 1.13.11 run in Ubuntu 24.04 WSL2 (kernel 5.10.16.3). Docker Engine 29.9.3 and Compose 5.7.0 are now installed in WSL; host-network-only container verification is pending. Random test credentials remain in ignored local configuration.

| Check                                             | Actual result                                       | Verification scope                                                                                                                                       |
| ------------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TypeScript                                        | Pass                                                | API, web, scripts and tests                                                                                                                              |
| npm test with PostgreSQL                          | 42 passed, 0 failed, 0 skipped                      | Foundation, teaching, attendance, Unicode locale integrity, media policy/gateway and durable-command failure/retry/teardown                              |
| npm test without database URL                     | 34 passed, 2 PostgreSQL-dependent workflows skipped | pg-mem cannot certify SKIP LOCKED command claiming                                                                                                       |
| Standard Playwright UI suite with PostgreSQL      | 3 specs passed individually after routing change    | Account/org/classroom, independent teacher/student chat, hands, polls, Yjs notes/board, outbox reload recovery, RTL/LTR/mobile                           |
| Real-SFU Playwright suite                         | Prior 2-spec baseline passed; expanded suite fails  | Actual API-issued gateway tokens, received RTP, UI device/display capture, moderation, stale-token rejection, room deletion and signed attendance/UI/CSV |
| Classroom UI repeat run                           | 2 consecutive passes                                | Same camera-first audio/display capture, focus/grid and Persian controls in supported dual-connection mode                                               |
| Web build                                         | Pass, media chunk size warning                      | Main JS 300.95 kB / 95.28 gzip; teaching 110.76 / 34.11; lazy media 632.62 / 168.98; CSS 36.77 / 8.20                                                    |
| npm audit                                         | 0 reported vulnerabilities at last check            | Locked graph only; not a security certification                                                                                                          |
| Compose / clean production deployment             | Not run                                             | Native WSL services were used                                                                                                                            |
| Physical devices / restrictive networks / TURN    | Not run                                             | No hardware or relay-only claim                                                                                                                          |
| Firefox / WebKit / physical mobile media          | Not run                                             | Chrome and mobile viewport only                                                                                                                          |
| Load / packet loss / egress / recording integrity | Not run                                             | No capacity or reliability benchmark claimed                                                                                                             |
| GitHub CI                                         | Workflow files written, remote run not performed    | PostgreSQL UI checks plus a dedicated real-SFU workflow; no push                                                                                         |

## Media and authorization evidence

The RTP workflow creates independent browser accounts and contexts, establishes organization membership, starts a classroom session and obtains join tokens from the protected API. Both browsers publish generated oscillator audio and animated 320x180 video at 10 fps through the authenticated signaling gateway and actual SFU. Received inbound RTP bytes and decoded frames are measured. These are synthetic test sources over real WebRTC, not simulated networking.

One completed run received:

- Browser A: 9,463 audio bytes, 1,276 video bytes, 6 decoded frames, 2 remote tracks.
- Browser B: 11,115 audio bytes, 2,471 video bytes, 8 decoded frames, 2 remote tracks.

The workflow also replaces video tracks and toggles mute. A separate moderator UI disables microphone, camera and screen-sharing permission, blocks media access, restores access and ends the session. The affected publisher loses publishing permission, cannot republish forbidden camera tracks, is disconnected when blocked and cannot reuse stale gateway tokens. A fresh authorized token reconnects after access is restored. Ending the session causes actual SFU room deletion and rejects old-token reconnection before token expiry. This enforcement assumes private upstream signaling; see MEDIA_CONTROL.md.

The PostgreSQL-specific outbox tests use an explicit test control adapter for deterministic failures. They verify superseded-policy suppression, eight-attempt durable retry limits, visible failure, authorized retry and end-session cleanup. The real-SFU suite independently exercises actual SDK room controls.

## Browser media UI and display capture

The classroom UI workflow uses Chromium-provided fake camera/microphone and display-capture sources through the browser's actual getUserMedia/getDisplayMedia APIs. The student decodes the teacher's video and display track. Focus/grid switching, screen-share stop, device selection UI, local camera mirroring preference, Persian controls, RTL layout and session-driven disconnect are exercised. The test-only flags follow [Chromium's display-capture test approach](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/media/webrtc/webrtc_getdisplaymedia_browsertest.cc).

This does not validate physical camera/microphone hardware, OS monitor/window pickers, shared system audio, device failure recovery or perceptual audio quality. The application does not override normal browser capture consent.

The default newer single-peer-connection path exhibited intermittent camera disappearance in this Windows/WSL device harness. The supported dual-peer-connection configuration passed the same UI workflow twice consecutively and in the full suite. The upstream cause has not been proven; this configuration choice is documented in ARCHITECTURE.md. Recovery and capacity still need testing.

## Collaboration and attendance evidence

Independent teacher/student contexts exchange persisted Unicode chat, hand raises, poll votes/published counts, mixed Persian/English notes and board shapes. User-local undo preserves another user's appended contribution. Unsent note updates survive reload in an authorized per-account browser outbox and subsequently synchronize. The basic board restores after reload.

LiveKit sends signed participant join/leave callbacks to the actual API. The real-media workflow confirms both users' positive observed connection durations and closed intervals, teacher-only reporting, and a downloadable CSV. Tests cover signature validation, body-hash checks, replay deduplication, conflicting reused event IDs, out-of-order leave/join and interval union. Session IDs now come from the distinct media room name, including late callbacks after session end. Connection duration is not a claim about attention or learning.

## Screenshots

Actual application with test accounts and test media:

- [English workspace](screenshots/workspace-en.png)
- [Persian workspace](screenshots/workspace-fa.png)
- [Persian mobile workspace](screenshots/workspace-mobile-fa.png)
- [Collaborative board](screenshots/teaching-board-en.png)
- [Attendance from actual SFU callbacks](screenshots/attendance-en.png)
- [Media moderation](screenshots/media-moderation-en.png)
- [Persian classroom and browser-provided fake camera](screenshots/classroom-media-fa.png)

Fonts are locally bundled Manrope and Vazirmatn with OFL notices in the web output. No external font service is required.

## Failures and limits retained honestly

The browser download returned regional HTTP 403; installed Chrome was used. Earlier errors included masked expected media configuration failures, too-low collaboration request limits, Vite dependency optimization reloads and inaccessible WSL localhost signaling. These were corrected.

This iteration found new Persian strings corrupted by a PowerShell-to-Python encoding path. Locale modules were rewritten as UTF-8 via direct file patches, and a test now enforces key parity and readable Persian Unicode. Device/media UI tests exposed a participant-context error and transport instability; these drove the current owned-room lifecycle, serialized device operations and dual-connection configuration. A test process stuck during teardown after a failure was explicitly terminated after verifying its task-owned process identity; the media suite now has a global timeout.

Still incomplete: full classroom admission/RBAC, immediate auth-session-to-media reconciliation, attendance reconciliation/retention, advanced board tools/history/presence, rich text notes, synchronized presentations, quizzes, breakout device-resumption reliability, recording/playback, LMS, event/ticket/payment, all translated API/errors/emails, accessibility certification, Redis fanout, clean deployment/recovery and performance testing. No full-product acceptance claim is made.

## Breakout iteration evidence and current open failure

Migrations 005/006 and `tests/breakouts.test.ts` cover independent child sessions, assignment/tenant/role enforcement, stale token rejection, separate chat/documents, balanced allocation, broadcasts, deadline extensions, automatic expiration, parent closure and source-preserving document copying. PostgreSQL also executes revision-aware media commands and verifies visible child teardown retry from the main classroom. All 42 PostgreSQL tests passed; pg-mem passes 34 with two PostgreSQL-specific skips.

The new standard browser spec passed self selection, child-route reload, authoritative return-to-main and Persian mobile management without horizontal overflow. Existing teaching and workspace specs passed individually after updating reload expectations. Screenshots: [English group management](screenshots/breakouts-en.png), [Persian mobile group management](screenshots/breakouts-mobile-fa.png).

A real-SFU breakout scenario has successfully exercised separate room publishers, received audio/video RTP for a visiting teacher, relocation with old-token rejection, source document copying and a real 30-second server expiry. However repeated runs exposed intermittent `Requested device not found` during device reacquisition and browser-close timeouts. Consequently the expanded real-media suite is currently **failing**, despite earlier successful scenarios. The breakout rows remain IN_PROGRESS. No browser shutdown or media recovery reliability claim is made.

Cancellation and connection-owned resume handling have been added. A separate native browser capture/reload test (two contexts, five cycles each) passed with ordinary Chromium fake-camera flags. The display-specific fake source is now scoped to the screen-capture UI spec. Independent browser processes are being used for the breakout students to test actual process boundaries. Diagnostic capture delegation records native request constraints and errors without replacing the media source. It is disabled unless TEST_MEDIA_CAPTURE_DIAGNOSTICS=true. Bundled Chromium download was attempted again and returned regional HTTP 403; installed Chrome is still used.

Browser spec runners restart ephemeral infrastructure per file, preserve production registration rate limits, discover every spec and retain separate result directories. A Windows/WSL restart changed the test IP; PostgreSQL and the SFU were revalidated and restarted only after authoritative process/service checks showed them stopped. No production deployment was performed.

The repeated Windows scenario completed all classroom/media assertions with file-backed native capture, including the final SFU disconnect, but its independent-browser fixture timed out during process cleanup. Software-requested browser flags did not resolve that timeout. Native-capture and browser-fixture health specs passed independently. The subsequent Linux result below supersedes the earlier expanded-suite failure for Linux only. See [Linux test environment](LINUX_TESTS.md).

## Linux media suite: all five specs passed

The official Playwright 1.64.1 Ubuntu Noble image was built and executed with PostgreSQL 16 and LiveKit 1.13.11. All five discovered media specs passed: separate breakout media/teacher visit/move/stale token rejection/source notes copy/real 30-second expiry/automatic return/final disconnect; independent-browser fixture health; camera/display-capture classroom UI and RTL; five-cycle native capture/reload; and RTP/moderation/signed attendance/UI/CSV. Independent browser process cleanup completed normally. The container reports Node 26.13.0; the Windows workstation uses Node 24.11.0. Host-network-only WSL Docker setup is described in LINUX_TESTS.md and is not a clean production deployment.

The RTP run measured browser A receiving 9428 audio bytes, 595 video bytes and 5 decoded frames; browser B received 10868 audio bytes, 1840 video bytes and 8 decoded frames, with two remote tracks each. These are connectivity assertions, not quality or capacity benchmarks. Breakout input is a generated 320x180, 10 fps native file camera plus synthetic audio; ordinary fake-camera and browser-tab capture have separate specs. Physical devices, TURN-only connectivity, packet-loss recovery and participant capacities remain untested. Windows cleanup/device issues remain open.

## File library backend evidence

The updated complete PostgreSQL suite passes **53 tests, zero skips**. File tests use actual filesystem bytes and SQL migrations: Unicode upload/download and API restart, exact declared sizes, concurrent quota reservations, rejected cross-tenant/student writes, folders/cycles/scope, literal wildcard search, byte-preserving copies, source lineage, ranges, audit events, fail-closed quarantine and stale scan leases, bounded physical cleanup and authorized retry. ClamAV framing/verdict tests use a deterministic local test daemon, not a deployed antivirus.

The default pg-mem suite passes **45 tests with two PostgreSQL-only skips**. Its test adapter explicitly reproduces PostgreSQL nullable CHECK semantics and provides text length. Literal ILIKE escaping and concurrent quota assertions run only with real PostgreSQL because pg-mem does not reproduce those database semantics. Production migrations and queries are unchanged by these adapter accommodations.

TypeScript and the web production build pass. The media bundle still exceeds Vite's 500 kB warning threshold. Real S3 provider and deployed scanner contracts, conversion/presentation workflows and file retention/backup remain unverified. See FILES.md for exact file capabilities and remaining gaps.

The complete two-user file browser spec passed in installed Windows Chrome: teacher upload, student permission hiding, mixed Persian/English text preview, keyboard focus return, exact downloaded bytes/Unicode filename, folders, rename/move, real copy and deletion, decoded image preview, refresh persistence, 390px Persian RTL without horizontal overflow, and separate organization storage. The test found and fixed hidden mobile organization navigation and an ambiguous select label. Screenshots: [English files](screenshots/files-en.png), [Persian mobile files](screenshots/files-mobile-fa.png).

Latest rerun after storage contract tests were added: **54 pass / 1 optional S3-provider skip** with PostgreSQL; **46 pass / 3 skips** with pg-mem. The S3 HTTP fixture confirms the adapter actually transmits `If-None-Match: *`, exact length and original bytes. The actual Garage 2.5.0 provider contract separately **failed** because replacement succeeded; it is not certified. SeaweedFS evaluation remains pending; see STORAGE_TESTS.md. A failed provider test is not hidden by the optional default-suite skip.

All five Linux media specs passed again after the file UI integration, including normal independent-browser cleanup. Latest received RTP measurements: A 9181 audio bytes / 595 video bytes / 5 frames; B 10621 audio bytes / 1840 video bytes / 8 frames. The four Linux ordinary UI specs passed individually; the first workspace run had a stale expectation for an unconfigured SFU, and passed after distinguishing configured media's missing-session guard. Do not interpret this as physical-device or full-product certification.

The standalone document converter and real Docker harness were added. Python syntax passes; image build and actual document assertions are still pending. It is not yet an API-connected presentation system. See CONVERSION.md.

## Presentation and storage milestone: 2026-11-06

This milestone supersedes the earlier pending conversion/S3 statements above. No phase or full product is complete.

- **65 tests pass, zero skips**, on Linux with PostgreSQL 16, actual converter containers and the actual SeaweedFS 4.52 server. Node is 26.13.0 in this Linux test setup. The default Windows/pg-mem suite passes **54 with five explicit environment-specific skips**. TypeScript, the web build, formatting and dependency audit pass; the media bundle warning remains.
- The converter image actually built with Ubuntu 24.04 packages: LibreOffice 24.2.7 and Poppler 24.02.0 security-updated distribution packages. All five real harness cases passed: PDF two-page rendering, mixed-text TXT, DOCX, malformed-PDF rejection and 201-page rejection. Output manifests/digests/dimensions were checked. These results do not certify malicious-parser/resource-exhaustion or arbitrary-layout fidelity.
- The real worker test uploads PDF/DOCX, claims jobs, converts in restricted containers, stages private outputs, releases through the explicit development scanning policy and serves authorized assets. Malformed input becomes a persisted failure. Deployed antivirus accuracy/availability remains untested; unscanned development release is not a clean verdict.
- Presentation API tests cover source/tenant/classroom guards, quota reservation, derived-asset mutation denial, exclusive processing claims, stale lease/generation fencing, page bounds, revisions retained across hide/show, ended-session command rejection, exhausted/live scan leases, infected output cleanup, retries and audited deletion. Fixture control tests are identified separately from actual conversion tests.
- **All five ordinary Linux UI specs passed in one runner execution**, including the new real-converter two-user presentation scenario. It tests PDF/DOCX preparation, teacher page synchronization, student refresh, independent browsing and revocation, exact original download, fitted page geometry and 390px Persian RTL. [English presentation](screenshots/presentations-en.png), [Persian mobile presentation](screenshots/presentations-mobile-fa.png).
- The first presentation UI run exposed an asynchronous controlled-checkbox feedback issue. Pending state now updates immediately and is reconciled with the server revision. Teaching snapshots reject stale out-of-order refresh results. The corrected complete workflow passed, then passed again in the full UI runner.
- The real S3 contract passes with SeaweedFS 4.52, including a subsequent concurrent-create assertion with exactly one winner. Anonymous and invalid-signature reads are denied. Garage's recorded failure remains; no compatibility guard was weakened. Native release SHA-256 was checked. Docker packaging, replicas, durability, backups/restore and capacity remain unverified.

The latest five-spec real-media pass predates this presentation iteration; no new media transport change is claimed here. The WSL restart stopped its prior native SFUs, so old process IDs/configured IPs must be revalidated before another media run. Standard teaching, breakout and file UI regression workflows did pass with the presentation changes.

`.github/workflows/conversion.yml` defines actual Docker processing plus browser gates on a native Linux runner. Its local constituent workflows passed; the workflow has not run on GitHub and no source/image/release was pushed. See PRESENTATIONS.md for current functionality and the unchanged remaining advanced requirements.

Final authorization review added a content-route check for current-generation, whole-presentation readiness. A direct known-UUID request for an individually ready asset is denied while the presentation is scanning. The 19 targeted PostgreSQL file/presentation tests and actual PDF/DOCX worker/API tests passed with that guard. The S3 contract also passed stronger exact 412/403/404 status assertions and concurrent-create verification. These targeted additions do not claim any new media transport certification.

The actual-converter two-user presentation browser workflow passed again after the content-route guard (28.7 seconds, 38.1 including test infrastructure). Its screenshots reflect the final fitted-page layout and current implementation.

## Offline assets and administration checkpoint

See SCOPE_UPDATES.md for the authoritative payment exclusion and new offline/TOASTER WORKS requirements. The supplied animation is now integrated with actual readiness, reduced motion, silent autoplay and cancellation fencing; owner administration exposes real organization operations, members and audited activity. Advanced board server state is implemented and tested, while its editor integration is pending.

Current Windows real-PostgreSQL suite: 65 pass / 2 explicit skips for actual converter and real S3. Default pg-mem: 56 pass / 5 explicit skips. New admin/board integration suites pass with both adapters. Final two-spec Chrome run passes admin and loading, including local-only HTTP, no browser errors, 503 retry, cancellation, Persian mobile and audit filtering. An earlier four-spec run printed four passing bodies but hung during cleanup and was interrupted; it is not a completed suite. No current new full-media, real-converter, S3 or all-service offline result is claimed.

TypeScript, production web build, formatting and npm audit pass. Build still warns about the ~633 kB media chunk. A fresh dependency resolution initially caused React 18/19 duplication; real browser tests caught this, then a single React/React DOM 19.3.1 tree plus Vite deduplication restored working UI. SDK vulnerability overrides resolve the reported advisories; no advanced-editor compatibility claim is made before editor tests.

Actual screenshots: toaster-works-loading.png, admin-operations-en.png and admin-operations-mobile-fa.png. Full disconnected installation and all-service LAN media/TURN deployment remain pending, as do the unimplemented master requirements. See OFFLINE.md, ADMIN.md and ADVANCED_BOARDS.md for exact boundaries.

## Identity, MySQL groundwork and actual online-class loading

Current combined PostgreSQL + native MySQL test execution: **69 pass / 2 explicit skips**, total71. Actual converter and real-S3 scenarios were not enabled in that run. MySQL8.4.13 passes its native prepared-query/DDL/Unicode/rollback/FK/drift contract; the full running application remains PostgreSQL pending cutover. See MYSQL.md.

Account/workspace browser pair passed with normal exit; separate registration-lock browser spec passed with an explicit isolated admin fixture. Six-character password policy, removed explanatory paragraphs, proxy empty-response recovery, own device revocation, profile persistence and password change are exercised. The exact original JSON error was correlated with Vite's failed connection during API watch restart; the user preview now has a non-watching API.

Latest actual-SFU online-class loader browser spec passed (normal exit,10.8s including setup): animation canvas and LOADING during real join and gated signaling, Escape cancellation, stale-request suppression, inert/focus cleanup and transition to real connected transport. The stable screenshot uses reduced motion. It is transport/loading evidence, not new synthetic RTP/TURN/physical-device/load certification. The separate test SFU was stopped; the user preview remains live on5173 with its own media server.

Server/web builds, strict typecheck and audit pass; media chunk warning persists. Offline Docker/Compose groundwork is draft and predates the required MySQL cutover. No release-readiness or complete offline installation is claimed.

## Native MySQL and offline checkpoint, 2026-11-06

This supersedes older current-backend and identity-only statements above. The existing API, worker, administrator CLI and persistent localhost:5173 preview now use native MySQL 8.4.13. The empty preview cutover compared all source/target tables under locks, retained PostgreSQL/configuration/backup, copied settings and restarted only after checks. Populated-source transfer is not implemented. See MYSQL.md.

Latest full native Linux wildcard run: **74 passed, zero skips**, including actual S3, isolated document conversion, concurrent migration/closure and an actual dump/restore with every-table canonical hash comparison. Targeted independent-browser presentation and genuine SFU classroom/breakout gates pass on MySQL. Typecheck, server/web build, format and npm audit pass; zero reported dependency advisories does not prove absence of vulnerabilities.

The separate network=none API run passed **71 tests with 3 explicit skips**. An internal-bridge namespace without default egress then passed explicit network isolation checks and targeted camera/audio/screen-share, received RTP and breakout-expiry/return. Built-production-web browser and consolidated media reruns are still pending; do not report preliminary failed runs as successful suites. Physical devices, TURN-only, cold offline installation, scanner/HTTPS/recovery and load/security certification remain outstanding. PROGRESS.md records live process handles and terminal evidence.

Final native database rerun after the least-privilege gate: **75 passed, zero skips** (exec66678). The prior74 count is superseded. Consolidated built-media evidence is pending because missing test-only probe entry was found and corrected; see PROGRESS.md.

Final consolidated isolated built-web media rerun (exec47617): **all five specs passed**, including genuine SFU RTP/decoded frames, UI screen/audio/video, devices and breakout isolation/expiry/return. This supersedes earlier pending media-suite wording. Ordinary built-web browser rerun remains pending. Physical/TURN-only, clean installation and production all-service gates remain outstanding.

Final built-web isolated browser runner exec73388 completed successfully: **nine passed, one explicit conversion/presentation skip**. Account/admin/files/group refresh/teaching/registration/animation and real-SFU joining ran without Internet egress. Actual conversion/presentation independently passed on MySQL at19757 outside this isolated namespace. This is runtime evidence, not a complete offline installer or physical/TURN-only certification. Preview runtime grants are now data-only with private separate operator migration configuration.

## Bundled production installation verification

A fresh generated production Compose and then a NEW installation configured from the actual v2 image bundle passed actual trusted HTTPS, Secure/HttpOnly auth, tenant denial, ClamAV clean/EICAR checks, separate non-root worker/container conversion and protected PNG assets. The latter ran all services in an INTERNAL network with no Internet egress; network routes/proxy/public TCP checks passed independently. No unscanned override, mock converter or disabled TLS verification was used. A real non-root output permission bug was found and fixed with final0640/GID65532 artifacts; the five-case converter harness and MySQL converter integration pair pass afterward. Linux/Windows bundle/config integrity tests pass; shell rejects unexpected files, symlinks and checksum drift.

Seven v2 images imported and ID/platform-verified in an initially empty separate Docker29.9.3 engine. The Docker-only initializer runs the bundled Node in network=none; target host Node/npm not required. This assumes Docker/Compose/compatible Linux are already installed. Bare-OS packages, full license/source inventory, production backup/restore, physical browser trust and TURN-only remain pending. Source shell hardening is newer than v2; PROGRESS.md records the next provisional artifact/evidence. Existing standalone real-media and browser gates remain separately scoped; no capacity or complete-platform certification.

## Matching encrypted MySQL/files/CA recovery drill

The generated private-filesystem installation now has streaming AES-256-GCM maintenance backups and new-destination-only restoration. Four targeted unit tests pass on Windows and Linux (backup authentication/atomic no-overwrite/private snapshot, narrow MySQL dump normalization, offline bundle inventory and installation secret isolation). Python volume extraction tests pass including private modes/ownership, unsafe tar members and nonempty destinations.

Fresh restore exec73691 passed canonical database comparison, exact volume fingerprints, **83 foreign-key checks and 51 unique-key checks**. Only the new MySQL service was started by restoration. After explicitly stopping the previous dedicated clone without deleting volumes, all services were activated in the internal network. The original authenticated session, Persian classroom message, exact private file and anonymous access denial passed through HTTPS with the original trusted CA. The same namespace passed no-default-route/no-proxy/public-TCP-denial checks. User preview data were not used.

Docker-only backup of snapshot04 and restore exec77098 used the cached worker image's Node/Docker/Compose with `--network=none`, not a host npm install. The restore again checked 83 foreign keys and 51 unique keys. A prior dedicated failure drill detected an injected orphan row, rejected wrong keys/modified ciphertext/existing targets, and exercised real ENOSPC with no published final archive and successful service resumption. Current repeated failure-drill status is recorded in PROGRESS.md.

This is evidence for matching small generated MySQL/private-filesystem installations, not populated PostgreSQL transfer, external S3 recovery, large-data performance or bare-machine disaster recovery. See [the operational procedure](BACKUP_RECOVERY.md). Full platform acceptance, remote MySQL TLS, physical media/TURN-only, legal/source distribution and capacity gates remain open.

The final provisional v4 bundle also passed a fresh, separate internal-network installation: actual trusted HTTPS/auth, tenant denial, real clean/EICAR scan, isolated non-root conversion and private PNG/anonymous denial. The test first omitted the documented host staging-directory preparation and failed conversion; after preparing that verified empty directory with UID1000/mode0700, the complete smoke passed. This setup step remains mandatory; worker health does not yet diagnose a missing staging preparation. Repeated expanded failure gate24947 passed with83FK/51unique and real ENOSPC. Separate native security regression passed13 tests and the explicitly enabled every-table recovery test then passed with no skip. No full-suite or capacity result is inferred from these targeted runs.

## Advanced editor integration

The real Excalidraw editor is now integrated with the existing server-authorized Yjs board protocol; existing basic boards are preserved. Native MySQL server/replica tests8782 passed3 tests without skips. Final built-web Chrome/MySQL browser test8111 passed: real geometry, mixed Persian text, durable pending changes across interrupted delivery and reload, actual received SVG content in both directions, PNG signature, live teacher-only permissions, local font requests with external HTTP blocked, RTL375px layout and Fit to content. Real screenshots are retained under `docs/screenshots/advanced-board-{desktop,mobile}.png` and were visually inspected.

The test found and drove a real fix for editor initialization racing the first received snapshot; checking only server persistence would have missed the empty restored canvas. Subsequent fixture corrections wait for the actual text editor and the receiving browser's authorized delta rather than assuming sender acknowledgement proves rendering. Existing teaching/browser regression47374 also passes on built web/native MySQL, covering legacy board/notes/polls/hands. Typecheck/server build pass. Application, web and worker Docker images build successfully with cached dependencies and `--network none`; final web rebuild4589 passes. The bundle v4 remains unchanged and predates this editor; subsequent bundle status is recorded in PROGRESS.md. This is not a physical-device, all-browser, full teaching-tool or large-board performance certification; [remaining board gaps](WHITEBOARD.md) are explicit.

## Teacher board history and recovery

New native MySQL migration007 and PostgreSQL migration014 add version snapshots and idempotent restoration receipts. Old applied migration files remain unchanged. Expanded native-MySQL server tests12237 and57107 pass history authorization, cross-document denial, stale-generation rejection, corruption detection, competing restores (one succeeds and one conflicts), automatic checkpoints and a full128-entry history refusing restore without modifying current state. Replica tests cover pending-edit quarantine across refresh and explicit discard; a recovery export retains old receipts.

Native MySQL migration/data-only privileges/every-table dump-restore tests51270 pass with the new history tables populated, including Persian labels. Built-web native-MySQL Chrome80713 passed actual version creation, isolated SVG preview, restoration, downloaded pending-edit recovery data and restored-scene SVG checks. A subsequent repeat67971 caught a real UI readiness bug after explicit discard: the replica reset correctly but the loaded flag could stay false. The client now marks readiness and refreshes authorized current state before re-enabling editing. Final repeat/build/deployed-bundle outcomes are recorded in PROGRESS.md; do not infer their success from the earlier pass. The trace from the initial180-second fixture-focus failure is not successful evidence. Teacher-only history bounds, retention behavior and remaining gaps are in [the board API contract](ADVANCED_BOARDS.md).

Final repeat22479 passes the complete native-MySQL built-web browser workflow after that readiness fix. V6 production-image installation97548 and actual bundled HTTPS smoke4532 pass in the internal namespace without Internet: scanner, worker conversion, private assets and optional board-history checks all execute against deployed services. The report explicitly records `boardHistory: PASSED`; the student cannot read saved history. V6 uses migration007, and previous scratch volumes are retained. A matching encrypted Docker-only backup succeeds and resumes services. Its separate restore gate is tracked in PROGRESS.md; no successful restore of this newer installation is inferred from the earlier six-migration snapshot. Full product, large-board capacity, physical-device/TURN-only, source/license distribution and bare-OS provisioning gates remain open.

That matching V6 Docker-only restore66721 also completed successfully:87 foreign keys,53 unique keys, canonical database and exact volume content checks pass. Only the new MySQL service starts; its application is deliberately not activated alongside the source identity. This verifies the new history tables within the full encrypted installation snapshot on the small scratch dataset. It adds no high-volume or external-storage guarantee.

## BigBlueButton-style classroom follow-up (2026-11-06)

The actual classroom now uses a full viewport stage, collapsible chat/people panel, navigation rail and portal-mounted LiveKit control bar. The adapted framing stylesheet and retained upstream references have explicit LGPL notices. See CLASSROOM_UI.md and third_party/bigbluebutton/NOTICE.md.

Native MySQL teaching and board-presence tests:11 pass,0 skip. Browser36848: advanced editor/presence/history/local-asset workflow and desktop/mobile/RTL layout pass. Its third setup was authentication-rate-limited, not a successful combined suite. Separate teaching3787 passes synchronized chat, hands, polls, notes, offline refresh and basic board. Type checking and updated offline-bundle inventory integrity pass.

Real SFU media2428 passes in development. Final isolated built-web media12019 passes8.4s (28s total): camera reception in an independent browser, microphone toggle preserving camera, screen sharing, focus/grid, device selection, Persian labels and end-session disconnect. Two earlier frame-reception failures remain unexplained; these passing local repeats do not establish broad reliability or physical-device compatibility. The earlier header-overlap failure was fixed by anchoring the device panel to the media region. Actual media screenshot classroom-media-fa.png is updated. Existing offline V6 artifacts predate this redesign; no claim of updated deployed offline images or release completion.
