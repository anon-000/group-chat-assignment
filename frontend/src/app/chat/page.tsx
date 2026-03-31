"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useAuth } from "@/lib/auth-context";
import { useWebSocket, type WsMessage } from "@/lib/use-websocket";
import { apiFetch } from "@/lib/api";
import Sidebar from "./components/sidebar";
import ChatView from "./components/chat-view";
import RoomSettings from "./components/room-settings";

export interface Room {
  id: string;
  name: string;
  type: "direct" | "group";
  members: {
    userId: string;
    role: string;
    user: { id: string; name: string; avatarUrl?: string };
  }[];
  role: string;
  unreadCount: number;
  lastMessage?: {
    id: string;
    content: Record<string, unknown>;
    type: string;
    createdAt: string;
  };
}

export interface Message {
  id: string;
  roomId: string;
  type: string;
  content: Record<string, unknown>;
  sender: { id: string; name: string; avatarUrl?: string };
  sender_id?: string;
  reactions: { emoji: string; userId: string }[];
  readBy: string[];
  createdAt: string;
  deleted?: boolean;
}

export default function ChatPage() {
  const { user } = useAuth();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [activeRoomId, setActiveRoomId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const token =
    typeof window !== "undefined"
      ? localStorage.getItem("accessToken")
      : null;
  const { connected, send, subscribe } = useWebSocket(token);
  const activeRoomIdRef = useRef(activeRoomId);
  activeRoomIdRef.current = activeRoomId;

  const loadRooms = useCallback(async () => {
    const res = await apiFetch("/rooms");
    if (res.ok) {
      const data = await res.json();
      setRooms(data);
    }
  }, []);

  useEffect(() => {
    loadRooms();
  }, [loadRooms]);

  // Clear unread when switching rooms
  useEffect(() => {
    if (activeRoomId) {
      setRooms((prev) =>
        prev.map((r) =>
          r.id === activeRoomId ? { ...r, unreadCount: 0 } : r
        )
      );
    }
  }, [activeRoomId]);

  // Update room list on new messages — subscribe once, read activeRoomId from ref
  useEffect(() => {
    const unsub = subscribe((msg: WsMessage) => {
      if (
        (msg.type === "text" || msg.type === "media") &&
        msg.room_id
      ) {
        const isOwnMessage = msg.sender_id === user!.id;
        setRooms((prev) =>
          prev.map((r) => {
            if (r.id === msg.room_id) {
              return {
                ...r,
                lastMessage: {
                  id: msg.message_id || "",
                  content: msg.payload || {},
                  type: msg.type,
                  createdAt: msg.timestamp || new Date().toISOString(),
                },
                unreadCount:
                  isOwnMessage || msg.room_id === activeRoomIdRef.current
                    ? r.unreadCount
                    : r.unreadCount + 1,
              };
            }
            return r;
          })
        );
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribe]);

  const activeRoom = rooms.find((r) => r.id === activeRoomId) || null;

  return (
    <div className="flex h-screen">
      <Sidebar
        rooms={rooms}
        activeRoomId={activeRoomId}
        onSelectRoom={(id) => {
          setActiveRoomId(id);
          setShowSettings(false);
        }}
        onRoomCreated={loadRooms}
        currentUserId={user!.id}
      />

      <div className="flex min-h-0 flex-1 flex-col">
        {activeRoom ? (
          <>
            {/* Room header */}
            <div className="flex items-center justify-between border-b border-gray-800 px-6 py-3">
              <div>
                <h2 className="font-semibold">{activeRoom.name}</h2>
                <p className="text-xs text-gray-400">
                  {activeRoom.members.length} members
                  {connected && (
                    <span className="ml-2 text-green-400">connected</span>
                  )}
                </p>
              </div>
              <button
                onClick={() => setShowSettings(!showSettings)}
                className="rounded-lg p-2 text-gray-400 hover:bg-gray-800 hover:text-gray-200"
              >
                <svg
                  className="h-5 w-5"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z"
                  />
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
                  />
                </svg>
              </button>
            </div>

            {showSettings ? (
              <RoomSettings
                room={activeRoom}
                currentUserId={user!.id}
                onClose={() => setShowSettings(false)}
                onUpdated={loadRooms}
              />
            ) : (
              <ChatView
                room={activeRoom}
                currentUserId={user!.id}
                send={send}
                subscribe={subscribe}
              />
            )}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-gray-500">
            Select a room to start chatting
          </div>
        )}
      </div>
    </div>
  );
}
