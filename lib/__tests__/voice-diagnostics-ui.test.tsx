import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import VoiceDiagnostics from "@/components/hud/VoiceDiagnostics";

vi.mock("../store", () => ({
  useStudio: () => ({
    state: {
      voice: {
        calls: [
          {
            id: "call-1",
            name: "Alice",
            createdAt: "2026-10-25T00:00:00Z",
            status: "ended",
            model: "gemini-3.8-live",
            apiVersion: "v1beta",
            durationMs: 2500,
            usageReports: [{ usage: { promptTokenCount: 0, totalTokenCount: 9 } }],
          },
          { id: "call-2", name: "Bob", createdAt: "2026-10-25T00:00:01Z", status: "error" },
        ],
      },
    },
  }),
}));

describe("voice usage labels", () => {
  it("distinguishes reports and estimates from bills and does not turn absent counts into zero", () => {
    const html = renderToStaticMarkup(<VoiceDiagnostics />);
    expect(html).toContain("all devices");
    expect(html).toContain("not Google&#x27;s actual bill");
    expect(html).toContain("estimates, not charges");
    expect(html).toContain("2.5s");
    expect(html).toContain("input 0, output unknown, total 9");
    expect(html).toContain("not a summed call total");
    expect(html).toContain("unknown (no metadata received)");
  });
});
