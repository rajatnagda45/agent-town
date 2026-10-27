// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WorkReportView, type WorkTask } from "@/components/work/WorkReport";

afterEach(cleanup);

it("shows a durable running or unknown query state without claiming cancellation", () => {
  const { rerender } = render(
    <WorkReportView task={{ ...task, status: "collecting", report: undefined }} />,
  );
  expect(screen.getByRole("status").textContent).toContain("Query running");
  rerender(
    <WorkReportView
      task={{
        ...task,
        status: "unresolved",
        queryState: "execution_outcome_unknown",
        report: undefined,
      }}
    />,
  );
  expect(screen.getByRole("status").textContent).toContain("automatic resubmission is blocked");
});

const task: WorkTask = {
  id: "compose_report",
  status: "completed",
  verdict: "ACCEPT",
  input: { goal: "Find the CR 10 manual maintenance schedule and cite sources" },
  contract: null,
  route: { workflow: "web-research", dataSources: ["web"], successCriteria: ["Cite sources"] },
  attempts: [
    {
      taskId: "t1",
      role: "nightshift-analyst",
      stage: "analyst",
      seatId: "analyze",
      executionDecision: {
        runtime: "nightshift",
        modelProvider: "unknown",
        model: "gpt-4o-mini",
        reason: ["only eligible option for the required capabilities, tools and permissions"],
        rejected: [{ optionId: "openclaw-local", missing: ["enforced tool and time budgets"] }],
      },
    },
  ],
  evidence: [
    {
      evidenceId: "ev_1",
      source: "web:tavily",
      content: JSON.stringify({ url: "https://example.com/cr10.pdf", title: "CR 10 manual" }),
      retrievedAt: "2026-10-27T00:00:00.000Z",
      freshUntil: "2026-10-28T00:00:00.000Z",
    },
    {
      evidenceId: "ev_2",
      source: "web:tavily",
      content: JSON.stringify({ url: "javascript:alert(1)", title: "Unsafe" }),
      retrievedAt: "2026-10-27T00:00:00.000Z",
    },
  ],
  analysis: { summary: "Inspect the shaft seal every 3000 hours." },
  critic: { decision: "ACCEPT", reason: "Every claim cites the manual." },
  repairHistory: [{ issues: ["Worker result must be a JSON object."] }],
  actions: [{ kind: "save-report", status: "completed", executed: true }],
  checks: [{ status: "verified", issues: [] }],
  report: {
    summary: "Inspect the shaft seal every 3000 hours.",
    verified: true,
    scope: "Third-party content not independently verified.",
  },
};

it("renders all six report sections with routing, sources, repairs and verification", () => {
  render(<WorkReportView task={task} />);
  for (const label of [
    "Summary",
    "Team and execution",
    "Findings and evidence",
    "Decisions and revisions",
    "Actions and deliverables",
    "Verification",
  ])
    expect(screen.getByLabelText(label)).toBeTruthy();
  expect(screen.getByText(/nightshift · model provider unknown/)).toBeTruthy();
  expect(screen.getByText(/openclaw-local \(enforced tool and time budgets\)/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "CR 10 manual" }).getAttribute("href")).toBe(
    "https://example.com/cr10.pdf",
  );
  // A non-http URL is never rendered as a link.
  expect(screen.queryByRole("link", { name: "Unsafe" })).toBeNull();
  expect(screen.getByText(/Schema repair 1/)).toBeTruthy();
  expect(screen.getByText("No open issues.")).toBeTruthy();
});

it("exports the full report as JSON", () => {
  const createObjectURL = vi.fn(() => "blob:report");
  Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  render(<WorkReportView task={task} />);
  fireEvent.click(screen.getByText("Export JSON"));
  expect(createObjectURL).toHaveBeenCalledOnce();
  expect(click).toHaveBeenCalledOnce();
  click.mockRestore();
});

it("shows the persisted execution timeline and the source the task actually read", () => {
  render(
    <WorkReportView
      task={{
        ...task,
        status: "unresolved",
        report: undefined,
        error: "Blocked: TEST-SKU-001 at Test Warehouse A has no physical count records.",
        timeline: [
          {
            at: "2026-10-27T10:00:00.000Z",
            event: "accepted",
            actor: "Agent Town",
            detail: "Request accepted.",
          },
          {
            at: "2026-10-27T10:00:05.000Z",
            event: "query_result",
            actor: "Agent Town data service (server)",
            detail: "inventory-physical-counts 0 rows.",
            source: "LIVE Zetaris · AGENT_TOWN_INVENTORY_DEMO.INVENTORY_PHYSICAL_COUNTS",
            sourceMode: "LIVE",
          },
        ],
      }}
    />,
  );
  const timeline = screen.getByRole("region", { name: "Execution timeline" });
  expect(timeline.textContent).toContain("query result · Agent Town data service (server)");
  expect(timeline.textContent).toContain("inventory-physical-counts 0 rows.");
  expect(screen.getByText(/Source: LIVE Zetaris · AGENT_TOWN_INVENTORY_DEMO/)).toBeTruthy();
});

