# Foundations

Archived spec & plan — status: shipped (audited 2026-07-03).

> **Status: Shipped** — verified against the codebase on 2026-07-03 by an automated audit.
>
> The Foundations epic is substantially complete. All core infrastructure, database schemas, tooling commands, and app scaffolding from the spec have been implemented. The monorepo includes a full local development stack (pnpm dev/kill), database migration system (db:migrate/db:check/db:reset), release tooling (pnpm release:patch|minor|major), and CI workflows. All required Postgres schema domains, ClickHouse telemetry tables, and Neo4j ontology packages exist. The apps/app includes auth (Better Auth), workspace/tenant routing, billing integration, and chat persistence. The only minor deviation is apps/web (static HTML site) instead of apps/website (Next.js app).

**Implementation evidence**

- /Users/macanderson/Workspaces/oxagen-platform/package.json — dev/kill/release:patch|minor|major/db:migrate/db:check/db:reset commands defined
- /Users/macanderson/Workspaces/oxagen-platform/docker-compose.dev.yml — Postgres, Neo4j, ClickHouse services configured for local dev (ports 5433, 7687, 8123)
- /Users/macanderson/Workspaces/oxagen-platform/packages/database/src/schema/ — 20 schema files covering auth, billing, chat, agent, workspace, org, workflow, ingestion, mcp, etc.
- /Users/macanderson/Workspaces/oxagen-platform/packages/database/drizzle/ — SQL migrations (0000_baseline.sql through 0031_workspace_memory_policy.sql) with all schema DDL
- /Users/macanderson/Workspaces/oxagen-platform/apps/app/src/app/(auth)/ — auth routes (login, signup, forgot-password, reset-password, verify)
- /Users/macanderson/Workspaces/oxagen-platform/apps/app/src/app/[orgSlug]/ — tenant/workspace routing with [workspaceSlug] subpaths (billing, members, access, settings, chat, knowledge)
- /Users/macanderson/Workspaces/oxagen-platform/apps/app/package.json — better-auth 1.6.11 dependency installed
- /Users/macanderson/Workspaces/oxagen-platform/apps/api/src/routes/v1/ — 212 API route files including auth.*, billing.*, conversation.* routes
- /Users/macanderson/Workspaces/oxagen-platform/apps/mcp/src/tools/ — 264 MCP tool implementations
- /Users/macanderson/Workspaces/oxagen-platform/packages/telemetry/ — ClickHouse telemetry client for runtime events
- /Users/macanderson/Workspaces/oxagen-platform/packages/ontology/ — Neo4j ontology package for graph schema and vector embeddings
- /Users/macanderson/Workspaces/oxagen-platform/.github/workflows/ — CI/CD pipelines (ci-test.yml, pipeline.yml, release.yml, vision-gate.yml, nightly.yml)

**Known gaps at time of archive**

- apps/website as a Next.js app (implemented as static apps/web instead, deployed to Vercel separately)

**Source documents** (archived verbatim below)

- `docs/specs/foundations/spec.md`
- `docs/specs/foundations/plan.md`

## Spec — `spec.md`

## Foundations — Design Specification

### 1. Scope

This document specifies the foundational layer of the Oxagen platform:
monorepo scaffolding, datastore schemas, secrets policy, local
development workflow, and release tooling.

Out of scope: feature-specific business logic, marketplace plugin design,
UI/UX of individual apps.

### 2. Goals and Acceptance Criteria

The epic is complete when **all** of the following are true.

#### 2.1 Infra and tooling

1. `pnpm dev` brings the full stack up locally — `apps/api`, `apps/mcp`,
   `apps/app`, `apps/website` — each reachable on a stable
   port, against Dockerized Postgres, Neo4j, and ClickHouse.
2. `pnpm kill` cleanly tears down the stack and removes orphaned
   containers and volumes.
3. `pnpm release:patch|minor|major` bumps versions across the monorepo,
   tags the release, and produces a changelog.
4. All secrets resolve through Google Secret Manager. No `.env` files
   committed. No secrets in CI YAML. No secrets in process arguments.
5. Postgres, Neo4j, and ClickHouse schemas defined here are created via
   versioned migrations and verified by `pnpm db:check`.
6. CI runs typecheck, lint, unit tests, and migration smoke against a
   throwaway Docker stack on every PR.

#### 2.2 `apps/website`

Hello-world page. Nothing else.

#### 2.3 `apps/app` — shipped features

1. **Auth.** Login, logout, session management.
2. **Tenant management.** Create tenant, switch tenant, list tenants
   the user belongs to. Slug-based routing per §4.
3. **Workspace management.** Create workspace within a tenant, switch
   workspace, list workspaces.
4. **Tenant user management.** Invite users to a tenant, assign roles,
   revoke access (`organization.tenant_users` CRUD).
5. **Workspace user management.** Invite users to a workspace, assign
   roles (`workspace.workspace_users` CRUD).
6. **Full billing suite** at the tenant level (§6.13):
   - Plan selection and upgrade/downgrade.
   - Payment method management (Stripe Elements).
   - Active subscription view with renewal, cancellation, and
     reactivation.
   - Invoice history with hosted invoice / PDF links.
   - Usage display: current-period token usage and cost rolled up
     from ClickHouse.
   - Credit balance and ledger view.
7. **Interactive agent shell.** Built on Vercel AI SDK + React Server
   Components streaming. Conversations and messages persist per §6.9.
   The agent surface is wired, but the agent build-out (capability
   library, tool registry UI) is **out of scope** for this epic —
   tables exist, UIs are stubbed.

#### 2.4 Explicitly out of scope

- Agent authoring UI, playbook authoring UI, execution monitoring UI.
- Plugin/marketplace surfaces.
- Public API documentation site.
- Production deployment to GCP — local + CI only.

Tables for the above (agent, workflow, execution, etc.) **are** created
and migrated. UI for them is not.

### 3. Datastore Boundaries

Per `CLAUDE.md` — authoritative:

| Store      | Purpose                                                    |
|------------|------------------------------------------------------------|
| PostgreSQL | Transactional state: users, orgs, billing, configs, definitions, durable job metadata |
| Neo4j      | Ontology, semantic relationships, agent memory, workflow lineage, execution graphs |
| ClickHouse | Append-only runtime events: logs, metrics, traces, token usage, execution telemetry, API access events |

Violations of this boundary block merge.

### 4. Identity and Routing

#### 4.1 Identifier strategy

| Concern                         | Strategy   |
|---------------------------------|------------|
| Internal relational identity    | `UUIDv7`   |
| Public API references           | `public_id` (prefixed string) |
| Human-readable URLs             | `slug`     |

**Never expose internal UUIDs in URLs or public API responses.**

#### 4.2 URL structure

```
/:tenant_slug/:workspace_slug/...
```

#### 4.3 Public ID prefixes

