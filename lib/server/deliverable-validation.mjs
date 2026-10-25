import { createHash } from "node:crypto";

const fail = (message) => Object.assign(new Error(message), { status: 400 });
const nonempty = (value, limit = 2000) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= limit;

/** The fingerprint binds a result to the canonical requirements, not a rewritten prompt. */
export const goalFingerprint = (incident) =>
  createHash("sha256")
    .update(JSON.stringify([incident.goal, incident.constraints, incident.acceptanceCriteria]))
    .digest("hex");

export const INFERENCE_VERSION = 1;
const MODES = ["exact", "max", "min"];
/** Synthesis and independent review are expected to overlap prior findings. */
export const OVERLAP_EXPECTED = new Set(["synthesis", "review"]);

const validSegments = (segments) =>
  segments === undefined ||
  (Array.isArray(segments) &&
    segments.length <= 10 &&
    segments.every(
      (item) =>
        nonempty(item?.label, 100) &&
        Number.isSafeInteger(item.minutes) &&
        item.minutes >= 1 &&
        item.minutes <= 1440,
    ));

export function validateDeliverables(tasks) {
  const owners = new Set();
  for (const task of tasks) {
    const spec = task.deliverable;
    if (spec === undefined) continue; // Existing persisted Phase 3 contracts remain valid.
    if (
      !spec ||
      !nonempty(spec.id, 128) ||
      !nonempty(spec.description) ||
      !["report", "research", "agenda", "synthesis", "review"].includes(spec.kind) ||
      (spec.duplicateReason !== undefined && !nonempty(spec.duplicateReason, 500)) ||
      (spec.kind === "agenda" &&
        (!Number.isSafeInteger(spec.minutes) ||
          spec.minutes < 1 ||
          spec.minutes > 1440 ||
          (spec.mode !== undefined && !MODES.includes(spec.mode)) ||
          !validSegments(spec.requiredSegments)))
    )
      throw fail("Invalid deliverable specification.");
    const key = spec.id.trim().toLowerCase();
    if (owners.has(key) && !spec.duplicateReason)
      throw fail("Duplicate deliverable requires an explicit independent contribution reason.");
    owners.add(key);
  }
}

/** A completed model call is not a verified deliverable. No model-supplied verdict is trusted. */
export function validateWorkerResult({ incident, deliverable, result, evidence = [] }) {
  const issues = [];
  let value;
  try {
    value = JSON.parse(result);
  } catch {
    return { pass: false, issues: ["Worker result must be a JSON object."] };
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { pass: false, issues: ["Worker result must be a JSON object."] };
  if (value.goalFingerprint !== goalFingerprint(incident)) issues.push("Canonical goal changed.");
  if (value.deliverableId !== deliverable.id) issues.push("Result claims another deliverable.");
  if (value.status !== "completed") issues.push("Worker reports an incomplete outcome.");
  if (!nonempty(value.content, 16000)) issues.push("Deliverable content is missing.");
  if (
    !Array.isArray(value.uncertainty) ||
    value.uncertainty.length > 20 ||
    !value.uncertainty.every((item) => nonempty(item, 1000))
  )
    issues.push("Explicit uncertainty is required.");
  const cited = value.evidenceIds;
  const validEvidence = evidence.filter(
    (item) =>
      item.incidentId === incident.incidentId &&
      nonempty(item.source) &&
      nonempty(item.recordId) &&
      Number.isFinite(Date.parse(item.sourceTimestamp)) &&
      (!item.freshUntil || Date.parse(item.freshUntil) > Date.now()),
  );
  if (
    !Array.isArray(cited) ||
    cited.length > 40 ||
    new Set(cited).size !== cited.length ||
    cited.some((id) => !validEvidence.some((item) => item.evidenceId === id))
  )
    issues.push("Citations must reference current, source-linked evidence supplied to this task.");
  if (deliverable.kind === "research" && (!Array.isArray(cited) || !cited.length))
    issues.push("Research needs source-linked evidence; generated citations are insufficient.");
  if (deliverable.kind === "agenda") {
    const agenda = value.agenda;
    if (
      !Array.isArray(agenda) ||
      !agenda.length ||
      agenda.length > 100 ||
      agenda.some(
        (item) =>
          !nonempty(item?.title, 200) || !Number.isSafeInteger(item.minutes) || item.minutes <= 0,
      )
    )
      issues.push("Agenda must contain named sections with positive integer minutes.");
    else {
      const total = agenda.reduce((sum, item) => sum + item.minutes, 0);
      const mode = deliverable.mode ?? "exact";
      const limit = deliverable.minutes;
      if (!Number.isSafeInteger(total) || (mode === "exact" && total !== limit))
        issues.push(`Agenda totals ${total} minutes; required ${limit}.`);
      else if (mode === "max" && total > limit)
        issues.push(`Agenda totals ${total} minutes; maximum ${limit}.`);
      else if (mode === "min" && total < limit)
        issues.push(`Agenda totals ${total} minutes; minimum ${limit}.`);
      for (const segment of deliverable.requiredSegments ?? [])
        if (
          !agenda.some(
            (item) =>
              normalize(item.title).includes(normalize(segment.label)) &&
              item.minutes === segment.minutes,
          )
        )
          issues.push(`Agenda needs a ${segment.minutes}-minute ${segment.label} section.`);
    }
  }
  return {
    pass: issues.length === 0,
    issues,
    resultHash: createHash("sha256").update(result).digest("hex"),
    scope: "Local deliverable structure and arithmetic only; external claims remain unverified.",
  };
}

export function workerRequirements(incident, child) {
  // The exact object to return, with real values: placeholders inside a JSON block were
  // echoed back verbatim by a live model instead of being filled in.
  const shape = {
    goalFingerprint: goalFingerprint(incident),
    deliverableId: child.deliverable.id,
    status: "completed",
    content: "your complete contribution as plain text",
    evidenceIds: [],
    uncertainty: ["each claim you could not verify"],
    ...(child.deliverable.kind === "agenda" ? { agenda: [{ title: "section", minutes: 5 }] } : {}),
  };
  return `${JSON.stringify({
    originalGoal: incident.goal,
    constraints: incident.constraints,
    acceptanceCriteria: incident.acceptanceCriteria,
    dependencies: child.dependsOn,
    deliverable: child.deliverable,
  })}\nReturn ONLY one JSON object shaped exactly like ${JSON.stringify(shape)}. Keep goalFingerprint and deliverableId exactly as given, put your work in content, list only evidence IDs supplied to you (or none), and do not echo this assignment.`;
}

const normalize = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9&]+/g, " ")
    .trim();

