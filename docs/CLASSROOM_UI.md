# Classroom interface

The classroom uses a full viewport stage, collapsible chat/people panel, navigation rail and persistent media controls. English uses LTR; Persian mirrors the logical layout. Small screens collapse the side panel to preserve the stage. Chat, participant lists and controls use actual authorized application state.

The framing adapts the BigBlueButton HTML5 client's navigation, sidebar and action-bar source patterns. See [the source and license notice](../third_party/bigbluebutton/NOTICE.md). This is not a measured copying percentage, pixel-for-pixel compatibility claim or adoption of BBB's server architecture.

## Workflows

- **Documents** selects notes or boards. Teachers use **Manage class content** to create a document in an accessible dialog.
- **Class discussion** and **Participants** toggle the side panel. Online people are authenticated classroom event connections, deduplicated by account; this is separate from SFU media participation and attendance.
- **Apps** opens activities, files, breakout rooms and attendance. Only authorized roles receive the corresponding controls.
- **Connect audio & video** joins the self-hosted SFU. Actual microphone, camera, screen sharing and disconnect controls appear in the bottom toolbar. Capture still requires browser permissions.
- A received screen-share track occupies the central stage. The board remains mounted so the layout switch does not discard editor state.
- Session controls, language and fullscreen remain in the header. Device settings open within the media region, clear of header controls.

## Verification and limits

`tests/e2e/classroom-layout.spec.ts` exercises two independent browsers, real chat delivery, online identities, RTL, desktop stage width and mobile overflow/footer bounds. `tests/e2e/advanced-board.spec.ts` exercises actual editor synchronization, remote presence, refresh, exports, snapshots and restored-generation recovery. `tests/media/classroom-ui.spec.ts` separately requires an actual SFU and synthetic browser devices; visual layout checks alone do not verify media.

Real application captures are retained in `docs/screenshots/classroom-layout-desktop.png` and `classroom-layout-mobile.png`. See VERIFICATION.md for final run results. Physical-device, cross-browser, accessibility and capacity gates remain open. Features such as recording, advanced quizzes and the complete LMS remain separate unfinished requirements; no decorative controls imply their completion.
