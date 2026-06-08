# Oxagen CLI

A comprehensive command-line interface for Oxagen, enabling you to manage organizations, workspaces, conversations, and more directly from your terminal.

## Installation

### From npm (when published)

```bash
npm install -g @oxagen/cli
# or
yarn global add @oxagen/cli
# or
pnpm add -g @oxagen/cli
```

After installation, verify the CLI is available:

```bash
oxagen --version
```

### From source (development)

Clone the repository and run:

```bash
cd oxagen-monorepo
pnpm install
pnpm build
pnpm -C apps/cli dev  # for development with tsx
# or
pnpm -C apps/cli build && node apps/cli/dist/index.js  # for production build
```

## Quick Start

### Authentication

First, authenticate with your Oxagen account:

```bash
oxagen auth login
```

You'll be prompted for your credentials. Your session is saved locally for subsequent commands.

Check who you're logged in as:

```bash
oxagen auth whoami
```

Log out when finished:

```bash
oxagen auth logout
```

### Organizations & Workspaces

List your organizations:

```bash
oxagen org list
```

Create a new organization:

```bash
oxagen org create --name "My Organization"
```

List workspaces in an organization:

```bash
oxagen workspace list
```

Create a new workspace:

```bash
oxagen workspace create --name "My Workspace"
```

## Common Commands

### Authentication

- `oxagen auth login` — Authenticate with your account
- `oxagen auth logout` — Remove local session
- `oxagen auth whoami` — Display current user

### Organization Management

- `oxagen org list` — List all organizations
- `oxagen org create` — Create a new organization
- `oxagen org member add` — Add a member to an organization
- `oxagen org member remove` — Remove a member from an organization
- `oxagen org member role change` — Change a member's role
- `oxagen org member invite accept` — Accept an org invite
- `oxagen org member invite decline` — Decline an org invite

### Workspace Management

- `oxagen workspace list` — List workspaces
- `oxagen workspace create` — Create a workspace
- `oxagen workspace member list` — List workspace members
- `oxagen workspace invite send` — Send an invite to a workspace
- `oxagen workspace model settings read` — Read model settings
- `oxagen workspace model settings write` — Update model settings

### Conversations & Chat

- `oxagen conversation list` — List conversations
- `oxagen conversation chat` — Start interactive chat
- `oxagen chat send` — Send a single message
- `oxagen conversation rename` — Rename a conversation
- `oxagen conversation archive` — Archive a conversation
- `oxagen conversation delete` — Delete a conversation
- `oxagen conversation purge` — Purge all conversations

### API Keys

- `oxagen api-key create` — Create a new API key
- `oxagen api-key revoke` — Revoke an API key

### Plugins

- `oxagen plugin list` — List available plugins
- `oxagen plugin install` — Install a plugin
- `oxagen plugin uninstall` — Uninstall a plugin
- `oxagen plugin org list` — List organization plugins
- `oxagen plugin org install` — Org-level plugin install
- `oxagen plugin org uninstall` — Org-level plugin uninstall
- `oxagen plugin org install bulk` — Bulk install plugins
- `oxagen plugin org set enabled` — Enable/disable org plugin
- `oxagen plugin workspace set enabled` — Enable/disable workspace plugin
- `oxagen plugin registry list` — List plugin registries
- `oxagen plugin registry add` — Add a custom registry
- `oxagen plugin registry remove` — Remove a registry
- `oxagen plugin registry sync` — Sync plugins from registry
- `oxagen plugin catalog get` — Get plugin from catalog
- `oxagen plugin catalog browse` — Browse plugin catalog
- `oxagen plugin credential reauth` — Re-authenticate plugin
- `oxagen plugin credential set secret` — Set plugin credentials
- `oxagen plugin denylist add` — Add to denylist
- `oxagen plugin denylist remove` — Remove from denylist
- `oxagen plugin settings set auth alerts` — Configure alerts

### Billing & Credits

- `oxagen billing status` — View billing status
- `oxagen billing credits purchase` — Purchase credits
- `oxagen billing subscription read` — View subscription
- `oxagen billing subscription upgrade start` — Start upgrade

### Agents & Workflows

- `oxagen agent mcp list` — List agent MCP servers
- `oxagen agent mcp register` — Register an MCP server
- `oxagen agent skill list` — List agent skills
- `oxagen agent tool list` — List available tools
- `oxagen agent approval resolve` — Resolve an approval
- `oxagen agent memory write` — Write to agent memory
- `oxagen agent memory recall` — Recall from agent memory
- `oxagen agent task background start` — Start background task
- `oxagen agent task background read` — Read task status
- `oxagen agent task background cancel` — Cancel task
- `oxagen agent plan approve` — Approve an agent plan
- `oxagen workflow run` — Run a workflow
- `oxagen workflow status` — Check workflow status
- `oxagen workflow cancel` — Cancel a workflow

### Content & Media

- `oxagen image list` — List images
- `oxagen image create` — Upload/create an image
- `oxagen image generate` — Generate an image with AI
- `oxagen image analyze` — Analyze an image
- `oxagen document list` — List documents
- `oxagen document create` — Create a document
- `oxagen document read` — Read a document
- `oxagen documents generate` — Generate documents
- `oxagen documents pdf create` — Generate PDF from documents
- `oxagen video generate` — Generate video
- `oxagen svg generate` — Generate SVG
- `oxagen asset upload` — Upload an asset

