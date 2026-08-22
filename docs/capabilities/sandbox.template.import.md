# import_sandbox_template

**Domain:** sandbox
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Risk level:** medium
**Requires approval:** no

## Intent

Import a portable sandbox-template manifest (as produced by
`export_sandbox_template`) into a chosen workspace environment. Creates the
template (non-default unless `setAsDefault`), its tool rows, and upserts any
missing vault secret keys the manifest references. Owner/Admin only.

**Secret-key upserts are NAMES only — never values.** Importing a manifest
never writes a secret value; it only ensures the referenced `secret_keys`
rows exist so the vault grid shows exactly what the caller needs to fill in.
Unknown tool refs that aren't installed in the destination workspace do
**not** fail the import — they surface as strings in `warnings[]` (Spec §3),
as does a `slug` collision resolved automatically or via the `slug` override.

## Input

| Field           | Type                       | Default  | Notes                                                                                     |
| --------------- | --------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| `environmentId` | `string`                    | required | Public id of the destination workspace environment                                          |
| `manifest`      | `SandboxTemplateManifest`  | required | The exported v1 manifest — `{ kind, version, name, slug, description?, provider, runtime?, resources, network, secretSelection, literalEnv, tools, packages, secretKeys }`; `packages` is `{ manager, names }[]` — per-ecosystem package list carried through import |
| `slug`          | `string?`                   | manifest's own slug | Overrides the manifest's slug — use to resolve a slug collision in the destination workspace |
| `setAsDefault`  | `boolean?`                  | `false`  | Promote the imported template to the environment's default immediately                      |

## Output

| Field      | Type                    | Notes                                                                                          |
| ---------- | ----------------------- | -------------------------------------------------------------------------------------------------- |
| `template` | `SandboxTemplateSummary` | Newly created template, same shape as `get_sandbox_template`                                       |
| `warnings` | `string[]`              | Non-fatal issues: uninstalled tool refs, slug collisions, or other manifest fields the destination workspace couldn't fully resolve |

## Side effects

Inserts a row into `environments.sandbox_templates`, one row per manifest
tool into `environments.sandbox_template_tools`, and upserts any missing keys
named in `manifest.secretKeys` into the workspace's `secret_keys` vault table
(name only — no value is ever set). Metering, IAM, and audit run through the
kernel.

## API

```
POST /v1/{org}/{workspace}/sandbox/template/import
Content-Type: application/json

{
  "environmentId": "env_...",
  "manifest": {
    "kind": "oxagen.sandbox-template",
    "version": 1,
    "name": "Python worker",
    "slug": "python-worker",
    "provider": "modal",
    "resources": {},
    "network": { "mode": "public" },
    "secretSelection": "all",
    "literalEnv": {},
    "tools": [],
    "packages": [{ "manager": "pip", "names": ["fastapi", "pydantic==2.5"] }],
    "secretKeys": [{ "key": "OPENAI_API_KEY", "sensitive": true, "required": true }]
  }
}
```

## MCP

Tool name: `import_sandbox_template`

## Errors

- `validation_error` — `manifest` failed Zod parse (wrong `kind`/`version`, malformed secret-key name).
- `unauthorized` — caller is not org Owner/Admin.
- `not_found` — no environment with that id in the active workspace.
- `conflict` — `slug` (manifest or override) collides with an existing template and no resolvable override was given.
