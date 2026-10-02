# @oxagen/cli

The governance-operations CLI for the Oxagen control plane: spend ceilings and
cost, run traces, knowledge-graph grounding, agent memory,
environments, the credential vault, and audit logs — from the terminal.

Oxagen **governs, grounds, explains, meters/bills and rates** agents; it does
not run them ([ADR-043](../../docs/adr/ADR-043-runtime-excision.md)). The
interactive coding agent this CLI used to ship — the REPL, sandboxes, skills,
slash commands, evals, local rules and settings — is gone. Stella owns all
things agentic: use the `stella` CLI with the oxagen MCP server. Every removed
entry point stays registered as a stub that prints exactly that, so a stale
script fails with guidance instead of an unknown-command error.

Full reference: **https://docs.oxagen.sh/docs/cli**

## Boundary

- **Owns:** the `oxagen` command tree (`src/program.ts`), the browser login
  with PKCE and a loopback listener (`src/auth/`), the local config and
  workspace binding (`src/lib/config.ts`, `.oxagen/workspace.json`), the HTTP
  client for the platform API (`src/lib/api.ts`), output formatting, the
  retirement stubs for the former coding-agent commands, and anonymous usage
  telemetry (`src/telemetry/usage.ts`).
- **Does not own:** any capability logic. Every command that reads or changes
  platform state calls [`apps/api`](../api/README.md) over HTTP, and the
  kernel runs there. It also does not own the work behind the machine
  commands (`oxagen agent enroll`, `oxagen agent run`, `oxagen hook`,
  `oxagen daemon`, and the rest), which lives in
  [`@oxagen/recorder`](../../packages/tacho/README.md) (`@oxagen/recorder/cli`),
  the steering freshness check
  ([`@oxagen/steering-freshness`](../../packages/steering-freshness/README.md)),
  or the consent page it opens (`/cli/authorize` in
  [`apps/app`](../app/README.md)).
- **Depends on:** `@oxagen/recorder` (the machine commands under
  `oxagen agent`, and the hidden ones the hooks and the service run),
  `@oxagen/steering-freshness` (`oxagen steering`),
  and `@oxagen/billing` (`formatUsd` and the rate card from
  `@oxagen/billing/rate-card`, for display).
- **Used by:** no workspace package imports it. It is published as the
  `oxagen` binary.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| Platform API client (`/v1/{org}/{workspace}/…`, `/v1/user/…`, bearer token) | boundary | `apps/cli/src/lib/api.ts` | Commands in `apps/cli/src/commands/`. Served by `apps/api/src/app.ts` |
| Browser login (`/cli/authorize`, then `POST /v1/auth/cli/token`) | boundary | `apps/cli/src/auth/loopback-login.ts`, `pkce.ts` | `oxagen login` |
| `CliDeps` from `defaultCliDeps` | adapter | `apps/cli/src/commands/tacho.ts` | `oxagen agent enroll`, `status`, `reassign`, `unenroll`, `export`, `verify`, `hosts`, `run`, and `detect`, and the hidden alias group that keeps the older spelling. The work lives in `@oxagen/recorder/cli` |
| Machine command dispatch | adapter | `apps/cli/src/index.ts`, `apps/cli/src/machine/` | `oxagen hook`, `daemon`, `mcp-stdio`, `credential`, `github`, and `arp`, which go straight to the recorder before the command tree loads. Hidden from `oxagen --help` |
| `evaluateGate`, `renderGate`, `installHook` | adapter | `apps/cli/src/commands/steering.ts` | `oxagen steering …`, and each harness's prompt-submit hook |
| Usage telemetry (`POST /v1/telemetry/usage`) | boundary | `apps/cli/src/telemetry/usage.ts` | Every command, unless `oxagen telemetry off` or `DO_NOT_TRACK=1` |
| Retired command stubs | registry | `apps/cli/src/commands/retired.ts` | `apps/cli/src/program.ts` |

The CLI bootstraps no kernel gate and registers no handler. Contracts that
declare the `cli` surface are served through the API, and
`pnpm check:manifest` counts the `cli` layer as met when a command file exists
for the capability or a command file names it.

## Entry points

