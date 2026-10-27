# Agent Town — slide content

Eight-slide content and visual direction, not a finished slide deck. Use a dark background, warm gold accents and the existing product screenshots. One message per slide; keep evidence readable. Use the actual final check results in the scorecard rather than copying stale numbers.

## 1. An answer still needs a review

**Engineering and operations leads need to know what ran, what supports it, and what remains uncertain.**

Show a short flow: request → scattered responses → manual evidence review. Explain the concrete release or inventory decision. Do not claim market size or customer adoption without research.

Speaker: “Our target is the handoff between receiving an AI answer and making a decision someone can defend.”

## 2. One place to delegate, inspect and return

**Agent Town connects an approachable office to durable agent work.**

Visual: [office screenshot](images/agent-town-office.png). Three labels only: find a teammate, start a task, inspect its record.

Speaker: “The spatial office is the entry point. The persisted execution record is the operational foundation.”

## 3. Follow one real task

**Question → actual execution → recorded result → reload.**

Visual: [task inspector](images/agent-town-task-inspector.png). Show supplied samples and the 40 ms mean, 100 ms nearest-rank P95/P99. Mark this as a recorded supplied-data example.

Speaker: “These five observations support the calculation, not a production reliability claim. The original request and task identity remain inspectable.”

## 4. Commit work before displaying progress

**SQLite records task identities and lifecycle; SSE brings committed state to the UI.**

Diagram: office/chat → custom Node runtime → SQLite; runtime → configured provider; approved Zetaris reads → frozen evidence → critique and deterministic checks → saved verdict.

Speaker: “Source grants and bounded roles constrain execution. Unknown outcomes remain unknown; a retry must not silently duplicate work.”

## 5. Sponsor contributions with an explicit acceptance gate

**Zetaris supplies approved evidence; Meterless supplies configured specialist execution.**

Two columns: source IDs/timestamps and role/task/provider audit. Today label both combined-live columns **BLOCKED**. Show only actual evidence after the gate passes. Local memory is scoped SQLite reuse, not a claim of operating the full hosted H-MEM service.

Speaker: “Adapters and mocked contract tests are implemented. The Mac has local configuration, but both sponsor services are unreachable. Combined live acceptance remains blocked.”

## 6. Measure review quality, not animation

**Next measurement: same case, same sources, manual workflow versus Agent Town.**

Display “0 paired human trials collected.” Protocol: five cases, three repeats per arm; elapsed review time, correct/uncertain decisions, valid citations, duplicate dispatches, restart recovery. Link [methodology](IMPACT_EVALUATION.md).

Speaker: “The existing core run establishes persisted execution. It does not establish a productivity percentage. We have a reproducible protocol to test that claim.”

## 7. A reviewable deliverable beyond the conversation

**Keep the result attached to its execution and evidence references.**

Visual: task inspector beside an investigation record excerpt using approved or explicitly synthetic data. Call out verification scope, unresolved verdict, source references and unexecuted actions.

Speaker: “The export gives a reviewer a portable index. It is editable, excludes raw source rows, and is not an authenticity certificate or substitute for the original provider audit.”

## 8. What is ready, and what comes next

**Core execution and local checks are demonstrated; sponsor acceptance and user impact remain the gates.**

Three next steps: complete the approved sponsor case; run the paired evaluation; capture and publish the final video and deck after review. Disclose pre-existing office work and identify the actual build-window additions.

Speaker: “We are optimizing for a decision the user can inspect and recover. We will keep limitations visible as the evidence improves.”

## Export specification and final on-slide copy

Export remains pending: this environment does not expose a presentation authoring session or the required presentation export runtime. No PPTX/PDF deck is claimed. The following copy is ready to place into eight 16:9 slides; use the speaker notes above, 36–44 pt headings, at least 22 pt body text, and the existing dark/gold visual direction.

| Slide | On-slide headline                          | On-slide supporting copy                                                                                                            | Visual / evidence label                                       |
| ----- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 1     | Can you defend the answer?                 | Who ran the task? Which facts support it? What remains unknown?                                                                     | One release-review question; no market or ROI claim           |
| 2     | Delegate. Inspect. Return.                 | An office for finding teammates. A ledger for reviewing their work.                                                                 | Actual office screenshot                                      |
| 3     | One request, one inspectable record        | Supplied samples: 10, 20, 30, 40, 100 ms. Mean: 40 ms. Nearest-rank P95/P99: 100 ms. Five samples are not a production benchmark.   | Recorded real task inspector, clearly labelled                |
| 4     | State survives the browser                 | Commit task identity → execute through configured provider → persist events and result → review after reload.                       | Native boxes and arrows; no independent-agent claim           |
| 5     | Evidence and execution have separate gates | Zetaris: approved reads and provenance. Meterless: bounded role execution. Combined live acceptance: BLOCKED.                       | Show current status; no mock screenshot labelled live         |
| 6     | Impact is a hypothesis to test             | Same case, same sources, same review standard. Time, correctness, citations and recovery. Paired trials collected: 0.               | Measurement protocol; no invented bar chart                   |
| 7     | Take the review record with you            | Task identity. Source references. Verification scope. Actions actually executed. Editable local snapshot, not a signed certificate. | Export screenshot labelled mocked proposal, not sponsor proof |
| 8     | Next: prove the complete decision          | Connect services. Validate one combined case. Measure the paired workflow. Record and review the final submission.                  | Working core / open gates; disclose pre-existing components   |

Export quality checks: embed screenshots, retain source notes, remove private material, open the exported file in a second viewer, inspect all eight slides for clipping, and rehearse at 2:45. Put the official event URL in notes on the sponsor and closing slides; link the repository's evidence and impact methodology on the corresponding slides. Do not include the engineering self-score as an achievement badge.
