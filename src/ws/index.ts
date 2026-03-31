import { Server as HttpServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import jwt from "jsonwebtoken";
import { URL } from "url";
import { config } from "../config";
import { redis, redisSub } from "../config/redis";
import { prisma } from "../config/db";
import { AuthPayload, WsEnvelope } from "../types";
import { v4 as uuidv4 } from "uuid";

// Map: userId -> Set of WebSocket connections (supports multiple tabs/devices)
const userConnections = new Map<string, Set<WebSocket>>();
// Map: ws -> { userId, rooms }
const connectionMeta = new Map<
  WebSocket,
  { userId: string; rooms: Set<string> }
>();

const PRESENCE_TTL = 30;
const HEARTBEAT_INTERVAL = 20_000;

export function setupWebSocket(server: HttpServer) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  // Subscribe to Redis for cross-instance broadcasting
  redisSub.on("message", (channel: string, message: string) => {
    // channel format: room:{roomId}
    const roomId = channel.replace("room:", "");
    broadcastToRoom(roomId, message);
  });

  wss.on("connection", async (ws: WebSocket, req) => {
    // Authenticate via query param
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    const token = url.searchParams.get("token");

    if (!token) {
      ws.close(4001, "Missing token");
      return;
    }

    let payload: AuthPayload;
    try {
      payload = jwt.verify(token, config.jwt.secret) as AuthPayload;
    } catch {
      ws.close(4001, "Invalid token");
      return;
    }

    const userId = payload.userId;

    // Register connection
    if (!userConnections.has(userId)) {
      userConnections.set(userId, new Set());
    }
    userConnections.get(userId)!.add(ws);
    connectionMeta.set(ws, { userId, rooms: new Set() });

    // Set presence
    await redis.set(`user:${userId}:status`, "online", "EX", PRESENCE_TTL);

    // Load user's rooms and subscribe to Redis channels
    const memberships = await prisma.roomMember.findMany({
      where: { userId },
      select: { roomId: true },
    });

    const meta = connectionMeta.get(ws)!;
    for (const m of memberships) {
      meta.rooms.add(m.roomId);
      await redisSub.subscribe(`room:${m.roomId}`);
    }

    // Heartbeat to keep presence alive
    const heartbeatTimer = setInterval(async () => {
      if (ws.readyState === WebSocket.OPEN) {
        await redis.set(
          `user:${userId}:status`,
          "online",
          "EX",
          PRESENCE_TTL
        );
      }
    }, HEARTBEAT_INTERVAL);

    // Handle incoming messages
    ws.on("message", async (raw: Buffer) => {
      try {
        const envelope = JSON.parse(raw.toString()) as WsEnvelope;
        await handleMessage(ws, userId, envelope);
      } catch (err) {
        ws.send(
          JSON.stringify({ type: "error", payload: { message: "Invalid message format" } })
        );
      }
    });

    // Handle disconnect
    ws.on("close", async () => {
      clearInterval(heartbeatTimer);

      const conns = userConnections.get(userId);
      if (conns) {
        conns.delete(ws);
        if (conns.size === 0) {
          userConnections.delete(userId);
          await redis.del(`user:${userId}:status`);

          // Broadcast offline to all rooms
          for (const roomId of meta.rooms) {
            const sysMsg = JSON.stringify({
              type: "system",
              room_id: roomId,
              sender_id: userId,
              payload: { event: "leave" },
              timestamp: new Date().toISOString(),
            });
            await redis.publish(`room:${roomId}`, sysMsg);
          }
        }
      }
      connectionMeta.delete(ws);
    });

    // Notify rooms that user is online
    for (const roomId of meta.rooms) {
      const sysMsg = JSON.stringify({
        type: "system",
        room_id: roomId,
        sender_id: userId,
        payload: { event: "join" },
        timestamp: new Date().toISOString(),
      });
      await redis.publish(`room:${roomId}`, sysMsg);
    }

    ws.send(JSON.stringify({ type: "connected", payload: { userId } }));
  });

  return wss;
}

async function handleMessage(
  ws: WebSocket,
  userId: string,
  envelope: WsEnvelope
) {
  const { type, room_id } = envelope;

  // Verify room membership
  const membership = await prisma.roomMember.findUnique({
    where: { roomId_userId: { roomId: room_id, userId } },
  });
  if (!membership) {
    ws.send(
      JSON.stringify({
        type: "error",
        payload: { code: 403, message: "Not a member of this room" },
      })
    );
    return;
  }

  switch (type) {
    case "text":
    case "media": {
      // Viewers cannot send
      if (membership.role === "viewer") {
        ws.send(
          JSON.stringify({
            type: "error",
            payload: { code: 403, message: "Viewers cannot send messages" },
          })
        );
        return;
      }

      const messageId = uuidv4();
      const message = await prisma.message.create({
        data: {
          id: messageId,
          roomId: room_id,
          senderId: userId,
          type: type === "text" ? "text" : "media",
          content: envelope.payload as any,
        },
      });

      const sender = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, name: true, avatarUrl: true },
      });

      const outgoing = JSON.stringify({
        type,
        room_id,
        message_id: message.id,
        sender_id: userId,
        payload: envelope.payload,
        sender,
        timestamp: message.createdAt.toISOString(),
      });

      await redis.publish(`room:${room_id}`, outgoing);
      break;
    }

    case "typing": {
      if (membership.role === "viewer") return;

      // Ephemeral — publish to Redis, never persist
      const typingMsg = JSON.stringify({
        type: "typing",
        room_id,
        sender_id: userId,
        payload: envelope.payload,
        timestamp: new Date().toISOString(),
      });
      await redis.publish(`room:${room_id}`, typingMsg);
      break;
    }

    case "reaction": {
      if (membership.role === "viewer") return;

      const { target_message_id, emoji } = envelope.payload as {
        target_message_id: string;
        emoji: string;
      };

      // Toggle reaction — add if not exists, remove if exists
      const existing = await prisma.reaction.findFirst({
        where: { messageId: target_message_id, userId, emoji },
      });

      if (existing) {
        await prisma.reaction.delete({ where: { id: existing.id } });
      } else {
        await prisma.reaction.create({
          data: { messageId: target_message_id, userId, emoji },
        });
      }

      const reactionMsg = JSON.stringify({
        type: "reaction",
        room_id,
        sender_id: userId,
        payload: {
          target_message_id,
          emoji,
          action: existing ? "removed" : "added",
        },
        timestamp: new Date().toISOString(),
      });
      await redis.publish(`room:${room_id}`, reactionMsg);
      break;
    }

    case "ack": {
      const { target_message_id, status } = envelope.payload as {
        target_message_id: string;
        status: "delivered" | "read";
      };

      await prisma.messageAck.upsert({
        where: {
          messageId_userId: { messageId: target_message_id, userId },
        },
        create: { messageId: target_message_id, userId, status },
        update: { status },
      });

      const ackMsg = JSON.stringify({
        type: "ack",
        room_id,
        sender_id: userId,
        payload: { target_message_id, status },
        timestamp: new Date().toISOString(),
      });
      await redis.publish(`room:${room_id}`, ackMsg);
      break;
    }
  }
}

function broadcastToRoom(roomId: string, message: string) {
  // Send to all local connections that are subscribed to this room
  for (const [ws, meta] of connectionMeta) {
    if (meta.rooms.has(roomId) && ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  }
}