| Prefix | Entity            |
|--------|-------------------|
| `ten_` | tenant            |
| `wrk_` | workspace         |
| `usr_` | user              |
| `agt_` | agent             |
| `pbk_` | playbook          |
| `exe_` | execution         |
| `tol_` | tool              |
| `doc_` | document          |

New prefixes require an ADR.

#### 4.4 Slug uniqueness

- Tenant slugs: globally unique.
- Workspace slugs: unique within tenant.

#### 4.5 Slug history

Slug renames preserve old URLs via `*_slug_history` tables with
`redirect_enabled`. Resolution checks current slug, then history.

### 5. Schema Mixins

Reusable column groups. Implementations apply mixins as Drizzle schema
helpers; migrations should be hand-written for clarity.

#### 5.1 `id_mixin`

| Column      | Type                                              |
|-------------|---------------------------------------------------|
| `id`        | `uuid primary key default uuid_generate_v7()`     |
| `public_id` | `text unique not null` (prefixed, see §4.3)       |

#### 5.2 `audit_mixin`

| Column                | Type                                       |
|-----------------------|--------------------------------------------|
| `created_at`          | `timestamptz not null default now()`       |
| `updated_at`          | `timestamptz not null default now()`       |
| `created_by_user_id`  | `uuid null`                                |
| `updated_by_user_id`  | `uuid null`                                |

#### 5.3 `soft_delete_mixin`

| Column                | Type              |
|-----------------------|-------------------|
| `deleted_at`          | `timestamptz null`|
| `deleted_by_user_id`  | `uuid null`       |

Hard deletes are prohibited on tenant-scoped tables.

#### 5.4 `tenant_scope_mixin`

| Column         | Type              |
|----------------|-------------------|
| `tenant_id`    | `uuid not null`   |
| `workspace_id` | `uuid not null`   |

Required on all tenant-owned tables to eliminate authorization joins.

#### 5.5 `version_mixin`

| Column              | Type                                  |
|---------------------|---------------------------------------|
| `version_number`    | `integer not null`                    |
| `is_latest`         | `boolean not null default false`      |
| `parent_version_id` | `uuid null`                           |
| `published_at`      | `timestamptz null`                    |

#### 5.6 `execution_status_mixin`

| Column         | Type                |
|----------------|---------------------|
| `status`       | `text not null`     |
| `started_at`   | `timestamptz null`  |
| `completed_at` | `timestamptz null`  |
| `failed_at`    | `timestamptz null`  |
| `cancelled_at` | `timestamptz null`  |

Allowed `status` values: `pending`, `queued`, `running`, `completed`,
`failed`, `cancelled`, `timed_out`. Enforced via `check` constraint, not
Postgres enum (eases migration).

#### 5.7 `json_contract_mixin`

| Column          | Type                              |
|-----------------|-----------------------------------|
| `input_schema`  | `jsonb not null`                  |
| `output_schema` | `jsonb not null`                  |
| `config`        | `jsonb not null default '{}'`     |
| `metadata`      | `jsonb not null default '{}'`     |

### 6. Postgres Schema

Domains: `auth` (§6.2), `organization` (§6.1), `workspace` (§6.3),
`integration` (§6.4), `agent` (§6.5), `workflow` (§6.6),
`event` (§6.7), `execution` (§6.8), `chat` (§6.9), `content` (§6.10),
`graph` (§6.11), `evaluation` (§6.12), `billing` (§6.13).

#### 6.1 `organization`

##### `organization.tenants`

Mixins: `id_mixin`, `audit_mixin`.

| Column      | Type                                |
|-------------|-------------------------------------|
| `name`      | `text not null`                     |
| `slug`      | `citext unique not null`            |
| `plan_type` | `text not null`                     |
| `status`    | `text not null`                     |
| `settings`  | `jsonb not null default '{}'`       |

##### `organization.tenant_users`

Mixins: `id_mixin`, `audit_mixin`.

| Column        | Type                              |
|---------------|-----------------------------------|
| `tenant_id`   | `uuid not null`                   |
| `user_id`     | `uuid not null`                   |
| `role`        | `text not null`                   |
| `permissions` | `jsonb not null default '{}'`     |
| `joined_at`   | `timestamptz not null`            |

Constraint: `unique (tenant_id, user_id)`.

##### `organization.tenant_slug_history`

| Column              | Type                                  |
|---------------------|---------------------------------------|
| `id`                | `uuid primary key`                    |
| `tenant_id`         | `uuid not null`                       |
| `old_slug`          | `citext not null`                     |
| `new_slug`          | `citext not null`                     |
| `changed_at`        | `timestamptz not null`                |
| `redirect_enabled`  | `boolean not null default true`       |

#### 6.2 `auth`

##### `auth.users`

Mixins: `id_mixin`, `audit_mixin`, `soft_delete_mixin`.

| Column                | Type                       |
|-----------------------|----------------------------|
| `email`               | `citext unique not null`   |
| `username`            | `citext unique null`       |
| `display_name`        | `text null`                |
| `avatar_url`          | `text null`                |
| `status`              | `text not null`            |
| `email_verified_at`   | `timestamptz null`         |
| `last_login_at`       | `timestamptz null`         |

##### `auth.credentials`

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`,
`soft_delete_mixin`.

| Column              | Type                  |
|---------------------|-----------------------|
| `provider`          | `text not null`       |
| `credential_type`   | `text not null`       |
| `encrypted_payload` | `bytea not null`      |
| `kms_key_id`        | `text null`           |
| `expires_at`        | `timestamptz null`    |
| `last_used_at`      | `timestamptz null`    |

##### `auth.api_keys`

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`,
`soft_delete_mixin`.

| Column          | Type                       |
|-----------------|----------------------------|
| `key_prefix`    | `text unique not null`     |
| `key_hash`      | `text not null`            |
| `name`          | `text not null`            |
| `scope`         | `jsonb not null`           |
| `expires_at`    | `timestamptz null`         |
| `last_used_at`  | `timestamptz null`         |

API key usage events live in ClickHouse (§7).

#### 6.3 `workspace`

##### `workspace.workspaces`

Mixins: `id_mixin`, `audit_mixin`.

| Column               | Type                              |
|----------------------|-----------------------------------|
| `tenant_id`          | `uuid not null`                   |
| `name`               | `text not null`                   |
| `slug`               | `citext not null`                 |
| `default_graph_id`   | `uuid null`                       |
| `settings`           | `jsonb not null default '{}'`     |

Constraint: `unique (tenant_id, slug)`.

##### `workspace.workspace_users`

Workspace-level RBAC. Required for shared workspaces, external
collaborators, and scoped agent permissions.

Mixins: `id_mixin`, `audit_mixin`.

| Column         | Type                              |
|----------------|-----------------------------------|
| `workspace_id` | `uuid not null`                   |
| `user_id`      | `uuid not null`                   |
| `role`         | `text not null`                   |
| `permissions`  | `jsonb not null default '{}'`     |
| `joined_at`    | `timestamptz not null`            |

