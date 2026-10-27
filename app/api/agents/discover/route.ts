import { NextResponse } from "next/server";

/** Gateway discovery is owned by the custom server, which intercepts this path. */
export async function GET() {
  return NextResponse.json(
    {
      agents: [],
      capability: {
        available: false,
        reason:
          "Start Agent Town with pnpm dev, pnpm start, or the packaged CLI to enable gateway discovery.",
      },
    },
    { status: 503, headers: { "Cache-Control": "no-store" } },
  );
}
