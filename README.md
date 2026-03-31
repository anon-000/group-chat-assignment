# Group Chat

A real-time group chat backend and frontend with room-based messaging, media sharing, voice recording, role-based access control, typing indicators, presence, and read receipts.

## Tech Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| API Server | Express.js + TypeScript | REST endpoints |
| WebSocket | `ws` library | Real-time messaging |
| Database | PostgreSQL 16 + Prisma ORM | Persistent storage |
| Cache / Pub-Sub | Redis 7 (ioredis) | Presence, typing, cross-instance broadcast |
| Object Storage | MinIO (S3-compatible) | Media files |
| Auth | JWT (HS256) + bcrypt | Stateless authentication |
| Validation | Zod | Request schema validation |
| Frontend | Next.js + Tailwind CSS | Client UI |
| Infrastructure | Docker Compose | Local development |

---

## Quick Start

```bash
# 1. Start infrastructure
docker compose up -d   # Postgres, Redis, MinIO

# 2. Install backend dependencies
npm install

# 3. Run database migrations
npx prisma migrate dev

# 4. Start backend (port 3000)
npm run dev

# 5. In another terminal — start frontend (port 3001)
cd frontend && npm install && npm run dev
```

Open `http://localhost:3001` in your browser.

---

## Project Structure

```
group-chat/
├── docker-compose.yml
├── Dockerfile
├── prisma/
│   └── schema.prisma             # 7 models
├── src/
│   ├── index.ts                  # Server entry point
│   ├── config/
│   │   ├── index.ts              # Environment config
│   │   ├── db.ts                 # Prisma client
│   │   ├── redis.ts              # Redis + Redis subscriber clients
│   │   └── minio.ts              # MinIO client + bucket init
│   ├── middleware/
│   │   ├── auth.ts               # JWT verification
│   │   └── roleGuard.ts          # Role-based access control
│   ├── routes/
│   │   ├── auth.ts               # Signup, login, refresh, lookup
│   │   ├── rooms.ts              # Room CRUD + message history
│   │   ├── members.ts            # Add/remove/change role
│   │   ├── upload.ts             # Presigned upload/download URLs
│   │   └── presence.ts           # Online members query
│   ├── ws/
│   │   └── index.ts              # WebSocket server + message routing
│   └── types/
│       └── index.ts
└── frontend/
    └── src/
        ├── app/
        │   ├── login/page.tsx
        │   ├── signup/page.tsx
        │   └── chat/
        │       ├── page.tsx            # Main chat page
        │       └── components/
        │           ├── sidebar.tsx      # Room list
        │           ├── chat-view.tsx    # Messages + input
        │           └── room-settings.tsx
        └── lib/
            ├── api.ts              # Fetch wrapper with auto-refresh
            ├── auth-context.tsx     # Auth state provider
            └── use-websocket.ts     # WS hook with reconnect
```

---

## Data Model

```
users             id, name, email, password, avatar_url, created_at
rooms             id, name, type (direct|group), created_by, archived_at, created_at
room_members      room_id, user_id, role (admin|member|viewer), joined_at
messages          id, room_id, sender_id, type (text|media|system), content (jsonb), deleted_at, created_at
message_acks      message_id, user_id, status (delivered|read), updated_at
reactions         id, message_id, user_id, emoji, created_at
media_uploads     id, room_id, uploader_id, object_key, mime_type, filename, size_bytes, created_at
```

Key indexes: `messages(room_id, created_at)` for paginated history.
Unique constraints: `reactions(message_id, user_id, emoji)` prevents duplicate reactions.

---

## REST API

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/auth/signup` | No | Register. Body: `{name, email, password}` |
| POST | `/auth/login` | No | Login. Body: `{email, password}` |
| POST | `/auth/refresh` | No | Refresh tokens. Body: `{refreshToken}` |
| GET | `/auth/me` | Yes | Get current user profile |
| GET | `/auth/lookup?email=X` | Yes | Find user by email |

### Rooms

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/rooms` | Yes | List user's rooms (with unread count, last message) |
| POST | `/rooms` | Yes | Create room. Body: `{name, type, memberIds?}` |
| GET | `/rooms/:id` | Yes | Room details with members |
| GET | `/rooms/:id/messages` | Yes | Paginated history. Query: `?before=ISO&limit=N` |

### Members

| Method | Path | Auth | Role |
|--------|------|------|------|
| GET | `/rooms/:id/members` | Yes | Any member |
| POST | `/rooms/:id/members` | Yes | Admin only |
| PATCH | `/rooms/:id/members/:uid` | Yes | Admin only |
| DELETE | `/rooms/:id/members/:uid` | Yes | Admin only |

### Media & Presence

