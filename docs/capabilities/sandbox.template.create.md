# create_sandbox_template

**Domain:** sandbox
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Create a portable sandbox template under a workspace environment: provider,
runtime image, resource caps, network posture, selected vault keys, literal
(non-secret) config, and a preloaded tool set. A template is the unit that
`bind_agent_environment` points an agent at, and the unit that
`export_sandbox_template`/`import_sandbox_template` move between workspaces or
orgs as a portable manifest. Owner/Admin only.

## Input

| Field             | Type                       | Default      | Notes                                                                                     |
| ----------------- | -------------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| `environmentId`   | `string`                   | required     | Public id of the parent workspace environment                                             |
| `name`            | `string`                   | required     | Display name (min 1 char)                                                                 |
| `slug`            | `string`                   | required     | URL-safe slug, unique within the workspace                                                |
| `description`     | `string \| null?`          | `null`       | Optional human description                                                                |
| `provider`        | `"modal" \| "vercel" \| "docker"?` | unset | Sandbox driver; provisioner fails fast if the driver has no credentials configured         |
| `runtime`         | `string \| null?`          | unset        | Runtime image identifier, driver-specific                                                 |
| `resources`       | `SandboxResources?`        | unset        | `{ vcpu?≤4, memoryMb?≤8192, timeoutMs?≤300000, diskMb?≤20480 }` — all bounded, all optional |
| `network`         | `SandboxNetwork?`          | unset        | `{ mode, config? }`; `mode` ∈ `public, static_egress, aws_privatelink, gcp_psc, reverse_tunnel, ssh_bastion` — only `public`/`static_egress` are implemented today, others fail fast with "requires Phase 2/3" |
| `secretSelection` | `SandboxSecretSelection?`  | unset        | `"all"` or `{ keyPublicIds: string[] }` — which vault keys resolve into the sandbox at run time |
| `literalEnv`      | `Record<string,string>?`  | unset        | Plain, non-sensitive `KEY=value` config injected at lowest precedence — never secrets      |
| `tools`           | `SandboxTemplateTool[]?`  | unset        | Preloaded tools: `{ kind, ref, config? }`; `kind` ∈ `capability, mcp_server, agent_skill, tool` |
| `packages`        | `SandboxPackageGroup[]?`  | `[]`         | Per-ecosystem packages installed into the image at provision time: `{ manager, names }[]`; `manager` ∈ `apt, cargo, gem, go, npm, pnpm, yarn, pip, poetry, uv`; `names` are free-text specs that may carry a version pin in that ecosystem's syntax (e.g. `fastapi`, `pydantic==2.5`, `left-pad@1.3.0`) |
| `setAsDefault`    | `boolean?`                 | `false`      | Promote the new template to the environment's default immediately                          |

## Output

| Field      | Type                    | Notes                                                                                                                                                                          |
| ---------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `template` | `SandboxTemplateSummary` | `{ id, environmentId, name, slug, description, isDefault, isActive, provider, runtime, resources, network, secretSelection, literalEnv, tools, packages }`; `tools` is `{ id, kind, ref, config }[]`; `packages` is `{ manager, names }[]` |

## Side effects

Inserts a row into `environments.sandbox_templates` (PostgreSQL), plus one row
per entry in `tools` into `environments.sandbox_template_tools`. If
`setAsDefault` is set, the same atomic default-swap used by
`set_default_sandbox_template` runs within the environment. Metering, IAM, and
audit run through the kernel.

## API

```
POST /v1/{org}/{workspace}/sandbox/template/create
Content-Type: application/json

{
  "environmentId": "env_...",
  "name": "Python worker",
  "slug": "python-worker",
  "provider": "modal",
  "runtime": "python:3.12-slim",
  "resources": { "vcpu": 2, "memoryMb": 4096, "timeoutMs": 60000 },
  "network": { "mode": "public" },
  "secretSelection": "all",
  "tools": [{ "kind": "capability", "ref": "web.search" }]
}
```

## MCP

Tool name: `create_sandbox_template`

## Errors

- `validation_error` — input failed Zod parse (empty `name`/`slug`, resource cap exceeded, unsupported `network.mode`).
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — no environment with that id in the active workspace.
- `conflict` — a template with the same `slug` already exists in the workspace.