- `bin.oxagen` → `dist/index.js`, built by `tsc` from `src/index.ts`. It
  sends the machine commands (`hook`, `daemon`, `mcp-stdio`, `credential`,
  `github`, `arp`) straight to the recorder through `src/machine/`, and every
  other command to `src/main.ts`, which installs the fatal-error handlers and
  hands off to `buildProgram()` in `src/program.ts`.
- `pnpm bundle` → `scripts/bundle.mjs`: the standalone single-file bundle.
- `pnpm compile` → a single executable, built by `tools/sea/compile.mjs` (see
  [`tools/sea`](../../tools/sea/README.md)).

## Rules

- The CLI governs agents and runs none (ADR-043). A former coding-agent
  command stays registered as a stub that points to `stella`.
- Commands reach platform state through the API only, never through a
  database client or the kernel.
- Telemetry never carries code, prompts, file contents, paths, model slugs,
  or keys.

## Tests

```bash
pnpm --filter @oxagen/cli test:unit src/commands/steering.test.ts
```

Never put `--` before the filename. Tests live in `src/**/__tests__/` and
beside their sources as `*.test.ts`.

## Installation

Three ways, in the order the docs recommend
(https://docs.oxagen.sh/docs/cli/installation):

1. **The Oxagen app.** Download it from https://downloads.oxagen.sh/. On first
   launch it links `oxagen` onto your PATH.
2. **A single executable.** Each version publishes `oxagen-<rust triple>`
   (`oxagen-aarch64-apple-darwin`, `oxagen-x86_64-unknown-linux-gnu`, and so
   on) with a `.sha256` beside it, at
   `https://downloads.oxagen.sh/latest/<file>` and
   `https://downloads.oxagen.sh/desktop/<version>/<file>`. It needs no Node.js.
3. **npm.** `npm install -g @oxagen/cli`. The package on npm lags the app
   (#4489).

**From a checkout of this repository** (contributors):

```bash
pnpm install
pnpm --filter @oxagen/cli start -- --version     # run from source (tsx)
# or
pnpm --filter @oxagen/cli build                  # compile once
node apps/cli/dist/index.js --version
```

**Standalone bundle** (portable, no install, for CI and containers):

```bash
pnpm --filter @oxagen/cli bundle
node apps/cli/dist-standalone/oxagen.mjs --version
```

> The standalone bundle is what
> `pnpm --filter @oxagen/cli publish:standalone` ships: the single-file bundle
> plus a clean manifest. Publishing `apps/cli/package.json` as-is does **not**
> work: its `bin` points at `dist/index.js`, whose shebang is
> `#!/usr/bin/env tsx`, and its `dependencies` still carry unpublished
> `workspace:*` packages.

## Authentication

```bash
oxagen login                                        # opens a browser, OAuth + org/workspace picker
oxagen login --token oxk_live_… --org acme --workspace main   # CI / headless
oxagen logout                                        # clear the saved session
oxagen graph search -q "workspace context" --limit 1 # confirm credentials work
```

Create an account at https://app.oxagen.sh, mint an API key under
**Organization → Developer → Tokens**, then see
https://docs.oxagen.sh/docs/cli/account-setup for the full setup.

## Commands

Run `oxagen --help` for the live, authoritative list; append `--help` to any
command for its flags. The full command tree lives in
`apps/cli/src/program.ts` and is documented at
https://docs.oxagen.sh/docs/cli/commands.

Everything except `cost`, `logs` and `telemetry` talks to the platform API and
needs `oxagen login` first. `oxagen agent enroll` with a one-time enrollment
token needs no login either.

**Meter and bill**

```bash
oxagen budget show                  # spend ceilings with their live burn
oxagen budget set --scope org --period month --limit 500
oxagen cost --in 200000 --out 40000 # project cost from the baked-in rate card
oxagen cost --rates                 # print the rate card
oxagen router stats|preview|policy  # the verified-outcome market router
```

**Explain** — traces and audit

```bash
oxagen trace <executionId>          # a run as a span tree (steps, tool calls, children)
oxagen logs                         # tail the CLI's own debug log
```

**Ground** — knowledge graph and agent memory

```bash
oxagen graph search -q "…"
oxagen memory list|show|promote|dismiss|import   # the memories agents wrote in their harnesses
```

**Govern** — workspace, agents, credentials

```bash
oxagen init --org <org> --workspace <ws>          # link this project to an org + workspace
oxagen pull                                       # write the workspace's published steering into .oxagen/
oxagen steering import <paths...>                 # preview Markdown files as steering records and policies, then --yes opens the PR
oxagen agent env bind|unbind|list                 # bind an agent to an environment
oxagen env list|get|create|update|rm|set-default  # workspace environments
oxagen secret list|set|rm|reveal|import|export    # encrypted credential vault
oxagen conversation export <id>                   # export a conversation as md/pdf
oxagen asset upload <url>                         # ingest a binary asset
```

**Wrap agents on this machine**

```bash
oxagen agent enroll --harness claude-code,codex   # hook these harnesses and install the collector service
oxagen agent status                               # enrollments, collector, hooks, bundle, spool
oxagen agent verify --harness codex               # one headless turn, confirmed chained
oxagen agent run --name my-agent -- ./my-agent    # one custom agent session under Oxagen
oxagen agent detect                               # which harnesses this machine has
oxagen agent reassign|unenroll|export|hosts       # move, remove, export, list machines
```

`oxagen hook`, `oxagen daemon`, `oxagen mcp-stdio`, `oxagen credential`,
`oxagen github`, and `oxagen arp` are hidden from help. The hooks, the user
service, and the connected apps that enrollment installs run them.

**Telemetry**

```bash
oxagen telemetry [on|off|status]    # anonymous usage telemetry (on by default)
```

**Auth**

```bash
oxagen login / logout
```

### Retired commands

`sandbox`, `sandbox-template`, `code`, `eval`, `file-lock`, `a2a`, `models`,
`skill`, `prompt`, `command`, `rules`, `settings`, `config`, `mcp`, `import`,
`pr`, `recover`, `lineage`, plus the interactive surfaces (`view`, `agents`, `solve`,
`replay`, `fleet`) and a bare `oxagen "<prompt>"`. Each prints a
retirement notice and exits non-zero. Use the `stella` CLI instead.

The CLI no longer reads `.oxagen/settings.json` — that file configured the
local coding agent. The only project-local state it writes is
`.oxagen/workspace.json` (the org + workspace binding `oxagen init` creates).

## Configuration

Session token and defaults live in `~/.config/oxagen/config.json`. Set these
to avoid passing org/workspace on every command (env vars win over the config
file):

```bash
export OXAGEN_ORG_ID=your-org-slug
export OXAGEN_WORKSPACE_ID=your-workspace-slug
export OXAGEN_API_TOKEN=oxk_live_…
export OXAGEN_API_URL=https://api.oxagen.sh    # default; override for self-hosted/staging
```

## Telemetry

The CLI collects anonymous usage telemetry (command names, durations, coarse
success/error categories, OS/arch) to improve the product. It never collects
code, prompts, file contents, file paths, model slugs, API keys, or other
personal data. On by default:

```bash
oxagen telemetry off
oxagen telemetry status
export DO_NOT_TRACK=1   # https://consoledonottrack.com/
```

## Development

Run this once from the **repo root** and leave it running — it builds the
package, installs an `oxagen` binary onto your PATH, then watches
`apps/cli/src/**` and rebuilds on every save:

```bash
pnpm cli:dev
```

Open a second terminal and use `oxagen` like a published binary; every source
edit is live on the next invocation. One-shot install without the watcher:

```bash
pnpm cli:install
```

Other workflows:

```bash
pnpm -C apps/cli dev -- graph search -q "workspace context" --limit 1
pnpm -C apps/cli build                  # compile to dist/ once
pnpm -C apps/cli bundle                 # standalone single-file bundle
pnpm -C apps/cli test:unit src/commands/steering.test.ts   # one file; CI runs the suite
pnpm -C apps/cli lint                   # lint (zero warnings enforced)
pnpm -C apps/cli typecheck              # type-check
```

Releases are managed monorepo-wide via `pnpm release:patch|minor|major`, which
bumps all packages to the same version and syncs it to Vercel.

## Support

- Docs: https://docs.oxagen.sh
- Issues: https://github.com/macanderson/oxagen/issues

## License

Proprietary — see [`LICENSE`](../../LICENSE).
