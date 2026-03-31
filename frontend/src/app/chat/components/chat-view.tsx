"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { apiFetch } from "@/lib/api";
import type { WsMessage } from "@/lib/use-websocket";
import type { Room, Message } from "../page";

interface ChatViewProps {
  room: Room;
  currentUserId: string;
  send: (msg: WsMessage) => void;
  subscribe: (fn: (msg: WsMessage) => void) => () => void;
}

export default function ChatView({
  room,
  currentUserId,
  send,
  subscribe,
}: ChatViewProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [recording, setRecording] = useState(false);
  const [recordingDuration, setRecordingDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingChunksRef = useRef<Blob[]>([]);
  const recordingTimerRef = useRef<ReturnType<typeof setInterval>>(undefined);
  const [typingUsers, setTypingUsers] = useState<
    Map<string, { name: string; timeout: ReturnType<typeof setTimeout> }>
  >(new Map());
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const typingTimeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const prevRoomIdRef = useRef<string>(undefined);
  const ackedMessagesRef = useRef<Set<string>>(new Set());

  // Load initial messages
  const loadMessages = useCallback(async () => {
    setLoadingHistory(true);
    const res = await apiFetch(`/rooms/${room.id}/messages?limit=50`);
    if (res.ok) {
      const data = await res.json();
      setMessages(
        data.reverse().map((m: Record<string, unknown>) => ({
          ...m,
          readBy: Array.isArray(m.acks)
            ? (m.acks as { userId: string }[]).map((a) => a.userId)
            : [],
        }))
      );
      setHasMore(data.length === 50);
    }
    setLoadingHistory(false);
  }, [room.id]);

  useEffect(() => {
    if (prevRoomIdRef.current !== room.id) {
      setMessages([]);
      setTypingUsers(new Map());
      setHasMore(true);
      ackedMessagesRef.current.clear();
      loadMessages();
      prevRoomIdRef.current = room.id;
    }
  }, [room.id, loadMessages]);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Subscribe to WS messages for this room
  useEffect(() => {
    const unsub = subscribe((msg: WsMessage) => {
      if (msg.room_id !== room.id) return;

      if (msg.type === "text" || msg.type === "media") {
        const newMsg: Message = {
          id: msg.message_id || "",
          roomId: room.id,
          type: msg.type,
          content: msg.payload || {},
          sender: msg.sender || {
            id: msg.sender_id || "",
            name: "Unknown",
          },
          reactions: [],
          readBy: [],
          createdAt: msg.timestamp || new Date().toISOString(),
        };
        setMessages((prev) => {
          if (prev.some((m) => m.id === newMsg.id)) return prev;
          return [...prev, newMsg];
        });

        // Clear typing for this sender
        setTypingUsers((prev) => {
          const next = new Map(prev);
          const entry = next.get(msg.sender_id || "");
          if (entry) {
            clearTimeout(entry.timeout);
            next.delete(msg.sender_id || "");
          }
          return next;
        });
      }

      if (msg.type === "typing" && msg.sender_id !== currentUserId) {
        const senderName =
          room.members.find((m) => m.userId === msg.sender_id)?.user.name ||
          "Someone";

        setTypingUsers((prev) => {
          const next = new Map(prev);
          const existing = next.get(msg.sender_id || "");
          if (existing) clearTimeout(existing.timeout);

          const timeout = setTimeout(() => {
            setTypingUsers((p) => {
              const n = new Map(p);
              n.delete(msg.sender_id || "");
              return n;
            });
          }, 3000);

          next.set(msg.sender_id || "", { name: senderName, timeout });
          return next;
        });
      }

      if (msg.type === "ack") {
        const { target_message_id, status } = msg.payload as {
          target_message_id: string;
          status: string;
        };
        if (status === "read" && msg.sender_id) {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== target_message_id) return m;
              if (m.readBy.includes(msg.sender_id!)) return m;
              return { ...m, readBy: [...m.readBy, msg.sender_id!] };
            })
          );
        }
      }

      if (msg.type === "reaction") {
        const { target_message_id, emoji, action } = msg.payload as {
          target_message_id: string;
          emoji: string;
          action: string;
        };
        setMessages((prev) =>
          prev.map((m) => {
            if (m.id !== target_message_id) return m;
            if (action === "added") {
              return {
                ...m,
                reactions: [
                  ...m.reactions,
                  { emoji, userId: msg.sender_id || "" },
                ],
              };
            } else {
              return {
                ...m,
                reactions: m.reactions.filter(
                  (r) =>
                    !(r.emoji === emoji && r.userId === (msg.sender_id || ""))
                ),
              };
            }
          })
        );
      }
    });
    return unsub;
  }, [subscribe, room.id, room.members, currentUserId]);

  // Send read acks for messages from others when they are visible
  useEffect(() => {
    const unacked = messages.filter(
      (m) =>
        !m.deleted &&
        m.sender?.id !== currentUserId &&
        !ackedMessagesRef.current.has(m.id)
    );
    for (const msg of unacked) {
      ackedMessagesRef.current.add(msg.id);
      send({
        type: "ack",
        room_id: room.id,
        payload: { target_message_id: msg.id, status: "read" },
        timestamp: new Date().toISOString(),
      });
    }
  }, [messages, room.id, currentUserId, send]);

  // Load older messages
  const loadOlderMessages = async () => {
    if (!hasMore || loadingHistory || messages.length === 0) return;
    setLoadingHistory(true);
    const oldest = messages[0]?.createdAt;
    const res = await apiFetch(
      `/rooms/${room.id}/messages?limit=50&before=${oldest}`
    );
    if (res.ok) {
      const data = await res.json();
      const mapped = data.reverse().map((m: Record<string, unknown>) => ({
        ...m,
        readBy: Array.isArray(m.acks)
          ? (m.acks as { userId: string }[]).map((a) => a.userId)
          : [],
      }));
      setMessages((prev) => [...mapped, ...prev]);
      setHasMore(data.length === 50);
    }
    setLoadingHistory(false);
  };

  const handleSend = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;

    send({
      type: "text",
      room_id: room.id,
      payload: { text: input.trim() },
      timestamp: new Date().toISOString(),
    });
    setInput("");
  };

  const handleTyping = () => {
    if (typingTimeoutRef.current) clearTimeout(typingTimeoutRef.current);
    send({
      type: "typing",
      room_id: room.id,
      payload: { status: "start" },
      timestamp: new Date().toISOString(),
    });
    typingTimeoutRef.current = setTimeout(() => {
      send({
        type: "typing",
        room_id: room.id,
        payload: { status: "stop" },
        timestamp: new Date().toISOString(),
      });
    }, 2000);
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Reset input so the same file can be selected again
    e.target.value = "";

    setUploading(true);
    try {
      // 1. Get presigned upload URL
      const presignRes = await apiFetch("/upload/presign", {
        method: "POST",
        body: JSON.stringify({
          mimeType: file.type,
          filename: file.name,
          roomId: room.id,
        }),
      });

      if (!presignRes.ok) {
        const data = await presignRes.json();
        alert(data.error || "Upload failed");
        setUploading(false);
        return;
      }

      const { uploadUrl, objectKey } = await presignRes.json();

      // 2. Upload file directly to MinIO
      await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });

      // 3. Send media message via WebSocket
      send({
        type: "media",
        room_id: room.id,
        payload: {
          object_key: objectKey,
          mime_type: file.type,
          filename: file.name,
          size_bytes: file.size,
        },
        timestamp: new Date().toISOString(),
      });
    } catch {
      alert("File upload failed");
    }
    setUploading(false);
  };

  const uploadAudioBlob = async (blob: Blob) => {
    setUploading(true);
    try {
      const mimeType = blob.type || "audio/webm";
      const ext = mimeType.includes("mp4") ? "m4a" : "webm";
      const filename = `voice-${Date.now()}.${ext}`;

      const presignRes = await apiFetch("/upload/presign", {
        method: "POST",
        body: JSON.stringify({ mimeType, filename, roomId: room.id }),
      });

      if (!presignRes.ok) {
        const data = await presignRes.json();
        alert(data.error || "Upload failed");
        setUploading(false);
        return;
      }

      const { uploadUrl, objectKey } = await presignRes.json();

      await fetch(uploadUrl, {
        method: "PUT",
        body: blob,
        headers: { "Content-Type": mimeType },
      });

      send({
        type: "media",
        room_id: room.id,
        payload: {
          object_key: objectKey,
          mime_type: mimeType,
          filename,
          size_bytes: blob.size,
        },
        timestamp: new Date().toISOString(),
      });
    } catch {
      alert("Voice upload failed");
    }
    setUploading(false);
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      // Pick best supported mime type
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/mp4")
          ? "audio/mp4"
          : "audio/webm";

      const recorder = new MediaRecorder(stream, { mimeType });
      mediaRecorderRef.current = recorder;
      recordingChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          recordingChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recordingChunksRef.current, {
          type: mimeType.split(";")[0],
        });
        if (blob.size > 0) {
          uploadAudioBlob(blob);
        }
      };

      recorder.start(100);
      setRecording(true);
      setRecordingDuration(0);
      recordingTimerRef.current = setInterval(() => {
        setRecordingDuration((d) => d + 1);
      }, 1000);
    } catch {
      alert("Microphone access denied");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    clearInterval(recordingTimerRef.current);
    setRecording(false);
    setRecordingDuration(0);
  };

  const cancelRecording = () => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.ondataavailable = null;
      mediaRecorderRef.current.onstop = null;
      mediaRecorderRef.current.stop();
      // Stop mic stream
      mediaRecorderRef.current.stream
        .getTracks()
        .forEach((t) => t.stop());
    }
    clearInterval(recordingTimerRef.current);
    recordingChunksRef.current = [];
    setRecording(false);
    setRecordingDuration(0);
  };

  const formatDuration = (secs: number) => {
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  };

  const handleReaction = (messageId: string, emoji: string) => {
    send({
      type: "reaction",
      room_id: room.id,
      payload: { target_message_id: messageId, emoji },
      timestamp: new Date().toISOString(),
    });
  };

  const typingNames = Array.from(typingUsers.values()).map((t) => t.name);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Messages */}
      <div ref={containerRef} className="min-h-0 flex-1 overflow-y-auto p-4 space-y-1">
        {hasMore && (
          <div className="text-center">
            <button
              onClick={loadOlderMessages}
              disabled={loadingHistory}
              className="text-xs text-blue-400 hover:underline disabled:opacity-50"
            >
              {loadingHistory ? "Loading..." : "Load older messages"}
            </button>
          </div>
        )}

        {messages.length === 0 && !loadingHistory && (
          <div className="flex flex-col items-center justify-center py-20 text-gray-500">
            <svg className="mb-3 h-12 w-12 text-gray-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
            </svg>
            <p className="text-sm font-medium">No messages yet</p>
            <p className="mt-1 text-xs">Send a message to start the conversation</p>
          </div>
        )}

        {messages.map((msg, i) => {
          if (msg.deleted) {
            return (
              <div key={msg.id} className="py-1 text-center text-xs text-gray-500 italic">
                Message deleted
              </div>
            );
          }

          const isMine = msg.sender?.id === currentUserId;
          const showAvatar =
            i === 0 || messages[i - 1]?.sender?.id !== msg.sender?.id;
          const text =
            msg.content && "text" in msg.content
              ? (msg.content.text as string)
              : JSON.stringify(msg.content);

          return (
            <div key={msg.id} className={`flex ${isMine ? "justify-end" : "justify-start"}`}>
              <div className={`group max-w-md ${isMine ? "items-end" : "items-start"}`}>
                {showAvatar && !isMine && (
                  <p className="mb-0.5 ml-1 text-xs font-medium text-gray-400">
                    {msg.sender?.name}
                  </p>
                )}
                <div className="flex items-end gap-1">
                  <div
                    className={`rounded-2xl px-3 py-2 text-sm ${
                      isMine
                        ? "bg-blue-600 text-white"
                        : "bg-gray-800 text-gray-100"
                    }`}
                  >
                    {msg.type === "media" ? (
                      <MediaBubble content={msg.content} isMine={isMine} />
                    ) : (
                      text
                    )}
                  </div>
                  {/* Quick reaction */}
                  <button
                    onClick={() => handleReaction(msg.id, "👍")}
                    className="opacity-0 group-hover:opacity-100 text-xs text-gray-500 hover:text-gray-300 transition-opacity mb-1"
                    title="React"
                  >
                    +
                  </button>
                </div>
                {/* Reactions */}
                {msg.reactions.length > 0 && (
                  <div className="mt-0.5 ml-1 flex gap-1 flex-wrap">
                    {groupReactions(msg.reactions).map(([emoji, users]) => (
                      <button
                        key={emoji}
                        onClick={() => handleReaction(msg.id, emoji)}
                        className={`rounded-full border px-1.5 py-0.5 text-xs ${
                          users.includes(currentUserId)
                            ? "border-blue-500 bg-blue-500/20"
                            : "border-gray-700 bg-gray-800"
                        }`}
                      >
                        {emoji} {users.length}
                      </button>
                    ))}
                  </div>
                )}
                <div className={`ml-1 mt-0.5 flex items-center gap-1 text-[10px] text-gray-600 ${isMine ? "justify-end" : ""}`}>
                  <span>
                    {new Date(msg.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  {isMine && (
                    <span title={msg.readBy.length > 0 ? `Read by ${msg.readBy.length}` : "Sent"}>
                      {msg.readBy.length > 0 ? (
                        <svg className="h-3.5 w-3.5 text-blue-400" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M2 12.5l5.5 5.5L18 7M8 12.5l5.5 5.5L24 7" />
                        </svg>
                      ) : (
                        <svg className="h-3.5 w-3.5 text-gray-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                          <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>

      {/* Typing indicator */}
      {typingNames.length > 0 && (
        <div className="px-4 py-1 text-xs text-gray-400">
          {typingNames.join(", ")}{" "}
          {typingNames.length === 1 ? "is" : "are"} typing...
        </div>
      )}

      {/* Input */}
      {room.role === "viewer" ? (
        <div className="border-t border-gray-800 px-4 py-3">
          <div className="flex items-center justify-center gap-2 rounded-lg bg-gray-800/60 px-4 py-2.5 text-sm text-gray-400">
            <svg className="h-4 w-4 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
            You don&apos;t have permission to send messages in this room
          </div>
        </div>
      ) : (
      <div className="border-t border-gray-800 p-4">
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          accept="image/jpeg,image/png,image/gif,image/webp,audio/mpeg,audio/ogg,audio/webm,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          onChange={handleFileUpload}
        />

        {recording ? (
          /* Recording UI */
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={cancelRecording}
              className="rounded-lg p-2 text-red-400 hover:bg-gray-800 hover:text-red-300"
              title="Cancel"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-7 7-7-7" />
              </svg>
            </button>

            <div className="flex flex-1 items-center gap-3 rounded-lg border border-red-500/30 bg-gray-800 px-4 py-2">
              <span className="h-2.5 w-2.5 animate-pulse rounded-full bg-red-500" />
              <span className="text-sm text-red-400">Recording</span>
              <span className="text-sm font-mono text-gray-300">
                {formatDuration(recordingDuration)}
              </span>
              <div className="flex-1" />
              {/* Waveform placeholder */}
              <div className="flex items-center gap-0.5">
                {Array.from({ length: 20 }).map((_, i) => (
                  <div
                    key={i}
                    className="w-0.5 rounded-full bg-red-400/60"
                    style={{
                      height: `${8 + Math.random() * 16}px`,
                      animationDelay: `${i * 50}ms`,
                    }}
                  />
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={stopRecording}
              className="rounded-lg bg-red-500 p-2 text-white hover:bg-red-600"
              title="Send voice message"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
              </svg>
            </button>
          </div>
        ) : (
          /* Normal input */
          <form onSubmit={handleSend} className="flex gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
              className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-gray-400 hover:bg-gray-700 hover:text-gray-200 disabled:opacity-50"
              title="Attach file"
            >
              {uploading ? (
                <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
              ) : (
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                </svg>
              )}
            </button>
            <input
              type="text"
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                handleTyping();
              }}
              placeholder="Type a message..."
              className="flex-1 rounded-lg border border-gray-700 bg-gray-800 px-4 py-2 text-sm outline-none focus:border-blue-500"
            />
            {input.trim() ? (
              <button
                type="submit"
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium hover:bg-blue-700"
              >
                Send
              </button>
            ) : (
              <button
                type="button"
                onClick={startRecording}
                disabled={uploading}
                className="rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-gray-400 hover:bg-gray-700 hover:text-gray-200 disabled:opacity-50"
                title="Record voice message"
              >
                <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
                </svg>
              </button>
            )}
          </form>
        )}
      </div>
      )}
    </div>
  );
}

function MediaBubble({
  content,
  isMine,
}: {
  content: Record<string, unknown>;
  isMine: boolean;
}) {
  const filename = (content.filename as string) || "file";
  const mimeType = (content.mime_type as string) || "";
  const objectKey = content.object_key as string;
  const sizeBytes = content.size_bytes as number;
  const isImage = mimeType.startsWith("image/");
  const isAudio = mimeType.startsWith("audio/");

  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const fetchUrl = async () => {
    if (downloadUrl || loading) return;
    setLoading(true);
    const res = await apiFetch(`/upload/download/${objectKey}`);
    if (res.ok) {
      const data = await res.json();
      setDownloadUrl(data.downloadUrl);
    }
    setLoading(false);
  };

  // Auto-fetch for images
  useEffect(() => {
    if (isImage) fetchUrl();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [objectKey]);

  const formatSize = (bytes: number) => {
    if (!bytes) return "";
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div className="space-y-1">
      {isImage && downloadUrl && (
        <img
          src={downloadUrl}
          alt={filename}
          className="max-w-xs rounded-lg cursor-pointer"
          onClick={() => window.open(downloadUrl, "_blank")}
        />
      )}

      {isAudio && downloadUrl && (
        <audio controls src={downloadUrl} className="max-w-xs" />
      )}

      <div
        className={`flex items-center gap-2 ${
          isImage && downloadUrl ? "" : "cursor-pointer"
        }`}
        onClick={() => {
          if (downloadUrl) {
            window.open(downloadUrl, "_blank");
          } else {
            fetchUrl();
          }
        }}
      >
        <svg
          className="h-4 w-4 shrink-0"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
          />
        </svg>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{filename}</p>
          <p className={`text-xs ${isMine ? "text-blue-200" : "text-gray-400"}`}>
            {formatSize(sizeBytes)}
            {loading && " — loading..."}
            {!downloadUrl && !loading && " — click to download"}
          </p>
        </div>
      </div>
    </div>
  );
}

function groupReactions(
  reactions: { emoji: string; userId: string }[]
): [string, string[]][] {
  const map = new Map<string, string[]>();
  for (const r of reactions) {
    const arr = map.get(r.emoji) || [];
    arr.push(r.userId);
    map.set(r.emoji, arr);
  }
  return Array.from(map.entries());
}
