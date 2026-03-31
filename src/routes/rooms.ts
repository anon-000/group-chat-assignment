import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { authenticate } from "../middleware/auth";
import { AuthRequest } from "../types";
import { subscribeUserToRoom } from "../ws";

const router = Router();

const createRoomSchema = z.object({
  name: z.string().min(1).max(200),
  type: z.enum(["direct", "group"]).default("group"),
  memberIds: z.array(z.string().uuid()).optional(),
});

// List rooms for current user
router.get(
  "/",
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.userId;

    const memberships = await prisma.roomMember.findMany({
      where: { userId },
      include: {
        room: {
          include: {
            members: {
              include: { user: { select: { id: true, name: true, avatarUrl: true } } },
            },
            messages: {
              take: 1,
              orderBy: { createdAt: "desc" },
              select: { id: true, content: true, type: true, createdAt: true },
            },
          },
        },
      },
    });

    const rooms = await Promise.all(
      memberships.map(async (m) => {
        const unreadCount = await prisma.message.count({
          where: {
            roomId: m.roomId,
            createdAt: { gt: m.joinedAt },
            acks: { none: { userId, status: "read" } },
            senderId: { not: userId },
          },
        });

        return {
          ...m.room,
          role: m.role,
          unreadCount,
          lastMessage: m.room.messages[0] || null,
        };
      })
    );

    res.json(rooms);
  }
);

// Create room
router.post(
  "/",
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const parsed = createRoomSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const userId = req.user!.userId;
    const { name, type, memberIds } = parsed.data;

    // For direct rooms, exactly 1 other member
    if (type === "direct") {
      if (!memberIds || memberIds.length !== 1) {
        res
          .status(400)
          .json({ error: "Direct rooms require exactly one other member" });
        return;
      }

      // Check if direct room already exists between these two users
      const existing = await prisma.room.findFirst({
        where: {
          type: "direct",
          AND: [
            { members: { some: { userId } } },
            { members: { some: { userId: memberIds[0] } } },
          ],
        },
      });
      if (existing) {
        res.status(409).json({ error: "Direct room already exists", roomId: existing.id });
        return;
      }
    }

    const room = await prisma.room.create({
      data: {
        name,
        type,
        createdBy: userId,
        members: {
          create: [
            { userId, role: "admin" },
            ...(memberIds || []).map((id) => ({ userId: id, role: "member" as const })),
          ],
        },
      },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, avatarUrl: true } } },
        },
      },
    });

    // Subscribe all members' WS connections to the new room
    await subscribeUserToRoom(userId, room.id);
    for (const id of memberIds || []) {
      await subscribeUserToRoom(id, room.id);
    }

    res.status(201).json(room);
  }
);

// Get room details
router.get(
  "/:id",
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.userId;
    const roomId = req.params.id as string;

    const membership = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!membership) {
      res.status(403).json({ error: "Not a member of this room" });
      return;
    }

    const room = await prisma.room.findUnique({
      where: { id: roomId },
      include: {
        members: {
          include: { user: { select: { id: true, name: true, avatarUrl: true } } },
        },
      },
    });

    res.json(room);
  }
);

// Message history (cursor-paginated)
router.get(
  "/:id/messages",
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.userId;
    const roomId = req.params.id as string;
    const before = req.query.before as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);

    const membership = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!membership) {
      res.status(403).json({ error: "Not a member of this room" });
      return;
    }

    const messages = await prisma.message.findMany({
      where: {
        roomId,
        ...(before ? { createdAt: { lt: new Date(before) } } : {}),
      },
      orderBy: { createdAt: "desc" },
      take: limit,
      include: {
        sender: { select: { id: true, name: true, avatarUrl: true } },
        reactions: {
          select: { emoji: true, userId: true },
        },
        acks: {
          where: { status: "read" },
          select: { userId: true },
        },
      },
    });

    // Replace soft-deleted messages with tombstones
    const result = messages.map((m) => {
      if (m.deletedAt) {
        return { id: m.id, roomId: m.roomId, deleted: true, createdAt: m.createdAt };
      }
      return m;
    });

    res.json(result);
  }
);

export default router;
