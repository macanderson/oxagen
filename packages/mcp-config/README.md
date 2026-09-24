# @oxagen/mcp-config

File-based MCP configuration: the settings schema, the three-scope settings
resolver, local credential files, the allow, deny, and ask permission
evaluator, and the organization's managed policy floor.

## Boundary

- **Owns:**
  - The Zod schemas for MCP server definitions, permissions, tool visibility,
    `settings.json`, and `managed.json` (`src/schema.ts`).
  - Loading and merging settings from the user
    (`~/.config/oxagen/settings.json`), project (`.oxagen/settings.json`), and
    local (`.oxagen/settings.local.json`) scopes, with `${VAR}` expansion
    (`src/resolve.ts`).
  - Reading and writing credential files under
    `~/.config/oxagen/credentials/` and resolving a server's credential
    (`src/credentials.ts`).
  - Evaluating a server and tool pair to `allow`, `deny`, or `ask`, and the
    flat `matchGlob` those rules use (`src/permissions.ts`).
  - The managed policy: org-provisioned servers, URL and command allow and
    deny lists, and denied tools (`src/managed.ts`).
- **Does not own:**
  - Connecting to an MCP server or materializing its tools:
    [`@oxagen/agent`](../agent/README.md)
    (`packages/agent/src/runtime/plugin-types/file-mcp.ts`).
  - Workspace-installed MCP servers and their encrypted credentials:
    [`@oxagen/plugins`](../plugins/README.md).
  - Path globs, where `*` stays inside one segment:
    [`@oxagen/glob`](../glob/README.md).
  - The CLI's own settings resolver: `apps/cli/src/settings/resolve.ts`.
- **Depends on:** No `@oxagen/*` runtime dependencies.
- **Used by:** `@oxagen/agent` and `@oxagen/rules`.

## Seams

| Seam | Kind | Source | Wired by |
|---|---|---|---|
| `resolveSettings` / `findProjectRoot` | export | `packages/mcp-config/src/resolve.ts` | `packages/agent/src/runtime/plugin-types/file-mcp.ts` |
| `resolveCredential` | export | `packages/mcp-config/src/credentials.ts` | `packages/agent/src/runtime/plugin-types/file-mcp.ts` |
| `ResolveCredentialOptions.remoteFetch` | port | `packages/mcp-config/src/credentials.ts` | Optional. `file-mcp.ts` passes none, so resolution stops at the environment and the credential file. |
| `filterToolVisibility` / `getNonDeniedTools` | export | `packages/mcp-config/src/permissions.ts` | `packages/agent/src/runtime/plugin-types/file-mcp.ts` |
| `evaluatePermission` / `evaluateServerPermissions` | export | `packages/mcp-config/src/permissions.ts` | No caller outside this package and its tests. |
| `matchGlob` | export | `packages/mcp-config/src/permissions.ts` | `packages/rules/src/auto-approval.ts`, `packages/rules/src/mandates/measures.ts` |
| `validateServerAgainstPolicy` | export | `packages/mcp-config/src/managed.ts` | `packages/agent/src/runtime/plugin-types/file-mcp.ts`, before a server connects |
| Settings files on disk | boundary | `packages/mcp-config/src/resolve.ts` | The working directory and the user's home directory |

## Entry points

The package has no root export. Import a subpath.

- `./schema` (`src/schema.ts`): Zod schemas and inferred types.
- `./resolve` (`src/resolve.ts`): `resolveSettings`, `findProjectRoot`,
  `getSettingsPaths`, and `expandEnvVars`.
- `./credentials` (`src/credentials.ts`): credential file reads and writes,
  `resolveCredential`, and refresh helpers.
- `./permissions` (`src/permissions.ts`): `evaluatePermission`, `matchGlob`,
  and tool visibility filters.
- `./managed` (`src/managed.ts`): `loadManagedConfig`,
  `validateServerAgainstPolicy`, and the URL, command, and tool checks.

## Rules

- A deny rule wins over an allow rule for the same server. Evaluation order is
  per-server deny, per-server allow, per-server default, then the global
  default.
- The project and local scopes come from the working directory and outrank the
  user's own file. A cloned repository can widen `allow` lists and the default
  policy. Any change that broadens what those scopes may set widens that
  exposure.
- A managed policy is a floor no user scope can override. A server that fails
  it is refused before a process spawns or a request leaves the machine.
- `matchGlob` matches flat values, so `*` crosses every separator. Do not merge
  it with `@oxagen/glob`.
- Credential files are plaintext on disk, protected only by file mode `0600`.

## Tests

```bash
pnpm --filter @oxagen/mcp-config test:unit src/permissions.test.ts
```

Tests sit beside their source under `src/`. The managed policy has its own
file, `src/managed-policy-enforcement.test.ts`.
