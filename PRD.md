# Chat System — Product Requirements Document

**Version**: 1.0  
**Status**: Draft  
**Scope**: Backend-focused real-time chat platform with room-based messaging, rich media support, and role-based access control.

---

## 1. Problem Statement

Teams need a reliable real-time communication layer that supports text, media, and structured collaboration. The system must scale to concurrent users across multiple rooms while enforcing per-room access policies.

---

## 2. Goals

- Deliver real-time message transport with sub-100ms perceived latency
- Support multiple message types: text, images, audio, documents
- Enforce fine-grained roles (Admin / Member / Viewer) per room
- Provide presence signals: online status, typing indicators, read receipts
- Keep the WebSocket channel lightweight; offload binary data to object storage

---

## 3. Non-Goals (v1)

- End-to-end encryption
- Voice/video calling
- Message threading / replies (future)
- Mobile push notifications (future)

---

## 4. User Roles

| Role | Permissions |
|---|---|
| **Admin** | Invite/remove members, change roles, delete any message, archive room, edit room settings |
| **Member** | Send messages, upload media, react to messages, edit own messages, delete own messages |
| **Viewer** | Read-only. Receives all broadcasts. Cannot send messages or upload. |

Role checks are enforced server-side on every WebSocket event and REST request. The client receives a structured `error` event (`code: 403`) on violation.

---

## 5. Core Features

### 5.1 Rooms

- Rooms are the unit of conversation. Each has a unique `room_id`, a name, and an optional description.
- Room types: **Direct** (exactly 2 members) and **Group** (2–500 members).
- Rooms persist indefinitely unless explicitly archived by an Admin.
- Members join rooms via invite link or explicit add by an Admin.

### 5.2 Real-Time Messaging (WebSocket)

Every authenticated client maintains a persistent WebSocket connection. Messages are JSON envelopes:

```json
{
  "type": "text | media | typing | system | reaction | ack",
  "room_id": "uuid",
  "message_id": "uuid",
  "sender_id": "uuid",
  "payload": { ... },
  "timestamp": "ISO 8601"
}
```

**Message types:**

- `text` — UTF-8 string content, optional markdown
- `media` — `{ object_key, mime_type, filename, size_bytes }`. Binary never transits the socket.
- `typing` — `{ state: "start" | "stop" }`. Ephemeral, never persisted.
- `system` — `{ event: "join" | "leave" | "role_changed" }`. Server-generated.
- `reaction` — `{ target_message_id, emoji }`. Stored as a lightweight join record.
- `ack` — `{ target_message_id, status: "delivered" | "read" }`. Stored per user per message.

### 5.3 Media Upload Flow

1. Client calls `POST /upload/presign` with `{ mime_type, filename, room_id }`.
2. Server validates role (Member+), checks mime allowlist, returns a pre-signed S3 URL (TTL: 5 min).
3. Client uploads directly to S3.
4. Client sends a `media` WebSocket message with the resulting `object_key`.
5. Server broadcasts to room; recipients fetch from S3 using their own pre-signed read URLs.

Accepted mime types (v1): `image/jpeg`, `image/png`, `image/gif`, `image/webp`, `audio/mpeg`, `audio/ogg`, `application/pdf`, `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`.

### 5.4 Typing Indicators

- Client emits `typing` (`state: start`) on first keydown.
- Client emits `typing` (`state: stop`) after 2 seconds of inactivity (debounced).
- Server publishes to Redis pub/sub channel for the room; subscribers broadcast to other connections.
- No database writes. State lives only in memory and expires on disconnect.

### 5.5 Presence

- On WebSocket connect, server sets `user:{user_id}:status = online` in Redis with a 30s TTL.
- Client sends a heartbeat ping every 20s; server resets TTL.
- On disconnect (or TTL expiry), server broadcasts a `system` event (`event: leave`) to all rooms the user was in.
- `GET /rooms/{room_id}/presence` returns a list of online member IDs for a room.

### 5.6 Message History

- `GET /rooms/{room_id}/messages?before={cursor}&limit={n}` — cursor-paginated, newest first, max 100 per page.
- Messages include sender metadata, reactions summary, and read receipt counts.
- Soft-deleted messages are replaced with `{ "deleted": true }` tombstones.

### 5.7 Read Receipts

- When a client's visible viewport includes a message, it sends `ack` with `status: read`.
- Server stores `(message_id, user_id, read_at)` in Postgres.
- Room list endpoint returns `unread_count` per room for the requesting user.

---

## 6. Data Model (high level)

```
users           id, name, email, avatar_url, created_at
rooms           id, name, type (direct|group), created_by, archived_at
room_members    room_id, user_id, role (admin|member|viewer), joined_at
messages        id, room_id, sender_id, type, content (jsonb), deleted_at, created_at
message_acks    message_id, user_id, status (delivered|read), updated_at
reactions       id, message_id, user_id, emoji, created_at
media_uploads   id, room_id, uploader_id, object_key, mime_type, filename, size_bytes, created_at
```

---

## 7. API Surface

### REST

| Method | Path | Description |
|---|---|---|
| POST | `/auth/token` | Issue JWT |
| GET | `/rooms` | List rooms for current user |
| POST | `/rooms` | Create a room |
| GET | `/rooms/{id}/messages` | Paginated message history |
| GET | `/rooms/{id}/members` | List members with roles |
| POST | `/rooms/{id}/members` | Invite a user (Admin only) |
| PATCH | `/rooms/{id}/members/{uid}` | Change role (Admin only) |
| DELETE | `/rooms/{id}/members/{uid}` | Remove member (Admin only) |
| POST | `/upload/presign` | Get pre-signed S3 upload URL |
| GET | `/rooms/{id}/presence` | Online members in room |

### WebSocket

`WS /ws/{room_id}?token={jwt}`

Authentication is via JWT query param on handshake. After upgrade, all communication is JSON envelopes as described in §5.2.

---

## 8. Non-Functional Requirements

| Concern | Target |
|---|---|
| WebSocket connections per instance | 10,000 |
| Message broadcast latency (p99) | < 200ms |
| Media upload size limit | 100 MB per file |
| Message history retention | 1 year (configurable) |
| Auth token TTL | 24h (refresh via `/auth/refresh`) |
| Horizontal scaling | Stateless WS servers behind a load balancer; Redis pub/sub for cross-instance fan-out |

---

## 9. Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| API + WS server | FastAPI (Starlette WebSockets) | Native async WS, Python ecosystem |
| Database | PostgreSQL | Relational integrity for roles/messages |
| Cache / Pub-Sub | Redis | Typing events, presence TTLs, cross-instance broadcast |
| Object storage | S3-compatible (MinIO for local dev) | Binary offload, pre-signed URLs |
| Auth | JWT (RS256) | Stateless, verifiable on WS upgrade |
| Containerisation | Docker + docker-compose | Local parity with prod |

---

## 10. Out of Scope — Future Phases

- Message search (full-text via Postgres `tsvector` or OpenSearch)
- Message threading / reply chains
- End-to-end encryption
- Push notifications (FCM/APNs)
- Voice/video (WebRTC, separate signalling service)
- Bots / webhook integrations
- Message scheduling