### Forms & Automation

- `oxagen form create` — Create a form
- `oxagen form submit` — Submit form data
- `oxagen form fill` — Fill form fields
- `oxagen automation list` — List automations
- `oxagen automation create` — Create an automation
- `oxagen automation trigger` — Trigger an automation

### Utilities

- `oxagen notifications list` — List notifications
- `oxagen notifications mark` — Mark notifications as read
- `oxagen user preferences get` — Get user preferences
- `oxagen user preferences read` — Read preferences
- `oxagen user preferences update` — Update preferences
- `oxagen user preferences write` — Write preferences
- `oxagen skill workspace list` — List workspace skills
- `oxagen archive create` — Create an archive
- `oxagen brandkit apply` — Apply brand kit settings

## Usage Examples

### Interactive Chat Session

```bash
oxagen conversation chat --workspace my-workspace
```

### Send a Single Message

```bash
oxagen chat send "What is the weather today?" --workspace my-workspace
```

### Create and Configure

```bash
# Create a new organization
oxagen org create --name "Acme Corp"

# Create a workspace within it
oxagen workspace create --name "Engineering"

# Invite team members
oxagen workspace invite send --email "alice@acme.com" --email "bob@acme.com"
```

### API Key Management

```bash
# Create an API key for programmatic access
oxagen api-key create

# Revoke a key by ID
oxagen api-key revoke <key-id>
```

### Plugin Management

```bash
# View available plugins
oxagen plugin catalog browse

# Install a plugin to your workspace
oxagen plugin install <plugin-id>

# Configure plugin credentials
oxagen plugin credential set secret <plugin-id> <secret-name> <secret-value>
```

## Configuration

Settings are stored in your user's config directory:
- **macOS**: `~/.config/oxagen/`
- **Linux**: `~/.config/oxagen/`
- **Windows**: `%APPDATA%\oxagen\`

Your authentication token is stored securely in the system keychain when available, with a fallback to the config directory.

## Troubleshooting

### `command not found: oxagen`

Ensure the CLI is installed globally:

```bash
npm list -g @oxagen/cli
```

If not installed, run:

```bash
npm install -g @oxagen/cli
```

### Authentication failures

Clear your cached session and re-authenticate:

```bash
oxagen auth logout
oxagen auth login
```

### Check version and help

```bash
oxagen --version
oxagen --help
oxagen <command> --help
```

## Publishing to npm

### Prerequisites

1. Ensure you have an npm account: https://www.npmjs.com/signup
2. Authenticate locally:
   ```bash
   npm login
   ```

3. Package must not be marked as `"private": true` in `package.json` (currently it is; see step below)

### Before Publishing

1. Update the version in `apps/cli/package.json`:

   ```bash
   # Use semantic versioning
   npm version patch   # 0.2.2 → 0.2.3 (bug fixes)
   npm version minor   # 0.2.2 → 0.3.0 (new features, backwards compatible)
   npm version major   # 0.2.2 → 1.0.0 (breaking changes)
   ```

   Or manually edit the `version` field.

2. Update `apps/cli/package.json` to remove the `"private": true` field:

   ```json
   {
     "name": "@oxagen/cli",
     "version": "0.3.0",
     "type": "module",
     "bin": {
       "oxagen": "./dist/index.js"
     }
     // ... rest of config
   }
   ```

3. Build the distribution:

   ```bash
   pnpm -C apps/cli build
   ```

4. Verify the build is correct:

   ```bash
   node apps/cli/dist/index.js --version
   node apps/cli/dist/index.js --help
   ```

### Publishing

From the monorepo root:

```bash
# Option 1: Using npm directly from the CLI package directory
cd apps/cli
npm publish

# Option 2: Using pnpm from monorepo root
pnpm publish -C apps/cli
```

### Verification

Verify the package was published:

```bash
npm view @oxagen/cli
npm info @oxagen/cli
```

Install from npm to verify:

```bash
npm install -g @oxagen/cli@latest
oxagen --version
```

### Post-Publish Checklist

- [ ] Version bumped in `apps/cli/package.json`
- [ ] `package.json` no longer marked `"private"`
- [ ] Distribution built (`apps/cli/dist/` up-to-date)
- [ ] Package published to npm
- [ ] Installation verified with `npm install -g @oxagen/cli@latest`
- [ ] Help text displays correctly: `oxagen --help`
- [ ] Global command works: `oxagen --version`
- [ ] Commit and tag pushed to repository

### Automated Release (via pnpm scripts)

This monorepo includes automated release tooling:

```bash
pnpm release:patch   # Bumps all packages including @oxagen/cli
pnpm release:minor
pnpm release:major
```

These commands:
- Bump version across all workspace packages (lockstep versioning)
- Create a git tag
- Publish to npm
- Sync version to Vercel projects

## Development

### Building from source

```bash
pnpm -C apps/cli build
```

### Testing

```bash
pnpm -C apps/cli test:unit
```

### Linting

```bash
pnpm -C apps/cli lint
```

### Interactive development

```bash
pnpm -C apps/cli dev -- <command> [args]
```

## Support

For issues, feature requests, or questions:

- GitHub Issues: https://github.com/oxagen/oxagen-monorepo/issues
- Documentation: https://oxagen-v2-docs.vercel.app
- Email: support@oxagen.ai

## License

MIT
