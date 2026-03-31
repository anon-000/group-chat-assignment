import { Router, Response } from "express";
import { redis } from "../config/redis";
import { prisma } from "../config/db";
import { authenticate } from "../middleware/auth";
import { AuthRequest } from "../types";

const router = Router();

// Get online members in a room
router.get(
  "/:id/presence",
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const userId = req.user!.userId;
    const roomId = req.params.id as string;

    // Verify membership
    const membership = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!membership) {
      res.status(403).json({ error: "Not a member of this room" });
      return;
    }

    // Get all members of the room
    const members = await prisma.roomMember.findMany({
      where: { roomId },
      select: { userId: true },
    });

    // Check which are online in Redis
    const pipeline = redis.pipeline();
    for (const m of members) {
      pipeline.get(`user:${m.userId}:status`);
    }
    const results = await pipeline.exec();

    const onlineIds = members
      .filter((_, i) => results && results[i] && results[i][1] === "online")
      .map((m) => m.userId);

    res.json({ online: onlineIds });
  }
);

export default router;
