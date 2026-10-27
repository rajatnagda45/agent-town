if (process.env.AGENT_TOWN_ALLOW_PAID_VOICE_TESTS !== "1") {
  console.error(
    "Paid live voice checks are disabled. Set AGENT_TOWN_ALLOW_PAID_VOICE_TESTS=1 to opt in explicitly.",
  );
  process.exit(1);
}

// Disabled checks must exit before loading the provider SDK (including under parallel CI load).
const { GoogleGenAI } = await import("@google/genai");

// Exercises the actual server token route and Live WebSocket without opening a microphone.
const origin = process.env.AGENT_TOWN_TEST_ORIGIN ?? "http://127.0.0.1:3000";
let session;
try {
  const stateResponse = await fetch(`${origin}/api/runtime/state`);
  if (!stateResponse.ok) throw new Error("Authoritative task runtime unavailable");
  const state = await stateResponse.json();
  const seat = state.seats.find((seat) => seat.assigned && seat.binding?.available);
  if (!seat) throw new Error("Assign a verified agent to a seat before checking voice");
  const response = await fetch(`${origin}/api/voice/session`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({
      seatId: seat.seatId,
      bindingRevision: seat.binding.revision,
      sessionKey: seat.binding.sessionKey,
    }),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
  const apiKey = data.key ?? data.token;
  if (typeof apiKey !== "string" || !apiKey)
    throw new Error("Voice session did not return credentials");
  const ai = new GoogleGenAI({ apiKey, httpOptions: { apiVersion: "v1beta" } });
  let audioChunks = 0;
  let transcript = false;
  let finish;
  let fail;
  const completed = new Promise((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });
  void completed.catch(() => {});
  const timer = setTimeout(() => fail(new Error("Live response timed out")), 25000);
  try {
    session = await ai.live.connect({
      model: data.model,
      config: data.config,
      callbacks: {
        onmessage(message) {
          const content = message.serverContent;
          for (const part of content?.modelTurn?.parts ?? []) {
            if (part.inlineData?.mimeType?.startsWith("audio/pcm")) audioChunks++;
          }
          if (content?.outputTranscription?.text) transcript = true;
          if (content?.turnComplete) {
            if (audioChunks && transcript) finish();
            else fail(new Error("Live response did not contain both audio and transcript"));
          }
        },
        onerror: () => fail(new Error("Live WebSocket failed; check Gemini access and quota")),
        onclose: () => fail(new Error("Live WebSocket closed before completion")),
      },
    });
    session.sendClientContent({
      turns: [{ role: "user", parts: [{ text: "Say hello in one short sentence." }] }],
      turnComplete: true,
    });
    await completed;
    console.log(
      `PASS: ${data.model}; server session auth, ${audioChunks} PCM audio chunks, and transcript verified.`,
    );
  } finally {
    clearTimeout(timer);
  }
} catch (error) {
  // Do not print provider error objects: they can contain the token-bearing WebSocket URL.
  console.error(
    error?.constructor === Error
      ? error.message
      : "Gemini voice verification failed. Check project model access, quota, and API restrictions.",
  );
  process.exitCode = 1;
} finally {
  session?.close();
}
