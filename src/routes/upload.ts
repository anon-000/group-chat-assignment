import { Router, Response } from "express";
import { z } from "zod";
import { v4 as uuidv4 } from "uuid";
import { minioClient } from "../config/minio";
import { config } from "../config";
import { prisma } from "../config/db";
import { authenticate } from "../middleware/auth";
import { AuthRequest } from "../types";

const router = Router();

const ALLOWED_MIMES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "audio/mpeg",
  "audio/ogg",
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const presignSchema = z.object({
  mimeType: z.string(),
  filename: z.string().min(1),
  roomId: z.string().uuid(),
});

// Get pre-signed upload URL
router.post(
  "/presign",
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const parsed = presignSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    const userId = req.user!.userId;
    const { mimeType, filename, roomId } = parsed.data;

    if (!ALLOWED_MIMES.has(mimeType)) {
      res.status(400).json({ error: "File type not allowed" });
      return;
    }

    // Verify user is a member with send permissions
    const membership = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId, userId } },
    });
    if (!membership || membership.role === "viewer") {
      res.status(403).json({ error: "No upload permission for this room" });
      return;
    }

    const objectKey = `${roomId}/${uuidv4()}-${filename}`;

    const uploadUrl = await minioClient.presignedPutObject(
      config.minio.bucket,
      objectKey,
      5 * 60 // 5 min TTL
    );

    // Record the upload
    await prisma.mediaUpload.create({
      data: {
        roomId,
        uploaderId: userId,
        objectKey,
        mimeType,
        filename,
        sizeBytes: 0, // Updated after upload if needed
      },
    });

    res.json({ uploadUrl, objectKey });
  }
);

// Get pre-signed download URL
router.get(
  "/download/:objectKey(*)",
  authenticate,
  async (req: AuthRequest, res: Response): Promise<void> => {
    const objectKey = req.params.objectKey as string;

    const media = await prisma.mediaUpload.findFirst({
      where: { objectKey },
    });
    if (!media) {
      res.status(404).json({ error: "File not found" });
      return;
    }

    // Verify user is a member of the room
    const membership = await prisma.roomMember.findUnique({
      where: { roomId_userId: { roomId: media.roomId, userId: req.user!.userId } },
    });
    if (!membership) {
      res.status(403).json({ error: "No access to this file" });
      return;
    }

    const downloadUrl = await minioClient.presignedGetObject(
      config.minio.bucket,
      objectKey,
      5 * 60
    );

    res.json({ downloadUrl });
  }
);

export default router;
