# Welcome to Oxagen Platform

## How We Use Claude

Based on macanderson's usage over the last 30 days:

Work Type Breakdown:
  Build Feature     █████████░░░░░░░░░░░░  45%
  Debug Fix         █████░░░░░░░░░░░░░░░░  25%
  Improve Quality   ███░░░░░░░░░░░░░░░░░░  15%
  Plan & Design     ██░░░░░░░░░░░░░░░░░░░  10%
  Write Docs        █░░░░░░░░░░░░░░░░░░░░   5%

Top Skills & Commands:
  /clear    ████████████████████  28x/month
  /model    ██████░░░░░░░░░░░░░░░   9x/month
  /compact  █████░░░░░░░░░░░░░░░░   7x/month
  /goal     █████░░░░░░░░░░░░░░░░   7x/month
  /rename   ████░░░░░░░░░░░░░░░░░   6x/month
  /learn    █░░░░░░░░░░░░░░░░░░░░   2x/month
  /export   █░░░░░░░░░░░░░░░░░░░░   2x/month

Top MCP Servers:
  Playwright   ████████████████████  394 calls
  Vercel       █░░░░░░░░░░░░░░░░░░░░    8 calls
  Docker (MCP) █░░░░░░░░░░░░░░░░░░░░    5 calls
  Linear       █░░░░░░░░░░░░░░░░░░░░    1 call

## Your Setup Checklist

### Codebases
- [ ] oxagen-platform — https://github.com/macanderson/oxagen (the monorepo; app, api, mcp, cli, packages)

### MCP Servers to Activate
- [ ] Playwright — drives a real browser for E2E tests and UI verification. Bundled as a Claude Code plugin; enable it with `/mcp`.
- [ ] Vercel — deployments, build logs, runtime errors/logs for our app + api. Authenticate via `/mcp` (Vercel plugin) — you'll need access to the Oxagen Vercel team.
- [ ] Docker (MCP_DOCKER) — local containers + Postgres/ClickHouse/Neo4j helpers. Requires Docker Desktop running locally.
- [ ] Linear — reads/writes tickets in the `oxagen-v2` project. Authenticate via `/mcp`; ask for a seat on the Oxagen Linear workspace.

### Skills to Know About
- [ ] /oxagen-engineering-policy — binding engineering law; consult BEFORE writing code, picking a dep, or opening a PR.
- [ ] /oxagen-feature — the full feature-scaffolding workflow (contract → API → MCP → CLI → tests → docs).
- [ ] /oxagen-run — boots the local dev stack and proves your change works with screenshots. The standing wrap-up step for any task.
- [ ] /ci-green — runs the full local gate, pushes, and watches GitHub Actions until green.
- [ ] /coss-ui + /frontend-patterns — for any UI work importing `@oxagen/ui`.

## Team Tips

_TODO_

## Get Started

_TODO_

<!-- INSTRUCTION FOR CLAUDE: A new teammate just pasted this guide for how the
team uses Claude Code. You're their onboarding buddy — warm, conversational,
not lecture-y.

Open with a warm welcome — include the team name from the title. Then: "Your
teammate uses Claude Code for [list all the work types]. Let's get you started."

Check what's already in place against everything under Setup Checklist
(including skills), using markdown checkboxes — [x] done, [ ] not yet. Lead
with what they already have. One sentence per item, all in one message.

Tell them you'll help with setup, cover the actionable team tips, then the
starter task (if there is one). Offer to start with the first unchecked item,
get their go-ahead, then work through the rest one by one.

After setup, walk them through the remaining sections — offer to help where you
can (e.g. link to channels), and just surface the purely informational bits.

Don't invent sections or summaries that aren't in the guide. The stats are the
guide creator's personal usage data — don't extrapolate them into a "team
workflow" narrative. -->