Constraint: `unique (workspace_id, user_id)`.

##### `workspace.folders`

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`.

| Column              | Type              |
|---------------------|-------------------|
| `parent_folder_id`  | `uuid null`       |
| `name`              | `text not null`   |
| `path`              | `ltree not null`  |

Path uses `ltree` for efficient subtree queries.

##### `workspace.workspace_slug_history`

| Column              | Type                                  |
|---------------------|---------------------------------------|
| `id`                | `uuid primary key`                    |
| `workspace_id`      | `uuid not null`                       |
| `old_slug`          | `citext not null`                     |
| `new_slug`          | `citext not null`                     |
| `changed_at`        | `timestamptz not null`                |
| `redirect_enabled`  | `boolean not null default true`       |

#### 6.4 `integration`

##### `integration.connections`

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`,
`soft_delete_mixin`.

| Column            | Type                              |
|-------------------|-----------------------------------|
| `provider`        | `text not null`                   |
| `display_name`    | `text not null`                   |
| `credential_id`   | `uuid null`                       |
| `status`          | `text not null`                   |
| `sync_enabled`    | `boolean not null default true`   |
| `last_sync_at`    | `timestamptz null`                |
| `config`          | `jsonb not null`                  |

##### `integration.connection_sync_jobs`

Mixins: `id_mixin`, `execution_status_mixin`.

| Column                | Type                              |
|-----------------------|-----------------------------------|
| `connection_id`       | `uuid not null`                   |
| `started_cursor`      | `text null`                       |
| `completed_cursor`    | `text null`                       |
| `records_processed`   | `bigint not null default 0`       |
| `error_payload`       | `jsonb null`                      |

#### 6.5 `agent`

##### `agent.agents`

Logical agent identity. Mixins: `id_mixin`, `audit_mixin`,
`tenant_scope_mixin`, `soft_delete_mixin`.

| Column            | Type                                  |
|-------------------|---------------------------------------|
| `name`            | `text not null`                       |
| `slug`            | `citext not null`                     |
| `description`     | `text null`                           |
| `default_model`   | `text not null`                       |
| `is_system_agent` | `boolean not null default false`      |

##### `agent.agent_versions`

Immutable snapshot. Mixins: `id_mixin`, `audit_mixin`,
`tenant_scope_mixin`, `version_mixin`, `json_contract_mixin`.

| Column                | Type                              |
|-----------------------|-----------------------------------|
| `agent_id`            | `uuid not null`                   |
| `system_prompt`       | `text not null`                   |
| `model`               | `text not null`                   |
| `temperature`         | `numeric(3,2) not null`           |
| `context_window`      | `integer null`                    |
| `tool_choice_policy`  | `text not null`                   |
| `runtime_config`      | `jsonb not null default '{}'`     |

##### `agent.tools`

Logical tool identity. Mixins: `id_mixin`, `audit_mixin`,
`tenant_scope_mixin`.

| Column        | Type                              |
|---------------|-----------------------------------|
| `name`        | `text not null`                   |
| `slug`        | `citext not null`                 |
| `tool_type`   | `text not null`                   |
| `description` | `text not null`                   |
| `is_enabled`  | `boolean not null default true`   |

##### `agent.tool_versions`

Immutable tool snapshot. Required for deterministic replay.

Mixins: `id_mixin`, `audit_mixin`, `version_mixin`.

| Column               | Type                              |
|----------------------|-----------------------------------|
| `tool_id`            | `uuid not null`                   |
| `input_schema`       | `jsonb not null`                  |
| `output_schema`      | `jsonb not null`                  |
| `runtime_config`     | `jsonb not null default '{}'`     |
| `execution_handler`  | `text not null`                   |
| `execution_mode`     | `text not null`                   |
| `timeout_seconds`    | `integer not null`                |

##### `agent.tool_assignments`

Mixins: `id_mixin`.

| Column              | Type              |
|---------------------|-------------------|
| `agent_version_id`  | `uuid not null`   |
| `tool_version_id`   | `uuid not null`   |
| `policy_config`     | `jsonb not null`  |

Assignments reference `tool_version_id`, not `tool_id` — required for
replay determinism.

##### `agent.mcp_servers`

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`.

| Column                | Type                  |
|-----------------------|-----------------------|
| `name`                | `text not null`       |
| `transport_type`      | `text not null`       |
| `endpoint_url`        | `text not null`       |
| `auth_strategy`       | `text not null`       |
| `health_status`       | `text not null`       |
| `last_healthcheck_at` | `timestamptz null`    |

#### 6.6 `workflow`

##### `workflow.playbooks`

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`,
`soft_delete_mixin`.

| Column        | Type              |
|---------------|-------------------|
| `name`        | `text not null`   |
| `slug`        | `citext not null` |
| `description` | `text null`       |

##### `workflow.playbook_versions`

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`, `version_mixin`.

| Column              | Type                              |
|---------------------|-----------------------------------|
| `playbook_id`       | `uuid not null`                   |
| `entry_step_id`     | `uuid null`                       |
| `graph_definition`  | `jsonb not null`                  |
| `is_active`         | `boolean not null default false`  |

##### `workflow.playbook_steps`

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`,
`json_contract_mixin`.

| Column                  | Type                              |
|-------------------------|-----------------------------------|
| `playbook_version_id`   | `uuid not null`                   |
| `step_key`              | `text not null`                   |
| `step_type`             | `text not null`                   |
| `prompt_template_id`    | `uuid null`                       |
| `execution_order`       | `integer null`                    |
| `retry_policy`          | `jsonb not null default '{}'`     |
| `timeout_policy`        | `jsonb not null default '{}'`     |

##### `workflow.playbook_step_assignments`

Mixins: `id_mixin`.

| Column              | Type                              |
|---------------------|-----------------------------------|
| `playbook_step_id`  | `uuid not null`                   |
| `agent_version_id`  | `uuid not null`                   |
| `model_override`    | `text null`                       |
| `max_retries`       | `integer not null default 0`      |
| `timeout_seconds`   | `integer null`                    |

##### `workflow.prompt_templates`

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`.

| Column | Type              |
|--------|-------------------|
| `name` | `text not null`   |
| `slug` | `citext not null` |

##### `workflow.prompt_template_versions`

Mixins: `id_mixin`, `audit_mixin`, `version_mixin`.

| Column                 | Type              |
|------------------------|-------------------|
| `prompt_template_id`   | `uuid not null`   |
| `system_prompt`        | `text not null`   |
| `user_prompt`          | `text not null`   |
| `template_variables`   | `jsonb not null`  |

#### 6.7 `event`

Trigger definitions. Event *occurrences* live in ClickHouse (§7).

##### `event.triggers`

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`.

