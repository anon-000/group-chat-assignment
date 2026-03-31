import { Request } from "express";

export interface AuthPayload {
  userId: string;
  email: string;
}

export interface AuthRequest extends Request {
  user?: AuthPayload;
}

export type WsMessageType =
  | "text"
  | "media"
  | "typing"
  | "system"
  | "reaction"
  | "ack";

export interface WsEnvelope {
  type: WsMessageType;
  room_id: string;
  message_id?: string;
  sender_id?: string;
  payload: Record<string, unknown>;
  timestamp: string;
}
