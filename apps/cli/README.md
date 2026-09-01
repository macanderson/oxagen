# Oxagen CLI

The Oxagen platform CLI: knowledge graph, agent memory, environments,
secrets, sandboxes, evals, budgets, and workspace configuration from the
terminal.

The interactive coding agent this CLI used to ship was retired in the Stella
cutover — Stella owns all things agentic. For a terminal coding agent, use
the `stella` CLI with the oxagen MCP server (see
`docs/specs/agent-engine-v2/`); the retired commands remain as stubs that
print exactly that.

Full reference: **https://docs.oxagen.sh/docs/cli**

## Installation

**From the monorepo** (recommended today):

```bash
git clone https://github.com/oxagen/oxagen-monorepo.git
cd oxagen-monorepo
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
`apps/cli/src/program.tsx` and is documented at
https://docs.oxagen.sh/docs/cli/commands.

**Runs, cost, and observability**

```bash
oxagen init                # scaffold .oxagen/ settings, link a workspace
oxagen pr status|watch     # watch CI on a pull request, merge when green
oxagen trace <executionId> # a run as a span tree (steps, tool calls, children)
oxagen logs                 # tail the CLI's own debug log
oxagen cost                 # price tokens or roll up this project's recorded spend
oxagen models                # inspect/select the coordinator model (on-device or cloud)
```

**Knowledge graph & memory** (requires platform auth)

```bash
oxagen graph search|pull|status
oxagen memory list|show|promote|candidates|import|rm
oxagen remember "<lesson>" --class RULE --enforcement 90
```

**Configuration**

```bash
oxagen config [key] [value]     # token, api-url, org, workspace, model
oxagen settings show|get|set|validate|init   # layered settings.json
```

**Extensibility**

```bash
oxagen agent list|show|new              # named agent definitions
oxagen agent env bind|unbind|list       # bind an agent to a platform environment
oxagen command list|show|new            # custom slash commands (run them via stella)
oxagen rules list|show|new|check        # workspace rules, hard-blocked at the tool layer
oxagen mcp add|list|remove|enable|disable|check   # external MCP servers
```

**Platform resources** (require platform auth)

```bash
oxagen env list|get|create|update|rm|set-default    # workspace environments
oxagen secret list|set|rm|reveal|import|export      # encrypted credential vault
oxagen sandbox files|cat                            # inspect a durable sandbox session
oxagen sandbox template list|get|create|rm|set-default|export|import
oxagen conversation export <id>                     # export a conversation as md/pdf
oxagen asset upload <url>                            # ingest a binary asset
oxagen a2a card                                       # Agent2Agent card for this workspace
oxagen recover [hash]                                 # restore agent work from the commit ledger
oxagen file-lock list|acquire|release                # the same locks write_file/edit_file use
```

**Telemetry**

```bash
oxagen telemetry [on|off|status]    # anonymous usage telemetry (on by default)
```

**Auth**

```bash
oxagen login / logout
```

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
- Issues: https://github.com/oxagen/oxagen-monorepo/issues

## License

Proprietary — see [`LICENSE`](../../LICENSE).