| Column              | Type                              |
|---------------------|-----------------------------------|
| `name`              | `text not null`                   |
| `event_type`        | `text not null`                   |
| `filter_expression` | `jsonb not null`                  |
| `is_enabled`        | `boolean not null default true`   |

##### `event.workflow_triggers`

Mixins: `id_mixin`.

| Column                  | Type              |
|-------------------------|-------------------|
| `trigger_id`            | `uuid not null`   |
| `playbook_version_id`   | `uuid not null`   |

#### 6.8 `execution`

Durable execution records. Step-level logs and traces live in
ClickHouse (§7).

##### `execution.executions`

Mixins: `id_mixin`, `execution_status_mixin`.

| Column                  | Type              |
|-------------------------|-------------------|
| `tenant_id`                 | `uuid not null`   |
| `workspace_id`              | `uuid not null`   |
| `playbook_version_id`       | `uuid not null`   |
| `trigger_event_id`          | `uuid null`       |
| `triggered_by_message_id`   | `uuid null`       |
| `started_by_user_id`        | `uuid null`       |
| `input_payload`             | `jsonb not null`  |
| `output_payload`            | `jsonb null`      |
| `failure_reason`            | `text null`       |

Inputs and outputs are immutable once written.
`triggered_by_message_id` links an execution back to the
`chat.messages` row that initiated it (when the trigger was a chat
turn). At most one of `trigger_event_id` and `triggered_by_message_id`
is non-null.

##### `execution.execution_steps`

Mixins: `id_mixin`, `execution_status_mixin`.

| Column              | Type                                  |
|---------------------|---------------------------------------|
| `execution_id`      | `uuid not null`                       |
| `playbook_step_id`  | `uuid not null`                       |
| `agent_version_id`  | `uuid not null`                       |
| `attempt_number`    | `integer not null default 1`          |
| `input_payload`     | `jsonb not null`                      |
| `output_payload`    | `jsonb null`                          |
| `token_usage`       | `jsonb null`                          |
| `latency_ms`        | `bigint null`                         |
| `failure_reason`    | `text null`                           |

##### `execution.tool_calls`

Mixins: `id_mixin`.

| Column                | Type                  |
|-----------------------|-----------------------|
| `execution_step_id`   | `uuid not null`       |
| `tool_version_id`     | `uuid not null`       |
| `request_payload`     | `jsonb not null`      |
| `response_payload`    | `jsonb null`          |
| `latency_ms`          | `bigint null`         |
| `token_usage`         | `jsonb null`          |
| `status`              | `text not null`       |
| `created_at`          | `timestamptz not null`|

##### `execution.execution_artifacts`

Artifacts produced by an execution (PDFs, reports, traces, embeddings).
Keeps the executions table small.

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`.

| Column          | Type                              |
|-----------------|-----------------------------------|
| `execution_id`  | `uuid not null`                   |
| `artifact_type` | `text not null`                   |
| `document_id`   | `uuid null`                       |
| `storage_uri`   | `text null`                       |
| `metadata`      | `jsonb not null default '{}'`     |

#### 6.9 `chat`

Conversations and messages are Claude-style: messages form a DAG, not
a flat list. Editing or regenerating a message creates a sibling
branch rather than overwriting history. The UI selects an *active leaf*
to render a linear view.

##### `chat.conversations`

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`.

| Column                   | Type              |
|--------------------------|-------------------|
| `user_id`                | `uuid not null`   |
| `agent_version_id`       | `uuid null`       |
| `title`                  | `text null`       |
| `status`                 | `text not null`   |
| `active_leaf_message_id` | `uuid null`       |

`active_leaf_message_id` is the currently-rendered tip of the message
DAG. The UI walks parents from this node to reconstruct the visible
conversation.

##### `chat.messages`

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`.

| Column                  | Type              |
|-------------------------|-------------------|
| `conversation_id`       | `uuid not null`   |
| `parent_message_id`     | `uuid null`       |
| `role`                  | `text not null`   |
| `content`               | `text not null`   |
| `content_blocks`        | `jsonb not null`  |
| `branch_reason`         | `text null`       |
| `is_active_in_branch`   | `boolean not null default true` |
| `metadata`              | `jsonb not null`  |

- `parent_message_id` references the message this one continues from.
  Root messages (first user turn) have `null`.
- Multiple messages may share a `parent_message_id` — those are
  sibling branches (edit, regenerate, or alternate response).
- `branch_reason` records *why* a branch exists: `edit`, `regenerate`,
  `tool_retry`, `manual_fork`. Null for the original path.
- `is_active_in_branch` marks whether this node is part of the path
  the user last selected. Branch-switching flips these flags within
  the conversation.
- `token_usage` lives in ClickHouse `token_usage` (§7.6), keyed by
  message id. Not stored on the Postgres row.

Constraints:
- `parent_message_id` foreign key to `chat.messages(id)` within the
  same `conversation_id` (enforced in app layer).
- Index `(conversation_id, parent_message_id)` for fast tree
  traversal.

#### 6.10 `content`

Logical documents and physical files are separated to enable
versioning, deduplication, retention policies, and CDN migration.

##### `content.files`

Physical storage object.

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`.

| Column              | Type                  |
|---------------------|-----------------------|
| `storage_provider`  | `text not null`       |
| `storage_bucket`    | `text not null`       |
| `storage_key`       | `text not null`       |
| `mime_type`         | `text not null`       |
| `size_bytes`        | `bigint not null`     |
| `checksum_sha256`   | `text not null`       |
| `uploaded_at`       | `timestamptz not null`|

Constraint: `unique (storage_provider, storage_bucket, storage_key)`.

##### `content.documents`

Logical document metadata. References a `files` row.

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`.

| Column              | Type              |
|---------------------|-------------------|
| `file_id`           | `uuid not null`   |
| `folder_id`         | `uuid null`       |
| `title`             | `text not null`   |
| `document_type`     | `text not null`   |
| `embedding_status`  | `text not null`   |

##### `content.content_generations`

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`.

| Column                  | Type              |
|-------------------------|-------------------|
| `execution_step_id`     | `uuid not null`   |
| `generation_type`       | `text not null`   |
| `source_document_ids`   | `uuid[] null`     |
| `output_document_id`    | `uuid null`       |
| `recipe_config`         | `jsonb not null`  |

#### 6.11 `graph`

##### `graph.graph_providers`

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`.

| Column          | Type              |
|-----------------|-------------------|
| `provider_type` | `text not null`   |
| `display_name`  | `text not null`   |
| `connection_id` | `uuid null`       |
| `status`        | `text not null`   |

##### `graph.routing_rules`

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`.

| Column              | Type              |
|---------------------|-------------------|
| `rule_name`         | `text not null`   |
| `match_expression`  | `jsonb not null`  |
| `target_graph_id`   | `uuid not null`   |
| `priority`          | `integer not null`|

#### 6.12 `evaluation`

##### `evaluation.evals`

