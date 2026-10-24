# Contributing to Agent Town

Thanks for your interest in contributing. Agent Town mixes React/Next.js with a Phaser game layer and a real-time AI agent backend, so the best contributions are focused and easy to verify in the running game.

Engineers, designers, level designers, and game designers are all equally welcome.

## Repository

[https://github.com/rajatnagda45/agent-town](https://github.com/rajatnagda45/agent-town)

## Setup

```bash
git clone https://github.com/rajatnagda45/agent-town.git
cd agent-town
pnpm install
pnpm dev
```

You'll need **Node.js 22.19.0 or newer** and **pnpm**. Node 22 is the project baseline; `.nvmrc`, `.node-version`, and CI select the 22.x release line. For live agent execution, start a running [OpenClaw](https://github.com/openclaw-dev/openclaw) gateway using the Node version required by that separate installation and configure its URL and token on the Agent Town server.

## Ground Rules

- Open an issue first for large features or architecture changes.
- One concern per PR. Don't mix unrelated changes.
- Include a screenshot or short recording for anything visual.
- Run `pnpm build` and `pnpm typecheck` before submitting.
- Use Node 22 and `pnpm release:check` for a local release package. The serial gate runs formatting, lint, type checks, unit tests, production build, packaged startup, and mocked browser checks. Packages, validation receipts, checksums, and screenshots are saved under `../artifacts/`; this command does not publish or change the version.
- Paid live voice checks are excluded from CI. They require the explicit `AGENT_TOWN_ALLOW_PAID_VOICE_TESTS=1` opt-in and `pnpm voice:check:live`; ordinary release checks use dummy credentials and a mocked provider.

## Design Principles

Agent Town's core experience lives in the game world, not in forms and modals.

- Tasks should feel **spatial**, not abstract.
- Worker behavior should be **readable at a glance** — no need to open a panel to understand what an agent is doing.
- **In-world interaction over hidden menus** — walk up, press E, give a task.
- New UI must match the **pixel HUD style** (see `components/hud/hud.css`).
- New scenes should **expand the world** — don't turn the game into a settings page.

## Good Places to Start

| Area                  | Examples                                                      |
| --------------------- | ------------------------------------------------------------- |
| **Gameplay feel**     | Walk-up interaction polish, camera behavior, task dialogue UX |
| **Scene design**      | New office layouts, POI placement, decorative props           |
| **Worker AI**         | Pathfinding quality, idle animation variety, emotion system   |
| **Observability HUD** | Agent detail panel, task timeline, metrics visualization      |
| **Performance**       | Render batching, WebSocket message coalescing, state updates  |
| **Bug fixes**         | Include repro steps in the PR description                     |

## For Designers

You don't need to write TypeScript. Useful contributions include:

- Interaction proposals and scene flow mockups
- Level layouts in Tiled Map Editor (export as JSON to `public/maps/`)
- POI placement ideas and idle activity sets
- Economy and progression concepts for the marketplace expansion

Open an issue or start a discussion before anyone writes code — these conversations shape the game significantly.

## Pull Requests

Every PR description should answer three questions:

1. **What changed?** — a plain-language summary
2. **Why?** — the motivation or problem being solved
3. **How to verify?** — steps a reviewer can follow to confirm it works

## Commit Messages

```
<type>(<scope>): <subject>
```

Types: `feat`, `fix`, `docs`, `refactor`, `perf`, `test`, `chore`

Examples:

```
feat(worker): add confused emote when task fails
fix(gateway): handle stale hello-ok after reconnect
perf(scene): batch tilemap redraws on seat status change
```

## Code Style

- TypeScript throughout — no `any` without a comment explaining why.
- Phaser scene logic and React UI stay strictly separated (bridge via `GameEventBus`).
- Explicit state transitions over hidden side effects.
- Constants over magic numbers — add to `lib/constants.ts`.
- No global mutable state — no `window.*` assignments.
- Sensitive data (tokens, API keys, tool inputs/outputs) must never appear in logs or UI.
