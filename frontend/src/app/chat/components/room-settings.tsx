"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api";
import type { Room } from "../page";

interface RoomSettingsProps {
  room: Room;
  currentUserId: string;
  onClose: () => void;
  onUpdated: () => void;
}

export default function RoomSettings({
  room,
  currentUserId,
  onClose,
  onUpdated,
}: RoomSettingsProps) {
  const [email, setEmail] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const isAdmin = room.role === "admin";

  const handleAddMember = async (e: React.FormEvent) => {
    e.preventDefault();
    setAdding(true);
    setError("");
    setSuccess("");

    // First look up user by email — we need their ID
    // For simplicity, we'll use a search endpoint or handle it differently
    // Since we don't have a user search endpoint, let's add by email via a workaround:
    // The backend expects userId, so we'll need to know the user's ID.
    // Let's add a simple approach: try to find user by email
    try {
      // We'll pass email to the backend and let it handle lookup
      // But our API expects userId... Let's search users
      const searchRes = await apiFetch(
        `/auth/lookup?email=${encodeURIComponent(email)}`
      );

      if (!searchRes.ok) {
        setError("User not found with that email");
        setAdding(false);
        return;
      }

      const userData = await searchRes.json();

      const res = await apiFetch(`/rooms/${room.id}/members`, {
        method: "POST",
        body: JSON.stringify({ userId: userData.id }),
      });

      if (res.ok) {
        setSuccess("Member added!");
        setEmail("");
        onUpdated();
      } else {
        const data = await res.json();
        setError(data.error || "Failed to add member");
      }
    } catch {
      setError("Failed to add member");
    }
    setAdding(false);
  };

  const handleRemoveMember = async (userId: string) => {
    const res = await apiFetch(`/rooms/${room.id}/members/${userId}`, {
      method: "DELETE",
    });
    if (res.ok) {
      onUpdated();
    }
  };

  const handleRoleChange = async (userId: string, newRole: string) => {
    const res = await apiFetch(`/rooms/${room.id}/members/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role: newRole }),
    });
    if (res.ok) {
      onUpdated();
    }
  };

  return (
    <div className="flex-1 overflow-y-auto p-6">
      <div className="mx-auto max-w-lg space-y-6">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Room Settings</h3>
          <button
            onClick={onClose}
            className="text-sm text-gray-400 hover:text-gray-200"
          >
            Close
          </button>
        </div>

        {/* Room info */}
        <div className="rounded-lg border border-gray-800 p-4">
          <p className="text-sm text-gray-400">Room name</p>
          <p className="font-medium">{room.name}</p>
          <p className="mt-2 text-sm text-gray-400">Type</p>
          <p className="text-sm capitalize">{room.type}</p>
        </div>

        {/* Add member */}
        {isAdmin && (
          <div className="rounded-lg border border-gray-800 p-4">
            <h4 className="mb-3 text-sm font-medium">Add Member</h4>
            <form onSubmit={handleAddMember} className="flex gap-2">
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="user@example.com"
                required
                className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm outline-none focus:border-blue-500"
              />
              <button
                type="submit"
                disabled={adding}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
              >
                Add
              </button>
            </form>
            {error && (
              <p className="mt-2 text-sm text-red-400">{error}</p>
            )}
            {success && (
              <p className="mt-2 text-sm text-green-400">{success}</p>
            )}
          </div>
        )}

        {/* Members list */}
        <div className="rounded-lg border border-gray-800 p-4">
          <h4 className="mb-3 text-sm font-medium">
            Members ({room.members.length})
          </h4>
          <div className="space-y-2">
            {room.members.map((member) => (
              <div
                key={member.userId}
                className="flex items-center justify-between rounded-lg bg-gray-800/50 px-3 py-2"
              >
                <div className="flex items-center gap-2">
                  <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-700 text-sm">
                    {member.user.name[0]?.toUpperCase()}
                  </div>
                  <div>
                    <p className="text-sm font-medium">
                      {member.user.name}
                      {member.userId === currentUserId && (
                        <span className="ml-1 text-xs text-gray-500">
                          (you)
                        </span>
                      )}
                    </p>
                    <p className="text-xs capitalize text-gray-400">
                      {member.role}
                    </p>
                  </div>
                </div>

                {isAdmin && member.userId !== currentUserId && (
                  <div className="flex items-center gap-2">
                    <select
                      value={member.role}
                      onChange={(e) =>
                        handleRoleChange(member.userId, e.target.value)
                      }
                      className="rounded border border-gray-700 bg-gray-800 px-2 py-1 text-xs outline-none"
                    >
                      <option value="admin">Admin</option>
                      <option value="member">Member</option>
                      <option value="viewer">Viewer</option>
                    </select>
                    <button
                      onClick={() => handleRemoveMember(member.userId)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >
                      Remove
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
