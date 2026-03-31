"use client";

import { useState } from "react";
import { useAuth } from "@/lib/auth-context";
import { apiFetch } from "@/lib/api";
import type { Room } from "../page";

interface SidebarProps {
  rooms: Room[];
  activeRoomId: string | null;
  onSelectRoom: (id: string) => void;
  onRoomCreated: () => void;
  currentUserId: string;
}

export default function Sidebar({
  rooms,
  activeRoomId,
  onSelectRoom,
  onRoomCreated,
  currentUserId,
}: SidebarProps) {
  const { user, logout } = useAuth();
  const [showCreateModal, setShowCreateModal] = useState(false);

  return (
    <div className="flex w-72 flex-col border-r border-gray-800 bg-gray-900">
      {/* User header */}
      <div className="flex items-center justify-between border-b border-gray-800 px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-600 text-sm font-medium">
            {user?.name?.[0]?.toUpperCase()}
          </div>
          <span className="text-sm font-medium">{user?.name}</span>
        </div>
        <button
          onClick={logout}
          className="text-xs text-gray-400 hover:text-gray-200"
        >
          Logout
        </button>
      </div>

      {/* New room button */}
      <div className="p-3">
        <button
          onClick={() => setShowCreateModal(true)}
          className="w-full rounded-lg bg-gray-800 px-3 py-2 text-sm text-gray-300 hover:bg-gray-700"
        >
          + New Room
        </button>
      </div>

      {/* Room list */}
      <div className="flex-1 overflow-y-auto">
        {rooms.map((room) => {
          const displayName =
            room.type === "direct"
              ? room.members.find((m) => m.userId !== currentUserId)?.user
                  .name || room.name
              : room.name;

          let lastMsgText = "";
          if (room.lastMessage) {
            const c = room.lastMessage.content;
            if (typeof c === "object" && c && "text" in c) {
              lastMsgText = c.text as string;
            } else if (room.lastMessage.type === "media") {
              const mime = typeof c === "object" && c && "mime_type" in c
                ? (c.mime_type as string)
                : "";
              const filename = typeof c === "object" && c && "filename" in c
                ? (c.filename as string)
                : "";
              if (mime.startsWith("image/")) lastMsgText = "📷 Photo";
              else if (mime.startsWith("audio/")) lastMsgText = "🎤 Voice message";
              else lastMsgText = `📎 ${filename || "File"}`;
            }
          }

          return (
            <button
              key={room.id}
              onClick={() => onSelectRoom(room.id)}
              className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
                activeRoomId === room.id
                  ? "bg-gray-800"
                  : "hover:bg-gray-800/50"
              }`}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-gray-700 text-sm font-medium">
                {room.type === "group" ? "#" : displayName[0]?.toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between">
                  <span className="truncate text-sm font-medium">
                    {displayName}
                  </span>
                  {room.unreadCount > 0 && (
                    <span className="ml-2 flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 px-1.5 text-xs">
                      {room.unreadCount}
                    </span>
                  )}
                </div>
                {lastMsgText && (
                  <p className="truncate text-xs text-gray-400">
                    {lastMsgText}
                  </p>
                )}
              </div>
            </button>
          );
        })}

        {rooms.length === 0 && (
          <p className="px-4 py-8 text-center text-sm text-gray-500">
            No rooms yet. Create one!
          </p>
        )}
      </div>

      {/* Create Room Modal */}
      {showCreateModal && (
        <CreateRoomModal
          onClose={() => setShowCreateModal(false)}
          onCreated={() => {
            setShowCreateModal(false);
            onRoomCreated();
          }}
        />
      )}
    </div>
  );
}

function CreateRoomModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");

    const res = await apiFetch("/rooms", {
      method: "POST",
      body: JSON.stringify({ name, type: "group" }),
    });

    if (res.ok) {
      onCreated();
    } else {
      const data = await res.json();
      setError(data.error || "Failed to create room");
    }
    setLoading(false);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div className="w-full max-w-sm rounded-xl bg-gray-900 p-6 shadow-xl">
        <h2 className="mb-4 text-lg font-semibold">Create Room</h2>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="rounded-lg bg-red-500/10 px-3 py-2 text-sm text-red-400">
              {error}
            </div>
          )}
          <div>
            <label className="mb-1 block text-sm text-gray-300">
              Room name
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              className="w-full rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm outline-none focus:border-blue-500"
              placeholder="e.g. General"
              autoFocus
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-4 py-2 text-sm text-gray-400 hover:text-gray-200"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {loading ? "Creating..." : "Create"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
