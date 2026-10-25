import { createHash } from "node:crypto";

/** Reviewed, task-scoped instructions. These do not install code or grant tools. */
const skills = [
  {
    id: "equipment-manual-review",
    version: "1.0.0",
    source: "builtin-reviewed",
    provider: "openclaw",
    manifestIds: ["maintenance-specialist"],
    capabilities: ["interpret_equipment_manual"],
    tools: [],
    instructions:
      "Review only the equipment manual passages and maintenance evidence supplied with this task. Cite the supplied source IDs and page or section where available. Separate observed facts from suggested checks. Do not operate equipment, change controls, or claim that a repair succeeded without verified evidence.",
  },
];

export const REVIEWED_SPECIALIST_SKILLS = Object.freeze(
  skills.map((skill) =>
    Object.freeze({
      ...skill,
      digest: createHash("sha256").update(skill.instructions).digest("hex"),
    }),
  ),
);

export function reviewedSkill(id, manifestId, provider) {
  return REVIEWED_SPECIALIST_SKILLS.find(
    (skill) =>
      skill.id === id && skill.manifestIds.includes(manifestId) && skill.provider === provider,
  );
}
