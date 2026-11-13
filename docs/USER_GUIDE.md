# Foundation user guide

## Organization owner

Register with an email and a password of at least 12 characters, then sign in. Create an organization. A single account can create/join multiple organizations and switch from the sidebar. Add a member by their already registered email and select teacher or student. This is direct membership provisioning; no invitation email is sent. Only the owner can add members.

## Teacher

Select the organization and create a classroom. Enter it to connect to the configured media server. Microphone and camera are initially off; enable them with browser consent. All current organization members can access its classrooms. Private per-course enrollment and waiting-room admission are not available yet. The Participants tab provides per-source media permissions and media blocking; this does not revoke organization membership or persistent document/chat access.

## Student

Register first and ask the organization owner to add your account. Sign in, select the organization, then enter a classroom. Use the class discussion panel for persisted public messages. Messages are visible to organization members who open that classroom and are refreshed approximately every two seconds. There is no private messaging yet.

## Language and devices

Use English/فارسی to switch workspace language and logical direction. Your preference is stored in that browser. Third-party media controls and API errors still use English. Desktop and mobile workspace screenshots are in docs/screenshots. Actual phone media behavior has not been verified. Use HTTPS on remote devices; localhost only works on the same device.

## Teaching workspace

Open Teaching workspace from a classroom card. Teachers/owners start a session, launch a single-choice poll, publish results and control a shared countdown. Students can vote once and raise/lower their hand. Ending a session closes its activities and preserves documents.

The Documents tab lists persistent classroom documents. Teachers create plain-text notes or a basic board; selecting Teachers can edit restricts writes server-side. Notes support mixed Persian/English, local undo/redo and Markdown export. Boards support pen, rectangle, ellipse, text, object eraser, pan/zoom, undo/redo and SVG export. Unsent Yjs changes are cached in a per-account browser outbox and replayed only after the server reauthorizes document access. Wait for Saved when practical, especially if browser storage is unavailable. Advanced whiteboard tools, versions and rich formatting are not available yet. Use Connect audio & video in the teaching header to keep the media stage connected while using activities/documents. The Class discussion button opens live chat on the same page. A direct media-only entry remains available from the dashboard.

Teachers can open Attendance to view actual signed media connection records and export CSV. Reports combine this classroom's observed intervals across sessions and do not infer attention, learning or absences. Configure LiveKit webhooks first; otherwise no attendance records will appear.

Start a session before connecting media. Use Participants to disable or allow another participant's microphone, camera or screen sharing. Permission does not activate their device. Blocking media disconnects that user; restoring access lets them reconnect. Pending/failed changes are displayed, with retry for failed SFU operations. End session schedules media-room deletion and immediately rejects subsequent joins.

## Group work

From an active main session, open Breakout rooms. Choose names, duration, manual or balanced random assignment and whether students may choose rooms. Start group work. Students use Enter assigned room, or select an available room when permitted. Each group has independent media, chat and documents. Teachers can visit groups, move students, send announcements, extend time or close all rooms. Students can return to main themselves.

Rooms close when the server deadline expires. Browsers return to main and an existing media connection resumes using the user's previous device choices when permitted. A fresh page keeps devices off. Screen sharing needs a new browser action. Group assignments and room routes survive refreshes. A teacher can copy a group's notes or board to main as a new teacher-only document, including after closure. Failed media cleanup commands appear in the main Participants panel for retry.
