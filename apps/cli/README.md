# Oxagen CLI

Command-line interface for the [Oxagen](https://oxagen.ai) platform. Chat with the agent, run workflows, generate content, manage your organization, and integrate external MCP servers — all from your terminal.

## Installation

```bash
npm install -g @oxagen/cli
# or
pnpm add -g @oxagen/cli
```

```bash
oxagen --version
```

### From source

```bash
cd oxagen-monorepo
pnpm install
pnpm -C apps/cli build
node apps/cli/dist/index.js --version
```

## Authentication

```bash
oxagen auth login --email you@example.com --password yourpassword
oxagen auth whoami
oxagen auth logout
```

Your session is written to `~/.config/oxagen/` and reused by all subsequent commands.

## Real-world scenarios

### Chat with the agent

```bash
# One-shot message
oxagen chat send "Summarize our Q2 pipeline and flag any blockers"

# Resume an existing conversation
oxagen chat send "Add the EMEA numbers too" --conversation conv_abc123

# List recent conversations
oxagen conversation list

# Post directly to a known conversation ID
oxagen conversation chat --conversation conv_abc123 --message "What changed since Monday?"

# Rename a conversation for future reference
oxagen conversation rename --conversation conv_abc123 --name "Q2 Pipeline Review"
```

### Run a workflow from CI/CD

```bash
# Trigger a release-notes workflow from a GitHub Action or deploy hook
oxagen workflow run \
  --workflow release-notes-generator \
  --input '{"version":"2.1.0","repo":"acme/platform"}'

# Poll until it finishes
oxagen workflow status --id wf_xyz789

# Cancel if something goes wrong mid-run
oxagen workflow cancel --id wf_xyz789
```

### Register an external MCP server

Expose your own tools to the Oxagen agent. Once registered, the server appears in the web app's MCP picker and can be toggled on per-conversation.

```bash
# Register a streamable-http server with bearer auth
oxagen agent mcp register \
  --name "internal-data-api" \
  --url https://tools.internal.example.com/mcp \
  --transport streamable-http \
  --auth bearer \
  --auth-config '{"token":"sk-..."}'

# Register a local stdio server
oxagen agent mcp register \
  --name "filesystem-tools" \
  --url file:///usr/local/bin/my-mcp-server \
  --transport stdio

# Check health and discovered tool counts
oxagen agent mcp list
```

### Connect Claude Code to Oxagen's MCP server

The Oxagen platform itself is an MCP server. Connect Claude Code, Claude Desktop, or Cursor to it using an API key.

**Claude Code**
```bash
oxagen api-key create   # copy the key that's printed

claude mcp add oxagen \
  --transport http \
  --url https://oxagen-v2-mcp.vercel.app/mcp \
  --header "Authorization: Bearer $OXAGEN_API_KEY"
```

**Claude Desktop** — add to `claude_desktop_config.json`:
```json
{
  "mcpServers": {
    "oxagen": {
      "command": "npx",
      "args": ["-y", "@oxagen/mcp-client"],
      "env": { "OXAGEN_API_KEY": "your-key-here" }
    }
  }
}
```

You can also retrieve connection instructions directly:
```bash
oxagen system install instructions
```

### Generate images and media

```bash
# Generate an image and print the URL
oxagen image generate --prompt "isometric diagram of a multi-agent system"

# Generate and save to disk
oxagen image generate \
  --prompt "product screenshot mockup, clean UI" \
  --model gpt-image-1 \
  --output ./assets/hero.png

# Analyze an existing image
oxagen image analyze --image ./screenshot.png

# Generate a video clip
oxagen video generate --prompt "short animation of data flowing through a pipeline"

# Generate an SVG illustration
oxagen svg generate --prompt "simple icon of a robot holding a document"
```

### Onboard a new team

```bash
# Create the org and workspace
oxagen org create --name "Acme Corp"
oxagen workspace create --name "Engineering" --org acme-corp

# Invite members
oxagen workspace invite send --email alice@acme.com --org acme-corp --workspace engineering
oxagen workspace invite send --email bob@acme.com   --org acme-corp --workspace engineering

# Promote to admin after they accept
oxagen org member role change --user user_alice --role admin --org acme-corp

# List who's in the workspace
oxagen workspace member list --org acme-corp --workspace engineering
```

### Work with documents

```bash
# Create a document
oxagen document create --title "Architecture Overview" --content "# Overview\n..."

# Generate a document from a prompt (agent writes it)
oxagen documents generate --prompt "Write a technical spec for our billing reconciliation system"

# Export to PDF
oxagen documents pdf create --document doc_abc123 --output spec.pdf

# List all documents
oxagen document list
```

### Manage plugins

```bash
# Browse what's available
oxagen plugin catalog browse

# Install for the org
oxagen plugin org install --listing listing_linear

# Enable for a specific workspace only
oxagen plugin workspace set-enabled --plugin plugin_xyz --enabled true

# Set OAuth credentials
oxagen plugin credential set-secret --plugin plugin_linear --key access_token --value sk-...

# List what's installed
oxagen plugin org list

# Remove
oxagen plugin org uninstall --listing listing_linear
```

### Run background agent tasks

```bash
# Start a long-running analysis task
oxagen agent task background start \
  --description "Analyze all GitHub issues opened this week and produce a triage report"

# Check progress
oxagen agent task background read --task task_abc123

# Cancel
oxagen agent task background cancel --task task_abc123
```

### Automations

```bash
# Create a scheduled automation
oxagen automation create \
  --name "daily-standup-summary" \
  --trigger '{"type":"cron","schedule":"0 9 * * 1-5"}'

# Trigger manually (e.g., from a webhook handler)
oxagen automation trigger --automation auto_abc123

# List all automations
oxagen automation list
```

---

## All commands

```
oxagen auth login / logout / whoami

oxagen chat send
oxagen conversation list / rename / archive / delete / purge / chat

oxagen workflow run / status / cancel
oxagen automation create / list / trigger

oxagen agent mcp register / list
oxagen agent memory recall / write
oxagen agent skill list
oxagen agent task background start / read / cancel
oxagen agent tool list
oxagen agent plan create / approve
oxagen agent approval resolve

oxagen image generate / analyze / create / list
oxagen video generate
oxagen svg generate
oxagen documents generate / pdf create
oxagen document create / list / read
oxagen archive create
oxagen asset upload
oxagen form create / fill / submit
oxagen brandkit apply

oxagen org create / list
oxagen org member add / remove / role change / invite accept / invite decline
oxagen workspace create / list
oxagen workspace invite send
oxagen workspace member list
oxagen workspace model settings read / write

oxagen plugin catalog browse / get
oxagen plugin org install / install-bulk / uninstall / list / set-enabled
oxagen plugin workspace set-enabled
oxagen plugin registry add / list / remove / sync
oxagen plugin credential reauth / set-secret
oxagen plugin denylist add / remove
oxagen plugin settings set-auth-alerts

oxagen billing status
oxagen billing credits purchase
oxagen billing subscription read / upgrade start

oxagen api-key create / revoke

oxagen skill workspace list
oxagen user preferences read / write
oxagen notifications list / mark
oxagen privacy export / erase
oxagen system install instructions
```

Pass `--help` to any command for flags and usage:

```bash
oxagen workflow run --help
```

---

## Configuration

Session token and defaults are stored in `~/.config/oxagen/`. To target a different org or workspace without passing flags on every command, set environment variables:

```bash
export OXAGEN_ORG=my-org
export OXAGEN_WORKSPACE=engineering
```

---

## Troubleshooting

**`command not found: oxagen`** — ensure global install succeeded:
```bash
npm list -g @oxagen/cli
npm install -g @oxagen/cli
```

**Auth failures** — clear and re-authenticate:
```bash
oxagen auth logout && oxagen auth login
```

---

## Development

```bash
pnpm -C apps/cli dev -- auth whoami   # run from source with tsx
pnpm -C apps/cli build                # compile to dist/
pnpm -C apps/cli test:unit            # run unit tests
pnpm -C apps/cli lint                 # lint (zero warnings enforced)
pnpm -C apps/cli typecheck            # type-check
```

Releases are managed monorepo-wide via `pnpm release:patch|minor|major`, which bumps all packages to the same version and syncs to Vercel.

---

## Support

- Docs: https://oxagen-v2-docs.vercel.app
- Issues: https://github.com/oxagen/oxagen-monorepo/issues
- Email: support@oxagen.ai

## License

MIT
