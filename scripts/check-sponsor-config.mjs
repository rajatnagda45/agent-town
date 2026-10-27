import { sponsorReadiness } from "../lib/server/sponsor-readiness.mjs";
const result = sponsorReadiness();
console.log(JSON.stringify(result, null, 2));
process.exitCode =
  result.nightshift.profileValid &&
  result.zetaris.profileValid &&
  result.zetaris.probeSelectValid &&
  result.nightshift.selectedForExecution &&
  result.zetaris.selectedForEvidence
    ? 0
    : 2;