Mixins: `id_mixin`, `audit_mixin`, `tenant_scope_mixin`.

| Column           | Type              |
|------------------|-------------------|
| `name`           | `text not null`   |
| `eval_type`      | `text not null`   |
| `dataset_config` | `jsonb not null`  |

##### `evaluation.eval_runs`

Mixins: `id_mixin`, `execution_status_mixin`.

| Column              | Type                  |
|---------------------|-----------------------|
| `eval_id`           | `uuid not null`       |
| `agent_version_id`  | `uuid not null`       |
| `score`             | `numeric(5,2) null`   |
| `results_payload`   | `jsonb not null`      |

#### 6.13 `billing`

Stripe is the payment provider. Postgres holds plan catalogue,
subscriptions, payment method references, invoice mirrors, and a
credit ledger. Raw usage events live in ClickHouse (§7.6); periodic
rollups land in `billing.usage_records` for invoicing.

Idempotency: every Stripe webhook is persisted to
`billing.stripe_events` before any state change. Re-processing the
same `stripe_event_id` is a no-op.

##### `billing.plans`

Catalogue of subscription plans. Seeded; rarely changes.

Mixins: `id_mixin`, `audit_mixin`.

| Column                     | Type                              |
|----------------------------|-----------------------------------|
| `name`                     | `text not null`                   |
| `slug`                     | `citext unique not null`          |
| `tier`                     | `text not null`                   |
| `stripe_product_id`        | `text not null`                   |
| `stripe_price_id_monthly`  | `text null`                       |
| `stripe_price_id_annual`   | `text null`                       |
| `monthly_cents`            | `integer not null`                |
| `annual_cents`             | `integer null`                    |
| `included_credit_cents`    | `integer not null default 0`      |
| `included_seats`           | `integer not null default 1`      |
| `features`                 | `jsonb not null default '{}'`     |
| `is_public`                | `boolean not null default true`   |

##### `billing.subscriptions`

One active subscription per tenant. Historical rows retained.

Mixins: `id_mixin`, `audit_mixin`.

| Column                       | Type                              |
|------------------------------|-----------------------------------|
| `tenant_id`                  | `uuid not null`                   |
| `plan_id`                    | `uuid not null`                   |
| `stripe_subscription_id`     | `text unique not null`            |
| `stripe_customer_id`         | `text not null`                   |
| `status`                     | `text not null`                   |
| `billing_interval`           | `text not null`                   |
| `current_period_start`       | `timestamptz not null`            |
| `current_period_end`         | `timestamptz not null`            |
| `cancel_at_period_end`       | `boolean not null default false`  |
| `canceled_at`                | `timestamptz null`                |
| `trial_end`                  | `timestamptz null`                |
| `seat_count`                 | `integer not null default 1`      |

Allowed `status`: `trialing`, `active`, `past_due`, `canceled`,
`incomplete`, `incomplete_expired`, `unpaid`, `paused`. Mirrors Stripe.

Index: `(tenant_id, status)` for "active subscription for tenant" lookup.

##### `billing.payment_methods`

Stripe payment method references. No raw card data ever in Postgres.

Mixins: `id_mixin`, `audit_mixin`, `soft_delete_mixin`.

| Column                       | Type                              |
|------------------------------|-----------------------------------|
| `tenant_id`                  | `uuid not null`                   |
| `stripe_customer_id`         | `text not null`                   |
| `stripe_payment_method_id`   | `text unique not null`            |
| `type`                       | `text not null`                   |
| `brand`                      | `text null`                       |
| `last4`                      | `text null`                       |
| `exp_month`                  | `integer null`                    |
| `exp_year`                   | `integer null`                    |
| `is_default`                 | `boolean not null default false`  |

Constraint: at most one `is_default = true` per `tenant_id` (partial
unique index).

##### `billing.invoices`

Mirror of Stripe invoices for in-app display.

Mixins: `id_mixin`, `audit_mixin`.

| Column                  | Type                              |
|-------------------------|-----------------------------------|
| `tenant_id`             | `uuid not null`                   |
| `subscription_id`       | `uuid null`                       |
| `stripe_invoice_id`     | `text unique not null`            |
| `number`                | `text null`                       |
| `status`                | `text not null`                   |
| `amount_due_cents`      | `integer not null`                |
| `amount_paid_cents`     | `integer not null default 0`      |
| `amount_remaining_cents`| `integer not null`                |
| `currency`              | `text not null default 'usd'`     |
| `period_start`          | `timestamptz not null`            |
| `period_end`            | `timestamptz not null`            |
| `due_at`                | `timestamptz null`                |
| `paid_at`               | `timestamptz null`                |
| `hosted_invoice_url`    | `text null`                       |
| `invoice_pdf_url`       | `text null`                       |

Allowed `status`: `draft`, `open`, `paid`, `void`, `uncollectible`.

##### `billing.invoice_line_items`

Mixins: `id_mixin`.

| Column                | Type                  |
|-----------------------|-----------------------|
| `invoice_id`          | `uuid not null`       |
| `description`         | `text not null`       |
| `quantity`            | `numeric(18,4) not null` |
| `unit_amount_cents`   | `integer not null`    |
| `total_cents`         | `integer not null`    |
| `metric`              | `text null`           |
| `metadata`            | `jsonb not null default '{}'` |

##### `billing.usage_records`

Rollup snapshots from ClickHouse `token_usage` (§7.6), keyed by
subscription period and metric. Written by a scheduled job; the
basis for invoice line items.

Mixins: `id_mixin`, `audit_mixin`.

| Column              | Type                  |
|---------------------|-----------------------|
| `tenant_id`         | `uuid not null`       |
| `subscription_id`   | `uuid not null`       |
| `metric`            | `text not null`       |
| `quantity`          | `numeric(20,6) not null` |
| `unit_cost_micros`  | `bigint not null`     |
| `total_cost_micros` | `bigint not null`     |
| `period_start`      | `timestamptz not null`|
| `period_end`        | `timestamptz not null`|
| `source_query_id`   | `text null`           |

Initial metrics: `tokens_input`, `tokens_output`, `tokens_cached`,
`executions`, `tool_calls`.

Constraint: `unique (subscription_id, metric, period_start, period_end)`.

##### `billing.credit_balances`

Current credit balance per tenant. Updated atomically with each ledger
entry.

Mixins: `id_mixin`, `audit_mixin`.

| Column            | Type                  |
|-------------------|-----------------------|
| `tenant_id`       | `uuid unique not null`|
| `balance_cents`   | `bigint not null default 0` |
| `last_event_at`   | `timestamptz null`    |

##### `billing.credit_ledger`

Append-only ledger of credit grants and consumption.

Mixins: `id_mixin`.

