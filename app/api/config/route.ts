import { NextResponse } from "next/server";
import { readOpenClawToken } from "@/lib/ws-proxy";

/** Returns server-side gateway configuration so the client can auto-configure. */
export async function GET() {
  const hasToken =
    process.env.AGENT_PROVIDER === "nightshift"
      ? !!process.env.NIGHTSHIFT_API_KEY && process.env.NIGHTSHIFT_API_KEY !== "rt-local"
      : !!(process.env.GATEWAY_TOKEN || readOpenClawToken());
  return NextResponse.json({ hasToken });
}
