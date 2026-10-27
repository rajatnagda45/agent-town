import { NextResponse } from "next/server";
import { loadInstalledContracts } from "@/lib/server/contracts.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET() {
  const audit = await loadInstalledContracts();
  return NextResponse.json(audit.report(), { headers: { "Cache-Control": "no-store" } });
}
