import {
  VOICE_API_VERSION,
  classifyVoiceError,
  sanitizeDiagnostic,
} from "@/lib/voice/diagnostics.mjs";
import { GoogleGenAI } from "@google/genai";
import { NextResponse } from "next/server";
import { isAllowedAppOrigin } from "@/lib/server-security.mjs";
import { voiceConfig, VOICE_MODEL, VOICE_SESSION_SECONDS } from "@/lib/voice/config";
import { getServerRuntime } from "@/lib/server/runtime-access.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const noStore = { "Cache-Control": "no-store" };
let attempts: number[] = [];

function setupError(code: string, status: number, headers = {}) {
  const diagnostic = sanitizeDiagnostic({ code, phase: "provisioning", httpStatus: status });
  return NextResponse.json(
    { error: diagnostic.message, diagnostic },
    { status, headers: { ...noStore, ...headers } },
  );
}

export async function GET() {
  return NextResponse.json(
    {
      configured: !!process.env.GEMINI_API_KEY,
      model: VOICE_MODEL,
      maxSeconds: VOICE_SESSION_SECONDS,
    },
    { headers: noStore },
  );
}

export async function POST(request: Request) {
  const url = new URL(request.url);
  const host = request.headers.get("host") ?? url.host;
  // Local app: do not let another website provision paid sessions through localhost.
  if (
    request.headers.get("sec-fetch-site") === "cross-site" ||
    !isAllowedAppOrigin(request.headers.get("origin"), host)
  ) {
    return setupError("origin", 403);
  }
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return setupError("configuration", 503);
  }
  let agent;
  let selection;
  try {
    if (Number(request.headers.get("content-length") ?? 0) > 40000)
      throw new Error("Context too large");
    const body = await request.text();
    if (body.length > 40000) throw new Error("Context too large");
    selection = body ? JSON.parse(body) : undefined;
    agent = await getServerRuntime().voice.retrieveContext(selection);
  } catch (error) {
    const status = error instanceof Error && "status" in error ? Number(error.status) : 400;
    return setupError(status >= 500 ? "service_unavailable" : "selection", status);
  }
  const now = Date.now();
  attempts = attempts.filter((at) => now - at < 60000);
  if (attempts.length >= 6) {
    return setupError("rate_limit", 429, { "Retry-After": "60" });
  }
  attempts.push(now);
  // Roster position gives every assigned agent its own voice, across Nightshift and OpenClaw.
  const roster: string[] = (getServerRuntime().rosterSeats?.() ?? [])
    .filter((seat: { assigned?: boolean }) => seat.assigned)
    .map((seat: { seatId: string }) => seat.seatId)
    .sort();
  const config = voiceConfig(
    agent && roster.includes(agent.seatId)
      ? { ...agent, voiceIndex: roster.indexOf(agent.seatId) }
      : agent,
  );
  let tokenName: string;
  try {
    const ai = new GoogleGenAI({
      apiKey,
      httpOptions: { apiVersion: VOICE_API_VERSION, timeout: 15000 },
    });
    const token = await ai.authTokens.create({
      config: {
        uses: 1,
        expireTime: new Date(now + VOICE_SESSION_SECONDS * 1000).toISOString(),
        newSessionExpireTime: new Date(now + 60000).toISOString(),
        liveConnectConstraints: { model: VOICE_MODEL, config },
      },
    });
    if (!token.name) throw new Error("No token returned");
    tokenName = token.name;
  } catch (error) {
    const diagnostic = classifyVoiceError(error, "provisioning");
    try {
      getServerRuntime().voice.recordFailure(selection, diagnostic);
    } catch {
      // Diagnostic storage must not replace the sanitized provider failure.
    }
    return NextResponse.json(
      { error: diagnostic.message, diagnostic, model: VOICE_MODEL, apiVersion: VOICE_API_VERSION },
      { status: 502, headers: noStore },
    );
  }
  try {
    // Token provisioning awaits a network request; reject a binding changed during that wait.
    const callId = getServerRuntime().voice.createCall(selection);
    return NextResponse.json(
      { token: tokenName, model: VOICE_MODEL, config, maxSeconds: VOICE_SESSION_SECONDS, callId },
      { headers: noStore },
    );
  } catch (error) {
    const status = error instanceof Error && "status" in error ? Number(error.status) : 503;
    return setupError(status >= 500 ? "service_unavailable" : "selection", status);
  }
}
