---
title: "Credential Vault, Environments & Sandboxes"
description: "Archived spec & plan — status: partially shipped (audited 2026-07-03)."
---

> **Status: Partially shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> Phase 0 (Vault + Environments core) of the credential vault spec is fully shipped with 14 contracts, 4 database tables, CLI commands, API routes, MCP tools, and a web settings UI. Phases 1–4 (Sandbox Templates, Agent Bindings, Network Agents, private networking, multi-provider support, and hardening) are not implemented. The spec is a complete phased design; only the first phase has been delivered.

**Implementation evidence**

- packages/database/atlas/migrations/20260626120000_environments_vault.sql — creates environments, secret_keys, secret_values, secret_access_log tables with RLS
- packages/oxagen/src/contracts/environment.\{create,delete,get,list,set_default,update}.ts — 6 environment contracts with tests
- packages/oxagen/src/contracts/secret.\{key.upsert,key.list,key.delete,value.set,value.unset,import_env,reveal,export}.ts — 8 secret contracts with tests
- packages/plugins/src/vault/vault-secret-service.ts — vault service with encryption, .env parsing, reveal/export
- packages/handlers/src/workspace-environment-seed.ts — seeding function for new workspaces
- apps/api/src/routes/v1/environment.*.ts — 6 API routes
- apps/api/src/routes/v1/secret.*.ts — 8 API routes
- apps/mcp/src/tools/environment.*.ts — 6 MCP tools
- apps/mcp/src/tools/secret.*.ts — 8 MCP tools
- apps/cli/src/commands/env.ts — oxagen env command group
- apps/cli/src/commands/secret.ts — oxagen secret command group
- apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/environments/ — web UI with grid, .env import, reveal/export
- docs/capabilities/environment.*.md + secret.*.md — 14 capability docs
- commit c80498c7 (PR #184) — feat: Environments + Credential Vault (Phase 0) merged 2026-06-26

**Known gaps at time of archive**

- Phase 1 — Sandbox Template contracts (sandbox.template.create/list/get/update/delete/set_default/tools.set)
- Phase 1 — Sandbox templates schema (sandbox_templates, sandbox_template_tools tables)
- Phase 1 — Agent Environment Binding contracts (agent.environment.bind/unbind/list)
- Phase 1 — Agent environment bindings schema (agent_environment_bindings table)
- Phase 1 — Trusted env injection (§11) — vault secrets bypass denylist in provisioning
- Phase 1 — Multi-provider provisioning backend integration (provider selection per template)
- Phase 2 — Network Agent contracts (network.agent.create/list/revoke)
- Phase 2 — Network agents schema (network_agents table)
- Phase 2 — Network reachability modes (static_egress, aws_privatelink, gcp_psc, reverse_tunnel, ssh_bastion)
- Phase 2 — Oxagen Network Agent (reverse tunnel container for in-house firewalls)
- Phases 3–4 — Cloud-private connectivity, multi-provider registry, hardening (rotation policies, fleet UI)

**Source documents** (archived verbatim below)

- `docs/superpowers/specs/2026-06-24-credential-vault-environments-sandboxes-spec.md`

## Spec — `2026-06-24-credential-vault-environments-sandboxes-spec.md`

## Spec — Credential Vault, Agent Environments & Sandbox Templates

**Date:** 2026-06-24
**Status:** Complete design spec (pre-implementation)
**Author:** Claude (with Mac Anderson)
**Related:** `2026-06-24-universal-connector-mcp-cli-spec.md` (consumes this feature for direct DB connections)

---

### 1. Summary

Introduce three workspace-level primitives so customers can run agents (and ingestion workers) against their own systems — including databases inside AWS/GCP VPCs and behind in-house firewalls:

1. **Environments** — named runtime scopes per workspace (`default`, `production`, `development`, `preview`). Exactly one is the **default**. Seeded automatically; managed in workspace settings.
2. **Sandbox Templates** — configurations *scoped to an environment* that drive how an agent's ephemeral **sandbox** is provisioned: provider (Modal/Vercel/…), runtime, resources, **network reachability mode**, preloaded tools/MCP servers/capabilities, and which secrets to inject. Each environment has a default template; multiple templates per environment are allowed.
3. **Vault** — a workspace-root catalog of environment-variable **keys** (each with a `sensitive` flag defaulting to true, a memo, and a **default value**) plus **per-environment value overrides**. Sensitive values are envelope-encrypted; **and — unlike Vercel — authorized users can export them back to plaintext** (Google Secret Manager–style), with an audit trail. A Vercel-style grid + `.env` paste importer drive the UI.

Agents bind to **(environment → sandbox template)** pairs (≥1; absent ⇒ workspace defaults). At run time the provisioner resolves the agent's environment, builds a `SandboxRequest` with the template's config + the environment's resolved secrets, and provisions the sandbox through the chosen provider with the chosen network mode — so a connector or agent can reach a private database.

The hard problem — **reaching databases inside a VPC or behind a firewall** — is answered by a tiered **network reachability model** on the sandbox template (`public` / `static_egress` / `aws_privatelink` / `gcp_psc` / `reverse_tunnel` / `ssh_bastion`), anchored by a small customer-run **Oxagen Network Agent** for the outbound-only reverse-tunnel case.

This reuses what exists: `@oxagen/crypto` envelope encryption + KMS, the workspace-seeding pattern, the `agent_versions` config, and the `@oxagen/sandbox` driver abstraction (Modal/Vercel/Docker).

---

### 2. Goals / Non-goals

#### Goals
- Per-workspace **Environments** with a strictly-maintained single default and safe activation/removal rules.
- **Sandbox Templates** (env-scoped, multi-per-env, default per env) carrying provider, resources, network mode, preloaded tools/MCP/capabilities, and secret selection.
- A **Vault**: workspace-root keys, `sensitive` (default true) → encrypted, memo, **default value**, **per-environment overrides**, `.env` paste import, Vercel-style grid, and **reversible plaintext export** with audit.
- **Agent ↔ environment+sandbox binding**, required ≥1, with graceful fallback to workspace defaults.
- **Private-network reachability** for AWS VPC, GCP VPC, and in-house firewalls.
- **Multi-provider** sandbox provisioning behind one driver abstraction.
- Trusted vault-env injection that bypasses the model-facing denylist **without** weakening it.

#### Non-goals (this spec)
- A general per-agent compute autoscaler / cluster scheduler (sandboxes stay ephemeral microVMs).
- Re-importing Oxagen's *own* datastores (this is for *customer* systems).
- Secret *rotation policies* / scheduled rotation (key-id rotation is supported; automated rotation is Phase-N).
- A full self-serve PrivateLink onboarding wizard (Phase-N; manual/assisted at first).

---

### 3. Terminology

| Term | Meaning |
|---|---|
| **Environment** | A named runtime scope in a workspace (`default`/`production`/`preview`/…). Owns `is_default`, `is_active`. |
| **Sandbox Template** | A configuration (provider, runtime, resources, **network mode**, preloaded tools, secret selection) *scoped to an environment*. Provisions sandboxes. Owns `is_default` (per environment), `is_active`. |
| **Sandbox** | The live, ephemeral microVM provisioned for a single agent/worker run from a template. Not persisted beyond telemetry. |
| **Secret Key / Env Var** | A workspace-root key (`DATABASE_URL`, …) with `sensitive`, memo, and a **default value**. |
| **Value override** | A per-(key, environment) value. Resolution: override ?? key default. |
| **Vault** | The store of keys + values (the encryption boundary). |
| **Oxagen Network Agent** | A small customer-run container that dials out to Oxagen and brokers a reverse tunnel into a private network. |

---

### 4. Concept model

```
Workspace
 ├── Environment (1 default, N total)            [environments.environments]
 │     └── Sandbox Template (1 default/env, N)    [environments.sandbox_templates]
 │            ├── preloaded tools/MCP/caps        [environments.sandbox_template_tools]
 │            ├── network mode + config           (jsonb on template)
 │            └── selected secret keys            (jsonb on template; default = all)
 ├── Secret Key (workspace root)                  [environments.secret_keys]
 │     ├── default value (sensitive→enc)          (on key)
 │     └── value override per Environment         [environments.secret_values]
 └── Agent → (Environment → Sandbox Template) ≥1  [environments.agent_environment_bindings]

Run(agent, env): resolve binding → resolve secrets(env) → build SandboxRequest → provision(provider, network) → execute
```

---

### 5. Data model

New schema **`environments`** (RLS-scoped like every tenant schema; could alternatively live under `agent.*`). All tables carry `org_id`, `workspace_id`, audit columns (`created_at/by`, `updated_at/by`), and soft-delete where noted. IDs follow the UUID-`id` + `public_id` convention.

#### 5.1 `environments.environments`
```
id, public_id ('env_…'), org_id, workspace_id
name, slug (citext), description
is_default  boolean not null default false
is_active   boolean not null default true
deleted_at  timestamptz
unique (workspace_id, slug) where deleted_at is null
unique (workspace_id) where is_default            -- exactly one default per workspace
```
**Seed:** on workspace creation, insert `name='default', slug='default', is_default=true, is_active=true`.

**Lifecycle invariants (handler-enforced + DB partial-unique):**
- Exactly one `is_default` per workspace at all times.
- `environment.set_default(envId)` swaps default atomically (unset old, set new) in one tx.
- The default environment **cannot** be deactivated or deleted. To remove/deactivate it, first promote another environment to default.

#### 5.2 `environments.sandbox_templates`
```
id, public_id ('sbx_…'), org_id, workspace_id
environment_id  uuid not null  -- FK environments.id  (sandbox config is BY environment)
name, slug (citext), description
is_default  boolean not null default false   -- one default PER environment
is_active   boolean not null default true
provider    text not null default 'modal'    -- 'modal'|'vercel'|'docker'|… (extensible)
runtime     text                             -- base image / language runtime tag
resources   jsonb                            -- { vcpu, memoryMb, timeoutMs, diskMb }
network     jsonb                            -- { mode, config } (§9)
secret_selection jsonb not null default '"all"'  -- 'all' | { keyPublicIds:[…] }
deleted_at  timestamptz
unique (workspace_id, slug) where deleted_at is null
unique (workspace_id, environment_id) where is_default   -- one default per environment
```
**Seed:** one `name='default'` template under the seeded default environment, `is_default=true`, `provider` = the deployment's configured default driver, conservative resources, `network.mode='public'`, `secret_selection='all'`.

Same default-lifecycle invariants as environments, scoped to `(workspace, environment)`: exactly one default template per environment; the default template can't be deactivated/deleted unless another is promoted within that environment.

#### 5.3 `environments.sandbox_template_tools` (preloaded tools / MCP / capabilities)
```
id, sandbox_template_id (FK), org_id, workspace_id
kind  text   -- 'capability' | 'mcp_server' | 'agent_skill' | 'tool'
ref   text   -- capability name | installed-plugin public_id/orgListingId | skill slug
config jsonb
unique (sandbox_template_id, kind, ref)
```
A template "comes with" a preloaded set; the picker only offers tools/MCP servers/capabilities **installed in the workspace** (joins `plugin.installed_plugins` / capability registry). This is how a template ships ready-to-use.

#### 5.4 `environments.secret_keys` (vault — workspace root)
```
id, public_id ('sk_…'), org_id, workspace_id
key        text not null   -- env var name; validated ^[A-Za-z_][A-Za-z0-9_]*$
sensitive  boolean not null default true
memo       text
-- default value (used when an environment has no override):
default_value_enc   bytea            -- when sensitive
default_value_text  text             -- when not sensitive
default_value_kms_key_id text
deleted_at timestamptz
unique (workspace_id, key) where deleted_at is null
check ( (sensitive and default_value_text is null)
     or (not sensitive and default_value_enc is null) )
```

#### 5.5 `environments.secret_values` (per-environment overrides)
```
id, org_id, workspace_id
secret_key_id  uuid (FK), environment_id uuid (FK)
value_enc  bytea            -- when key.sensitive
value_text text             -- when not key.sensitive
value_kms_key_id text
unique (secret_key_id, environment_id)
```
**Resolution** for environment E: `value(key,E) = override(key,E) ?? key.default`. A key with neither override nor default resolves to *unset* (not injected).

#### 5.6 `environments.agent_environment_bindings`
```
id, org_id, workspace_id
agent_id (FK agent.agents.id)
environment_id (FK), sandbox_template_id (FK, nullable -> use env default)
is_primary boolean not null default false   -- the agent's default env when run context is ambiguous
unique (agent_id, environment_id)
```
- Required ≥1 per agent. On `agent.definition.update`/create, if no bindings supplied, **auto-create one** to (workspace default env, that env's default template), `is_primary=true`. This satisfies both "required ≥1" and "fall back to defaults."
- Kept **out of the immutable `agent_versions.config`** (bindings are mutable operational config; rebinding must not require a new agent version).

#### 5.7 `environments.secret_access_log` (audit for reversible export)
```
id, org_id, workspace_id, actor_user_id
action  text   -- 'reveal' | 'export'
scope   jsonb  -- { keyPublicIds?, environmentId?, count }
occurred_at timestamptz
```
Append-only. Written on every plaintext reveal/export (§7.3). (May also mirror to ClickHouse telemetry.)

#### 5.8 `environments.network_agents` (reverse-tunnel registrations — §9.5)
```
id, public_id ('na_…'), org_id, workspace_id
name, status text         -- 'pending'|'online'|'offline'
enrollment_token_enc bytea -- one-time enrollment secret (encrypted)
last_seen_at timestamptz
metadata jsonb            -- advertised reachable CIDRs/hosts, agent version
```

#### 5.9 Reused (no new tables)
- **Crypto/KMS:** `@oxagen/crypto` (`encrypt`/`decrypt` + `KmsAdapter`), `resolveCredentialKms()` pattern with a new key id `workspace_vault_v1`. Master key `AUTH_TOKEN_ENCRYPTION_KEY`.
- **Sandbox provisioning:** `@oxagen/sandbox` `SandboxDriver` (Modal/Vercel/Docker) + `SandboxRequest` (extended, §10/§12).
- **Workspace default pointer:** store `defaultEnvironmentId` on the workspace `settings` jsonb (or rely on `is_default`; §8.1 decision).

---

### 6. Environments — defaults & lifecycle

- **Seeded** at workspace creation (hook at `workspace.create.ts:102`, mirroring `seedWorkspaceDefaultRegistry`; use the `withSystemDb` variant for the new-org Server Action path).
- **Set default** (`environment.set_default`) — atomic swap; updates the partial-unique `is_default`. Available in **workspace settings UI** and via **CLI/MCP** (capability parity).
- **Deactivate/Delete guard** — reject if the target is the current default; the error instructs the user to promote another environment first. Deactivating an environment stops new runs from resolving to it; in-flight runs finish.
- **Workspace setting** — "Default environment" selector lives under `settings/environments` (new route) and is also exposed via `workspace.settings.write` (add `defaultEnvironmentId`).

---

### 7. The Vault — keys, values, encryption, export, import

#### 7.1 Keys & values
- A **key** is workspace-root: `key`, `sensitive` (default **true**), `memo`, and a **default value**.
- A **value override** is per (key, environment). Missing override ⇒ default. Missing both ⇒ unset.
- `sensitive` is a property of the **key** and governs storage for *both* the default and all overrides (encrypted vs plaintext column).

#### 7.2 Encryption
- Sensitive values are envelope-encrypted with `@oxagen/crypto`: `encrypt(plaintext, 'workspace_vault_v1', { adapter })` → `value_enc` (bytea) + `value_kms_key_id` for rotation. New service `packages/plugins/src/vault/vault-secret-service.ts` mirrors `credential-service.ts`.
- Non-sensitive values stored as plaintext (`*_text`) — they're config, not secrets.
- Plaintext never logged; masked in UI by default.

#### 7.3 Reversible plaintext export (the deliberate Vercel difference)
- `secret.reveal(keyPublicId, environmentId?)` → single decrypted value.
- `secret.export(environmentId?, keyPublicIds?)` → a decrypted set (optionally rendered as `.env` text for a chosen environment).
- **Authorization:** Owner/Admin only. **Every** reveal/export writes `secret_access_log` (actor, scope, time) — Google-Secret-Manager-style: secrets *are* retrievable in plaintext by authorized principals, but every access is recorded. This is intentional and distinct from Vercel's write-only secrets.

#### 7.4 `.env` import (`secret.import_env`)
Parse pasted text → upsert keys + set values for chosen target (default values, or a specific environment's overrides):
- Accept `KEY=VALUE`, `export KEY=VALUE`, `KEY="value"`, `KEY='value'`, `KEY=` (empty).
- **Strip surrounding quotes**; preserve inner content (including `=`).
- **Ignore** blank lines and `#` comment lines; strip trailing inline comments only when outside quotes.
- New keys default `sensitive=true`; existing keys keep their flag.
- Returns a **preview** (parsed rows + which are new vs override) so the UI can confirm before commit.

#### 7.5 Grid UX (Vercel-style)
- **Layout = matrix** (decided — §18.7): rows are **keys**, columns are **Default value + one per environment**. Each value cell is the `(key, environment)` override; `‹inherit›` (muted) where no override falls back to Default. Inheritance is visible in one view — chosen over per-environment tabs because workspaces have few environments (3–5) and cross-env comparison is the common task. (Full IA + mockups: §16.)
- Row header columns: **Key · Sensitive** (toggle, default on) **· Memo**. Value columns: **Default · ‹each env›**, masked with **reveal/copy** for authorized principals (logged).
- **Paste `.env`** → parsed preview (`KEY · VALUE(masked) · NEW|OVERRIDE · target`) → choose target (defaults or a specific environment) → import.
- **Export** (per environment → `.env`) and **Reveal** actions (Owner/Admin, logged), each echoed with a visible "recorded" affordance (the Google-Secret-Manager posture, §7.3).
- Empty-state seeds nothing; the grid is per-workspace and shared across environments via the override model.

---

### 8. Sandbox Templates — config & lifecycle

A template is **scoped to an environment** and carries:
- **provider** — `modal` (default) | `vercel` | `docker` | … (extensible registry, §11).
- **runtime** — base image / language tag.
- **resources** — `{ vcpu, memoryMb, timeoutMs, diskMb }` (bounded; e.g. ≤4 vcpu, ≤8 GB, ≤300 s).
- **network** — reachability mode + config (§9).
- **preloaded tools** — rows in `sandbox_template_tools` (capabilities/MCP/skills installed in the workspace).
- **secret_selection** — `all` (default) or a chosen subset of vault keys to inject.

**Defaults & lifecycle** — one default per environment; atomic `sandbox.template.set_default` within an environment; default template can't be deactivated/deleted unless another is promoted in that environment. Seeded default template under the seeded default environment.

---

### 9. Network reachability (VPC / firewall) — the centerpiece

`network` on a sandbox template = `{ mode, config }`. The provisioner configures the sandbox's egress/connectivity per mode. The DB host/port/credentials come from the **vault** (e.g. `DATABASE_URL`); the **mode** governs *how the sandbox reaches that host*.

| Mode | How it works | Customer setup | Best for |
|---|---|---|---|
| `public` *(default)* | Sandbox egresses to the public internet | none | Public cloud DBs, SaaS APIs |
| `static_egress` | Sandbox egresses via stable NAT IP(s); we expose the egress IPs | Allowlist Oxagen egress IP(s) in their **SG / firewall / authorized networks** | AWS RDS public endpoint, **GCP Cloud SQL authorized networks**, on-prem inbound allow |
| `aws_privatelink` | We create an interface **VPC endpoint** to the customer's **endpoint service** | Publish an AWS **PrivateLink** endpoint service; share service name + region | **AWS VPC**, private, no public exposure (enterprise) |
| `gcp_psc` | **Private Service Connect** consumer endpoint to the customer's published service | Publish a PSC service attachment | **GCP VPC**, private (enterprise) |
| `reverse_tunnel` | Customer runs the **Oxagen Network Agent** inside their network; it dials **out** to Oxagen and brokers a reverse tunnel; the sandbox connects through it | Run one container (Docker/K8s), enroll with a one-time token | **In-house managed firewalls** (no inbound change), locked-down VPCs |
| `ssh_bastion` | Sandbox tunnels through a customer **bastion** host | Provide bastion host/port + an SSH key (stored as a vault secret) | Anywhere SSH egress is permitted |

**Mapping to the three the customer named:**
- **AWS VPC** → `static_egress` (simple: RDS + SG allowlist) → `aws_privatelink` (private/enterprise) → `reverse_tunnel`/`ssh_bastion` (fallback).
- **GCP VPC** → `static_egress` (Cloud SQL authorized networks) → `gcp_psc` (private) → `reverse_tunnel`/`ssh_bastion`.
- **In-house managed firewall** → **`reverse_tunnel`** (outbound-only — no inbound firewall change; the cleanest answer) → `ssh_bastion` → `static_egress` (if they'll allow our IP inbound).

#### 9.5 The Oxagen Network Agent (reverse tunnel)
A small, signed container the customer runs inside their network (its own sub-project; Phase-N):
- **Outbound-only**: authenticates to an Oxagen relay with a one-time enrollment token (`network_agents.enrollment_token_enc`), maintains a persistent reverse tunnel (mTLS). No inbound firewall rules.
- **Scoped reachability**: the agent advertises an allowlist of reachable hosts/CIDRs/ports (`network_agents.metadata`); the relay only forwards to those. Least-privilege.
- **Health**: heartbeats → `status`/`last_seen_at`; a `reverse_tunnel` template whose agent is `offline` fails the run with a clear error (not a silent hang).
- The sandbox sees a local proxy endpoint; the connector's `DATABASE_URL` host resolves through the tunnel.

> Comparable to how managed-ingestion vendors reach private databases. It is the general solution for networks that forbid inbound connections; PrivateLink/PSC are the cloud-native private alternatives for AWS/GCP.

---

### 10. Multi-provider sandboxes

- The existing `@oxagen/sandbox` driver selection is **env-var-driven** (`SANDBOX_DRIVER`). Generalize so the **template's `provider`** selects the driver per run (env var becomes the deployment default / fallback only).
- Extend `SandboxRequest` with `resources` (vcpu/disk) and `network` (mode + resolved config) so a driver can apply provider-specific networking (static egress IP, tunnel proxy endpoint, PrivateLink DNS).
- Network modes may be provider-specific (egress IPs differ per provider/region); the template stores provider + mode together, and the provisioner validates the combination (e.g., `aws_privatelink` requires a provider/region that supports it).

---

### 11. Trusted env injection (the denylist trust boundary)

Today `agent.code.execute` sanitizes the model-supplied `env` via `sanitizeSandboxEnv()`, which **denylists** `DATABASE_`, `MODAL_`, `VERCEL_`, `AWS_`, `OXAGEN_`, `NEO4J_`, `CLICKHOUSE_`, … (protecting Oxagen's own infra from prompt-injected env). A customer's `DATABASE_URL` would be stripped by this denylist — correct for *model-controlled* env, wrong for *vault* secrets the customer deliberately configured.

**Resolution — split the env into two channels in the provisioner:**
1. **Trusted vault env** — resolved from the vault for the run's environment (the keys the template selects). Injected by the provisioner, **no denylist** (these are the customer's own, intentionally-set secrets). The LLM never sees the values.
2. **Model-supplied env** — still passes `sanitizeSandboxEnv()` (denylist intact).

Final `SandboxRequest.env = sanitize(modelEnv) ⊕ trustedVaultEnv` (vault wins on conflict). Concretely: `agent.code.execute` (and the connector worker) load `resolveEnvironmentSecrets(workspaceId, environmentId, template.secret_selection)` and merge **below** sanitization. This keeps the denylist protecting Oxagen infra while letting `DATABASE_URL` (from the vault) reach the sandbox.

---

### 12. Provisioning flow (end-to-end)

```
provisionForRun(agentId, runEnvironmentId?):
  env   = runEnvironmentId
          ?? agent.primaryBinding.environment
          ?? workspace.defaultEnvironment
  tmpl  = agent.binding(env).sandboxTemplate
          ?? env.defaultSandboxTemplate
  preflight: env.is_active && tmpl.is_active; if reverse_tunnel, agent online
  secrets = resolveEnvironmentSecrets(workspaceId, env.id, tmpl.secret_selection)  // decrypt
  net     = configureNetwork(tmpl.network)        // static egress / tunnel proxy / privatelink dns
  tools   = preload(tmpl.sandbox_template_tools)  // capabilities/MCP/skills
  req: SandboxRequest = {
         provider: tmpl.provider, runtime: tmpl.runtime,
         resources: tmpl.resources, network: net,
         env: merge(sanitize(modelEnv), secrets),   // §11
         orgId, workspaceId }
  driver = getSandboxDriver(req.provider)
  return driver.run(req) / driver.stream(req)
```

---

### 13. Contracts (new) — capability parity (contract → API → MCP → CLI → docs)

**Environments:** `environment.create` · `environment.list` · `environment.get` · `environment.update` · `environment.delete` · `environment.set_default`
**Sandbox templates:** `sandbox.template.create` · `.list` · `.get` · `.update` · `.delete` · `.set_default` · `sandbox.template.tools.set`
**Vault:** `secret.key.upsert` · `secret.key.list` · `secret.key.delete` · `secret.value.set` · `secret.value.unset` · `secret.import_env` · `secret.reveal` · `secret.export`
**Agent binding:** `agent.environment.bind` · `agent.environment.unbind` · `agent.environment.list`
**Network agent:** `network.agent.create` (returns enrollment token) · `network.agent.list` · `network.agent.revoke`
**Workspace settings:** extend `workspace.settings.write` with `defaultEnvironmentId`.

All scoped (org+workspace from `ctx`, never request). Mutations gated **Owner/Admin**; `secret.reveal`/`secret.export` additionally audit-logged. App call sites add explicit IAM gates (apps/app doesn't bootstrap IAM).

---

### 14. Security & IAM

- **Encryption:** envelope AES-256-GCM via `@oxagen/crypto` + KMS adapter; `value_kms_key_id` per value for rotation. Missing master key ⇒ writes fail loudly, reads return "locked" (never silent plaintext).
- **Reversible export is privileged + audited** (§7.3) — the one place secrets leave encrypted form. Owner/Admin + `secret_access_log`.
- **Trusted vs model env** (§11) keeps Oxagen infra secrets unreachable by prompts while letting customer secrets through.
- **Sandbox isolation** — ephemeral microVM (Modal/Vercel in prod, never Docker); only the run's resolved vault subset is injected; resource/timeout caps; output-size caps.
- **Network least-privilege** — reverse-tunnel agents advertise an explicit reachable allowlist; static-egress documents exact IPs; PrivateLink/PSC are single-service.
- **Default-lifecycle invariants** are DB-enforced (partial unique on `is_default`) *and* handler-guarded, so a workspace can never end up with zero or two defaults.
- **RLS** on all `environments.*` tables; reads via `withTenantDb`, seeds via `withSystemDb`.

---

### 15. Seeding (workspace creation)

At `packages/handlers/src/workspace.create.ts` (after the existing registry/capability/skill seeds, ~line 110), add:
```
const envId  = await seedWorkspaceDefaultEnvironment({ orgId, workspaceId, userId, tx })   // is_default=true
await seedWorkspaceDefaultSandboxTemplate({ orgId, workspaceId, environmentId: envId, userId, tx }) // is_default=true
```
New files `workspace-environment-seed.ts` / `workspace-sandbox-template-seed.ts` mirror `workspace-registry-seed.ts` (both `withTenantDb` and `withSystemDb` variants for the Server-Action path). Backfill script seeds existing workspaces.

---

### 16. UI surfaces (web + TUI)

The vault + environments feature presents through **one web settings page** and **two CLI command groups**. Both surfaces call the *same* contracts (§13) — no drift. OXA-1848/1849/1850 are backend-only; **OXA-1853** builds the web UI from this section. Secrets never travel to a client in plaintext: pages render masked placeholders and `reveal` is a separate, audited round-trip.

#### 16.1 Web — `settings/environments`
- **Route:** `apps/app/src/app/[orgSlug]/[workspaceSlug]/settings/environments/` — server `page.tsx` (resolve org+ws, role-check, fetch masked rows via `runInTenantScope`+`invoke`) → client `environments-panel.tsx` (state) → `environments-actions.ts` server actions (`"use server"`, re-check Owner/Admin, `invoke()`, `revalidatePath`). New declarative entry in `settings/layout.tsx`'s `SettingsNav`. Primitives from `@/components/ui/*` (Button, Input, Switch, Badge, Textarea); hand-rolled `<table>` matrix (matches the integrations-panel convention).
- **Environments bar** (top): chips per environment, the workspace default marked **★**. A **Manage environments** drawer lists each env with `[Set default]` (→ `environment.set_default`) and a `⋯` menu (Rename/Deactivate/Delete via `environment.update`/`delete`). On the ★ default, Deactivate/Delete are **disabled** with the tooltip *"Promote another environment to default first."* — the promote-before-remove guard taught at the affordance, not via a post-click error.

```
SECRETS                            [ + Add key ]  [ Paste .env ]  [ Export ▾ ]
 ┌──────────────┬──────┬────────────┬──────────┬──────────┬──────────┬─────────┐
 │ KEY          │ SENS │ MEMO       │ DEFAULT  │ DEV      │ PREVIEW  │ PROD    │
 ├──────────────┼──────┼────────────┼──────────┼──────────┼──────────┼─────────┤
 │ DATABASE_URL │  ●   │ primary pg │ •••••• 👁│ ‹inherit›│ •••••• 👁│ ••••• 👁│
 │ LOG_LEVEL    │  ○   │ debug|info │ info     │ debug    │ ‹inherit›│ warn    │
 └──────────────┴──────┴────────────┴──────────┴──────────┴──────────┴─────────┘
   ● sensitive (encrypted, masked)  ○ plain config  👁 reveal (logged)  ‹inherit›→Default
```

- **Cell = (key, environment) override.** Click a value cell → inline editor (`secret.value.set`/`unset`); `‹inherit›` cells offer "Set override for ‹env›". The **Default** column edits `secret_keys.default_value` (`secret.key.upsert`). Row-header cells (Key/SENS/Memo) → key editor; toggling `sensitive` re-stores the row (encrypted ↔ plaintext).
- **Paste `.env`** → dialog: paste box → `secret.import_env` returns a **preview** (new vs override, per-target) → confirm → commit. **Export ▾** (`secret.export`, per env → `.env`) and per-cell **👁 reveal** (`secret.reveal`) are Owner/Admin-only and surface a "recorded" toast.

#### 16.2 TUI — `oxagen env` + `oxagen secret`
Flag-driven first (agents/scripts drive these with few tokens — the CLI-over-MCP rationale); `--json` on every read for scripting; Ink only for an optional interactive editor. `fetch()` → `/api/v1/<capability>` with the Bearer token + org/ws scope from `apps/cli/src/lib/config.ts`. New files `apps/cli/src/commands/env.ts` + `secret.ts` (mirror `config.ts`), wired as Commander noun→verb groups in `index.tsx`.

```
$ oxagen env list                     # → environment.list
  NAME         SLUG        DEFAULT  ACTIVE  TEMPLATES
  Default      default     ★        yes     1
  Production   production           yes     2

$ oxagen env set-default production   # → environment.set_default (atomic swap)
  ✓ default environment: Development → Production

$ oxagen secret list --env production # → secret.key.list (resolved per env)
  KEY           SENS  VALUE      SOURCE     MEMO
  DATABASE_URL  ●     ••••••••   override   primary pg
  REDIS_URL     ●     ‹unset›    —          (no default, no override)

$ oxagen secret set LOG_LEVEL debug --env dev --sensitive=false   # key.upsert + value.set
$ oxagen secret import --env prod -f .env.prod                    # import_env → preview; --yes commits
$ oxagen secret reveal DATABASE_URL --env prod                    # reveal  (⚠ recorded)
$ oxagen secret export --env prod -o .env.prod                    # export  (⚠ recorded)
```

- **Verb→contract:** `env list/get/create/rename/rm/set-default` → `environment.*`; `secret list/get/set/unset/import/reveal/export/rm` → `secret.*`. `import` prints a preview and requires `--yes` to commit (mirrors the web preview-then-import); `reveal`/`export` echo `⚠ recorded` (mirrors the web "recorded" toast). `‹unset›`/`‹inherit›` render the resolution rule (§5.5) in the terminal.

#### 16.3 Empty state (what OXA-1848 seeding buys)
A brand-new workspace already shows **one ★ Default environment** and an **empty secrets grid** — never blank-and-broken — because seeding (§15) creates the default env up front. The grid's first row appears on first `Add key` / `Paste .env` / `oxagen secret set`.

---

### 17. Testing

- **Default invariants:** can't create two defaults; can't delete/deactivate the default env/template; promoting another then deleting works; partial-unique blocks races.
- **Resolution:** value(key,E) = override ?? default ?? unset; per-environment correctness; sensitive→encrypted, non-sensitive→plaintext.
- **Crypto round-trip:** encrypt→decrypt equality; rotation via new key id; missing master key fails writes / locks reads.
- **`.env` import:** quotes stripped, comments ignored, `export ` handled, inline-comment-in-quotes preserved; preview vs commit.
- **Reveal/export:** Owner/Admin only; every call writes `secret_access_log`; non-admin denied.
- **Trusted-env boundary:** vault `DATABASE_URL` reaches the sandbox; model-supplied `DATABASE_URL` is stripped; vault wins on conflict.
- **Provisioning:** binding → template → secrets → SandboxRequest assembled correctly; missing binding falls back to defaults; offline reverse-tunnel fails fast.
- **E2E (`apps/app/e2e/`):** create environment → add secret via `.env` paste (sensitive) → create sandbox template (network mode) → bind agent → run → assert env present in sandbox + value never in model-visible payloads; screenshots of the grid, env settings, and a successful run.
- Coverage ratchets per policy (cap 90, ≥2.5% headroom); **test-completeness-judge** before PR.

---

### 18. Phasing

- **Phase 0 — Vault + Environments core.** Tables, crypto service, seeding, `secret.*` + `environment.*` contracts, the Vercel-style grid + `.env` import + reveal/export. (No sandbox changes yet — immediately useful for model-keys/config.)
- **Phase 1 — Sandbox Templates + binding + trusted injection.** Templates (provider/resources/network=`public`/secret selection), preloaded tools, agent bindings, the §11/§12 provisioning path. `static_egress` shipped (publish egress IPs).
- **Phase 2 — Private networking.** `reverse_tunnel` + the Oxagen Network Agent (the in-house-firewall answer); `ssh_bastion`.
- **Phase 3 — Cloud-private + multi-provider.** `aws_privatelink`, `gcp_psc`; provider registry beyond Modal/Vercel; per-template provider selection.
- **Phase 4 — Hardening.** Rotation policies, per-env egress allowlists, network-agent fleet UI, secret versioning/history.

---

### 19. Open decisions (recommendation in **bold**)

1. **Default-sandbox scope:** **per-environment** (each environment has its own default template; "system default sandbox" = default env's default template). Alt: one workspace-wide default (doesn't fit "config by environment").
2. **Where the workspace default-env pointer lives:** **rely on `environments.is_default`** (single source of truth) and surface it in settings; mirror into `workspace.settings` only if the UI needs a cheap read. Alt: store `defaultEnvironmentId` on the workspace row.
3. **Template-local literal env vars:** **vault is the single source of truth; templates only *select* keys** (plus may set non-sensitive literal config). Avoids a second secret store. (Confirm — the ask said "templates need a way of saving env vars"; this reads it as *select + surface*, not *duplicate-store*.)
4. **Schema home:** **new `environments` schema**. Alt: fold into `agent.*` (closer to bindings, but secrets are broader than agents).
5. **Non-sensitive value storage:** **plaintext column** (it's config). Alt: encrypt everything uniformly (simpler code, heavier, and weakens the meaning of `sensitive`).
6. **Reveal/export authority:** **Owner/Admin + audit**. Confirm whether a narrower "secrets manager" role is wanted later.
7. **Secrets grid layout:** **matrix** (keys × [Default + environments]; `‹inherit›` where no override) — DECIDED. Chosen over per-environment tabs: few environments per workspace make the matrix readable, and cross-env comparison (the common task) needs no tab switching. Mockups in §16.1.

---

### 20. Net recommendation

Build Environments, Sandbox Templates, and the Vault as three workspace primitives on top of `@oxagen/crypto`, the workspace-seeding pattern, the `agent_versions` config, and the `@oxagen/sandbox` drivers. Keep **exactly one default** environment (and one default template per environment) with DB-enforced invariants and promote-before-remove semantics. Make the vault the single secret store — workspace-root keys + default value + per-environment overrides, `sensitive` (default true) → encrypted, **with deliberate, audited plaintext export** unlike Vercel. Inject vault secrets into sandboxes through a **trusted channel** that bypasses the model-facing denylist without weakening it. And answer private-network reachability with a **tiered network model** — `static_egress` for allowlistable cloud DBs, `aws_privatelink`/`gcp_psc` for private cloud, and an outbound-only **reverse-tunnel Network Agent** for in-house firewalls — selected per sandbox template. This is the substrate that lets agents and connectors reach a customer's databases wherever they live.

