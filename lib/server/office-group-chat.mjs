export const OFFICE_GROUP_SESSION = "office:group:main";
import { classifyOfficeIntent } from "./office-intent.mjs";
import { dataIntent, purchaseOrderId } from "./task-intent.mjs";
import { investigationView } from "./inventory-office-api.mjs";
import { officeLead } from "./office-lead.mjs";
// Settled for a group turn. An unknown outcome is never retried, so it settles the turn too;
// otherwise one stuck agent would hold the whole office conversation.
const finished = new Set(["completed", "failed", "stopped", "interrupted", "outcome_unknown"]);
// How long a turn waits for an unavailable teammate before skipping it with a note.
const UNAVAILABLE_GRACE_MS = 2 * 60 * 1000;
const safeTurnId = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,48}$/.test(value);
const MAX_SUPPORTING = 2;
/** " · Source: LIVE …" from the task's recorded query event, when it read any data. */
const sourceLine = (task) => {
  const read = (task.timeline ?? []).findLast((event) => event.source);
  return read ? ` · Source: ${read.source}` : "";
};
// What a message asks for, and which seat roles serve it.
const RELEVANCE = [
  [/\b(?:plan\w*|steps?|schedule|roadmap|prioriti\w*|organi[sz]e)\b/i, /plan/i],
  [
    /\b(?:analy\w*|assess\w*|investigat\w*|data|numbers?|metrics?|trends?|why|cause|calculat\w*)\b/i,
    /analy|data/i,
  ],
  [/\b(?:review\w*|risks?|check\w*|verify|critique|wrong|flaws?)\b/i, /critic|review/i],
  [/\b(?:research\w*|sources?|search\w*|web|docs?|manuals?|articles?)\b/i, /research/i],
];

/** The office lead answers; at most two others join, chosen by role relevance in roster order.
 * Greetings go to the lead alone. Without a lead, the first available agent leads. */