| Method | Path | Description |
|--------|------|-------------|
| POST | `/upload/presign` | Get presigned upload URL |
| GET | `/upload/download/:key` | Get presigned download URL |
| GET | `/rooms/:id/presence` | Online member IDs |

---

## WebSocket Protocol

**Connect:** `ws://localhost:3000/ws?token={JWT}`

All messages are JSON envelopes:

```json
{
  "type": "text | media | typing | reaction | ack",
  "room_id": "uuid",
  "payload": { ... },
  "timestamp": "ISO 8601"
}
```

### Message Types

| Type | Persisted | Viewer Can Send | Description |
|------|-----------|-----------------|-------------|
| `text` | Yes | No | Text message. Payload: `{text}` |
| `media` | Yes | No | File/image/audio. Payload: `{object_key, mime_type, filename, size_bytes}` |
| `typing` | No | No | Ephemeral typing indicator. Payload: `{state: "start"\|"stop"}` |
| `reaction` | Yes | No | Toggle emoji reaction. Payload: `{target_message_id, emoji}` |
| `ack` | Yes | Yes | Read receipt. Payload: `{target_message_id, status: "read"}` |
| `system` | No | Server-only | Join/leave events. Payload: `{event: "join"\|"leave"}` |

---

## Core Features — How They Work

### 1. Real-Time Messaging (Redis Pub/Sub)

The system uses Redis pub/sub for cross-instance message fan-out. Two Redis clients are maintained: one for commands (`redis`) and one for subscriptions (`redisSub`).

**Flow:**

```
User A sends message via WebSocket
        │
        ▼
Server validates membership + role
        │
        ▼
Message persisted to PostgreSQL (messages table)
        │
        ▼
redis.publish("room:{roomId}", JSON)
        │
        ▼
redisSub receives on "room:{roomId}" channel
        │
        ▼
broadcastToRoom() iterates all local WS connections
where meta.rooms.has(roomId), sends to each
```

Each WebSocket connection tracks which rooms it's subscribed to in a `connectionMeta` map. On connect, the server loads the user's room memberships and subscribes to all their room channels. If a room is created or joined after the WS connection is established, the subscription is added dynamically — either when the REST API creates the room/adds the member, or lazily on the first WS message to that room.

This design supports **horizontal scaling**: multiple server instances behind a load balancer all subscribe to the same Redis channels, so a message published by one instance reaches clients connected to all other instances.

### 2. Authentication

Users sign up with email + password. Passwords are hashed with bcrypt (10 rounds). On login/signup, the server issues two JWTs:

- **Access token** (24h TTL): Used in `Authorization: Bearer` header for REST and as query param for WS
- **Refresh token** (7d TTL): Contains `type: "refresh"`, used to get new token pairs

The frontend stores tokens in `localStorage` and auto-refreshes on 401 responses. The WS connection authenticates during the handshake via `?token=` query param.

### 3. Role-Based Access Control

Every room member has a role: `admin`, `member`, or `viewer`.

| Permission | Admin | Member | Viewer |
|------------|:-----:|:------:|:------:|
| Read messages | Yes | Yes | Yes |
| Send messages | Yes | Yes | No |
| Upload media | Yes | Yes | No |
| React to messages | Yes | Yes | No |
| Send typing indicators | Yes | Yes | No |
| Send read receipts | Yes | Yes | Yes |
| Manage members | Yes | No | No |
| Change roles | Yes | No | No |

Enforcement happens at two levels:
- **REST middleware** (`requireRole`): Checks `room_members` table before allowing admin-only operations
- **WebSocket handler**: Checks role on every incoming message; viewers get a `403` error event

The frontend replaces the input area with a "no permission" banner for viewers.

### 4. Presence

Online status is tracked via Redis keys with TTL:

```
Key:    user:{userId}:status
Value:  "online"
TTL:    30 seconds
```

- **On WS connect**: Set key with 30s TTL
- **Heartbeat** (every 20s): Reset TTL to keep alive
- **On disconnect**: Delete key (if last connection for that user)
- **On TTL expiry**: User automatically goes offline

Multiple connections (tabs/devices) are supported — the user stays online as long as any connection exists. The `GET /rooms/:id/presence` endpoint pipelines Redis `GET` calls for all room members and returns online IDs.

### 5. Typing Indicators

Purely ephemeral — no database writes. When a user types:

1. Client emits `typing` with `state: "start"` on keystroke
2. Client debounces and emits `state: "stop"` after 2s of inactivity
3. Server publishes directly to Redis `room:{roomId}` channel
4. Other clients show "{name} is typing..." with a 3s auto-expire timeout

### 6. Media Upload (Presigned URLs)