const NUMBER_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  ten: 10,
  fifteen: 15,
  twenty: 20,
  thirty: 30,
  forty: 40,
  "forty-five": 45,
  sixty: 60,
  ninety: 90,
};
const DURATION =
  /\b(?:(\d{1,4}|one|two|three|four|five|ten|fifteen|twenty|thirty|forty-five|forty|sixty|ninety)\s*-?\s*(min(?:ute)?s?|hours?|hrs?)\b|(half)[\s-]an?[\s-]?hour|(half)[\s-]hour|an?\s+(hour)\b)/gi;
const AGENDA =
  /\b(agenda|demo|demonstration|presentation|talk|meeting|session|workshop|walkthrough|pitch|schedule|run[- ]?of[- ]?show|standup|stand-up|webinar|lecture)\b/i;
const MAX_BEFORE =
  /\b(under|less than|at most|no more than|within|up to|max(?:imum)?(?: of)?|not (?:to )?exceed(?:ing)?|no longer than|shorter than)\s*(?:a|an)?\s*$/i;
const MAX_AFTER = /^\s*(?:or less|or fewer|max(?:imum)?|tops|at most)\b/i;
const MIN_BEFORE =
  /\b(at least|minimum(?: of)?|no less than|no shorter than|more than)\s*(?:a|an)?\s*$/i;
const MIN_AFTER = /^\s*(?:or more|minimum|at least)\b/i;
const SEGMENT_BEFORE =
  /\b(?:with|including|plus|and|includes|followed by|then|leaving|reserve|reserving|allow(?:ing)?|for)\s+(?:a|an|the)?\s*$/i;
const SEGMENT_AFTER =
  /^\s*-?\s*(?:long\s+)?(?:(?:for|of)\s+(?:the\s+)?)?(q\s*&\s*a|q and a|questions?|break|intro(?:duction)?|wrap[- ]?up|recap|closing|opening|setup|demo segment|live demo|overview|discussion|buffer|summary)\b/i;

function durations(text) {
  const found = [];
  for (const match of text.matchAll(DURATION)) {
    let minutes;
    if (match[3] || match[4]) minutes = 30;
    else if (match[5]) minutes = 60;
    else {
      const amount = /^\d+$/.test(match[1])
        ? Number(match[1])
        : NUMBER_WORDS[match[1].toLowerCase()];
      minutes = /^h/i.test(match[2]) ? amount * 60 : amount;
    }
    const before = text.slice(Math.max(0, match.index - 40), match.index);
    const after = text.slice(match.index + match[0].length, match.index + match[0].length + 40);
    const segment = SEGMENT_AFTER.exec(after);
    found.push({
      minutes,
      mode:
        MAX_BEFORE.test(before) || MAX_AFTER.test(after)
          ? "max"
          : MIN_BEFORE.test(before) || MIN_AFTER.test(after)
            ? "min"
            : "exact",
      // A segment is a named part inside the total ("with a 5-minute Q&A").
      segment: segment && SEGMENT_BEFORE.test(before) ? segment[1] : null,
    });
  }
  return found;
}