| Column            | Type                              |
|-------------------|-----------------------------------|
| `tenant_id`       | `uuid not null`                   |
| `delta_cents`     | `bigint not null`                 |
| `reason`          | `text not null`                   |
| `reference_type`  | `text null`                       |
| `reference_id`    | `uuid null`                       |
| `created_by_user_id` | `uuid null`                    |
| `created_at`      | `timestamptz not null default now()` |

Allowed `reason`: `grant_signup`, `grant_plan_renewal`, `grant_manual`,
`consume_execution`, `consume_tool_call`, `consume_token_overage`,
`refund`, `adjustment`.

Index: `(tenant_id, created_at desc)`.

##### `billing.stripe_events`

Idempotent webhook log. Insert with `on conflict do nothing` on
`stripe_event_id`. Processing happens after insert.

Mixins: `id_mixin`.

| Column              | Type                              |
|---------------------|-----------------------------------|
| `stripe_event_id`   | `text unique not null`            |
| `event_type`        | `text not null`                   |
| `api_version`       | `text null`                       |
| `payload`           | `jsonb not null`                  |
| `received_at`       | `timestamptz not null default now()` |
| `processed_at`      | `timestamptz null`                |
| `processing_error`  | `text null`                       |

### 7. ClickHouse Schema

All append-only runtime telemetry. Tables partitioned by month on
`emitted_at` / `created_at`. TTL policies set per table (default: 90
days for raw, materialized rollups retained longer).

#### 7.1 `execution_logs`

| Column          | Type              |
|-----------------|-------------------|
| `execution_id`  | `UUID`            |
| `step_id`       | `UUID`            |
| `tenant_id`     | `UUID`            |
| `workspace_id`  | `UUID`            |
| `log_level`     | `LowCardinality(String)` |
| `message`       | `String`          |
| `metadata`      | `String` (JSON)   |
| `created_at`    | `DateTime64(3)`   |

Order by: `(tenant_id, execution_id, created_at)`.

#### 7.2 `traces`

| Column          | Type              |
|-----------------|-------------------|
| `trace_id`      | `String`          |
| `execution_id`  | `UUID`            |
| `tenant_id`     | `UUID`            |
| `started_at`    | `DateTime64(3)`   |
| `completed_at`  | `Nullable(DateTime64(3))` |

#### 7.3 `spans`

| Column          | Type              |
|-----------------|-------------------|
| `span_id`       | `String`          |
| `trace_id`      | `String`          |
| `parent_span_id`| `Nullable(String)`|
| `span_type`     | `LowCardinality(String)` |
| `tenant_id`     | `UUID`            |
| `started_at`    | `DateTime64(3)`   |
| `completed_at`  | `Nullable(DateTime64(3))` |
| `metadata`      | `String` (JSON)   |

#### 7.4 `events`

| Column          | Type              |
|-----------------|-------------------|
| `event_id`      | `UUID`            |
| `tenant_id`     | `UUID`            |
| `workspace_id`  | `UUID`            |
| `event_type`    | `LowCardinality(String)` |
| `source_system` | `LowCardinality(String)` |
| `stream_offset` | `Nullable(String)`|
| `payload`       | `String` (JSON)   |
| `emitted_at`    | `DateTime64(3)`   |

#### 7.5 `api_key_events`

| Column          | Type              |
|-----------------|-------------------|
| `api_key_id`    | `UUID`            |
| `tenant_id`     | `UUID`            |
| `ip_address`    | `IPv6`            |
| `user_agent`    | `String`          |
| `request_path`  | `String`          |
| `response_code` | `UInt16`          |
| `created_at`    | `DateTime64(3)`   |

#### 7.6 `token_usage`

| Column              | Type              |
|---------------------|-------------------|
| `execution_step_id` | `UUID`            |
| `tenant_id`         | `UUID`            |
| `model`             | `LowCardinality(String)` |
| `input_tokens`      | `UInt64`          |
| `output_tokens`     | `UInt64`          |
| `cached_tokens`     | `UInt64`          |
| `cost_usd_micros`   | `UInt64`          |
| `created_at`        | `DateTime64(3)`   |

### 8. Neo4j Schema

Graph constructs and vector embeddings. Node and edge types defined
explicitly in `/packages/ontology`.

**Node labels (initial):** `Tenant`, `Workspace`, `User`, `Agent`,
`AgentVersion`, `Tool`, `ToolVersion`, `Playbook`, `PlaybookVersion`,
`Execution`, `Document`, `AgentMemory`, `Conversation`, `Message`.

**Edge types (initial):** `OWNS`, `MEMBER_OF`, `USES_TOOL`,
`EXECUTED`, `PRODUCED`, `DERIVED_FROM`, `TRIGGERED_BY`, `REFERENCES`,
`REMEMBERS`, `SIMILAR_TO`, `REPLIES_TO`, `BRANCHED_FROM`.

Chat-specific semantics:
- `(:Message)-[:REPLIES_TO]->(:Message)` mirrors
  `chat.messages.parent_message_id` for graph-native traversal.
- `(:Message)-[:BRANCHED_FROM]->(:Message)` connects sibling branches
  to their common parent — convenient for "show me all the
  regenerations of this turn" queries.
- `(:Message)-[:TRIGGERED]->(:Execution)` mirrors
  `execution.executions.triggered_by_message_id`.
- `(:Message)-[:REFERENCES]->(:Document)` for retrieval context.
- `(:Conversation)-[:CONTAINS]->(:Message)` for scoping.

#### 8.1 Vector embeddings

Embeddings are stored as vector properties on nodes (Neo4j native
vector index, requires Neo4j 5.13+).

| Node label    | Property     | Index name                   |
|---------------|--------------|------------------------------|
| `Document`    | `embedding`  | `document_embedding_index`   |
| `AgentMemory` | `embedding`  | `memory_embedding_index`     |
| `Message`     | `embedding`  | `message_embedding_index`    |

Each index declares dimension and similarity function (default
`cosine`) alongside its node type in `/packages/ontology`.

Postgres rows that have a Neo4j-resident embedding track sync state
via an `embedding_status` column (e.g.
`content.documents.embedding_status`).

#### 8.2 Mutation contract

Neo4j writes happen only from Inngest functions (`@oxagen/inngest-functions`, served via `apps/api`) and the ontology service
in `/packages/ontology`. `apps/api` does not write Neo4j directly —
reads only.

### 9. Indexing Standards

Required on every applicable table.

**Tenant-scoped tables:** `(tenant_id, workspace_id)`.

**Execution tables:** `(execution_id)`, `(status)`, `(started_at)`.

**Slug routing:**
- `organization.tenants(slug)`
- `workspace.workspaces(tenant_id, slug)`

**ClickHouse `events` table:** partition by `toYYYYMM(emitted_at)`,
order by `(tenant_id, event_type, emitted_at)`.

Index additions require a migration and a brief note in the PR.

### 10. Schema Conventions

- **UUIDv7** for all primary keys. Sortable, distributed-safe, better
  B-tree locality.
