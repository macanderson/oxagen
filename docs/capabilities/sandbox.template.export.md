# export_sandbox_template

**Domain:** sandbox
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** low
**Requires approval:** no

## Intent

Export a sandbox template as a portable v1 manifest — its config, tools, and
required secret key **NAMES** (never secret values) — so it can be
distributed via the plugin/marketplace path and re-created in another
workspace or org with `import_sandbox_template`. Workspace members can read.

**No audit entry is recorded and no secret values ever leave the vault**: a
manifest carries no secret material by construction (Spec §19.6) — the
`sandboxTemplateManifestSchema` is the single source of truth for the shape
and has no `value` field on its `secretKeys` entries.

## Input

| Field        | Type     | Default  | Notes                             |
| ------------ | -------- | -------- | ---------------------------------- |
| `templateId` | `string` | required | Public id of the sandbox template to export (min 1) |

## Output

| Field      | Type                       | Notes                                                                                                                                                                                                                     |
| ---------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `manifest` | `SandboxTemplateManifest` | `{ kind: "oxagen.sandbox-template", version: 1, name, slug, description?, provider, runtime?, resources, network, secretSelection, literalEnv, tools, packages, secretKeys }`; `packages` is `{ manager, names }[]` (per-ecosystem package list, `manager` ∈ `apt, cargo, gem, go, npm, pnpm, yarn, pip, poetry, uv`); `secretKeys` is `{ key, sensitive, memo?, required }[]` — names only, never values |

## Side effects

Read-only. No PostgreSQL rows are written and **no audit log entry is
created** — exporting a manifest is not a secret-reveal operation. Metering
and IAM still run through the kernel.

## API

```
POST /v1/{org}/{workspace}/sandbox/template/export
Content-Type: application/json

{
  "templateId": "sbx_..."
}
```

## MCP

Tool name: `export_sandbox_template`

## Errors

- `validation_error` — missing/empty `templateId`.
- `unauthorized` — caller is not a member of the active workspace.
- `not_found` — no template with that id in the active workspace.
