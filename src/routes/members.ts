import { Router, Response } from "express";
import { z } from "zod";
import { prisma } from "../config/db";
import { authenticate } from "../middleware/auth";
import { requireRole } from "../middleware/roleGuard";
import { AuthRequest } from "../types";

const router = Router({ mergeParams: true });

// List members
router.get(
  "/",
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

    const members = await prisma.roomMember.findMany({
      where: { roomId },
      include: {
        user: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
    });

    res.json(members);
  }
);

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(["admin", "member", "viewer"]).default("member"),
});

// Add member (admin only)
router.post(
  "/",
  authenticate,
  requireRole("admin"),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const roomId = req.params.id as string;
    const parsed = addMemberSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const { userId, role } = parsed.data;

    // Check user exists
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    // Check not already a member
    const existing = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (existing) {
      res.status(409).json({ error: "User is already a member" });
      return;
    }

    const member = await prisma.roomMember.create({
      data: { roomId, userId, role },
      include: {
        user: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
    });

    res.status(201).json(member);
  }
);

const updateRoleSchema = z.object({
  role: z.enum(["admin", "member", "viewer"]),
});

// Change role (admin only)
router.patch(
  "/:uid",
  authenticate,
  requireRole("admin"),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const roomId = req.params.id as string;
    const targetUserId = req.params.uid as string;

    const parsed = updateRoleSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const membership = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId: targetUserId } },
    });
    if (!membership) {
      res.status(404).json({ error: "Member not found" });
      return;
    }

    const updated = await prisma.roomMember.update({
      where: { roomId_userId: { roomId, userId: targetUserId } },
      data: { role: parsed.data.role },
      include: {
        user: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
    });

    res.json(updated);
  }
);

// Remove member (admin only)
router.delete(
  "/:uid",
  authenticate,
  requireRole("admin"),
  async (req: AuthRequest, res: Response): Promise<void> => {
    const roomId = req.params.id as string;
    const targetUserId = req.params.uid as string;

    // Prevent removing self if last admin
    if (targetUserId === req.user!.userId) {
      const adminCount = await prisma.roomMember.count({
        where: { roomId, role: "admin" },
      });
      if (adminCount <= 1) {
        res
          .status(400)
          .json({ error: "Cannot remove the last admin from the room" });
        return;
      }
    }

    await prisma.roomMember.delete({
      where: { roomId_userId: { roomId, userId: targetUserId } },
    });

    res.status(204).end();
  }
);

export default router;
