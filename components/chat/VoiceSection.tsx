"use client";
import { Mic, PhoneOff } from "lucide-react";
import { useStudio } from "@/lib/store";
import { useVoice } from "@/lib/voice/VoiceProvider";
import type { SeatState } from "@/types/game";
import VoiceDiagnostics from "@/components/hud/VoiceDiagnostics";
export default function VoiceSection({
  group,
  seat,
  sessionKey,
  canSend,
  blocked,
  expanded,
  onPrepare,
}: {
  group: boolean;
  seat?: SeatState;
  sessionKey: string;
  canSend?: boolean;
  blocked: boolean;
  expanded: boolean;
  onPrepare: () => Promise<void>;
}) {
  const voice = useVoice();
  const studio = useStudio();
  const seatId = seat?.seatId;
  return (
    <details className="center-voice" open={voice.active || expanded}>
      <summary>
        <Mic size={16} />
        {group ? "Voice availability" : "Voice conversation"}
      </summary>
      {group ? (
        <p>Group voice is not supported. Choose an individual agent to call.</p>
      ) : (
        <>
          <p>
            {voice.active
              ? `${voice.agent?.label} · ${voice.status} · ${Math.floor(voice.elapsed / 60)}:${String(voice.elapsed % 60).padStart(2, "0")}`
              : "Talk directly with the selected agent."}
          </p>
          {voice.active ? (
            <>
              <button className="pixel-button" onClick={voice.toggleMute}>
                {voice.muted ? "Unmute" : "Mute"}
              </button>
              <button className="pixel-button" onClick={voice.stop}>
                <PhoneOff size={14} /> End call
              </button>
            </>
          ) : voice.agent?.seatId === seatId && studio.getActiveSessionKey() === sessionKey ? (
            <button
              className="pixel-button pixel-button--primary"
              disabled={voice.configured !== true || !canSend || blocked}
              onClick={() => void voice.start()}
            >
              Start call
            </button>
          ) : (
            <button
              className="pixel-button"
              disabled={!sessionKey || !canSend || blocked}
              onClick={() => void onPrepare()}
            >
              Prepare call with {seat?.label}
            </button>
          )}
          {!sessionKey && <p>Create a conversation to enable voice.</p>}
        </>
      )}
      {(voice.error || voice.notice) && <p role="status">{voice.error || voice.notice}</p>}
      {!group && (
        <>
          <small>
            Audio and conversation context are sent to Google. Transcripts are saved to this
            conversation.
          </small>
          <VoiceDiagnostics />
        </>
      )}
    </details>
  );
}
