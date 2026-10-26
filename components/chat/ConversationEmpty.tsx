import { Users } from "lucide-react";
import CharacterPortrait from "@/components/hud/CharacterPortrait";

export default function ConversationEmpty({
  name,
  spritePath,
  group,
  query,
  error,
  onRetry,
  onClear,
  onCompose,
}: {
  name: string;
  spritePath?: string;
  group: boolean;
  query: string;
  error: string;
  onRetry: () => void;
  onClear: () => void;
  onCompose: () => void;
}) {
  return (
    <div className="center-empty" role={error ? "alert" : "status"}>
      {group ? (
        <Users size={32} />
      ) : (
        <div className="center-portrait">
          <CharacterPortrait spritePath={spritePath ?? ""} name={name} />
        </div>
      )}
      <div className="center-eyebrow">{name}</div>
      <h2>
        {error
          ? "History is temporarily unavailable"
          : query
            ? "No matching messages"
            : group
              ? "Bring the team together"
              : `Start a conversation with ${name}`}
      </h2>
      <p>
        {error
          ? "We couldn’t load saved messages. This does not mean your conversation is empty. Your draft is preserved."
          : query
            ? "Try another search or return to the full conversation."
            : group
              ? "Share a brief with the office. Each teammate’s contribution stays connected to the shared request."
              : "Ask a question or delegate work. Your first message opens a dedicated conversation with this teammate."}
      </p>
      {error && <p className="ui-error">{error}</p>}
      <button className="pixel-button" onClick={error ? onRetry : query ? onClear : onCompose}>
        {error ? "Retry history" : query ? "Clear search" : "Write a message"}
      </button>
    </div>
  );
}
