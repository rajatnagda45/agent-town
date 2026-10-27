# Demo runbook

Use one local server and retain its SQLite database. Fresh clones do not include the owner's private recorded tasks. Do not reset a real database to prepare a demo.

## Install and launch

```sh
node --version
pnpm --version
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Node must satisfy `package.json`; pnpm is 10.20.0. Configure ignored `.env.local` before building because provider selection is also exposed as a non-secret build setting. Development uses `pnpm dev`, not `pnpm dev:next`, which omits the custom runtime. Open `/app` and `/app/chat` on the configured local port (default 3000).

Names only: core OpenClaw setup uses `AGENT_PROVIDER`, `GATEWAY_URL` and optionally `GATEWAY_TOKEN`. Set `OPENCLAW_PROTOCOL_MODULE` to the installed protocol module when automatic discovery is unavailable. Local overrides are `PORT` and `AGENT_TOWN_DB_PATH`. Sponsor configuration is documented in the root [environment template](../.env.example). Optional voice uses `GEMINI_API_KEY`; voice is outside the core recording path. No secret belongs in a `NEXT_PUBLIC_` variable.

## Preflight without model execution

```sh
pnpm contracts:check
pnpm sponsors:config
pnpm nightshift:check
node --env-file-if-exists=.env.local scripts/check-zetaris.mjs
node scripts/check-team-demo.mjs --turn release_audit_20261027
```

Run only probes relevant to the configured provider. Zetaris executes the configured approved read-only SELECT. On this Mac, configuration is now present, but both sponsor endpoints refuse connections and Zetaris evidence mode is not selected. `sponsors:config` validates offline structure and selection; it cannot establish live access. The final command reads an existing group turn from the running local server; it does not create a new run. A fresh clone should use the checked-in sanitized evidence instead of expecting this turn to exist.

## Deterministic question and expected checkpoints

For an authorized fresh core run, select an available teammate and submit:

> Using only these latency samples in milliseconds: 10, 20, 30, 40, 100, compute the arithmetic mean and nearest-rank P95 and P99. Show the arithmetic, explain the limitation of five samples, and do not infer production reliability. Do not use tools or change external data.

Expected facts are deterministic, although provider wording and timing vary: sum 200, count 5, mean 40; ranks ceil(0.95×5) and ceil(0.99×5) both 5, value 100. Record the actual task ID and backend binding. Inspect the original question, recorded lifecycle and result. Reload and verify the same ID and result. Do not describe model output as independently verified merely because the task completed.

A fresh group run can be requested with `node scripts/check-team-demo.mjs --run --turn YOUR_UNIQUE_DEMO_ID`, **only after authorization for provider usage**. Reinspect the same ID without `--run` if the response is interrupted.

For the stronger sponsor demonstration, run one approved inventory case using the reviewed Nightshift roles and Zetaris mappings, retaining the source cutoff, context bindings, and actual audits. In Operations, download the selected investigation record and compare its task ID, status, verdict, and verification scope with the UI. The download is local and performs no new provider work.

## Recovery

| Failure                           | Response                                                                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Server unavailable                | Confirm custom server, port and one process per database; restart using the same DB path                              |
| Disconnected gateway              | Inspect connection diagnostics and credentials locally; do not expose tokens on camera                                |
| Specialist readiness unavailable  | Show the setup explanation; review role bindings and source grants; do not call the group run independent specialists |
| Stale/missing evidence            | Preserve unresolved verdict; obtain approved fresh evidence and use the supported bounded revision                    |
| Interrupted provider call         | Inspect original task; do not automatically retry an uncertain execution                                              |
| No historical task after clone    | Use checked-in evidence labelled historical, or authorize a new run; never import the private DB into Git             |
| Voice failure                     | Read diagnostic code and phase; return to text; do not claim physical playback from received PCM                      |
| Dependency or browser check fails | Preserve log and diagnose before recording; do not suppress error overlays                                            |

## Local release verification

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm phase3:check
node scripts/package-release.mjs
node scripts/check-release-archive.mjs
pnpm audit --audit-level=high
```

Browser checks require installed Chrome; set `PUPPETEER_EXECUTABLE_PATH` if necessary. They use isolated databases and mocked gateway/voice transports, not paid sponsor services. Packaging writes local artifacts in the sibling `artifacts` directory and does not publish. Run with local socket/browser permission where a sandbox restricts them.

## Screens to capture

1. Office overview (existing `images/agent-town-office.png`).
2. Real request, response and task inspector (existing `images/agent-town-task-inspector.png`).
3. Same task ID after reload, captured during rehearsal.
4. Actual accepted sponsor source/provider audit and verdict, only when available.
5. Downloaded investigation record matched to its UI, using approved data.

Existing PNGs show prior real application states. New mocked release screenshots are regression artifacts and must be labelled as such. No public recording or deployment was created by this mission.

## Evidence package

Before recording, open the sanitized [demo evidence manifest](evidence/demo-manifest-20261027.json). It indexes the real latency task and the supporting Office Group turn without copying the private database or raw provider payloads.

After recording, add the public video URL only after all of these checks pass:

1. Duration is between one and four minutes.
2. A signed-out browser can open the link without requesting access.
3. The visible task and provider claims match the manifest or a newer sanitized receipt.
4. Tokens, local paths, private conversations, desktop notifications and account details are absent.
5. Any synthetic dataset, historical run, fallback, mock, or edited wait is labeled on screen.
6. The README placeholder and submission form use the same reviewed URL.
