"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { getWsUrl } from "./api";

export interface WsMessage {
  type: string;
  room_id?: string;
  message_id?: string;
  sender_id?: string;
  payload?: Record<string, unknown>;
  sender?: { id: string; name: string; avatarUrl?: string };
  timestamp?: string;
}

export function useWebSocket(token: string | null) {
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const listenersRef = useRef<Set<(msg: WsMessage) => void>>(new Set());
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const closedIntentionallyRef = useRef(false);

  const connect = useCallback(() => {
    if (!token) return;

    // Close any existing connection first
    if (wsRef.current) {
      closedIntentionallyRef.current = true;
      wsRef.current.close();
      wsRef.current = null;
    }

    closedIntentionallyRef.current = false;
    const ws = new WebSocket(getWsUrl(token));
    wsRef.current = ws;

    ws.onopen = () => setConnected(true);

    ws.onmessage = (event) => {
      // Only process if this is still the active connection
      if (wsRef.current !== ws) return;
      try {
        const msg: WsMessage = JSON.parse(event.data);
        listenersRef.current.forEach((fn) => fn(msg));
      } catch {
        // ignore
      }
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      setConnected(false);
      // Only reconnect if not intentionally closed
      if (!closedIntentionallyRef.current) {
        reconnectTimerRef.current = setTimeout(connect, 2000);
      }
    };

    ws.onerror = () => ws.close();
  }, [token]);

  useEffect(() => {
    connect();
    return () => {
      closedIntentionallyRef.current = true;
      clearTimeout(reconnectTimerRef.current);
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [connect]);

  const send = useCallback((msg: WsMessage) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const subscribe = useCallback((fn: (msg: WsMessage) => void) => {
    listenersRef.current.add(fn);
    return () => {
      listenersRef.current.delete(fn);
    };
  }, []);

  return { connected, send, subscribe };
}
