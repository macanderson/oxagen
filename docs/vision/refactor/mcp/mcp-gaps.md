# MCP Server Integration — Gap Analysis & Improvement Plan

> **Date**: 2026-06-25  
> **Status**: Draft  
> **Scope**: Authentication, registry, error handling, context injection, tool availability, and comparison with Claude Code's MCP capabilities.

---

## Current State Assessment

### What We Have (Solid Foundations)

**Authentication**: Three strategies are wired — `none`, `bearer` (static token), and full OAuth 2.1 with PKCE via `DbOAuthClientProvider`. The OAuth flow includes:

- Browser-redirect-based authorize/callback routes in the Next.js app
- Encrypted credential storage (AES-256-GCM in `mcp.credentials`)
- Proactive token refresh via `plugin.oauth-refresh-watcher` Inngest cron (every 30 min)
- `markCredentialNeedsReauth` + org-manager email notification when refresh fails

**Registration**: The `agent.mcp.register` capability does:

- SSRF protection (blocks private IPs, loopback, cloud metadata)
- Healthcheck probe on registration
- Tool descriptor snapshots for replay durability
- Immutable audit trail (`security.mcp_server_changes`) for enable/disable/delete

**Tool Materialization**: The `plugin-type` spine integrates MCP tools cleanly:

- IAM gate via `authorizeExternalCapability()` on synthetic capability ids
- Per-server error isolation (one degraded server doesn't break others)
- Auth failure auto-marks `needs_reauth` and skips gracefully
- ClickHouse telemetry for every invocation

**Consent/Approval**: First-use HITL consent cards with 30-day TTL and wildcard pre-grants.

**Registry Discovery**: Workspace-scoped MCP registries backed by the official `registry.modelcontextprotocol.io` API — cursor-paginated, Zod-validated, with lazy seeding of the default registry.

---

## Gaps and Issues

### 1. Registry is Too Primitive

**Current state**: A single `mcp.registries` table stores a base URL. The `plugin.catalog.browse` handler fetches live from the registry on every browse. There's a 60s in-process TTL cache, but no persisted catalog.

**Problems**:

- No local catalog persistence — if the upstream registry is down, the marketplace shows nothing
- No incremental sync (`updatedSince` is wired in the client but never actually used by a sync job)
- No registry composition/prioritization — you can add multiple registries but there's no merge strategy, deduplication, or conflict resolution
- No private/org-scoped registry support beyond pointing `baseUrl` at a different host
- No server version pinning or update notifications — you install a server and have no idea when it publishes a breaking change
- The registry schema was stripped of sync machinery (`last_synced_at`, `last_synced_cursor` were explicitly removed)

**Claude Code comparison**: Claude Code supports plugin-provided MCP servers, install scopes (local/project/user), automatic reconnection, and a growing first-party plugin marketplace. Their managed MCP layer lets organizations control which MCP servers are allowed/blocked org-wide.

---

### 2. Authentication Has Structural Holes

**Current state**: OAuth 2.1 works for the one first-party server (GitHub MCP). Static bearer/header auth works for arbitrary servers.

**Problems**:

- **No OAuth discovery flow for arbitrary servers** — `DbOAuthClientProvider` only works when the `orgListingId` is pre-configured. If a user registers a raw MCP URL that supports OAuth, there's no way to trigger the OAuth dance; they'd have to manually obtain and paste a token.
- **`authConfig` stores secrets in plaintext JSONB** — The `mcp_servers.auth_config` column is `jsonb` (not encrypted). Only the `mcp.credentials` table uses encrypted bytea. When a user registers a server with `authStrategy: "bearer"` via the API, the token sits unencrypted in `auth_config`. The encrypted path only kicks in for servers linked through `installed_plugins`.
- **No credential rotation for static tokens** — Bearer tokens expire; there's no mechanism to prompt users to refresh them or detect expiry.
- **No mutual TLS or signed request support** — Some enterprise MCP servers (internal deployments) require mTLS or HMAC-signed requests. The transport only supports header-based auth.
- **Session tokens rejected with a confusing path** — The code correctly rejects session tokens at the MCP surface, but there's no user-facing guidance about why; users might try to use their browser session token.

---

### 3. Transport Support is Incomplete

**Current state**: Only `streamable-http` is fully implemented. `stdio` is accepted as a `transportType` enum value in the contract but produces `status: "degraded"` with zero tools discovered.

**Problems**:

- **stdio is advertised but non-functional** — The registration contract accepts `transportType: "stdio"` but the runtime can't actually spawn a local process. This is fine for a cloud platform (stdio implies a co-located process), but should either be fully removed from the contract or implemented for self-hosted deployments.
- **No WebSocket transport** — The MCP spec supports WebSocket transport; Claude Code supports it. We don't.
- **No SSE fallback** — Older MCP servers use SSE (server-sent events) transport. `streamable-http` is the newer spec but backward compatibility is missing.

---

### 4. Error Handling is Correct but Lacks Recovery

**Current state**: Per-server failures are isolated. Auth failures mark `needs_reauth`. Connection failures log and skip.

**Problems**:

- **No automatic reconnection/retry** — When a healthy server becomes temporarily unreachable (DNS blip, restart), it stays in a "skip" state until the next agent turn. There's no circuit-breaker pattern with exponential backoff or proactive reconnection.
- **No connection pooling** — Every `materializeTools()` call reconnects to every enabled MCP server from scratch. For a workspace with 5+ MCP servers, this adds significant latency per agent turn.
- **No healthcheck cron** — The healthcheck runs only at registration time. A server that goes down stays `"healthy"` in the DB indefinitely until the next tool invocation attempt. There's no periodic healthcheck job to update `healthStatus` and `lastHealthcheckAt`.
- **Degraded/unreachable servers never auto-recover** — Once marked unhealthy, there's no mechanism to re-probe and flip back to healthy without a manual re-enable action.
- **No error taxonomy surfaced to the user** — When an MCP server fails, the agent sees nothing (the server is silently skipped). The user has no signal in the chat that "GitHub MCP tools are unavailable because auth expired."

---

### 5. Context Injection / Tool Availability Has UX Gaps

**Current state**: Tools are materialized per-turn via `materializeTools()`. The `serverAllowlist` option lets the UI toggle which servers are active for a given turn.

**Problems**:

- **No tool-level granularity in the allowlist** — You can enable/disable servers, but can't selectively enable/disable individual tools from a server. If a server exposes 40 tools and you only need 3, all 40 are stuffed into the model context.
- **No tool description enrichment** — Remote tool descriptions come verbatim from the MCP server. Many MCP servers have poor descriptions. There's no layer for org-admins to override/enrich tool descriptions for better model routing.
- **No tool grouping or categorization** — Tools are flat. Claude Code's approach groups tools by server with metadata, making it easier for the model to reason about which tools to use.
- **Consent flow blocks the entire turn** — When a first-use consent card fires, the agent blocks on `waitForApproval` with a 5-minute TTL. If the user doesn't respond, the tool call fails and the agent loses the flow. There's no "skip and use alternatives" fallback.
- **No dynamic tool updates** — If a MCP server adds/removes tools between turns, the snapshot is stale until the next `materializeTools` call. Claude Code advertises "dynamic tool updates" where the server can push notifications about changed tools.

---

### 6. Managed MCP / Org-Level Governance

**Current state**: IAM policies can deny synthetic capability ids (`mcp.<serverId>.<tool>`). The `agent.mcp.register` capability itself is restricted to Owner/Admin.

**Problems**:

- **No org-wide server allowlist/blocklist** — An admin can't say "only these MCP servers are allowed in any workspace." Each workspace is independent. Claude Code's "managed MCP" layer lets organizations define a positive list.
- **No server signing/verification** — When you register a URL, you trust whatever responds. There's no certificate pinning, server identity verification, or manifest signing.
- **No rate limiting per MCP server** — A misbehaving MCP server could be called thousands of times. There's no per-server rate limit (only the general billing gate).
- **No tool-level IAM policies in the UI** — The synthetic `mcp.<serverId>.<tool>` IAM is technically possible but there's likely no UI to configure per-tool policies; it requires manually crafting IAM policy documents.

---

## Gaps vs. Claude Code's MCP Features

| Feature                             | Claude Code                   | Oxagen                                 | Gap                         |
| ----------------------------------- | ----------------------------- | -------------------------------------- | --------------------------- |
| Remote HTTP servers                 | Yes                           | Yes (streamable-http)                  | Parity                      |
| SSE transport                       | Yes                           | No                                     | Missing                     |
| stdio transport                     | Yes (local)                   | Contract-only, non-functional          | Structural (cloud vs local) |
| WebSocket transport                 | Yes                           | No                                     | Missing                     |
| OAuth 2.1 + PKCE                    | Yes (native, first-party)     | Yes (GitHub only, manual for others)   | Partial                     |
| Automatic reconnection              | Yes                           | No                                     | Missing                     |
| Push messages / channels            | Yes                           | No                                     | Missing                     |
| Dynamic tool updates                | Yes                           | No                                     | Missing                     |
| Install scopes (local/project/user) | Yes                           | Workspace-only                         | Different model             |
| Managed MCP (org-level allow/block) | Yes                           | No (IAM exists but no UI/policy layer) | Missing                     |
| Plugin marketplace with search      | Yes (growing)                 | Registry browse (live fetch)           | Weaker                      |
| Connection pooling                  | Unclear                       | No (reconnects per turn)               | Missing                     |
| Tool-level enable/disable           | Likely (per permission rules) | Server-level only                      | Missing                     |
| Error surfacing to user             | Shown in UI                   | Silent skip                            | Missing                     |

---

## Recommended Improvements (Priority Order)

### P0 — Security / Correctness

1. **Fix the credential storage gap** — Move `authConfig` secrets to encrypted `mcp.credentials` for ALL servers, not just plugin-linked ones. This is a security issue.

### P1 — Reliability / Performance

2. **Add a healthcheck cron** — An Inngest job (every 5 min) that re-probes enabled servers and updates `healthStatus`. Enables auto-recovery and surfaces degradation.

3. **Connection pooling / caching** — Cache `Client` instances per (workspaceId, serverId) with a TTL. Avoid reconnecting to 5 servers on every turn.

4. **Surface MCP errors to the agent/user** — Instead of silently skipping unavailable servers, inject a system-level annotation ("GitHub MCP is unavailable: auth expired") so the model can inform the user and the user can take action.

### P2 — Registry & Discovery

5. **Persist the registry catalog locally** — Add a sync job that snapshots registry listings into a local table. Enables offline browse, version pinning, and update notifications.

6. **Org-level managed MCP policies** — A simple allowlist/blocklist at the org level: "these server URLs/names are approved; all others require admin approval to register."

### P3 — Auth & Transport Gaps

7. **OAuth discovery for arbitrary servers** — When a user registers a raw URL, probe its `/.well-known/oauth-authorization-server` endpoint. If OAuth is available, trigger the authorize flow rather than requiring a pasted token.

8. **SSE/WebSocket transport support** — Many existing MCP servers still use SSE. Add backward-compatible transport negotiation.

9. **Remove or implement stdio** — Either drop `stdio` from the contract (it's misleading for a cloud platform) or implement it for self-hosted/on-prem mode where the agent process can spawn child processes.

### P4 — UX / Governance

10. **Tool-level filtering** — Let users/admins disable specific tools from a server via the consent or IAM system without disabling the entire server.

---

## Design: File-Based MCP Configuration & Permissions

The current system is fully DB-backed — the CLI hits the remote API for every MCP operation. This is unusable offline, slow for iteration, prevents version-controlling MCP configurations, and makes per-project tool scoping impossible. We need a file-based configuration layer modeled after Claude Code's approach.

### Claude Code's Model (Reference)

Claude Code uses a three-tier layered JSON settings system with merge semantics:

| Scope            | File                          | VCS              | Purpose                                     |
| ---------------- | ----------------------------- | ---------------- | ------------------------------------------- |
| User (global)    | `~/.claude/settings.json`     | No               | Personal defaults, auth, global MCP servers |
| Project (shared) | `.claude/settings.json`       | Yes              | Team-wide MCP servers, shared permissions   |
| Local (personal) | `.claude/settings.local.json` | No (.gitignored) | Developer overrides, secrets                |

Key design properties:

- Later scopes override earlier ones (local > project > user)
- `mcpServers` defines servers per scope with transport, args, env
- `permissions` uses allow/deny rules with tool-name patterns
- Org admins can push managed config via `managed_mcp` (allowlist/denylist of server commands)
- Secrets (tokens, keys) live in local/user scope (never committed)
- Server definitions are just JSON — no daemon, no database

### Proposed Oxagen Design

#### File Hierarchy

```
~/.config/oxagen/
├── config.json               # existing: token, orgSlug, workspaceSlug, apiUrl
├── settings.json             # NEW: user-scope settings (global MCP servers, permissions)
└── credentials/
    └── <server-name>.json    # NEW: encrypted per-server credentials (never synced)

.oxagen/                      # project-scope (checked into VCS)
├── settings.json             # team-wide MCP servers, permissions, tool policies
└── settings.local.json       # developer-local overrides (.gitignored)
```

#### Settings Schema

```jsonc
// .oxagen/settings.json (project scope — committed to VCS)
{
  "$schema": "https://oxagen.sh/schemas/settings.v1.json",

  // MCP server definitions — merged across scopes
  "mcpServers": {
    "github": {
      "transport": "streamable-http",
      "url": "https://api.githubcopilot.com/mcp/",
      "auth": "oauth", // "oauth" | "bearer" | "header" | "none"
      "oauthServerUrl": "https://api.githubcopilot.com/mcp/",
      "scopes": ["repo", "read:org"],
    },
    "linear": {
      "transport": "streamable-http",
      "url": "https://mcp.linear.app/sse",
      "auth": "bearer",
      "envToken": "LINEAR_MCP_TOKEN", // resolved from env or credentials/
    },
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "./src"],
      "env": { "HOME": "${HOME}" },
    },
    "internal-api": {
      "transport": "streamable-http",
      "url": "https://mcp.internal.acme.com/v1",
      "auth": "header",
      "headers": { "X-API-Key": "${ACME_MCP_KEY}" }, // env var expansion
    },
  },

  // Permissions: declarative allow/deny rules for MCP tool invocations
  "permissions": {
    // Default policy for MCP tools: "ask" | "allow" | "deny"
    "defaultMcpPolicy": "ask",

    // Per-server overrides
    "mcpServers": {
      "github": {
        "defaultPolicy": "allow", // trust all github tools
        "deny": ["delete_repository"], // except this one
      },
      "filesystem": {
        "defaultPolicy": "allow",
      },
      "internal-api": {
        "allow": ["query_*", "get_*"], // glob patterns
        "deny": ["delete_*", "drop_*"],
      },
    },
  },

  // Tool visibility: control which tools are advertised to the model
  "toolVisibility": {
    "github": {
      "include": ["create_pull_request", "list_issues", "get_file_contents"],
      // omit "include" to show all; use "exclude" to hide specific tools
    },
    "internal-api": {
      "exclude": ["admin_*"],
    },
  },
}
```

```jsonc
// .oxagen/settings.local.json (gitignored — developer-local)
{
  "mcpServers": {
    "linear": {
      // Override: use my personal token instead of team's
      "envToken": "MY_LINEAR_TOKEN",
    },
    "my-dev-server": {
      "transport": "streamable-http",
      "url": "http://localhost:3456/mcp",
      "auth": "none",
    },
  },
  "permissions": {
    "mcpServers": {
      "my-dev-server": { "defaultPolicy": "allow" },
    },
  },
}
```

```jsonc
// ~/.config/oxagen/settings.json (user scope — all projects)
{
  "mcpServers": {
    "memory": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@anthropic/mcp-memory"],
    },
  },
  "permissions": {
    "defaultMcpPolicy": "ask",
  },
}
```

#### Merge Strategy

Scopes merge with **later-wins** semantics (same as Claude Code):

```
user (global) < project (.oxagen/settings.json) < local (.oxagen/settings.local.json) < env overrides
```

Rules:

1. `mcpServers` merges by key — a local entry with the same name replaces the project entry entirely (no deep-merge of individual fields within a server).
2. `permissions` merges by server name — local deny/allow lists append to (not replace) project-level rules. Local `defaultPolicy` overrides project.
3. `toolVisibility` merges by server name — local fully replaces project for that server.
4. Environment variables (`${VAR}`) are expanded at runtime. Missing vars cause the server to be skipped with a warning (not a hard error).

#### Credential Resolution Order

For `auth: "bearer"` or `auth: "header"` servers:

1. **Inline value** (only in local/user scope — never commit secrets)
2. **`envToken` / `headers`** — env var name, resolved at runtime
3. **Credential file** — `~/.config/oxagen/credentials/<server-name>.json` (encrypted at rest via OS keychain or `OXAGEN_CREDENTIAL_KEY`)
4. **Remote fetch** — CLI calls `GET /agent/mcp/{serverId}/credential` to pull the workspace-encrypted token (requires `oxagen auth login`)

For `auth: "oauth"` servers:

1. **Local token cache** — `~/.config/oxagen/credentials/<server-name>.json` stores access + refresh tokens
2. **OAuth flow** — CLI opens browser for authorize; callback writes tokens to credential file
3. **Auto-refresh** — on 401, CLI attempts refresh using stored refresh_token before prompting re-auth

#### CLI Integration

```bash
# Add a server to project scope (creates/updates .oxagen/settings.json)
oxagen mcp add github --url https://api.githubcopilot.com/mcp/ --auth oauth

# Add to user scope (global)
oxagen mcp add memory --scope user --transport stdio --command "npx -y @anthropic/mcp-memory"

# Add to local scope (gitignored)
oxagen mcp add dev-server --scope local --url http://localhost:3456/mcp --auth none

# List effective servers (merged view)
oxagen mcp list
# Output:
#   github        streamable-http  .oxagen/settings.json    healthy
#   memory        stdio            ~/.config/oxagen/settings.json  healthy
#   dev-server    streamable-http  .oxagen/settings.local.json     unreachable

# Set permissions
oxagen mcp permit github --allow-all --deny delete_repository
oxagen mcp permit internal-api --allow "query_*,get_*" --deny "delete_*"

# Authenticate an OAuth server
oxagen mcp auth github
# → Opens browser → OAuth flow → tokens saved to ~/.config/oxagen/credentials/github.json

# Health check
oxagen mcp check
# → Probes all effective servers, updates status display

# Remove
oxagen mcp remove dev-server --scope local
```

#### How Permissions Work at Runtime

When the CLI agent (or the platform runtime) is about to invoke an MCP tool:

```
1. Resolve effective permissions for (server, tool):
   - Check local scope → project scope → user scope → platform IAM (if online)
   - First matching allow/deny rule wins (most specific scope first)

2. Apply policy:
   - "allow" + tool matches allow pattern → execute immediately
   - "deny" + tool matches deny pattern → reject with explanation
   - "ask" (default) → prompt user for confirmation (CLI: interactive; web: consent card)
   - No matching rule → fall through to defaultMcpPolicy

3. Remember decisions (optional):
   - CLI can write an allow/deny to settings.local.json for the session
   - "Always allow" persists to project/user scope via `oxagen mcp permit`
```

This is equivalent to how Claude Code's permission system works — the file is the source of truth, the agent reads it at startup and per-tool-call, and user decisions can be persisted back to the appropriate scope.

#### Managed Configuration (Org-Level — Platform Synced)

For enterprise deployments, the platform can push a managed policy file that acts as a **floor** (cannot be overridden by lower scopes):

```jsonc
// ~/.config/oxagen/managed.json (written by `oxagen org sync-policy`)
{
  "_managed": true,
  "_orgId": "org_abc123",
  "_syncedAt": "2026-06-25T10:00:00Z",

  "mcpServers": {
    // Org-provisioned servers — users can't remove or override auth
    "company-jira": {
      "transport": "streamable-http",
      "url": "https://mcp.internal.acme.com/jira",
      "auth": "oauth",
      "managed": true,
    },
  },

  "managedPolicy": {
    // Allowlist: ONLY these server URLs/commands are permitted
    "allowedServerUrls": [
      "https://api.githubcopilot.com/mcp/",
      "https://mcp.linear.app/**",
      "https://mcp.internal.acme.com/**",
    ],
    "allowedCommands": [
      "npx -y @modelcontextprotocol/*",
      "npx -y @anthropic/*",
    ],
    // Denylist: these are always blocked regardless of user config
    "deniedServerUrls": [
      "http://**", // block all non-TLS in managed orgs
    ],
    "deniedTools": ["*.delete_*", "*.drop_*", "*.rm_rf"],
  },
}
```

Enforcement:

- When a user runs `oxagen mcp add`, the CLI checks the URL/command against `managedPolicy`
- Denied servers fail with: "Blocked by organization policy. Contact your admin."
- If `allowedServerUrls` is non-empty, only those patterns are permitted (positive allowlist)
- Managed servers cannot be removed or have their auth overridden

#### Migration from Current DB-Only Model

The file-based config layer is **additive** — it doesn't replace the DB. Both sources feed into the same `materializeTools()` path:

```
Sources:
  1. File-based (.oxagen/settings.json + local + user) → local MCP servers
  2. DB-based (mcp.mcp_servers + installed_plugins)   → platform-registered servers

Merge at materializeTools():
  - File-based servers are treated as "virtual" — no DB row, no orgListingId
  - Permissions from files are evaluated BEFORE the platform IAM gate
  - If a server exists in BOTH file and DB, file config wins for transport/auth
    (allows local credential override without touching the platform)
  - Consent flow is skipped for file-configured servers with "allow" permission
    (the user explicitly configured and approved it — no HITL needed)
```

The CLI agent works **offline-first** with file-based config. Platform features (billing, telemetry, org governance) engage when the API is reachable.

---

## Key Files Reference

| File                                                                       | Role                                                |
| -------------------------------------------------------------------------- | --------------------------------------------------- |
| `packages/agent/src/dispatch/mcp-client.ts`                                | Low-level MCP transport client                      |
| `packages/agent/src/runtime/plugin-types/mcp.ts`                           | MCP plugin-type contributor (tool loading)          |
| `packages/agent/src/runtime/materialize-tools.ts`                          | Central tool materialization + IAM/consent wrapping |
| `packages/agent/src/runtime/consent.ts`                                    | First-use consent system                            |
| `packages/agent/src/runtime/mcp-snapshots.ts`                              | Tool descriptor snapshots + audit                   |
| `packages/agent/src/handlers/agent.mcp.register.ts`                        | Registration handler (SSRF, healthcheck, insert)    |
| `packages/oxagen/src/contracts/agent.mcp.register.ts`                      | Registration contract (input/output schemas)        |
| `packages/plugins/src/oauth/db-oauth-provider.ts`                          | OAuth 2.1 provider backed by encrypted DB           |
| `packages/plugins/src/registry/registry-client.ts`                         | MCP Registry API client                             |
| `packages/plugins/src/first-party-mcp.ts`                                  | First-party server descriptors (GitHub MCP)         |
| `packages/database/src/schema/mcp.ts`                                      | All MCP-related Drizzle schemas                     |
| `packages/handlers/src/workspace-registry-seed.ts`                         | Default registry seeder                             |
| `packages/inngest-functions/src/functions/plugin.oauth-refresh-watcher.ts` | Proactive OAuth refresh cron                        |
| `apps/mcp/src/context.ts`                                                  | MCP server auth (API key resolution)                |
| `apps/mcp/src/middleware.ts`                                               | MCP server bootstrap + transport auth gate          |