- **No Postgres enums.** Use `text` + `check` constraints.
- **`jsonb` at boundaries** (configs, schemas, metadata). Never for
  ownership, authorization, or join keys.
- **Immutable once written:** agent versions, prompt versions, workflow
  versions, tool versions, execution inputs, execution outputs,
  execution artifacts.
- **Mutable:** workspace settings, connection settings, integration
  configs, user preferences.

The immutable/mutable split is the foundation of deterministic replay,
auditability, and lineage. Violating it blocks merge.

### 11. Secrets Policy

Foundations milestone uses environment variables. A migration to a
managed secret store (Doppler, 1Password, or a vendor SM) is deferred
until production hosting hardens.

1. **`.env.example` at the repo root is canonical.** Every required
   variable is listed with a short comment. CI greps the codebase to
   verify no `process.env.X` reads outside the declared set.
2. **`.env.local` is the only secret-bearing file** developers create,
   and it is gitignored. Layout matches `.env.example`.
3. **`packages/config` validates env via Zod on boot.** Apps fail closed
   if a required variable is missing or malformed.
4. **CI uses GitHub Actions Secrets** mapped to the same names as
   `.env.example`. No raw secrets in workflow YAML.
5. **Per-app declarations.** Each app exports `requiredEnv` from its
   `env.ts`; the boot wrapper enforces the contract.
6. **No secret rotation tooling yet.** Manual rotation via provider
   dashboards. Documented as a follow-up.

### 12. Local Development Workflow

#### 12.1 `pnpm dev`

1. Verifies Docker is running and `.env.local` exists.
2. Starts `postgres`, `neo4j`, `clickhouse` containers via
   `docker-compose.dev.yml`.
3. Runs pending migrations (Postgres + ClickHouse + Neo4j ontology
   sync).
4. Starts all `apps/*` in parallel via Turborepo, with consistent port
   assignment.

Production-equivalent stack: Neon (Postgres), ClickHouse Cloud,
Neo4j AuraDB. Local Docker images are kept version-pinned to those
managed services.

#### 12.2 `pnpm kill`

1. Stops all `apps/*` processes.
2. `docker compose -f docker-compose.dev.yml down --remove-orphans`.
3. Optional `--volumes` flag for full reset.

#### 12.3 `pnpm db:check`

Verifies that the running Postgres, ClickHouse, and Neo4j schemas match
the migration set. Exit non-zero on drift.

#### 12.4 Port assignments

| App         | Port |
|-------------|------|
| `api`       | 4000 |
| `mcp`       | 4100 |
| `runner`    | 4200 |
| `app`       | 3000 |
| `website`   | 3100 |

### 13. Release Process

#### 13.1 `pnpm release:patch|minor|major`

1. Verifies clean working tree on `main`.
2. Runs full test suite.
3. Bumps version across all packages and apps using Changesets.
4. Generates `CHANGELOG.md` updates.
5. Creates a single commit, tags `vX.Y.Z`, pushes tag.
6. CI builds and publishes artifacts on tag push.

#### 13.2 Versioning

Single version across the monorepo. Per-package independent versioning
is explicitly out of scope for v1.

### 14. CI Requirements

On every PR:

- `pnpm typecheck`
- `pnpm lint`
- `pnpm test`
- `pnpm db:migrate` against a throwaway Docker stack
- `pnpm db:check`

All must pass before merge.

### 15. Stack Decisions

| Concern                  | Choice                              |
|--------------------------|-------------------------------------|
| Postgres ORM             | **Drizzle**                         |
| Postgres migrations      | Drizzle Kit (generated, hand-edited)|
| ClickHouse client        | Official `@clickhouse/client`       |
| Job / queue layer        | **Inngest**                         |
| Vector store             | **Neo4j** (native vector index)     |
| Secret manager           | Environment variables (`.env.local`)|
| Postgres hosting         | **Neon**                            |
| ClickHouse hosting       | **ClickHouse Cloud**                |
| Neo4j hosting            | **Neo4j AuraDB Free**               |
| Frontend hosting         | **Vercel**                          |
| `apps/app` framework     | Next.js App Router + RSC streaming  |
| Interactive agent SDK    | **Vercel AI SDK** (`ai` package)    |
| Auth                     | **Better Auth** (Drizzle adapter)   |
| Payments                 | **Stripe**                          |

#### 15.1 ORM — Drizzle

Chosen for native TypeScript schemas (mixins composable as functions),
first-class support for `citext` / `ltree` / `bytea` / `uuid_generate_v7()`
defaults, multi-schema support, and SQL migrations that can be
hand-edited per spec §10.

#### 15.2 Job orchestration — Inngest

The runner dispatches workflow steps as Inngest functions. Inngest
provides durable execution, retries, and event-driven triggers
TypeScript-natively. Step-level state remains in Postgres
(`execution.execution_steps`); Inngest holds in-flight orchestration.

The `event.triggers` table maps Oxagen event types to Inngest function
names. Inngest events are emitted from `apps/api` and from agent capability handlers;
the runner subscribes.

#### 15.3 Vector embeddings — Neo4j

Per CLAUDE.md, semantic retrieval lives in Neo4j. Embeddings are
stored as vector properties on graph nodes (`Document`, `AgentMemory`,
`ExecutionArtifact`, etc.) using Neo4j's native vector index.

Required:
- Neo4j 5.13+ for vector index support.
- One vector index per labeled embedding source (e.g.
  `document_embedding_index` on `:Document(embedding)`).
- Embedding dimension and similarity function (`cosine` default)
  declared in `/packages/ontology` alongside the node type.
- Postgres `content.documents.embedding_status` reflects sync state
  with Neo4j.

Postgres `pgvector` is **not** used. Vector-similarity queries route
through Neo4j only.

#### 15.4 Auth — Better Auth

Better Auth runs against the canonical Postgres schema via its Drizzle
adapter. Sessions and accounts persist into our own database, not a
vendor store.

- `auth.users` (spec §6.2) is the canonical user table; Better Auth
  binds to it directly rather than maintaining a parallel `users`
  table.
- Sessions, accounts (OAuth provider linkage), and verification tokens
  live in additional Better Auth tables under the `auth` schema:
  `auth.sessions`, `auth.accounts`, `auth.verifications`. These follow
  the Better Auth schema reference; columns are not redefined here.
- Server-only session reads in `apps/app` server components. Client
  components never see tokens — they call server actions.
- API keys (`auth.api_keys`, §6.2) are the machine-auth surface for
  `apps/api` and `apps/mcp`. They are not Better Auth managed; they
  remain a first-party concept of the platform.
- OAuth providers wired at minimum: Google, GitHub. Configurable per
  deployment via Secret Manager.

#### 15.5 Secret manager local emulation

Local dev uses the real Google Secret Manager against a `dev` GCP
project, scoped per-developer. No local emulator. Offline dev requires
a cached `.env.local` (last successful fetch) — apps fail closed if no
cache exists.