it("shows the supplier decision, why it was made, the recalled memory and required approvals", () => {
  render(
    <WorkReportView
      task={{
        ...task,
        purchaseOrder: "PO-1042",
        recalled: {
          taskId: "compose_run1",
          verifiedAt: "2026-10-27T12:00:00.000Z",
          decision: "Confirm the remaining shipment with the carrier: SHP-1042-B.",
          confidence: 1,
          evidenceIds: ["ev_old_shipment_123456"],
          conclusions: { in_transit: 15 },
        },
        evidence: [
          {
            evidenceId: "ev_shipment_b_0123456789",
            source: "zetaris:zetaris_supplier_shipments",
            recordId: "SHP-1042-B",
            content: JSON.stringify({
              po_id: "PO-1042",
              shipped_quantity: "15",
              status: "delivered",
            }),
            retrievedAt: "2026-10-27T13:00:00.000Z",
          },
        ],
        report: {
          ...task.report!,
          decision: {
            poId: "PO-1042",
            status: "recommended",
            verified: true,
            decision:
              "Verify the 15 delivered units at the dock, then record the missing goods receipt.",
            actions: [
              "Verify the 15 delivered units at the dock, then record the missing goods receipt.",
            ],
            approvals: [
              "Recording a goods receipt for 15 units changes records: authorized human approval required.",
            ],
            confidence: 1,
            rules: [
              {
                id: "memory_freshness",
                title: "Memory freshness",
                condition: "A recalled finding must match current records before it is used",
                fired: true,
                reason: "Prior finding (in transit 15) no longer matches current records.",
                evidenceIds: ["ev_old_shipment_123456"],
              },
              {
                id: "in_transit",
                title: "Shipment in transit",
                condition: "Units are shipped but not yet delivered",
                fired: false,
                reason: "No units are in transit.",
                evidenceIds: [],
              },
            ],
            memory: {
              status: "conflicts",
              reason: "Prior finding no longer matches current records.",
            },
          },
        },
      }}
    />,
  );
  const decision = screen.getByRole("region", { name: "Decision" });
  expect(decision.textContent).toContain("record the missing goods receipt");
  expect(decision.textContent).toContain("verified by independent review");
  expect(decision.textContent).toContain("Memory freshness✓");
  expect(decision.textContent).toContain("Shipment in transit—");
  expect(screen.getByRole("note", { name: "Human approval required" }).textContent).toContain(
    "no payment was approved and no record was changed",
  );
  const memory = screen.getByRole("region", { name: "Memory" });
  expect(memory.textContent).toContain("compose_run1");
  expect(memory.textContent).toContain("Conflicts with current records — not reused");
  expect(memory.textContent).toContain("Memory is prior context, not proof");
  expect(screen.getByText(/shipped_quantity: 15 · status: delivered/)).toBeTruthy();
});

it("shows the lifecycle with real stage states, worker identities and honest delivery", () => {
  render(
    <WorkReportView
      task={task}
      lifecycle={{
        taskId: "compose_report",
        overall: "blocked",
        composerStatus: "unresolved",
        progress: { done: 3, total: 8 },
        stages: [
          {
            id: "received",
            title: "Received",
            purpose: "Alice accepted the request",
            status: "done",
          },
          {
            id: "executing",
            title: "Researching",
            purpose: "Server web search and source retrieval",
            status: "failed",
            executor: "Agent Town data service (server)",
            error: "Web search: timeout",
          },
          {
            id: "reviewing",
            title: "Reviewing",
            purpose: "Critic checks the output",
            status: "not_started",
            worker: {
              role: "nightshift-critic",
              configured: { seatId: "review", label: "Kritika", agentId: "main" },
              selected: {
                optionId: "nightshift",
                runtime: "nightshift",
                model: "gpt-4o-mini",
                reason: null,
                rejected: [{ optionId: "openclaw", missing: ["capability discovery failed"] }],
              },
              dispatched: null,
              executed: null,
            },
          },
        ],
        criteria: [{ description: "Cite sources", status: "not_met" }],
        independence: {
          kind: "same_agent_different_sessions",
          warning: "Separate sessions are separate contexts, not independent agents.",
        },
        delivery: {
          messageDelivered: true,
          deliveredAt: "2026-10-27T14:08:00.000Z",
          workVerified: false,
        },
        diagnosis: {
          cause: "timeout",
          confirmed: true,
          observed: "Web search request failed or timed out.",
        },
        createdAt: "2026-10-27T14:00:00.000Z",
        updatedAt: "2026-10-27T14:08:00.000Z",
      }}
    />,
  );
  const panel = screen.getByRole("region", { name: "Lifecycle" });
  expect(panel.textContent).toContain("Lifecycle · blocked");
  expect(panel.textContent).toContain("3 of 8 required stages done");
  expect(panel.textContent).toContain("a delivered reply does not mean the work succeeded");
  expect(panel.textContent).toContain("Blocked: timeout.");
  expect(panel.textContent).toContain("Researching · Failed");
  expect(panel.textContent).toContain("Executor: Agent Town data service (server)");
  expect(panel.textContent).toContain("Kritika (review) → main");
  expect(panel.textContent).toContain("Rejected openclaw: capability discovery failed.");
  expect(panel.textContent).toContain("Not dispatched");
  expect(panel.textContent).toContain("No execution recorded");
  expect(panel.textContent).toContain("not independent agents");
  expect(panel.textContent).toContain("not met · Cite sources");
});
