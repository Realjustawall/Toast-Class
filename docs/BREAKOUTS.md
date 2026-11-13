# Breakout room protocol

Group work is part of an active main classroom session. The teacher creates 2–12 named rooms with a 30 second–24 hour server deadline. Manual assignment and balanced random assignment validate that every selected account is a distinct student in the same organization. Teachers visit any child; students enter only their current assignment. Optional self selection permits a student to change their own assignment. A student may always choose to return to main.

Each child has its own persisted classroom and classroom session, and therefore a distinct LiveKit room, chat history, notes, boards, polls and attendance. The organization classroom list omits child rooms. Nesting groups and manually restarting/ending child sessions are rejected. Main-session termination closes all active children in the same database transaction.

## Authorization and moves

Child data routes reuse the classroom access guard. Student access additionally checks the active group, deadline, parent session and assignment. Media token issuance and the authenticated signaling gateway repeat the current location check. An assigned student cannot obtain a main-room media token until returning to main; all normal organization role boundaries remain in force.

Assignment changes increment a durable revision and append an event. In the same transaction, media removal commands target every non-destination room, including main. A worker executes only commands for the current revision of an active group. This prevents an older delayed move from disconnecting a student who has since legitimately returned. It also removes any remaining connections from other rooms. Gateway checks reject old-location tokens immediately; removing an existing SFU connection is asynchronous and its failure is visible in media command status. Keep upstream signaling private as described in MEDIA_CONTROL.md.

The browser follows assignment changes while in a child. Main-room assignments show an explicit invitation to enter. Room routes survive refreshes. During an in-app move, an already connected user's own microphone/camera choices carry to the destination, subject to the destination policy and browser permission. A fresh page never automatically captures devices. Screen capture always requires a new browser action. A manual media disconnect opts out of automatic media reconnection on a subsequent room change.

## Closing, expiry and recovery

An expiry worker checks persisted deadlines every second. Transactions lock the parent session before the group and children, recheck status, end child activities, enqueue actual SFU room deletions and emit a system audit event. Each replica may run this worker; row locking and the status recheck prevent duplicate closure. Missed deadlines are processed after restart. Join/data authorization uses the deadline even before the worker runs.

Realtime invalidations plus periodic state recovery update the browser. Group deadlines use server time, not browser authority. The displayed assigned count comes from assignments; live media count comes from the SFU and is unavailable when it cannot be measured. These numbers describe different states and include a visiting teacher in the media count.

Closed group documents remain accessible to teachers. Copy document to main creates a new teacher-only document, copies the Yjs update log and preserves source lineage and authorship. It supports both existing basic board and plain-text note documents. It does not merge into an existing document or implement version history.

## Limits

Teaching-assistant scopes, per-class enrollment, a separate breakout analytics report, rich text, advanced board tools, document compaction and per-node resource placement remain pending. Students lose child data access after returning or closure; closing does not erase their already downloaded data or browser outbox. No retention policy is implemented yet. Short network interruption retains assignment, but physical mobile recovery, TURN-only connectivity and adverse-network tests have not run. There is no E2EE claim.
