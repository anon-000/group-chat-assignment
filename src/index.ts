import express from "express";
import cors from "cors";
import http from "http";
import { config } from "./config";
import { prisma } from "./config/db";
import { ensureBucket } from "./config/minio";
import { setupWebSocket } from "./ws";
import authRouter from "./routes/auth";
import roomsRouter from "./routes/rooms";
import membersRouter from "./routes/members";
import uploadRouter from "./routes/upload";
import presenceRouter from "./routes/presence";

const app = express();

app.use(cors());
app.use(express.json());

// REST routes
app.use("/auth", authRouter);
app.use("/rooms", roomsRouter);
app.use("/rooms/:id/members", membersRouter);
app.use("/upload", uploadRouter);
app.use("/rooms", presenceRouter);

// Health check
app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

const server = http.createServer(app);

// WebSocket
setupWebSocket(server);

async function main() {
  // Ensure MinIO bucket exists
  try {
    await ensureBucket();
    console.log("MinIO bucket ready");
  } catch (err) {
    console.warn("MinIO not available yet, will retry on first upload:", err);
  }

  // Verify DB connection
  await prisma.$connect();
  console.log("Database connected");

  server.listen(config.port, () => {
    console.log(`Server running on port ${config.port}`);
    console.log(`WebSocket available at ws://localhost:${config.port}/ws`);
  });
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
