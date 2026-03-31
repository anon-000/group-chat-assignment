import { Response, NextFunction } from "express";
import { MemberRole } from "@prisma/client";
import { prisma } from "../config/db";
import { AuthRequest } from "../types";

export function requireRole(...roles: MemberRole[]) {
  return async (
    req: AuthRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const userId = req.user?.userId;
    const roomId = (req.params.roomId || req.params.id) as string;

    if (!userId || !roomId) {
      res.status(400).json({ error: "Missing user or room context" });
      return;
    }

    const membership = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });

    if (!membership) {
      res.status(403).json({ error: "Not a member of this room" });
      return;
    }

    if (!roles.includes(membership.role)) {
      res.status(403).json({ error: "Insufficient permissions" });
      return;
    }

    next();
  };
}
