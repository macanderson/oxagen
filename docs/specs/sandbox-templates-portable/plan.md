# Sandbox Templates + Portable Template Artifacts — Implementation Plan

**Branch:** `feat/sandbox-templates-portable`
**Parent spec:** `docs/superpowers/specs/2026-06-24-credential-vault-environments-sandboxes-spec.md` (§5.2, §5.3, §5.6, §8, §10–§13, §19)
**Status of prerequisites:** Phase 0 (Vault + Environments) is SHIPPED on main — `environments.environments`, `secret_keys`, `secret_values`, `secret_access_log`, all `environment.*`/`secret.*` contracts, `injectEnvironmentSecrets()` trusted-env boundary (`packages/agent/src/handlers/_environment-env.ts`), `settings/environments` web UI.

## What this branch ships

Phase 1 of the spec, with the §19 decisions locked in, **plus a portability requirement**:

> Sandbox templates are **portable artifacts**. A third party building on Oxagen (e.g. a company running its own code-evaluation suite) must be able to ship a pre-optimized sandbox config — custom prewarmed image, resources, preloaded tools, required secret keys — as a versioned manifest, distribute it via the plugin/marketplace path, and run evals on it. Nothing about a template may be hard-coded to Oxagen-internal use.

## §19 decisions (locked)

1. Default-sandbox scope: **per-environment**. "System default sandbox" = default environment's default template.
2. Workspace default-env pointer: **`environments.is_default` is the single source of truth** (already shipped). No mirror into workspace.settings.
3. Template env vars: **vault is the single secret store; templates *select* keys** (`secret_selection`) and may carry **non-sensitive literal config** (`literal_env` jsonb — plain KEY=value pairs, never secrets).
4. Schema home: **`environments` schema** (existing).
5. Non-sensitive storage: **plaintext columns** (already shipped for vault).
6. Reveal/export authority: **Owner/Admin + audit** (already shipped for vault; template export needs no audit — manifests contain no secret values).
7. Secrets grid: matrix (already shipped).

## 1. Schema (new tables in `packages/database/src/schema/environments.ts`)

Follow the existing file's conventions exactly (mixins, no cross-schema FK `.references()`, partial-uniques canonical in the Atlas migration, placeholder `unique().nullsNotDistinct()` in Drizzle).

### `environments.sandbox_templates` (§5.2)
- `idMixin("sbx")`, `auditMixin()`, `orgScopeMixin()`, `softDeleteMixin()`
- `environment_id uuid not null` (app-enforced FK)
- `name text not null`, `slug citext not null`, `description text`
- `is_default boolean not null default false` — one default PER environment
- `is_active boolean not null default true`
- `provider text not null default 'modal'` — `'modal' | 'vercel' | 'docker'` (extensible; validate in zod, not a DB enum)
- `runtime text` — image ref (digest-pinned encouraged) or language tag; null = driver default image
- `resources jsonb not null default '{}'` — `{ vcpu?, memoryMb?, timeoutMs?, diskMb? }` (bounded in zod: ≤4 vcpu, ≤8192 MB, ≤300000 ms, ≤20480 MB disk)
- `network jsonb not null default '{"mode":"public"}'` — `{ mode, config? }`, mode ∈ `public|static_egress|aws_privatelink|gcp_psc|reverse_tunnel|ssh_bastion` (all six valid in schema; provisioner fails fast on not-yet-implemented modes)
- `secret_selection jsonb not null default '"all"'` — `'all' | { keyPublicIds: string[] }`
- `literal_env jsonb not null default '{}'` — non-sensitive literal config pairs (§19.3)
- Uniques: `(workspace_id, slug) where deleted_at is null`; `(workspace_id, environment_id) where is_default` (one default per environment)
- Index: `(org_id, workspace_id)`, `(environment_id)`

### `environments.sandbox_template_tools` (§5.3)
- `idMixin("sbt")`, `auditMixin()`, `orgScopeMixin()`
- `sandbox_template_id uuid not null`
- `kind text not null` — `'capability' | 'mcp_server' | 'agent_skill' | 'tool'` (DB check)
- `ref text not null`, `config jsonb not null default '{}'`
- Unique `(sandbox_template_id, kind, ref)`