## Plan — `plan.md`

## Foundations — Implementation Plan

Owner: TBD. Target: TBD.

This plan tracks execution of `spec.md`. Each phase is independently
mergeable. Acceptance criteria in §2 of the spec gate epic completion.

### Phase 0 — ADRs

Stack decisions are resolved in spec §15. Document each as a one-page
ADR in `docs/adr/` before Phase 1 starts:

- [ ] ADR-001: Drizzle as Postgres ORM
- [ ] ADR-002: Inngest as job orchestration layer
- [ ] ADR-003: Neo4j as vector store (not pgvector)
- [ ] ADR-004: Real Google Secret Manager for local dev (no emulator)
- [ ] ADR-005: Single-version monorepo via Changesets
- [ ] ADR-006: Better Auth bound to canonical `auth.users`

### Phase 1 — Monorepo scaffold

- [ ] Turborepo workspace with `/apps`, `/packages`, `/plugins`, `/tools`
- [ ] App stubs: `api`, `mcp`, `runner`, `app`, `website`, `cli`
- [ ] Shared `tsconfig`, `eslint`, `prettier` configs in `/packages/config`
- [ ] `pnpm dev` / `pnpm kill` skeletons (no infra wired yet)

Exit: every app builds and runs a "hello world" health endpoint.

### Phase 2 — Datastore infra

- [ ] `docker-compose.dev.yml` for Postgres + Neo4j + ClickHouse
- [ ] Migration tooling per store (Postgres via chosen ORM; ClickHouse
      via versioned `.sql` files; Neo4j via `cypher-shell` migrations)
- [ ] `pnpm db:migrate`, `pnpm db:check`, `pnpm db:reset` commands

Exit: `pnpm dev` brings stack up, runs all migrations, `db:check` is green.

### Phase 3 — Postgres schema

Implement spec §6 in this order (dependencies first):

- [ ] §5 mixins as reusable Drizzle helpers
- [ ] §6.1 organization
- [ ] §6.2 auth
- [ ] §6.3 workspace (with `workspace_users`)
- [ ] §6.4 integration
- [ ] §6.5 agent (with `tool_versions` split)
- [ ] §6.6 workflow
- [ ] §6.7 event (definitions only)
- [ ] §6.8 execution (with `execution_artifacts`,
      `triggered_by_message_id`)
- [ ] §6.9 chat (DAG model with `parent_message_id`,
      `active_leaf_message_id`)
- [ ] §6.10 content (with `files` / `documents` split)
- [ ] §6.11 graph
- [ ] §6.12 evaluation
- [ ] §6.13 billing (full suite)
- [ ] §9 indexes
- [ ] Seed data for local dev (incl. seed `billing.plans`)

Exit: schema matches spec, `db:check` passes, seed loads cleanly.

### Phase 4 — ClickHouse schema

- [ ] §7.1–§7.6 tables with partitioning and TTL
- [ ] Materialized rollups for token usage and event volume
- [ ] Ingestion library in `/packages/telemetry`

Exit: all apps can write telemetry; sample dashboard query returns data.

### Phase 5 — Neo4j ontology and vectors

- [ ] Node and edge type definitions in `/packages/ontology`
- [ ] Constraints and indexes for initial labels
- [ ] Vector indexes (spec §8.1) — `Document`, `AgentMemory`,
      `Chat:Message`
- [ ] Embedding write path from runner; sync state back to Postgres
      `embedding_status` columns
- [ ] Sync command that reconciles Postgres → Neo4j for canonical
      entities (Tenant, Workspace, User, Agent, etc.)

Exit: ontology contains live entities; vector similarity queries
return expected nearest-neighbor results; traversal queries return
expected paths.

### Phase 6 — Env var contract

- [ ] `.env.example` canonical at repo root
- [ ] Zod-validated env loader in `/packages/config`; per-app
      `requiredEnv` exports
- [ ] Pre-commit hook scanning for raw secret values in tracked files
- [ ] GitHub Actions Secrets mirror `.env.example` for CI
- [ ] CI grep verifies no `process.env.X` outside the declared set

Exit: every app fails closed on missing env; `.env.local` is the only
secret-bearing file and it is gitignored.

### Phase 6.5 — `apps/website`

- [ ] Hello-world Next.js page. Nothing else.

Exit: page renders at port 3100.

### Phase 6.6 — `apps/app` shell

Shipped features per spec §2.3. Agent / workflow / execution UIs are
stubbed only.

- [ ] Next.js App Router skeleton with RSC streaming enabled
- [ ] Better Auth wired to `auth.users` via Drizzle adapter; sessions,
      accounts, and verifications migrated under the `auth` schema
- [ ] Google + GitHub OAuth providers configured via Secret Manager
- [ ] Auth: login, logout, session (server components only)
- [ ] Tenant CRUD: create, switch, list; slug routing per §4
- [ ] Workspace CRUD: create, switch, list within tenant
- [ ] Tenant user management: invite, role assignment, revoke
- [ ] Workspace user management: invite, role assignment
- [ ] Vercel AI SDK wired into a placeholder chat surface that
      persists to `chat.conversations` / `chat.messages` per §6.9
- [ ] Stub pages for agents, playbooks, executions (out of scope for
      build-out, but routes exist)

Exit: a new user can sign up, create a tenant, create a workspace,
invite a collaborator, and open a streaming chat against a stub agent.

### Phase 6.7 — Billing (`apps/app` + `apps/api`)

Spec §6.13. The full billing suite is in scope.

- [ ] Stripe customer creation on tenant creation
- [ ] Plan catalogue UI (read from `billing.plans`)
- [ ] Checkout: Stripe Elements payment method capture
- [ ] Subscription create / upgrade / downgrade / cancel / reactivate
- [ ] Payment method management UI
- [ ] Invoice list + hosted invoice / PDF links
- [ ] Current-period usage view (rolled up from ClickHouse
      `token_usage` into `billing.usage_records`)
- [ ] Credit balance + ledger UI
- [ ] Stripe webhook handler in `apps/api` with idempotent processing
      via `billing.stripe_events`
- [ ] Scheduled Inngest job: nightly usage rollup from ClickHouse →
      `billing.usage_records`

Exit: a tenant can subscribe to a plan, pay, see invoices, view usage,
and cancel — end to end against Stripe test mode.

### Phase 7 — Release tooling

- [ ] Changesets configured
- [ ] `pnpm release:patch|minor|major` scripts
- [ ] CI tag-triggered build and publish

Exit: a no-op patch release completes end-to-end against a test
artifact registry.

### Phase 8 — CI

- [ ] PR workflow: typecheck, lint, test, db:migrate, db:check
- [ ] Required status checks configured on `main`

Exit: PR cannot merge without green CI.

### Done

All checkboxes complete and the §2 acceptance criteria pass on a fresh
clone.

