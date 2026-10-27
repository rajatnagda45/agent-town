import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiveServerMessage } from "@google/genai";
import { GeminiVoiceClient } from "../voice/client";
import type { VoiceAgentContext } from "../voice/agent-context";

const { connect, sendAudio, closeSession, sendTools, sendContent } = vi.hoisted(() => ({
  connect: vi.fn(),
  sendAudio: vi.fn(),
  closeSession: vi.fn(),
  sendTools: vi.fn(),
  sendContent: vi.fn(),
}));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    live = { connect };
  },
}));

let callbacks: {
  onmessage: (message: LiveServerMessage) => void;
  onclose: (event: { code: number; reason?: string }) => void;
  onerror: (event: { message?: string }) => void;
};
let capture: {
  port: { onmessage?: (event: { data: Float32Array }) => void; close: ReturnType<typeof vi.fn> };
  disconnect: ReturnType<typeof vi.fn>;
};
let track: { enabled: boolean; stop: ReturnType<typeof vi.fn>; onended: (() => void) | null };
let closeContext: ReturnType<typeof vi.fn>;
let getMicrophone: ReturnType<typeof vi.fn>;
let fetchToken: ReturnType<typeof vi.fn>;
let sources: Array<{ stop: ReturnType<typeof vi.fn> }>;
let audioContext: {
  state: string;
  onstatechange: (() => void) | null;
  resume: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.useFakeTimers();
  sources = [];
  track = { enabled: true, stop: vi.fn(), onended: null };
  closeContext = vi.fn().mockResolvedValue(undefined);
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  getMicrophone = vi.fn().mockResolvedValue(stream);
  fetchToken = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      token: "temporary",
      model: "gemini-3.8-live",
      config: {},
      maxSeconds: 600,
      callId: "voice_server-id",
    }),
  });
  vi.stubGlobal("window", { isSecureContext: true });
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: getMicrophone } });
  vi.stubGlobal("fetch", fetchToken);
  vi.stubGlobal(
    "AudioContext",
    class {
      state = "running";
      onstatechange: (() => void) | null = null;
      constructor() {
        // eslint-disable-next-line @typescript-eslint/no-this-alias -- expose the mock device for interruption tests
        audioContext = this;
      }
      sampleRate = 16000;
      currentTime = 0;
      destination = {};
      audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
      resume = vi.fn().mockResolvedValue(undefined);
      close = closeContext;
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
      createBuffer = (_channels: number, length: number, rate: number) => ({
        duration: length / rate,
        copyToChannel: vi.fn(),
      });
      createBufferSource = () => {
        const source = { connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() };
        sources.push(source);
        return source;
      };
    },
  );
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = { onmessage: undefined, close: vi.fn() };
      connect = vi.fn();
      disconnect = vi.fn();
      constructor() {
        capture = { port: this.port, disconnect: this.disconnect };
      }
    },
  );
  connect.mockReset();
  sendAudio.mockReset();
  closeSession.mockReset();
  sendTools.mockReset();
  sendContent.mockReset();
  connect.mockImplementation(async (options) => {
    callbacks = options.callbacks;
    callbacks.onmessage({ setupComplete: {} } as LiveServerMessage);
    return {
      sendRealtimeInput: sendAudio,
      close: closeSession,
      sendToolResponse: sendTools,
      sendClientContent: sendContent,
    };
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function events() {
  return { status: vi.fn(), transcript: vi.fn(), error: vi.fn() };
}

describe("voice media lifecycle", () => {
  it("reports a busy microphone before any Gemini provisioning and releases audio", async () => {
    getMicrophone.mockRejectedValue(
      Object.assign(new Error("private device"), { name: "NotReadableError" }),
    );
    const client = new GeminiVoiceClient(events());
    await expect(client.start({ seatId: "alice", bindingRevision: 1 })).rejects.toThrow(
      /microphone could not be opened/,
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(connect).not.toHaveBeenCalled();
    expect(fetchToken.mock.calls.some(([url]) => url === "/api/voice/session")).toBe(false);
    const report = JSON.parse(fetchToken.mock.calls[0][1].body);
    expect(report.diagnostic).toMatchObject({ code: "microphone_busy", phase: "browser" });
    expect(JSON.stringify(report)).not.toContain("private device");
    expect(closeContext).toHaveBeenCalledOnce();
  });

  it.each(["configuration", "selection", "rate_limit", "origin"])(
    "preserves the server's %s failure category",
    async (code) => {
      fetchToken.mockResolvedValueOnce({
        ok: false,
        json: async () => ({ diagnostic: { code, phase: "provisioning" } }),
      });
      const client = new GeminiVoiceClient(events());
      await expect(client.start()).rejects.not.toThrow(/Gemini voice connection failed/);
      expect(connect).not.toHaveBeenCalled();
      expect(track.stop).toHaveBeenCalledOnce();
      expect(closeContext).toHaveBeenCalledOnce();
    },
  );

  it("records token-route network errors as provisioning failures instead of microphone failures", async () => {
    fetchToken.mockRejectedValueOnce(new TypeError("Failed to fetch https://private.test"));
    const client = new GeminiVoiceClient(events());
    await expect(client.start({ seatId: "alice", bindingRevision: 1 })).rejects.toThrow(
      /connection failed/,
    );
    await vi.advanceTimersByTimeAsync(0);
    const report = JSON.parse(
      fetchToken.mock.calls.find(([url]) => url === "/api/runtime/voice/diagnostics")![1].body,
    );
    expect(report.diagnostic).toMatchObject({ code: "connection", phase: "provisioning" });
    expect(JSON.stringify(report)).not.toContain("private.test");
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("does not mislabel a failed handshake as a previously connected session", async () => {
    connect.mockImplementation(async (options) => {
      callbacks = options.callbacks;
      callbacks.onclose({ code: 1006 });
      return { close: closeSession };
    });
    const event = events();
    const client = new GeminiVoiceClient(event);
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(event.error).toHaveBeenCalledWith(expect.stringContaining("connection failed"));
    const report = JSON.parse(
      fetchToken.mock.calls.find(([url]) => url === "/api/runtime/voice/diagnostics")![1].body,
    );
    expect(report.diagnostic).toMatchObject({
      code: "connection",
      phase: "connection",
      closeCode: 1006,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes audio after a browser interruption without ending the call", async () => {
    const event = events();
    const client = new GeminiVoiceClient(event);
    await client.start();
    audioContext.state = "suspended";
    audioContext.resume.mockImplementation(async () => {
      audioContext.state = "running";
    });
    audioContext.onstatechange?.();
    await vi.advanceTimersByTimeAsync(6000);
    expect(audioContext.resume).toHaveBeenCalledTimes(2);
    expect(event.error).not.toHaveBeenCalled();
    client.close();
    expect(audioContext.onstatechange).toBeNull();
  });

  it("reports blocked playback instead of leaving a silent call active", async () => {
    const event = events();
    const client = new GeminiVoiceClient(event);
    await client.start();
    audioContext.state = "suspended";
    audioContext.resume.mockImplementation(() => new Promise(() => {}));
    audioContext.onstatechange?.();
    await vi.advanceTimersByTimeAsync(5000);
    expect(event.error).toHaveBeenCalledWith(expect.stringContaining("Browser audio is paused"));
    expect(closeSession).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("cancels pending audio recovery when the user ends the call", async () => {
    const event = events();
    const client = new GeminiVoiceClient(event);
    await client.start();
    audioContext.state = "suspended";
    audioContext.onstatechange?.();
    client.close();
    await vi.advanceTimersByTimeAsync(6000);
    expect(event.error).not.toHaveBeenCalled();
  });
  it("sends voice actions with the server call identity and preserves action IDs", async () => {
    const client = new GeminiVoiceClient(events());
    await client.start();
    const signal = new AbortController();
    fetchToken.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ task: { status: "cancel_requested" } }),
    });
    expect(
      await client.action(
        "cancel_task",
        { taskId: "task-1" },
        { actionId: "tool-1", signal: signal.signal },
      ),
    ).toMatchObject({ task: { status: "cancel_requested" } });
    const request = fetchToken.mock.calls.find(([url]) => url === "/api/runtime/voice/actions");
    expect(JSON.parse(request![1].body)).toEqual({
      callId: "voice_server-id",
      actionId: "tool-1",
      tool: "cancel_task",
      args: { taskId: "task-1" },
    });
    signal.abort();
    expect(request![1].signal.aborted).toBe(true);
    fetchToken.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "Task not found" }),
    });
    expect(
      await client.action("get_task_progress", { taskId: "foreign" }, { actionId: "tool-2" }),
    ).toEqual({ error: "Task not found" });
    client.close();
    await expect(
      client.action("assign_task", { message: "Late" }, { actionId: "tool-3" }),
    ).rejects.toThrow(/unavailable/);
  });
  it("records metadata-only usage and connected duration, then finalizes exactly once", async () => {
    const client = new GeminiVoiceClient(events());
    await client.start();
    await vi.advanceTimersByTimeAsync(2100);
    callbacks.onmessage({
      usageMetadata: { promptTokenCount: 10, responseTokenCount: 3, totalTokenCount: 13 },
    } as LiveServerMessage);
    client.close();
    client.close();
    await vi.advanceTimersByTimeAsync(0);
    const reports = fetchToken.mock.calls
      .filter(([url]) => url === "/api/runtime/voice/diagnostics")
      .map(([, options]) => JSON.parse(options.body));
    expect(reports[0]).toMatchObject({ status: "connected", durationMs: 0 });
    expect(reports.at(-1)).toMatchObject({
      status: "ended",
      durationMs: 2100,
      usage: { promptTokenCount: 10, responseTokenCount: 3, totalTokenCount: 13 },
    });
    expect(reports.filter((report) => report.status === "ended")).toHaveLength(1);
    expect(reports.map((report) => report.sequence)).toEqual([1, 2, 3]);
  });

  it("sanitizes a rejected SDK connection in both UI errors and persisted diagnostics", async () => {
    connect.mockRejectedValue(
      Object.assign(new Error("model not found?key=secret"), { status: 404 }),
    );
    const event = events();
    const client = new GeminiVoiceClient(event);
    await expect(client.start()).rejects.toThrow(/model or API version/);
    await vi.advanceTimersByTimeAsync(0);
    const reports = fetchToken.mock.calls
      .filter(([url]) => url === "/api/runtime/voice/diagnostics")
      .map(([, options]) => JSON.parse(options.body));
    expect(reports.at(-1)).toMatchObject({
      status: "error",
      durationMs: 0,
      diagnostic: { code: "model_api_version", httpStatus: 404 },
    });
    expect(JSON.stringify(reports)).not.toContain("secret");
    expect(track.stop).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("classifies websocket model/version failures without publishing their reason", async () => {
    const event = events();
    const client = new GeminiVoiceClient(event);
    await client.start();
    callbacks.onclose({ code: 1008, reason: "Unsupported API version at ?key=secret" });
    await vi.advanceTimersByTimeAsync(0);
    expect(event.error).toHaveBeenCalledWith(expect.stringContaining("model or API version"));
    expect(JSON.stringify(event.error.mock.calls)).not.toContain("secret");
    const reports = fetchToken.mock.calls
      .filter(([url]) => url === "/api/runtime/voice/diagnostics")
      .map(([, options]) => JSON.parse(options.body));
    expect(reports.at(-1).diagnostic).toMatchObject({ code: "model_api_version", closeCode: 1008 });
    expect(JSON.stringify(reports)).not.toContain("secret");
  });

  it("notifies the UI when usage cannot be saved while allowing the call to continue", async () => {
    const telemetryError = vi.fn();
    fetchToken.mockImplementation(async (url) =>
      url === "/api/runtime/voice/diagnostics"
        ? { ok: false }
        : {
            ok: true,
            json: async () => ({
              token: "temporary",
              model: "gemini-3.8-live",
              config: {},
              maxSeconds: 600,
              callId: "voice_server-id",
            }),
          },
    );
    const client = new GeminiVoiceClient({ ...events(), telemetryError });
    await client.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(telemetryError).toHaveBeenCalled();
    expect(track.stop).not.toHaveBeenCalled();
    client.close();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("silently refreshes only the selected identity with the latest snapshot during a pause", async () => {
    const client = new GeminiVoiceClient(events());
    const selection = { seatId: "alice", sessionKey: "s1", bindingRevision: 3 };
    await client.start(selection);
    callbacks.onmessage({ serverContent: { turnComplete: true } } as LiveServerMessage);
    sendContent.mockClear();
    const context: VoiceAgentContext = {
      ...selection,
      name: "Alice",
      role: "Engineer",
      status: "running",
      gatewayConnected: true,
      tasks: [],
      conversation: [],
    };
    callbacks.onmessage({
      voiceActivity: { voiceActivityType: "ACTIVITY_START" },
    } as LiveServerMessage);
    client.updateContext(context);
    client.updateContext({ ...context, status: "idle" });
    client.updateContext({ ...context, seatId: "bob", status: "wrong agent" });
    client.updateContext({ ...context, sessionKey: "s2", status: "wrong session" });
    client.updateContext({ ...context, bindingRevision: 4, status: "wrong binding" });
    await vi.advanceTimersByTimeAsync(1800);
    expect(sendContent).not.toHaveBeenCalled();
    callbacks.onmessage({
      voiceActivity: { voiceActivityType: "ACTIVITY_END" },
      serverContent: { turnComplete: true },
    } as LiveServerMessage);
    await vi.advanceTimersByTimeAsync(1500);
    expect(sendContent).toHaveBeenCalledOnce();
    expect(sendContent.mock.calls[0][0].turnComplete).toBe(false);
    const payload = JSON.stringify(sendContent.mock.calls[0][0]);
    expect(payload).toContain('\\"status\\":\\"idle\\"');
    expect(payload).not.toContain("wrong");
    client.updateContext({ ...context, status: "idle" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(sendContent).toHaveBeenCalledOnce();
    client.close();
  });

  it("preserves an interrupting utterance and finalizes the assistant fragment separately", async () => {
    const event = events();
    const client = new GeminiVoiceClient(event);
    await client.start();
    callbacks.onmessage({
      serverContent: { outputTranscription: { text: "I can prepare" } },
    } as LiveServerMessage);
    callbacks.onmessage({
      voiceActivity: { voiceActivityType: "ACTIVITY_START" },
      serverContent: { inputTranscription: { text: "Actually " } },
    } as LiveServerMessage);
    const part = { inlineData: { mimeType: "audio/pcm;rate=24000", data: btoa("\0\0") } };
    callbacks.onmessage({
      serverContent: {
        interrupted: true,
        outputTranscription: { text: "stale answer" },
        modelTurn: { parts: [part] },
      },
    } as LiveServerMessage);
    expect(event.transcript).toHaveBeenCalledWith("assistant", "I can prepare", true, {
      interrupted: true,
    });
    expect(event.transcript).not.toHaveBeenCalledWith("user", "Actually ", true);
    expect(sources).toHaveLength(0);
    callbacks.onmessage({ serverContent: { turnComplete: true } } as LiveServerMessage);
    callbacks.onmessage({
      serverContent: { inputTranscription: { text: "make it shorter", finished: true } },
    } as LiveServerMessage);
    expect(event.transcript).toHaveBeenCalledWith("user", "Actually make it shorter", true);
    expect(JSON.stringify(event.transcript.mock.calls)).not.toContain("stale answer");
    client.close();
  });

  it("keeps a new user utterance together when an old response ends before its interruption event", async () => {
    const event = events();
    const client = new GeminiVoiceClient(event);
    await client.start();
    callbacks.onmessage({
      serverContent: { outputTranscription: { text: "Previous reply" } },
    } as LiveServerMessage);
    callbacks.onmessage({
      voiceActivity: { voiceActivityType: "ACTIVITY_START" },
      serverContent: { inputTranscription: { text: "Actually " } },
    } as LiveServerMessage);
    callbacks.onmessage({ serverContent: { turnComplete: true } } as LiveServerMessage);
    expect(event.transcript).toHaveBeenCalledWith("assistant", "Previous reply", true);
    expect(event.transcript).not.toHaveBeenCalledWith("user", "Actually ", true);
    callbacks.onmessage({ serverContent: { interrupted: true } } as LiveServerMessage);
    callbacks.onmessage({
      voiceActivity: { voiceActivityType: "ACTIVITY_END" },
      serverContent: { inputTranscription: { text: "change that", finished: true } },
    } as LiveServerMessage);
    expect(event.transcript).toHaveBeenCalledWith("user", "Actually change that", true);
    client.close();
  });

  it("preserves a buffered assistant reply as interrupted when the call closes", async () => {
    const event = events();
    const client = new GeminiVoiceClient(event);
    await client.start();
    callbacks.onmessage({
      serverContent: {
        inputTranscription: { text: "Please help" },
        outputTranscription: { text: "I can start by" },
      },
    } as LiveServerMessage);
    client.close();
    client.close();
    expect(event.transcript).toHaveBeenCalledWith("user", "Please help", true);
    expect(event.transcript).toHaveBeenCalledWith("assistant", "I can start by", true, {
      interrupted: true,
    });
    expect(
      event.transcript.mock.calls.filter(([role, , finished]) => role === "assistant" && finished),
    ).toHaveLength(1);
    callbacks.onmessage({
      serverContent: { outputTranscription: { text: "Late reply" }, turnComplete: true },
    } as LiveServerMessage);
    expect(JSON.stringify(event.transcript.mock.calls)).not.toContain("Late reply");
  });

  it("aborts a pending tool on interruption and never sends its late response", async () => {
    let resolveTool!: (value: Record<string, unknown>) => void;
    let toolSignal: AbortSignal | undefined;
    const tool = vi.fn((_name, _args, signal) => {
      toolSignal = signal;
      return new Promise<Record<string, unknown>>((resolve) => {
        resolveTool = resolve;
      });
    });
    const client = new GeminiVoiceClient({ ...events(), tool });
    await client.start();
    callbacks.onmessage({
      toolCall: { functionCalls: [{ id: "late-tool", name: "assign_task", args: {} }] },
    } as LiveServerMessage);
    await vi.advanceTimersByTimeAsync(0);
    expect(toolSignal?.aborted).toBe(false);
    callbacks.onmessage({ serverContent: { interrupted: true } } as LiveServerMessage);
    expect(toolSignal?.aborted).toBe(true);
    resolveTool({ accepted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sendTools).not.toHaveBeenCalled();
    client.close();
  });

  it("aborts an executing tool when the server cancels its call", async () => {
    let signal: AbortSignal | undefined;
    let complete!: (value: Record<string, unknown>) => void;
    const client = new GeminiVoiceClient({
      ...events(),
      tool: (_name, _args, pendingSignal) => {
        signal = pendingSignal;
        return new Promise((resolve) => {
          complete = resolve;
        });
      },
    });
    await client.start();
    callbacks.onmessage({
      toolCall: { functionCalls: [{ id: "canceled", name: "assign_task", args: {} }] },
    } as LiveServerMessage);
    await vi.advanceTimersByTimeAsync(0);
    callbacks.onmessage({ toolCallCancellation: { ids: ["canceled"] } } as LiveServerMessage);
    expect(signal?.aborted).toBe(true);
    complete({ accepted: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sendTools).not.toHaveBeenCalled();
    client.close();
  });

  it("does not mistake late input transcripts or an interrupted turn boundary for a quiet user", async () => {
    const client = new GeminiVoiceClient(events());
    await client.start();
    const notice = { taskId: "pause", status: "completed", message: "Done" };
    client.queueTaskAnnouncement(notice);
    callbacks.onmessage({
      voiceActivity: { voiceActivityType: "ACTIVITY_START" },
    } as LiveServerMessage);
    callbacks.onmessage({
      serverContent: { interrupted: true, turnComplete: true },
    } as LiveServerMessage);
    await vi.advanceTimersByTimeAsync(1500);
    expect(sendContent).not.toHaveBeenCalled();
    callbacks.onmessage({
      voiceActivity: { voiceActivityType: "ACTIVITY_END" },
    } as LiveServerMessage);
    callbacks.onmessage({
      serverContent: { inputTranscription: { text: "Hello" } },
    } as LiveServerMessage);
    await vi.advanceTimersByTimeAsync(1500);
    expect(sendContent).not.toHaveBeenCalled();
    callbacks.onmessage({ serverContent: { turnComplete: true } } as LiveServerMessage);
    await vi.advanceTimersByTimeAsync(1500);
    expect(sendContent).toHaveBeenCalledOnce();
    client.close();
  });

  it("withdraws superseded task announcements before they can be spoken", async () => {
    const client = new GeminiVoiceClient(events());
    await client.start();
    client.queueTaskAnnouncement({ taskId: "old", status: "completed", message: "Old result" });
    client.cancelTaskAnnouncement("old");
    await vi.advanceTimersByTimeAsync(1500);
    expect(sendContent).not.toHaveBeenCalled();
    client.close();
  });
  it("sends only a binding selection and persists final turns using the server call identity after close", async () => {
    const client = new GeminiVoiceClient(events());
    await client.start({ seatId: "alice", bindingRevision: 3, sessionKey: "agent:main:main" });
    expect(JSON.parse(fetchToken.mock.calls[0][1].body)).toEqual({
      seatId: "alice",
      bindingRevision: 3,
      sessionKey: "agent:main:main",
    });
    client.close();
    await client.saveTranscript({
      id: "turn1",
      role: "user",
      content: "Hello",
      timestamp: "2026-10-25T00:00:00Z",
    });
    const transcriptRequest = fetchToken.mock.calls.find(
      ([url]) => url === "/api/runtime/voice/transcripts",
    );
    expect(transcriptRequest).toBeDefined();
    expect(transcriptRequest![1].keepalive).toBe(true);
    expect(JSON.parse(transcriptRequest![1].body)).toMatchObject({
      callId: "voice_server-id",
      id: "turn1",
    });
  });
  it("waits for a quiet turn before announcing a task, and never repeats it", async () => {
    const announcement = vi.fn();
    const client = new GeminiVoiceClient({ ...events(), announcement });
    await client.start();
    callbacks.onmessage({
      voiceActivity: { voiceActivityType: "ACTIVITY_START" },
    } as LiveServerMessage);
    client.queueTaskAnnouncement({
      taskId: "done-1",
      status: "completed",
      message: "Draft email",
      result: "Ready",
    });
    await vi.advanceTimersByTimeAsync(1800);
    expect(sendContent).not.toHaveBeenCalled();
    callbacks.onmessage({
      voiceActivity: { voiceActivityType: "ACTIVITY_END" },
      serverContent: { turnComplete: true },
    } as LiveServerMessage);
    await vi.advanceTimersByTimeAsync(900);
    expect(sendContent).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(600);
    expect(sendContent).toHaveBeenCalledOnce();
    expect(announcement).toHaveBeenCalledExactlyOnceWith("done-1");
    expect(JSON.stringify(sendContent.mock.calls[0][0])).toContain("done-1");
    callbacks.onmessage({ serverContent: { turnComplete: true } } as LiveServerMessage);
    client.queueTaskAnnouncement({ taskId: "done-1", status: "completed", message: "Draft email" });
    await vi.advanceTimersByTimeAsync(1800);
    expect(sendContent).toHaveBeenCalledOnce();
    expect(announcement).toHaveBeenCalledOnce();
    client.close();
  });

  it("does not acknowledge an announcement whose send failed", async () => {
    const announcement = vi.fn();
    const event = events();
    const client = new GeminiVoiceClient({ ...event, announcement });
    await client.start();
    sendContent.mockImplementationOnce(() => {
      throw new Error("Connection closed");
    });
    client.queueTaskAnnouncement({ taskId: "failed-send", status: "completed", message: "Draft" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(sendContent).toHaveBeenCalledOnce();
    expect(announcement).not.toHaveBeenCalled();
    expect(event.error).toHaveBeenCalled();
  });

  it("drops queued task notices when the call ends", async () => {
    const client = new GeminiVoiceClient(events());
    await client.start();
    client.queueTaskAnnouncement({ taskId: "done-2", status: "completed", message: "Draft email" });
    client.close();
    await vi.advanceTimersByTimeAsync(3000);
    expect(sendContent).not.toHaveBeenCalled();
  });
  it("responds to a tool call once and drops canceled calls", async () => {
    const tool = vi.fn().mockReturnValue({ accepted: true, taskId: "task-1" });
    const client = new GeminiVoiceClient({ ...events(), tool });
    await client.start();
    const message = {
      toolCall: {
        functionCalls: [{ id: "call-1", name: "assign_task", args: { message: "Draft email" } }],
      },
    } as unknown as LiveServerMessage;
    callbacks.onmessage(message);
    callbacks.onmessage(message);
    await vi.advanceTimersByTimeAsync(0);
    expect(tool).toHaveBeenCalledOnce();
    expect(sendTools).toHaveBeenCalledWith({
      functionResponses: [
        { id: "call-1", name: "assign_task", response: { accepted: true, taskId: "task-1" } },
      ],
    });
    callbacks.onmessage({
      toolCallCancellation: { ids: ["call-2"] },
      toolCall: { functionCalls: [{ id: "call-2", name: "assign_task", args: {} }] },
    } as LiveServerMessage);
    await vi.advanceTimersByTimeAsync(0);
    expect(tool).toHaveBeenCalledOnce();
    client.close();
  });
  it("stops late microphone acquisition when the user cancels", async () => {
    let grant!: (stream: unknown) => void;
    getMicrophone.mockImplementation(
      () =>
        new Promise((resolve) => {
          grant = resolve;
        }),
    );
    const client = new GeminiVoiceClient(events());
    const start = client.start();
    await vi.waitFor(() => expect(getMicrophone).toHaveBeenCalled());
    client.close();
    grant({ getTracks: () => [track] });
    await start;
    expect(track.stop).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
    expect(fetchToken).not.toHaveBeenCalled();
  });

  it("sends PCM at the capture rate, suppresses muted audio, and releases resources", async () => {
    const client = new GeminiVoiceClient(events());
    await client.start();
    capture.port.onmessage!({ data: new Float32Array([0.5]) });
    expect(sendAudio.mock.calls[0][0].audio.mimeType).toBe("audio/pcm;rate=16000");
    client.setMuted(true);
    expect(track.enabled).toBe(false);
    sendAudio.mockClear();
    capture.port.onmessage!({ data: new Float32Array([0.5]) });
    expect(sendAudio).not.toHaveBeenCalled();
    client.setMuted(false);
    expect(track.enabled).toBe(true);
    client.close();
    client.close();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(capture.disconnect).toHaveBeenCalledOnce();
    expect(closeSession).toHaveBeenCalledOnce();
    expect(closeContext).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("plays every audio part and stops all of them on interruption", async () => {
    const client = new GeminiVoiceClient(events());
    await client.start();
    const part = { inlineData: { mimeType: "audio/pcm;rate=24000", data: btoa("\0\0") } };
    callbacks.onmessage({
      serverContent: { modelTurn: { parts: [part, part] } },
    } as LiveServerMessage);
    expect(sources).toHaveLength(2);
    callbacks.onmessage({ serverContent: { interrupted: true } } as LiveServerMessage);
    sources.forEach((source) => expect(source.stop).toHaveBeenCalledOnce());
    client.close();
  });

  it("ends a call at the time cap instead of reconnecting and incurring more usage", async () => {
    const event = events();
    const client = new GeminiVoiceClient(event);
    await client.start();
    await vi.advanceTimersByTimeAsync(600000);
    expect(event.error).toHaveBeenCalledWith(expect.stringContaining("10-minute"));
    expect(track.stop).toHaveBeenCalledOnce();
    expect(closeSession).toHaveBeenCalledOnce();
  });
});