### `environments.agent_environment_bindings` (§5.6)
- `idMixin("aeb")`, `auditMixin()`, `orgScopeMixin()`
- `agent_id uuid not null`, `environment_id uuid not null`
- `sandbox_template_id uuid` (nullable → use the environment's default template)
- `is_primary boolean not null default false`
- Unique `(agent_id, environment_id)`; partial-unique `(agent_id) where is_primary` in the migration
- Bindings stay OUT of `agent_versions.config` (mutable operational config).

### Migration
- One Atlas file in `packages/database/atlas/migrations/`, prefix **later than `20260710120000` AND later than the shared local DB's current revision** (check `atlas_schema_revisions` / pick `202607121*`). Hand-write the partial uniques. Regenerate checksum: `atlas migrate hash --dir "file://atlas/migrations"` from `packages/database`.
- RLS policies mirroring the existing `environments.*` tables; add all three tables to `packages/database/src/tenant-policy.manifest.ts`.
- Verify with a real `SELECT` against local PG (`localhost:5433`, `unset DATABASE_URL` first).

## 2. Service layer (`packages/plugins/src/environments/`)

New `sandbox-template-service.ts` mirroring `environment-service.ts`:
- CRUD + `setDefaultTemplate` (atomic swap within one environment, one tx)
- Default-lifecycle guards: default template can't be deactivated/deleted unless another is promoted within that environment; deleting/deactivating an ENVIRONMENT is already guarded (default env), no change.
- `listTemplates(environmentId?)`, `getTemplate`, `setTemplateTools` (replace-set semantics)
- Binding service: `bindAgentEnvironment`, `unbindAgentEnvironment`, `listAgentBindings`; auto-bind rule — on bind-set becoming empty or agent having none, resolution falls back to workspace default env + its default template (resolution helper, not a stored row; do NOT retro-insert rows on agent create in this branch — fallback covers it).
- `resolveSandboxTemplateForRun({ agentId?, environmentId? })` → `{ environment, template }` implementing §12 resolution: explicit env → agent primary binding → workspace default env; template = binding's template → env default template. Preflight: both `is_active`; clear errors otherwise.
- Extend `resolveEnvironmentSecrets` with optional `selection` param (`'all' | { keyPublicIds }`) filtering which vault keys resolve.

## 3. Manifest format v1 (portability core — `packages/oxagen/src/contracts/sandbox.template.export.ts` exports the zod schema; single source of truth)

```jsonc
{
  "kind": "oxagen.sandbox-template",
  "version": 1,
  "name": "Acme eval prewarmed",
  "slug": "acme-eval-prewarmed",
  "description": "Pre-optimized eval sandbox: prewarmed Node + repo toolchain",
  "provider": "modal",
  "runtime": "ghcr.io/acme/eval-prewarmed@sha256:…",
  "resources": { "vcpu": 2, "memoryMb": 4096, "timeoutMs": 300000, "diskMb": 10240 },
  "network": { "mode": "public" },
  "literalEnv": { "ACME_EVAL_SPLIT": "verified" },
  "tools": [
    { "kind": "capability", "ref": "agent.code.execute" },
    { "kind": "agent_skill", "ref": "acme-eval" }
  ],
  "secretKeys": [
    { "key": "EVAL_API_KEY", "sensitive": true, "memo": "provider key for the eval judge", "required": true }
  ]
}
```

Rules:
- **Secret key NAMES only, never values.** Import upserts missing `secret_keys` rows (no value) so the vault grid shows exactly what to fill in; `required:true` keys that resolve to unset produce a preflight warning at provision time (not a hard fail — the run may not need them).
- Export = template row + tools + referenced key names → manifest JSON. No audit needed (no secret material).
- Import = zod-validate manifest → create template (non-default) under a caller-chosen environment (+ `setAsDefault` option) + tools rows + secret-key upserts. Slug collision → suffix `-2` style or reject with clear error (reject; caller passes `slug` override).
- Unknown `tools[].ref` not installed in the workspace: import succeeds but returns `warnings[]` (tool preload skips missing refs at provision time with a logged warning). Portability must not hard-depend on the target workspace's installed plugins.

## 4. Contracts (dot-named, matching current main; ADR-025 snake reland renames later)

| Contract | Notes |
|---|---|
| `sandbox.template.create` | Owner/Admin |
| `sandbox.template.list` | filter by environmentId |
| `sandbox.template.get` | |
| `sandbox.template.update` | incl. is_active; guard default deactivate |
| `sandbox.template.delete` | soft; guard default |
| `sandbox.template.set_default` | atomic per-environment swap |
| `sandbox.template.tools.set` | replace-set |
| `sandbox.template.export` | returns manifest v1 |
| `sandbox.template.import` | manifest v1 + environmentId (+slug/setAsDefault overrides) |
| `agent.environment.bind` | upsert binding; `isPrimary` swap atomic |
| `agent.environment.unbind` | |
| `agent.environment.list` | bindings for an agent (resolved template names) |

Every contract: `layers: ["api", "mcp", "app", "docs", "unit"]` (check existing environment.* contracts for the exact layer vocabulary and copy it; `app` layer only for the ones with UI surface: create/list/update/delete/set_default/tools.set/export/import + agent.environment.*). Handlers in `packages/handlers/src/` (or `packages/agent/src/handlers/` for agent.* — follow where `agent.sandbox.*` handlers live), registered in `packages/handlers/src/register.ts`. API routes `apps/api/src/routes/v1/` (one combined `sandbox-template.ts` + `agent-environment.ts` file is fine — note the combined-file false-positive convention in CLAUDE.md), mounted in `apps/api/src/app.ts`. MCP tools in `apps/mcp/src/tools/`. Org+workspace from ctx, never request. Mutations Owner/Admin-gated same as `environment.create`.

## 5. Provisioning integration (§11/§12)

- Extend `SandboxSessionSpec` and `SandboxRequest` (`packages/sandbox/src/types.ts`) with optional `imageRef?: string` (custom image; drivers that can't honor it throw a clear error — docker CAN, modal passes it to the runner if supported else clear error, vercel throws), `resources?: { vcpu?, diskMb? }` additions, and keep `network: "allow" | "deny"` for drivers while the template's rich `network.mode` maps: `public|static_egress → "allow"` semantics + mode recorded for telemetry; unimplemented modes (`aws_privatelink|gcp_psc|reverse_tunnel|ssh_bastion`) fail fast at provision with "requires Phase 2/3".
- `getSandbox()` gains optional `provider` override (`getSandbox(provider?)`) — template's provider selects the driver per run; `SANDBOX_DRIVER` stays the deployment default/fallback. Unavailable provider (missing creds) → clear error, not fallback.
- `agent.sandbox.start` (and the `agent.code.execute` path): accept optional `sandboxTemplateId` / use `resolveSandboxTemplateForRun`; apply template runtime/resources/provider; inject vault secrets filtered by `secret_selection`, merged as: `literal_env` (lowest) → vault secrets → sanitized caller env (highest) — extend `injectEnvironmentSecrets` with `selection` + `literalEnv` params. Preserve the existing trust boundary EXACTLY (caller env still sanitized; vault+literal bypass denylist).

## 6. Plugin-pack distribution (the third-party story)

- Plugin manifest type (`packages/plugins/src/registry/` — read `builtin skills` pattern from PR #713 for the embedded-data convention) gains optional `sandboxTemplates?: SandboxTemplateManifest[]`.
- On plugin install into a workspace (find the install seam — `plugin.installed_plugins` write path / `resolveAgentToolsManager` install seam in `apps/app/src/lib/agent-tools/authz.ts` per memory), each manifest imports via the same code path as `sandbox.template.import` into the workspace's **default environment**, non-default, slug-prefixed by the pack if collision. Idempotent re-install (upsert by slug).
- Ship ONE first-party proof pack: an `code-evals` template manifest (node-flavored prewarmed image ref placeholder, 2 vcpu / 4 GB / 300 s, tools = `agent.code.execute` capability + a `code-eval` skill ref, secretKeys = `AI_GATEWAY_API_KEY` required) registered as embedded module data. This proves: "another company ships its own evaluation suite with a preoptimized sandbox config and runs it on Oxagen" with zero platform code.

## 7. UI (`apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/environments/`)

- New **Sandbox templates** section under the existing page (below secrets matrix): per-environment template list (default ★), create/edit dialog (name, provider, runtime image ref, resources, network mode select, secret-selection multi-pick from vault keys, literal env rows, tools picker limited to workspace-installed items), set-default, deactivate/delete with the promote-first guard tooltip (mirror the environments drawer pattern).
- **Export** (download manifest JSON) / **Import** (paste JSON → preview → confirm) actions.
- Agent settings surface: environment bindings editor on the agent detail/settings page (find where agent config is edited; add bindings list + primary toggle).
- Server actions in the existing `actions.ts` pattern (`"use server"`, re-check Owner/Admin, `invoke()`, `revalidatePath`). Explicit IAM gates (apps/app doesn't bootstrap IAM).
- `apps/app/capability-ui-map.json` entries for every `app`-layer capability (route, page, entry, proof → e2e spec path).
- E2E spec `apps/app/e2e/sandbox-templates.spec.ts`: create template → set default → export → import round-trip → bind agent; screenshots.

## 8. Docs + tests

- `docs/capabilities/<name>.md` for every new contract + `_index.md` rows.
- Unit tests colocated for every contract/handler/service (match existing `environment.*.test.ts` patterns). Manifest zod round-trip, import warnings, resolution chain, secret_selection filter, literal_env merge order, provider override, default-swap atomicity, guards.
- **NEVER run all tests.** Run only the specific test files you add/touch: `pnpm --filter <pkg> test:unit -- <file>` (or the package's vitest binary directly on one file). apps/api build typechecks test files — run the package typecheck after editing tests.
- Coverage ratchets: only bump per policy (≥2.5% headroom, cap 90).

## Work split (agents)

1. **core-backend**: §1 schema+migration+RLS+manifest-entry, §2 services, §3 manifest schema, §4 contracts+handlers+API+MCP (+unit tests, docs stubs)
2. **provisioning**: §5 (after core-backend)
3. **portability-packs**: §6 (after core-backend)
4. **ui**: §7 (after core-backend)
5. **docs**: §8 docs (after core-backend)

All agents: commit frequently with explicit pathspecs, push to `feat/sandbox-templates-portable`, never rebase, never run whole-repo suites.
