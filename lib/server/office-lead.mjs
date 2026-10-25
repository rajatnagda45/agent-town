// The office lead is a seat (Alice by default) that fronts the server-side Team Lead: it speaks
// the lead's decisions in the group chat, keeps the run ledger and knows every agent's reviewed
// abilities and limits. Assignment and transfer decisions stay validated server code.
export const DEFAULT_OFFICE_LEAD_SEAT = "seat-0";
const LEDGER_LIMIT = 60;

const unique = (values) => [...new Set(values)];

/** The assigned lead seat, or null when it is unassigned. */
export function officeLead(runtime) {
  const seatId = runtime.officeLeadSeatId;
  if (!seatId) return null;
  const seat = (runtime.rosterSeats?.() ?? []).find(
    (item) => item.seatId === seatId && item.assigned,
  );
  return seat ? { seatId: seat.seatId, label: seat.label } : null;
}

/** Every office agent's runtime, reviewed specialties, tools, limits and current availability. */
export function agentDirectory(runtime) {
  const operations = runtime.operations;
  const registries = operations?.routed
    ? operations.routing.options.map((option) => option.registry)
    : operations?.registry
      ? [operations.registry]
      : [];
  return (runtime.rosterSeats?.() ?? [])
    .filter((seat) => seat.assigned)
    .map((seat) => {
      const owner = runtime.seatOwner?.(seat.seatId) ?? runtime;
      const manifests = registries
        .filter((registry) => registry.runtime === owner)
        .flatMap((registry) =>
          registry.catalogue
            .filter(({ manifest }) =>
              registry.grantsFor(manifest.id).some((grant) => grant.seatId === seat.seatId),
            )
            .map(({ manifest }) => manifest),
        );
      const provider = owner.gateway.provider;
      const available = seat.binding?.available === true;
      const limitations = [];
      if (!available) limitations.push("Unavailable: its backend agent is not verified right now.");
      if (provider === "nightshift") limitations.push("Text reasoning only; makes no tool calls.");
      if (!manifests.length)
        limitations.push("General teammate; no reviewed specialist role or tool grant.");
      for (const manifest of manifests) {
        if (manifest.permissions.sensitiveWrites !== "denied")
          limitations.push(`${manifest.id}: sensitive writes need approval.`);
        limitations.push(
          `${manifest.id}: at most ${manifest.limits.maxToolCalls} tool calls and ${manifest.limits.maxRuntimeSeconds}s per task.`,
        );
      }
      return {
        seatId: seat.seatId,
        name: seat.label,
        role: seat.roleTitle || "Agent",
        runtime: provider,
        available,
        isLead: seat.seatId === runtime.officeLeadSeatId,
        specialties: manifests.map((manifest) => manifest.id),
        capabilities: unique(manifests.flatMap((manifest) => manifest.capabilities)),
        tools: unique(manifests.flatMap((manifest) => manifest.tools)),
        limitations,
      };
    });
}

/** Compact directory text for the lead's planning prompt. */
export function directoryBrief(directory) {
  return directory
    .filter((agent) => !agent.isLead)
    .map(
      (agent) =>
        `${agent.name} (${agent.role}, ${agent.runtime}${agent.available ? "" : ", unavailable"})${agent.capabilities.length ? ` can: ${agent.capabilities.join(", ")}` : ""}${agent.tools.length ? `; tools: ${agent.tools.join(", ")}` : ""}${agent.limitations.length ? `; limits: ${agent.limitations.join(" ")}` : ""}`,
    )
    .join("\n")
    .slice(0, 3000);
}

/** Append one bounded ledger entry to a team run. */
export function ledgerEntry(run, event, detail, at) {
  return [...(run.ledger ?? []), { at, event, detail: String(detail).slice(0, 600) }].slice(
    -LEDGER_LIMIT,
  );
}
