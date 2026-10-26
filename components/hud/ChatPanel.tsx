"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { SendHorizontal, Mic, MicOff, PhoneOff, MessageSquare } from "lucide-react";
import { runtimeRequest, useStudio } from "@/lib/store";
import { useVoice } from "@/lib/voice/VoiceProvider";
import { gameEvents } from "@/lib/events";
import type { ChatMessage, SessionRecord, TaskItem } from "@/types/game";
import { findTask } from "@/lib/reducer";
import HudFlyout from "./HudFlyout";
import MessageBubble from "./MessageBubble";
import SessionSwitcher from "./SessionSwitcher";
import CharacterPortrait from "./CharacterPortrait";
import VoiceDiagnostics from "./VoiceDiagnostics";

const OFFICE_GROUP_SESSION = "office:group:main";

export default function ChatPanel({
  messages,
  tasks,
  isConnected,
  sessions,
  activeSessionKey,
}: {
  messages: ChatMessage[];
  tasks: TaskItem[];
  isConnected: boolean;
  sessions: SessionRecord[];
  activeSessionKey?: string;
}) {
  const { state } = useStudio();
  const voice = useVoice();
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [groupHistory, setGroupHistory] = useState<ChatMessage[]>([]);
  const [sendError, setSendError] = useState("");
  const sendCapability = state.capabilities?.["chat.send"];
  const groupAgents = state.seats.filter((seat) => seat.assigned && seat.binding?.available);
  const canSend = isConnected && sendCapability?.available && groupAgents.length > 0;
  const sendReason = !isConnected
    ? "Connect the gateway to execute tasks."
    : !sendCapability?.available
      ? (sendCapability?.reason ?? "Backend contracts are being checked.")
      : !groupAgents.length
        ? "Bind an office agent to a verified backend in Crew."
        : "";
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const pendingTurn = useRef<{ message: string; id: string } | null>(null);
  useEffect(() => {
    if (!isConnected) return;
    let cancelled = false;
    void runtimeRequest<{ messages: ChatMessage[] }>("office-group")
      .then((result) => {
        if (!cancelled) setGroupHistory(result.messages);
      })
      .catch((error) => {
        if (!cancelled) setSendError(error.message);
      });
    return () => {
      cancelled = true;
    };
  }, [isConnected, state.runtimeError]);
  const groupMessages = useMemo(() => {
    const byId = new Map<string, ChatMessage>();
    for (const message of groupHistory) byId.set(message.id, message);
    for (const message of state.chatMessages)
      if (message.sessionKey === OFFICE_GROUP_SESSION) byId.set(message.id, message);
    return [...byId.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }, [groupHistory, state.chatMessages]);
  const displayMessages = voice.mode === "text" ? groupMessages : messages;
  const displayTasks = voice.mode === "text" ? state.tasks : tasks;
  const lastMessage = displayMessages.at(-1);
  const voiceLabel = {
    idle: voice.error ? "Call stopped — see details below" : "Ready to talk",
    connecting: "Connecting…",
    listening: "Listening",
    speaking: "Speaking",
    thinking: "Thinking…",
    muted: "Microphone muted",
  }[voice.status];

  const actorByRunId = useMemo(() => {
    const map = new Map<string, string>();
    for (const task of displayTasks) {
      if (!task.actorName) continue;
      if (task.runId) map.set(task.runId, task.actorName);
      map.set(task.taskId, task.actorName);
    }
    return map;
  }, [displayTasks]);

  const stopHandler = useCallback((runId: string, seatId: string) => {
    gameEvents.emit("stop-task", runId, seatId);
  }, []);

  const virtualizer = useVirtualizer({
    count: displayMessages.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 80,
    overscan: 5,
  });

  useEffect(() => {
    if (!displayMessages.length || !followRef.current) return;
    const frame = requestAnimationFrame(() =>
      virtualizer.scrollToIndex(displayMessages.length - 1, { align: "end" }),
    );
    return () => cancelAnimationFrame(frame);
  }, [displayMessages.length, lastMessage?.content.length, virtualizer]);

  const handleSend = async () => {
    const trimmed = input.trim();
    if (!trimmed || !canSend || sending) return;
    if (pendingTurn.current?.message !== trimmed)
      pendingTurn.current = { message: trimmed, id: crypto.randomUUID().replaceAll("-", "") };
    setSending(true);
    setSendError("");
    try {
      await runtimeRequest("office-group", {
        turnId: pendingTurn.current.id,
        message: trimmed,
      });
      pendingTurn.current = null;
      setInput("");
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Could not send to the office.");
    } finally {
      setSending(false);
    }
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      handleSend();
    }
  };

  return (
    <HudFlyout
      title="Chat"
      subtitle="Your conversation in the office"
      headerAction={
        voice.mode === "voice" ? (
          <SessionSwitcher sessions={sessions} activeKey={activeSessionKey} />
        ) : undefined
      }
      bodyClass="hud-flyout__body--chat"
    >
      <div className="hud-chat-layout">
        <Link
          className="full-chat-link"
          href={
            voice.mode === "voice" && voice.agent
              ? `/app/chat?seat=${encodeURIComponent(voice.agent.seatId)}`
              : "/app/chat"
          }
        >
          Open Full Chat ↗
        </Link>
        <div className="chat-conversation-tools">
          <div className="chat-mode-switch" role="group" aria-label="Conversation mode">
            <button
              type="button"
              aria-pressed={voice.mode === "text"}
              onClick={() => voice.setMode("text")}
            >
              <MessageSquare size={13} />
              Text
            </button>
            <button
              type="button"
              aria-pressed={voice.mode === "voice"}
              onClick={() => voice.setMode("voice")}
            >
              <Mic size={13} />
              Voice
            </button>
          </div>
          {voice.mode === "text" ? (
            <div className="chat-agent-row" aria-label="Office group chat">
              <div className="chat-agent-identity">
                <strong>Office group</strong>
                <span>
                  {groupAgents.length} available teammate{groupAgents.length === 1 ? "" : "s"} ·
                  shared work
                </span>
              </div>
            </div>
          ) : (
            <div className={`chat-agent-row ${voice.active ? "chat-agent-row--active" : ""}`}>
              <span className="chat-agent-portrait">
                <CharacterPortrait
                  spritePath={voice.agent?.spritePath}
                  name={voice.agent?.label ?? "Agent"}
                />
              </span>
              <div className="chat-agent-identity">
                <label className="sr-only" htmlFor="chat-agent">
                  Conversation agent
                </label>
                <select
                  id="chat-agent"
                  value={voice.agent?.seatId ?? ""}
                  onChange={(event) => {
                    setInput("");
                    void voice.selectAgent(event.target.value);
                  }}
                >
                  {!voice.agent && <option value="">Choose an agent</option>}
                  {state.seats
                    .filter((seat) => seat.assigned)
                    .map((seat) => (
                      <option key={seat.seatId} value={seat.seatId}>
                        {seat.label}
                      </option>
                    ))}
                </select>
                <span>{voice.agent?.roleTitle ?? "AI teammate"}</span>
              </div>
              {voice.active && (
                <span
                  className="chat-call-indicator"
                  title={voice.status === "connecting" ? "Connecting call" : "Voice call active"}
                  aria-label={
                    voice.status === "connecting" ? "Connecting call" : "Voice call active"
                  }
                />
              )}
            </div>
          )}
        </div>
        <div
          ref={scrollRef}
          className="hud-chat"
          role="log"
          aria-label="Conversation messages"
          aria-relevant="additions"
          onScroll={() => {
            const element = scrollRef.current;
            if (element)
              followRef.current =
                element.scrollHeight - element.scrollTop - element.clientHeight < 60;
          }}
        >
          {displayMessages.length === 0 ? (
            <div className="hud-empty">
              {voice.mode === "voice"
                ? `Start a call to talk with ${voice.agent?.label ?? "your teammate"}.`
                : "Message the office. Available agents will share findings here."}
            </div>
          ) : (
            <div
              style={{ height: virtualizer.getTotalSize(), width: "100%", position: "relative" }}
            >
              {virtualizer.getVirtualItems().map((virtualRow) => {
                const message = displayMessages[virtualRow.index];
                const task = findTask(displayTasks, message.taskId ?? message.runId);
                const canStop =
                  task?.status === "running" &&
                  state.capabilities?.["chat.abort"]?.available &&
                  (task.runId ?? task.taskId);
                return (
                  <div
                    key={virtualRow.key}
                    data-index={virtualRow.index}
                    ref={virtualizer.measureElement}
                    style={{
                      position: "absolute",
                      top: 0,
                      left: 0,
                      width: "100%",
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    <div style={{ paddingBottom: 8 }}>
                      <MessageBubble
                        msg={message}
                        actorName={actorByRunId.get(message.taskId ?? message.runId)}
                        canStop={!!canStop}
                        onStop={
                          canStop
                            ? () => stopHandler(task.runId ?? task.taskId, task.seatId ?? "")
                            : undefined
                        }
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {voice.mode === "voice" ? (
          <div className="chat-voice-composer">
            <div className="chat-voice-state" role="status">
              <span>
                {voice.agent ? `${voice.agent.label} · ` : ""}
                {voiceLabel}
              </span>
              <time>
                {voice.active
                  ? `${Math.floor(voice.elapsed / 60)}:${String(voice.elapsed % 60).padStart(2, "0")} / 10:00`
                  : ""}
              </time>
            </div>
            <div className="chat-voice-buttons">
              {!voice.active ? (
                <button
                  type="button"
                  className="pixel-button pixel-button--primary"
                  disabled={voice.configured !== true || !voice.agent}
                  onClick={() => void voice.start()}
                >
                  <Mic size={14} />
                  Start call
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="pixel-button"
                    disabled={voice.status === "connecting"}
                    aria-pressed={voice.muted}
                    onClick={voice.toggleMute}
                  >
                    {voice.muted ? <MicOff size={14} /> : <Mic size={14} />}
                    {voice.muted ? "Unmute" : "Mute"}
                  </button>
                  <button type="button" className="pixel-button chat-end-call" onClick={voice.stop}>
                    <PhoneOff size={14} />
                    End
                  </button>
                </>
              )}
            </div>
            {voice.configured === null && (
              <p className="chat-voice-hint" role="status">
                Checking voice availability…
              </p>
            )}
            {voice.configured === false && (
              <p className="chat-voice-error">
                Voice is not configured for this workspace. Ask your workspace owner to enable it.
              </p>
            )}
            {voice.error && (
              <p className="chat-voice-error" role="alert">
                {voice.error}
              </p>
            )}
            {voice.notice && (
              <p className="chat-voice-hint" role="status">
                {voice.notice}
              </p>
            )}
            <p className="chat-voice-hint">
              Audio and this conversation’s context go to Google. Transcripts join your saved chat.{" "}
              {isConnected
                ? "Ask for work or progress naturally."
                : "Connect the gateway to execute tasks."}
            </p>
            <VoiceDiagnostics />
          </div>
        ) : (
          <div>
            {(sendError || sendReason || state.runtimeError) && (
              <p className="chat-voice-hint" role="status">
                {sendError || state.runtimeError || sendReason}
              </p>
            )}
            <div className="hud-chat-input-row">
              <textarea
                aria-label="Message"
                ref={inputRef}
                className="pixel-input"
                style={{ flex: 1, minHeight: 40, height: 40, resize: "none", padding: "8px 10px" }}
                placeholder={isConnected ? "Type a message..." : "Connect first..."}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                onKeyDown={handleKeyDown}
                disabled={!canSend || sending}
              />
              <button
                type="button"
                className="pixel-icon-btn pixel-icon-btn--primary"
                style={{ width: 40, height: 40, minWidth: 40, minHeight: 40 }}
                onClick={handleSend}
                disabled={!canSend || sending || !input.trim()}
                title={sendReason || "Send"}
                aria-busy={sending}
                aria-label="Send message"
              >
                {sending ? (
                  <span className="composer-sending">…</span>
                ) : (
                  <SendHorizontal size={16} />
                )}
              </button>
            </div>
          </div>
        )}
      </div>
    </HudFlyout>
  );
}
