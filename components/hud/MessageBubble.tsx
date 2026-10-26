"use client";

import { Square, Mic } from "lucide-react";
import type { ChatMessage } from "@/types/game";
import ToolBubble from "./ToolBubble";

import Markdown from "@/components/ui/Markdown";
import CopyButton from "@/components/ui/CopyButton";

export default function MessageBubble({
  msg,
  actorName,
  canStop,
  onStop,
  grouped = false,
  avatar,
}: {
  msg: ChatMessage;
  actorName?: string;
  canStop?: boolean;
  onStop?: () => void;
  grouped?: boolean;
  avatar?: React.ReactNode;
}) {
  if (msg.role === "system") {
    return <div className="hud-chat__system">{msg.content}</div>;
  }

  if (msg.role === "tool") {
    return <ToolBubble msg={msg} />;
  }

  const isAssistant = msg.role === "assistant";
  const isUser = msg.role === "user";

  return (
    <div
      className={`hud-chat__bubble ${isUser ? "hud-chat__bubble--user" : "hud-chat__bubble--assistant"}`}
    >
      <div className="hud-chat__header">
        <div className={`hud-chat__role ${grouped ? "message-continuation" : ""}`}>
          {avatar}
          {grouped ? "Continued" : isUser ? "You" : (msg.actorName ?? actorName ?? "Assistant")}
          {msg.source === "voice" && (
            <span className="chat-message-source" title="Voice transcript">
              <Mic size={10} />
              <span className="sr-only">Voice</span>
            </span>
          )}
        </div>
        {msg.timestamp && Number.isFinite(Date.parse(msg.timestamp)) && (
          <time
            className="chat-message-time"
            dateTime={msg.timestamp}
            title={new Date(msg.timestamp).toLocaleString()}
          >
            {new Date(msg.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
          </time>
        )}
        <CopyButton text={msg.content} />
        {/* Stop button on the assistant bubble while streaming, or on user bubble as fallback */}
        {canStop && (isAssistant || isUser) && (
          <button
            type="button"
            className="hud-chat__stop"
            onClick={onStop}
            title="Stop task"
            aria-label="Stop task"
          >
            <Square size={10} fill="currentColor" />
          </button>
        )}
      </div>
      <div className="hud-chat__content">
        {isAssistant ? (
          <>
            <Markdown text={msg.content} />
            {msg.incidentId && (
              <button
                type="button"
                onClick={() =>
                  window.dispatchEvent(
                    new CustomEvent("agent-town:open-investigation", { detail: msg.incidentId }),
                  )
                }
              >
                Open investigation
              </button>
            )}
            {msg.streaming ? <span className="pixel-cursor">▌</span> : null}
          </>
        ) : (
          <>{msg.content}</>
        )}
      </div>
    </div>
  );
}