export function selectParticipants(available, message, leadSeatId) {
  const lead = available.find((seat) => seat.seatId === leadSeatId) ?? available[0];
  if (!lead) return [];
  if (greeting.test(message)) return [lead];
  const supporting = available
    .filter((seat) => seat !== lead)
    .map((seat, index) => ({
      seat,
      index,
      score: RELEVANCE.filter(
        ([asks, serves]) => asks.test(message) && serves.test(`${seat.roleTitle} ${seat.label}`),
      ).length,
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, MAX_SUPPORTING)
    .map((item) => item.seat);
  return [lead, ...supporting];
}
function specialistIntent(message) {
  const team = /^(?:please\s+)?(?:assign|ask|get)\s+(?:the\s+)?team\s+to\s+(.+)$/i.exec(
    message.trim(),
  );
  if (team) return { kind: "team_request", goal: team[1].trim() };
  const match =
    /^(?:please\s+)?(?:assign|hire)\s+(?:a\s+)?(?:specialist\s+to\s+)?(research|maintenance(?:\s+specialist)?(?:\s+to)?\s+review)\s+(.+)$/i.exec(
      message.trim(),
    );
  if (!match) return null;
  return {
    kind: "specialist_request",
    specialistKind: /^research/i.test(match[1]) ? "research" : "maintenance-manual",
    goal: match[2].trim(),
  };
}
const greeting = /^(?:hi|hello|hey|good (?:morning|afternoon|evening))[!?.\s]*$/i;
const refersToPrevious =
  /^(?:follow[ -]?up|continue|make (?:it|that)|expand (?:it|that)|shorten (?:it|that)|summarize (?:that|the previous)|use (?:the )?(?:previous|earlier|above)|based on (?:the )?(?:previous|earlier|above))\b/i;

function contribution(seat, index, total) {
  const role = (seat.roleTitle ?? "").toLowerCase();
  if (/critic|verif/.test(role))
    return "Challenge the current proposal: give one specific risk or missing check.";
  if (/planner/.test(role))
    return "Turn the findings into a short actionable plan. Do not repeat the analysis.";
  if (/analyst/.test(role))
    return "Identify the main facts and assumptions. Do not present an unverified conclusion as fact.";
  if (index === total - 1 && total > 1)
    return "Synthesize the distinct contributions into a concise answer, preserving open questions.";
  if (index === 0) return "Start with one focused answer or useful question.";
  return "Add one concrete point the earlier teammates missed. Do not rewrite their answers.";
}

/** One durable office turn. Each available seat sees earlier teammates' replies. */
export class OfficeGroupChat {
  constructor(runtime, { defaultScenarioId = "default" } = {}) {
    this.runtime = runtime;
    this.defaultScenarioId = defaultScenarioId;
    this.routing = new Set();
    this.specialistRouting = new Set();
    this.running = false;
    this.again = false;
    this.closed = false;
    this.unsubscribe = runtime.db.subscribe((event) => {
      if (event.kind === "task" || event.kind === "seat") this.schedule();
      if (
        [
          "orchestration",
          "operation.evidence",
          "operation.verification",
          "operation.reasoning",
          "composer.task",
        ].includes(event.kind)
      )
        this.bridge();
    });
  }
  messages() {
    return this.runtime.db.messages(OFFICE_GROUP_SESSION);
  }
  send(input) {
    this.runtime.estop?.assertClear();
    if (
      !input ||
      !safeTurnId(input.turnId) ||
      typeof input.message !== "string" ||
      !input.message.trim() ||
      input.message.length > 32000
    )
      throw Object.assign(new Error("A valid turn ID and message are required."), { status: 400 });
    const id = `group_user_${input.turnId}`;
    const existing = this.runtime.db.getMessage(id);
    if (existing) {
      if (existing.content !== input.message.trim())
        throw Object.assign(new Error("Turn ID already belongs to another message."), {
          status: 409,
        });
      this.schedule();
      return existing;
    }
    const pending = this.messages().find(
      (message) => message.role === "user" && message.source === "group" && !this.done(message),
    );
    if (pending)
      throw Object.assign(new Error("The office is still working on the previous turn."), {
        status: 409,
      });
    const intent =
      specialistIntent(input.message) ??
      dataIntent(input.message) ??
      classifyOfficeIntent(input.message.trim(), {
        defaultScenarioId: this.defaultScenarioId,
      });
    if (intent.kind !== "data_request") this.runtime.require("chat.send");
    let participants = (this.runtime.rosterSeats?.() ?? this.runtime.db.seats())
      .filter((seat) => {
        const owner = this.owner(seat);
        return (
          seat.assigned &&
          seat.binding?.agentId &&
          owner.seatView(owner.db.getSeat(seat.seatId) ?? seat).binding.available
        );
      })
      .map((seat) => ({
        seatId: seat.seatId,
        label: seat.label,
        roleTitle: seat.roleTitle,
        sessionKey: seat.binding.sessionKey,
        bindingRevision: seat.binding.revision,
        gatewayId: this.owner(seat).gatewayId,
      }));
    if (!participants.length && intent.kind === "ordinary")
      throw Object.assign(new Error("No available office agents are bound to seats."), {
        status: 409,
      });
    participants = selectParticipants(
      participants,
      input.message.trim(),
      officeLead(this.runtime)?.seatId,
    );
    if (intent.kind !== "ordinary") participants = [];
    const message = {
      id,
      runId: "",
      role: "user",
      source: "group",
      content: input.message.trim(),
      sessionKey: OFFICE_GROUP_SESSION,
      timestamp: new Date().toISOString(),
      groupTurnId: input.turnId,
      participants,
      ...(intent.kind !== "ordinary" ? { officeIntent: intent.kind } : {}),
    };
    this.runtime.db.saveMessage(message);
    if (intent.kind !== "ordinary") {
      this.route(message, intent);
      return message;
    }
    this.schedule();
    return message;
  }
  /** The runtime that holds a seat or a recorded participant; older turns used this runtime. */
  owner(seat) {
    if (seat.gatewayId)
      return (
        (this.runtime.peers ?? []).find((peer) => peer.gatewayId === seat.gatewayId) ?? this.runtime
      );
    return this.runtime.seatOwner?.(seat.seatId) ?? this.runtime;
  }
  done(turn) {
    if (turn.officeIntent === "data_request")
      return (
        !!this.runtime.db.getMessage(`group_bridge_${turn.groupTurnId}_report`) ||
        !!this.runtime.db.getMessage(`group_bridge_${turn.groupTurnId}_blocked`)
      );
    return turn.participants.every(
      (_, index) => !!this.runtime.db.getMessage(`group_reply_grp_${turn.groupTurnId}_${index}`),
    );
  }
  route(turn, classified) {
    if (this.routing.has(turn.groupTurnId)) return;
    this.routing.add(turn.groupTurnId);
    try {
      const intent =
        classified ??
        specialistIntent(turn.content) ??
        dataIntent(turn.content) ??
        classifyOfficeIntent(turn.content, {
          defaultScenarioId: this.defaultScenarioId,
        });
      if (intent.kind === "specialist_request") {
        void this.routeSpecialist(turn, intent);
        return;
      }
      if (intent.kind === "team_request") {
        this.routeTeam(turn, intent);
        return;
      }
      if (intent.kind === "data_request")
        return this.routeComposer(
          turn,
          intent.goal,
          purchaseOrderId(intent.goal)
            ? `Supplier delivery investigation (${purchaseOrderId(intent.goal)})`
            : "Data task",
        );
      if (intent.missing.length) {
        this.post(
          turn,
          "missing",
          `To start the inventory investigation, provide: ${intent.missing.join(", ")}.`,
        );
        return;
      }
      // Inventory work runs in the automated, verified Work pipeline; the legacy manual-step
      // investigation is never started from chat, where nobody would advance it.
      return this.routeComposer(turn, intent.submission.goal, "Inventory investigation");
    } finally {
      this.routing.delete(turn.groupTurnId);
    }
  }
  /** Start (or rejoin) the Work pipeline task for this turn and report its progress here. */
  routeComposer(turn, goal, label) {
    try {
      if (!this.runtime.composer) throw new Error("The task composer is unavailable.");
      const task = this.runtime.composer.create({
        submissionId: `group_${turn.groupTurnId}`,
        goal,
      });
      if (!this.runtime.db.record("office.groupComposer", turn.groupTurnId))
        this.runtime.db.saveRecord(
          "office.groupComposer",
          turn.groupTurnId,
          { taskId: task.id },
          0,
        );
      this.post(
        turn,
        "started",
        `${label} started · ${task.id} · status ${task.status.replaceAll("_", " ")}. Progress is reported here as it happens.\n\n[Open report](/work/${encodeURIComponent(task.id)})`,
      );
      this.bridge();
    } catch (error) {
      this.post(turn, "blocked", `${label} blocked: ${error.message}`);
    }
  }
  async routeSpecialist(turn, intent) {
    if (this.specialistRouting.has(turn.groupTurnId)) return;
    this.specialistRouting.add(turn.groupTurnId);
    try {
      if (!this.runtime.operations?.requestSpecialist)
        throw new Error("Specialist operations are unavailable.");
      const result = await this.runtime.operations.requestSpecialist({
        requestId: `group_${turn.groupTurnId}`,
        goal: intent.goal,
        kind: intent.specialistKind,
      });
      const decision = result.executionDecision;
      const routedVia = decision
        ? ` Routed to ${decision.runtime} (model provider ${decision.modelProvider}): ${decision.reason[0]}.`
        : "";
      const blockedBy = result.reason ? ` Blocked: ${result.reason}.` : "";
      this.post(
        turn,
        "specialist",
        `${result.status.toUpperCase()} · ${result.incidentId} · ${result.role}.${routedVia}${blockedBy} Open Employees to follow the assignment. Completion still requires evidence and verification.`,
        result.incidentId,
      );
    } catch (error) {
      this.post(turn, "blocked", `Specialist assignment blocked: ${error.message}`);
    } finally {
      this.specialistRouting.delete(turn.groupTurnId);
    }
  }
  /** The Team Lead splits the goal; its progress is posted back into this conversation. */
  routeTeam(turn, intent) {
    try {
      if (!this.runtime.teamLead) throw new Error("The Team Lead is unavailable.");
      const run = this.runtime.teamLead.start({
        requestId: `group_${turn.groupTurnId}`,
        goal: intent.goal,
        groupTurnId: turn.groupTurnId,
      });
      if (run.status === "planning")
        this.post(
          turn,
          "team-plan",
          `Team Lead is splitting the work into distinct assignments · open /team/${run.id}`,
        );
    } catch (error) {
      this.post(turn, "blocked", `Team run blocked: ${error.message}`);
    }
  }
  post(turn, stage, content, incidentId = null) {
    const id = `group_bridge_${turn.groupTurnId}_${stage}`;
    const existing = this.runtime.db.getMessage(id);
    if (existing && (stage !== "report" || existing.content === content)) return;
    const lead = officeLead(this.runtime);
    this.runtime.db.saveMessage({
      id,
      runId: "",
      role: "assistant",
      source: "group",
      // The office-lead seat (Alice by default) speaks for the Team Lead.
      ...(lead ? { seatId: lead.seatId } : {}),
      actorName: lead ? `${lead.label} (office lead)` : "Office lead",
      content,
      sessionKey: OFFICE_GROUP_SESSION,
      timestamp: new Date().toISOString(),
      groupTurnId: turn.groupTurnId,
      ...(incidentId ? { incidentId } : {}),
    });
  }
  bridge() {
    for (const turn of this.messages().filter((entry) =>
      ["data_request", "inventory_shortage_investigation"].includes(entry.officeIntent),
    )) {
      const link = this.runtime.db.record("office.groupComposer", turn.groupTurnId);
      if (!link || !this.runtime.composer) continue;
      const task = this.runtime.composer.get(link.taskId);
      const reportLink = `[Open report](/work/${encodeURIComponent(task.id)})`;
      // One line per real execution event, posted once each; terminal results follow below.
      for (const event of task.timeline ?? [])
        if (
          [
            "memory_recalled",
            "query_submitted",
            "query_result",
            "query_failed",
            "policy_applied",
            "analyzing",
            "reviewing",
            "memory_saved",
          ].includes(event.event)
        )
          this.post(
            turn,
            `timeline_${task.id}_${event.event}_${event.at}`,
            `${task.id} · ${event.event.replaceAll("_", " ")} · ${event.actor}\n${event.detail}`,
          );
      if (["completed", "unresolved"].includes(task.status)) {
        const report = task.report;
        const refs =
          report?.sourceReferences
            ?.map((ref) => `${ref.evidenceId} — ${ref.source} / ${ref.recordId}`)
            .join("\n") ?? "";
        this.post(
          turn,
          "report",
          `${task.status === "completed" && report?.verified ? "Verified report" : "Unverified / blocked"} · ${task.id}${sourceLine(task)}\n\n${report?.summary || task.error || "No verified deliverable was produced."}\n\n${report?.scope ?? ""}\n\n${refs}\n\n${reportLink}`,
        );
      } else if (
        ["needs_clarification", "needs_confirmation", "approval_required"].includes(task.status)
      ) {
        this.post(
          turn,
          `clarify_${task.revision}`,
          `${task.route.clarification ?? "Review the task scope before execution."}\n\n${reportLink}`,
        );
      }
    }
    for (const turn of this.messages().filter(
      (entry) => entry.officeIntent === "inventory_shortage_investigation",
    )) {
      const link = this.runtime.db.record("office.groupIncident", turn.groupTurnId);
      if (!link) continue;
      let root;
      try {
        root = investigationView(this.runtime, link.incidentId);
      } catch {
        continue;
      }
      const views = [root];
      if (root.revisedIncidentId) {
        try {
          views.push(investigationView(this.runtime, root.revisedIncidentId));
        } catch {
          /* revision not yet ready */
        }
      }
      for (const view of views) {
        if (view.evidence.length)
          this.post(
            turn,
            `evidence_${view.incidentId}`,
            `Evidence collected for ${view.incidentId}: ${view.evidence.map((item) => item.evidenceId).join(", ")}.`,
            view.incidentId,
          );
        if (view.report) {
          const { verdict, reconciliation, evidenceIds } = view.report;
          const source = view.evidence.length
            ? view.synthetic
              ? "SYNTHETIC DATA"
              : "live Zetaris"
            : "no source evidence";
          this.post(
            turn,
            `verdict_${view.report.verificationId}`,
            `${verdict.toUpperCase()} · ${view.incidentId}\nDiscrepancy: ${reconciliation?.discrepancy ?? "unknown"}; explained: ${reconciliation?.explained ?? "unknown"}; unexplained: ${reconciliation?.unexplained ?? "unknown"}.\nEvidence IDs: ${evidenceIds.length ? evidenceIds.join(", ") : "none"}. Source: ${source}.`,
            view.incidentId,
          );
        } else if (["blocked", "failed", "unresolved", "outcome_unknown"].includes(view.status)) {
          this.post(
            turn,
            `status_${view.incidentId}_${view.status}`,
            `${view.status.toUpperCase()} · ${view.incidentId}. No verified explanation is available.`,
            view.incidentId,
          );
        }
      }
    }
  }
  schedule() {
    if (this.closed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    queueMicrotask(() => {
      if (this.closed) return;
      for (const turn of this.messages().filter((entry) =>
        ["inventory_shortage_investigation", "specialist_request", "data_request"].includes(
          entry.officeIntent,
        ),
      ))
        if (
          !this.runtime.db.getMessage(`group_bridge_${turn.groupTurnId}_blocked`) &&
          !this.runtime.db.getMessage(`group_bridge_${turn.groupTurnId}_specialist`)
        )
          this.route(turn);
      this.bridge();
      void this.advance();
    });
  }
  async advance() {
    if (this.closed) return;
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    try {
      do {
        this.again = false;
        for (const turn of this.messages().filter(
          (message) =>
            message.role === "user" && message.source === "group" && !message.officeIntent,
        )) {
          for (const [index, participant] of turn.participants.entries()) {
            const taskId = `grp_${turn.groupTurnId}_${index}`;
            const replyId = `group_reply_${taskId}`;
            if (this.runtime.db.getMessage(replyId)) continue;
            // Group messages live here; the turn's task, seat and reply live with the seat owner.
            const owner = this.owner(participant);
            const task = owner.db.getTask(taskId);
            if (task && !finished.has(task.status)) return;
            if (task) {
              const content =
                task.status === "completed"
                  ? task.result ||
                    owner.db.getMessage(`assistant_${taskId}`)?.content ||
                    "Completed without a text reply."
                  : `${participant.label}: could not complete this turn (${task.status.replaceAll("_", " ")}).`;
              this.runtime.db.saveMessage({
                id: replyId,
                runId: task.runId ?? "",
                taskId,
                role: task.status === "completed" ? "assistant" : "system",
                source: "group",
                seatId: participant.seatId,
                actorName: participant.label,
                content,
                sessionKey: OFFICE_GROUP_SESSION,
                timestamp: new Date().toISOString(),
                groupTurnId: turn.groupTurnId,
              });
              continue;
            }
            const seat = owner.db.getSeat(participant.seatId);
            if (
              !seat?.assigned ||
              seat.binding?.revision !== participant.bindingRevision ||
              seat.binding?.sessionKey !== participant.sessionKey
            ) {
              this.runtime.db.saveMessage({
                id: replyId,
                runId: "",
                role: "system",
                source: "group",
                seatId: participant.seatId,
                actorName: participant.label,
                content: `${participant.label}: agent binding changed; this teammate was skipped.`,
                sessionKey: OFFICE_GROUP_SESSION,
                timestamp: new Date().toISOString(),
                groupTurnId: turn.groupTurnId,
              });
              continue;
            }
            if (!owner.seatView(seat).binding.available) {
              const waited = Date.now() - Date.parse(turn.timestamp);
              if (!(waited >= UNAVAILABLE_GRACE_MS)) {
                // Nothing else wakes this turn if the agent never returns: re-check later.
                clearTimeout(this.waitTimer);
                this.waitTimer = setTimeout(
                  () => this.schedule(),
                  Math.max(1000, UNAVAILABLE_GRACE_MS - (waited || 0)),
                );
                this.waitTimer.unref?.();
                return;
              }
              this.runtime.db.saveMessage({
                id: replyId,
                runId: "",
                role: "system",
                source: "group",
                seatId: participant.seatId,
                actorName: participant.label,
                content: `${participant.label}: agent unavailable for ${Math.round(UNAVAILABLE_GRACE_MS / 60000)} minutes; skipped this turn.`,
                sessionKey: OFFICE_GROUP_SESSION,
                timestamp: new Date().toISOString(),
                groupTurnId: turn.groupTurnId,
              });
              continue;
            }
            const history = this.messages();
            const previousTurn = refersToPrevious.test(turn.content)
              ? history
                  .filter(
                    (entry) =>
                      entry.source === "group" && entry.role === "user" && entry.id !== turn.id,
                  )
                  .at(-1)
              : null;
            const discussion = history
              .filter(
                (entry) =>
                  entry.source === "group" &&
                  ["user", "assistant"].includes(entry.role) &&
                  (entry.groupTurnId === turn.groupTurnId ||
                    entry.groupTurnId === previousTurn?.groupTurnId),
              )
              .slice(-10)
              .map(
                (entry) =>
                  `${entry.role === "user" ? "You" : entry.actorName}: ${entry.content.slice(0, 500)}`,
              )
              .join("\n\n");
            try {
              owner.submit({
                taskId,
                seatId: participant.seatId,
                sessionKey: participant.sessionKey,
                bindingRevision: participant.bindingRevision,
                message: `Office request: ${turn.content}\nYour contribution: ${contribution(seat, index, turn.participants.length)} Reply in at most 120 words. Address the request directly; skip greetings and repeated introductions.`,
                context:
                  `Office group discussion (background, not verified evidence). Share your work and build on teammates' findings. Do not claim verified success without verification.\n\n${discussion}`.slice(
                    0,
                    6000,
                  ),
              });
            } catch (error) {
              this.runtime.db.saveMessage({
                id: replyId,
                runId: "",
                role: "system",
                source: "group",
                seatId: participant.seatId,
                actorName: participant.label,
                content:
                  error.status === 409
                    ? `${participant.label}: agent is unavailable or its binding changed.`
                    : `${participant.label}: could not assign this teammate.`,
                sessionKey: OFFICE_GROUP_SESSION,
                timestamp: new Date().toISOString(),
                groupTurnId: turn.groupTurnId,
              });
              continue;
            }
            return;
          }
        }
      } while (this.again && !this.closed);
    } finally {
      this.running = false;
      if (this.again) this.schedule();
    }
  }
  close() {
    this.closed = true;
    clearTimeout(this.waitTimer);
    this.unsubscribe();
  }
}
