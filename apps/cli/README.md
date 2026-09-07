# Oxagen CLI

The governance-operations CLI for the Oxagen control plane: spend ceilings and
cost, run traces, knowledge-graph grounding, agent memory,
environments, the credential vault, and audit logs — from the terminal.

Oxagen **governs, grounds, explains, meters/bills and rates** agents; it does
not run them ([ADR-041](../../docs/adr/ADR-041-runtime-excision.md)). The
interactive coding agent this CLI used to ship — the REPL, sandboxes, skills,
slash commands, evals, local rules and settings — is gone. Stella owns all
things agentic: use the `stella` CLI with the oxagen MCP server. Every removed
entry point stays registered as a stub that prints exactly that, so a stale
script fails with guidance instead of an unknown-command error.

Full reference: **https://docs.oxagen.sh/docs/cli**

## Installation

**From the monorepo** (recommended today):

```bash
git clone https://github.com/macanderson/oxagen.git
cd oxagen
pnpm install

pnpm --filter @oxagen/cli start -- --version     # run from source (tsx)
# or
pnpm --filter @oxagen/cli build                  # compile once
node apps/cli/dist/index.js --version
```

**Standalone bundle** (portable, no install — CI/containers):

```bash
pnpm --filter @oxagen/cli bundle
node apps/cli/dist-standalone/oxagen.mjs --version
```

**From npm:**

```bash
npm install -g @oxagen/cli
# or
pnpm add -g @oxagen/cli
oxagen --version
```

> The published npm package expects `tsx` on `PATH`, so it does not run
> standalone outside the monorepo. Use the monorepo or standalone bundle
> methods instead.
>
> The standalone bundle is what
> `pnpm --filter @oxagen/cli publish:standalone` ships — the single-file bundle
> plus a clean manifest. Publishing `apps/cli/package.json` as-is does **not**
> work: its `bin` points at `dist/index.js`, whose shebang is
> `#!/usr/bin/env tsx`, and its `dependencies` still carry unpublished
> `workspace:*` packages.

See https://docs.oxagen.sh/docs/cli/installation for the full walkthrough.

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
needs `oxagen login` first.

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
oxagen memory list|show|edit|salience|promote|demote|candidates|citations|import|rm
oxagen remember "<lesson>" --class RULE --enforcement 90
```

**Govern** — workspace, agents, credentials

```bash
oxagen init                                       # link this project to an org + workspace
oxagen agent env bind|unbind|list                 # bind an agent to an environment
oxagen env list|get|create|update|rm|set-default  # workspace environments
oxagen secret list|set|rm|reveal|import|export    # encrypted credential vault
oxagen conversation export <id>                   # export a conversation as md/pdf
oxagen asset upload <url>                         # ingest a binary asset
```

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
`daemon`, `replay`, `fleet`) and a bare `oxagen "<prompt>"`. Each prints a
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
pnpm -C apps/cli test:unit              # run unit tests
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