Binary data never transits the WebSocket. The flow uses presigned S3 URLs:

```
Client                    Server                    MinIO
  │                         │                         │
  ├─POST /upload/presign───►│                         │
  │  {mimeType, filename,   │                         │
  │   roomId}               │                         │
  │                         ├─validate role, mime──►   │
  │                         ├─generate object key──►   │
  │                         ├─presignedPutObject()──►  │
  │◄─{uploadUrl, objectKey}─┤                         │
  │                         │                         │
  ├─PUT uploadUrl──────────────────────────────────►  │
  │  (file body)            │                         │
  │                         │                         │
  ├─WS: media message──────►│                         │
  │  {object_key, mime_type} │                         │
  │                         ├─persist + broadcast──►  │
  │                         │                         │
  │  (other clients)        │                         │
  │◄─WS: media broadcast────┤                         │
  │                         │                         │
  ├─GET /upload/download/key►│                         │
  │                         ├─presignedGetObject()──► │
  │◄─{downloadUrl}──────────┤                         │
  │                         │                         │
  ├─GET downloadUrl────────────────────────────────►  │
  │◄─file data──────────────────────────────────────┤ │
```

Allowed types: JPEG, PNG, GIF, WebP, MP3, OGG, WebM, MP4 audio, PDF, Word docs. Presigned URLs expire after 5 minutes.

### 7. Voice Messages

The frontend uses the browser's `MediaRecorder` API:

1. User taps the mic button (appears when text input is empty)
2. Browser requests microphone permission
3. Recording starts with `audio/webm;codecs=opus` (with fallback)
4. UI shows recording state: pulsing red dot, timer, cancel/send buttons
5. On send: recording stops, blob is uploaded via the presigned URL flow
6. A `media` WS message is sent with the audio metadata
7. Recipients see an inline `<audio>` player

### 8. Read Receipts

When messages appear in a user's viewport, the frontend sends `ack` messages:

```json
{"type": "ack", "room_id": "...", "payload": {"target_message_id": "...", "status": "read"}}
```

The server upserts into `message_acks` and broadcasts to the room. The sender sees:
- **Single checkmark** (gray): Message sent, not yet read
- **Double checkmark** (blue): Read by at least one person

Unread counts per room are computed server-side by counting messages with no read ack from the requesting user.

### 9. Rooms

Two types:
- **Group** (2-500 members): Creator becomes admin, can invite others
- **Direct** (exactly 2 members): Enforced uniqueness — can't create duplicate DMs

Rooms persist indefinitely. Messages support cursor-based pagination (`?before=timestamp&limit=N`, max 100). Soft-deleted messages return as `{deleted: true}` tombstones.

---



## Screenshots
<img width="1470" height="956" alt="Screenshot 2026-04-01 at 12 11 33 AM" src="https://github.com/user-attachments/assets/576bd8b5-cb9f-44af-9fdb-2ec04ce42f1f" />
<img width="1470" height="956" alt="Screenshot 2026-04-01 at 12 53 30 AM" src="https://github.com/user-attachments/assets/1609150f-b767-4937-8406-5c8be56f1d5b" />
<img width="1470" height="956" alt="Screenshot 2026-04-01 at 12 53 52 AM" src="https://github.com/user-attachments/assets/80cb526e-9538-45a2-9ae6-0d1c80a44048" />


---
## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `DATABASE_URL` | `postgresql://postgres:postgres@localhost:5432/groupchat` | PostgreSQL connection |
| `REDIS_URL` | `redis://localhost:6379` | Redis connection |
| `PORT` | `3000` | Server port |
| `JWT_SECRET` | — | Secret for signing JWTs |
| `JWT_EXPIRES_IN` | `24h` | Access token TTL |
| `JWT_REFRESH_EXPIRES_IN` | `7d` | Refresh token TTL |
| `MINIO_ENDPOINT` | `localhost` | MinIO host |
| `MINIO_PORT` | `9000` | MinIO S3 API port |
| `MINIO_ACCESS_KEY` | `minioadmin` | MinIO access key |
| `MINIO_SECRET_KEY` | `minioadmin` | MinIO secret key |
| `MINIO_BUCKET` | `chat-uploads` | S3 bucket name |
| `MINIO_USE_SSL` | `false` | TLS for MinIO |

---

## Docker Services

| Service | Image | Port | Purpose |
|---------|-------|------|---------|
| postgres | `postgres:16-alpine` | 5432 | Database |
| redis | `redis:7-alpine` | 6379 | Pub/sub + cache |
| minio | `minio/minio:latest` | 9000 (API), 9001 (console) | Object storage |

MinIO console: `http://localhost:9001` (minioadmin/minioadmin)
