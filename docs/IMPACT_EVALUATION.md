# Impact evaluation

**Status: measurement protocol prepared; no measured productivity or accuracy improvement claimed.**

## User and problem

An operations lead must explain a stock discrepancy before approving a correction. Today they collect counts, balances and movement records, reconcile timestamps, consult a colleague, and preserve enough evidence to defend the decision. Agent Town aims to keep that review attached to durable task and source identities. A plausible answer without traceability is insufficient.

## Evidence already available

The [recorded core run](evidence/team-demo-20261027.json) contains four distinct task IDs, four events per contribution, nonempty result fingerprints, and one shared backend identity. This is one real OpenClaw run, not four independent specialists and not a sponsor investigation. The earlier observed approximately 24.2 seconds includes observation overhead; it is not a paired benchmark.

The supplied-data latency example has five values: 10, 20, 30, 40, 100 ms. Mean is 40 ms; nearest-rank P95 and P99 are 100 ms. Correct sample arithmetic does not establish production performance or decision quality.

Automated recovery, deduplication and evidence tests use isolated databases and mocked providers. Test pass counts measure regression coverage, not a production reliability percentage. No new human timing observations were collected in this mission.

## Equivalent baseline and Agent Town procedures

Use five approved, frozen, non-sensitive inventory cases: balanced stock, missing movement, duplicate movement, stale count, and ambiguous discrepancy. Mark synthetic cases as synthetic in both arms. An independent reviewer writes the expected calculation and acceptable uncertainty before either arm runs.

**Baseline:** a competent operator receives the same four sources, question and cutoff time. They may use their normal spreadsheet, calculator, search and existing chat assistant. They produce a recommendation, citations, calculations and limitations. Do not artificially disable tools or make the baseline search for files Agent Town receives automatically.

**Agent Town:** the same operator receives the same sources and objective through the reviewed investigation workflow. Record setup separately. Start timing at source/question availability, include human review and any correction, and stop only when the same required deliverable is accepted. Export the investigation record and preserve original source evidence privately.

Alternate arm order across cases to reduce learning effects. Repeat each case three times per arm (15 trials per arm), record warm/cold state, model and version, and report repeated-case learning as a limitation. Prefer multiple operators for a later study. Do not pool different datasets or hide failures.

## Raw observation template

Use the checked-in blank [impact trial template](evidence/impact-trials-template.csv), adding one row per trial. There are currently **zero collected paired trials**. Keep the template blank until a human actually performs and reviews the corresponding arm.

```csv
case_id,trial,arm,operator_alias,order,source_snapshot_id,provider_model,start_utc,end_utc,setup_seconds,review_seconds,human_steps,cited_claims,total_checkable_claims,correct,unresolved,contradictions_detected,incorrect_claims,completion_success,duplicate_dispatches,recovery_result,usefulness_rating_1_to_5,cost_if_available,notes
```

A human step is a deliberate navigation, copy, command, review or correction; document the counting method in advance. A truthful unresolved outcome on insufficient evidence can be correct. Two reviewers should independently assess correctness without seeing the arm, resolve disagreements, and retain both initial assessments.

## Calculations and reporting

- Total task time = end minus start; include failed attempts and review. Report setup separately.
- Paired time difference = baseline time minus Agent Town time for the same case/trial. Report all observations, median difference and range; compute percentage only against a nonzero paired baseline.
- Evidence coverage = valid cited claims / total checkable claims. Validate the cited source actually supports each claim.
- Completion and correctness = counts / attempted trials, with unresolved and timeout counts alongside them. Set a common timeout before testing.
- Duplicate dispatches = repeated provider executions for the same accepted task identity; distinguish a bounded intentional revision.
- Recovery = unchanged task/evidence IDs and result after reload/restart. Include at least one interrupted run and preserve `outcome_unknown` if provider completion cannot be established.

Publish only sanitized observations with consent. Small repeated samples, operator familiarity, provider drift and synthetic cases limit generalization. Do not claim customer adoption, ROI or percentage savings until this protocol produces reviewable measurements.

## Reproduction

Use [the runbook](DEMO_RUNBOOK.md) and the root README's sponsor workflow. Sponsor access, reviewed data, an operator and authorized usage are prerequisites. Existing isolated regressions can be rerun with `pnpm test`; they do not fill the human-study CSV.

## Final sprint experiment decision

No paired experiment was run. Local configuration was supplied, but both sponsor services refused connections before authentication or query execution. A human baseline against a failed or unavailable Agent Town arm would not measure the intended workflow. The recorded latency example is useful for checking arithmetic and traceability, but is too small to establish operational productivity. Keep the trial count at zero until equivalent-case inputs, reachable services, reviewed provider usage and a human operator are available.
