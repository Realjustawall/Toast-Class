# Media control and authenticated signaling

TOASTER uses LiveKit as the SFU and a same-origin Fastify signaling gateway. The browser receives `/api/v1/media/signal` as its server URL. `LIVEKIT_URL` is an **internal API-to-SFU address**, never the public browser signaling address.

## Network boundary

Keep SFU signaling port 7880 private. Docker Compose binds it to 127.0.0.1; the Caddy example routes public `/api/*` to the application and does not expose a direct SFU hostname. Only the app may access upstream signaling/RoomService APIs. ICE media transport still uses its configured UDP/TCP ports. Direct public SFU signaling would bypass the revocation checks described below; this deployment invariant is mandatory, not an optional optimization.

The gateway accepts only the RTC websocket and validation paths. It does not proxy arbitrary SFU admin APIs. Each signaling upgrade validates the HttpOnly application cookie, token signature/expiry, exact user identity, organization membership, active classroom session and policy version. Browser websocket Origin must match APP_ORIGIN. Upstream host comes only from trusted configuration, never a request parameter. Signaling payload/queue limits are 1 MiB. Log serializers remove query strings, which may carry media tokens.

## Session identity and permissions

A media room is `toaster-<classroom-session-UUID>`. Ending one session cannot accidentally delete a later session's room. Join tokens contain opaque classroom/session IDs and a policy version in signed metadata. Clients cannot update their own metadata or publish data-channel messages. Public class chat uses the separately authorized, persistent application channel.

Per-session media permissions independently allow microphone, camera and screen sharing, or block media access entirely. A policy update is committed with its audit event and durable SFU command in one transaction. New tokens use the new policy; previous tokens fail gateway validation even before their TTL expires. The SFU command mutes disallowed published tracks and updates publishing-source permissions, or disconnects a blocked participant. Restoring permission never turns on another user's device.

LiveKit self-hosted token revocation alone is insufficient for this boundary. TOASTER relies on private upstream signaling plus gateway checks, not a claim that self-hosted LiveKit invalidates every issued token. Live permission updates and old-token rejection were tested against an actual self-hosted SFU. Application logout currently rejects subsequent signaling requests; an already established media connection is not immediately terminated solely by logout. Further account-session/media reconciliation remains required.

## Durable media commands

Migration 004 adds media_permissions and media_commands. Workers claim commands with PostgreSQL `FOR UPDATE SKIP LOCKED`, then lock the classroom session through the bounded SFU operation. A newer policy version supersedes older commands. SFU calls time out after five seconds. Failures retry up to eight attempts with exponential delay capped at 60 seconds, then become visibly failed. Teachers can inspect command state and explicitly retry failed commands. Deletion/removal are idempotent when the SFU room/participant no longer exists.

Ending a session commits the ended state and deletion command atomically. The gateway denies new/reconnecting entrants immediately after commit. Existing media disconnects when deletion succeeds. The UI exposes pending/failed changes instead of claiming an unavailable SFU has already applied them. No distributed transaction with the SFU is claimed; retries provide eventual application of the durable intent.

## API

| Method | Route                                                   | Policy                                                                                   |
| ------ | ------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| POST   | /api/v1/classrooms/:id/join                             | Active session + membership; returns scoped token, gateway URL and current policy        |
| GET    | /api/v1/classrooms/:id/participants                     | Actual SFU participant state; no simulated counts                                        |
| POST   | /api/v1/classrooms/:id/participants/:userId/permissions | Teacher/owner; full microphone/camera/screenShare/blocked policy; returns 202 command ID |
| GET    | /api/v1/classrooms/:id/media-commands                   | Teacher/owner; includes prior session cleanup state                                      |
| POST   | /api/v1/classrooms/:id/media-commands/:command/retry    | Teacher/owner; failed commands only                                                      |

Media blocking currently blocks audio/video access, not organization membership or access to persistent class documents/chat. Full classroom admission/banning, configurable contextual RBAC, TURN-only testing, packet-loss recovery and physical device certification remain pending.
