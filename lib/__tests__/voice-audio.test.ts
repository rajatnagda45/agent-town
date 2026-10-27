import { describe, expect, it, vi } from "vitest";
import { decodePcm16, encodePcm16, VoicePlayback } from "../voice/audio";

describe("voice PCM transport", () => {
  it("encodes clipped samples as little-endian signed 16-bit PCM", () => {
    const binary = atob(encodePcm16(new Float32Array([-2, -1, 0, 1, 2])));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    expect([...bytes]).toEqual([0, 128, 0, 128, 0, 0, 255, 127, 255, 127]);
    expect([...decodePcm16(btoa(binary))]).toEqual([-1, -1, 0, 32767 / 32768, 32767 / 32768]);
  });

  it("rejects a truncated PCM frame", () => {
    expect(() => decodePcm16(btoa("x"))).toThrow("Invalid PCM");
  });

  it("schedules contiguous audio and clears every queued source on interruption", () => {
    const sources: Array<{
      start: ReturnType<typeof vi.fn>;
      stop: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }> = [];
    const context = {
      currentTime: 1,
      destination: {},
      createBuffer: vi.fn((_channels, length, rate) => ({
        duration: length / rate,
        copyToChannel: vi.fn(),
      })),
      createBufferSource: () => {
        const source = {
          start: vi.fn(),
          stop: vi.fn(),
          disconnect: vi.fn(),
          connect: vi.fn(),
          buffer: null,
          onended: null,
        };
        sources.push(source);
        return source;
      },
    } as unknown as AudioContext;
    const playback = new VoicePlayback(context);
    const chunk = encodePcm16(new Float32Array(2400));
    playback.play(chunk);
    playback.play(chunk);
    expect(sources[0].start).toHaveBeenCalledWith(1.015);
    expect(sources[1].start.mock.calls[0][0]).toBeCloseTo(1.115);
    expect(playback.speaking).toBe(true);
    playback.stop();
    for (const source of sources) {
      expect(source.stop).toHaveBeenCalledOnce();
      expect(source.disconnect).toHaveBeenCalledOnce();
    }
    expect(playback.speaking).toBe(false);
  });
});