/** Deterministic, versioned contract inference from the user's own words. It never guesses:
 * conflicting totals or impossible segments produce a clarification question instead.
 * @param {string} goal @param {string[]} [constraints] */
export function inferDeliverable(goal, constraints = []) {
  const text = [goal, ...constraints].join("\n");
  const found = durations(text);
  if (!found.length || !AGENDA.test(text)) return { deliverable: null, clarification: null };
  const totals = found.filter((item) => !item.segment);
  const values = [...new Set(totals.map((item) => `${item.minutes}:${item.mode}`))];
  if (values.length !== 1)
    return {
      deliverable: null,
      clarification: totals.length
        ? `The request mentions ${[...new Set(totals.map((item) => `${item.minutes} minutes`))].join(" and ")}. Which one is the total length, and is it exact or a maximum?`
        : "The request names only segment durations. What is the total length, and is it exact or a maximum?",
    };
  const total = totals[0];
  const requiredSegments = found
    .filter((item) => item.segment)
    .map((item) => ({ label: item.segment.replace(/\s+/g, " "), minutes: item.minutes }));
  const reserved = requiredSegments.reduce((sum, item) => sum + item.minutes, 0);
  if (total.mode !== "min" && reserved > total.minutes)
    return {
      deliverable: null,
      clarification: `The named segments total ${reserved} minutes, more than the ${total.minutes}-minute limit. Which should change?`,
    };
  return {
    deliverable: {
      id: "primary",
      description: goal.trim().slice(0, 2000),
      kind: "agenda",
      minutes: total.minutes,
      mode: total.mode,
      ...(requiredSegments.length ? { requiredSegments } : {}),
    },
    clarification: null,
  };
}

/** True when a caller-supplied contract would accept a result the user's words forbid. */
export function weakensContract(caller, inferred) {
  if (!inferred) return false;
  if (caller?.kind !== "agenda" || !Number.isSafeInteger(caller.minutes)) return true;
  const mode = caller.mode ?? "exact";
  const within =
    inferred.mode === "exact"
      ? mode === "exact" && caller.minutes === inferred.minutes
      : inferred.mode === "max"
        ? ["exact", "max"].includes(mode) && caller.minutes <= inferred.minutes
        : ["exact", "min"].includes(mode) && caller.minutes >= inferred.minutes;
  const segments = (inferred.requiredSegments ?? []).every((need) =>
    (caller.requiredSegments ?? []).some(
      (item) => normalize(item.label) === normalize(need.label) && item.minutes === need.minutes,
    ),
  );
  return !within || !segments;
}

/** Quoted phrases and multi-word proper names from the goal. A missing term is a review
 * signal only: mentioning a name does not prove relevance, and paraphrase is legitimate. */
export function topicTerms(goal) {
  const quoted = [...goal.matchAll(/["“]([^"”]{3,60})["”]/g)].map((m) => m[1].trim());
  const names = [...goal.matchAll(/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)+)\b/g)].map(
    (m) => m[1],
  );
  return [...new Set([...quoted, ...names])].slice(0, 8);
}

const shingles = (text) => {
  const words = normalize(text).split(" ").filter(Boolean);
  const set = new Set();
  for (let i = 0; i + 3 <= words.length; i++) set.add(words.slice(i, i + 3).join(" "));
  return set;
};

export function contentSimilarity(a, b) {
  const left = shingles(a);
  const right = shingles(b);
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const item of left) if (right.has(item)) shared++;
  return shared / (left.size + right.size - shared);
}

/** Warnings for the Critic and the Lead, never an automatic pass or rejection. */
export function reviewSignals({
  goal,
  content,
  agendaTitles = [],
  siblings = [],
  threshold = 0.8,
}) {
  const haystack = normalize([content, ...agendaTitles].join(" "));
  const missingTopicTerms = topicTerms(goal).filter((term) => !haystack.includes(normalize(term)));
  const similarTo = siblings
    .map((item) => ({
      deliverableId: item.deliverableId,
      similarity: contentSimilarity(content, item.content),
    }))
    .filter((item) => item.similarity >= threshold)
    .map((item) => ({ ...item, similarity: Math.round(item.similarity * 100) / 100 }));
  return {
    missingTopicTerms,
    similarTo,
    note: "Signals inform review; they neither prove nor disprove relevance.",
  };
}
