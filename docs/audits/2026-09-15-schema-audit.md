# Schema audit, 2026-09-15

Every Postgres schema on the `app-rebuild` integration branch (120 tables in
21 schemas, plus the six lane branches that add `tools`, `control`-shaped and
`cost` tables on top of it), the 20 ClickHouse tables and the 30 Neo4j labels,
read against the Mission Control spec's target schema (Appendix A: 9
schemas, 35 tables in the wedge, 37 in full; Appendix A.10 says where each of
today's tables goes). The spec is the source of truth; a finding that the
rebuild already resolves is marked so rather than fixed twice.

What this audit changed is in one PR (branch
`worktree-schema-audit-attribution-rename`, targeting `app-rebuild`):

- The audit trio is `created_by_id` / `updated_by_id` / `deleted_by_id` on
  every table (81 today; 180 columns), in the Drizzle mixins, the handlers,
  contracts, surfaces, docs and JSON schemas (ADR-077; migration
  `20260915230000_attribution_columns_by_id.sql`, verified by a from-scratch
  replay of all 124 migrations: 180 old-named columns before, 0 after).
- `billing.payment_methods`, `ingestion.source_connections`,
  `mcp.registries` and `plugin.installed_plugins` now spread the shared
  mixins instead of hand-rolling the same columns (no DDL change).
- `drizzle.config.ts` no longer lists the `workflow`, `eval` and `cms`
  schemas that migration `20260907120000` dropped.
- The orphaned static references `docs/reference/database.html`,
  `docs/reference/db-reference.html` and `docs/erd/oxagen-erd-v0.4.1.svg`
  are deleted: no script generated them, nothing linked them, and they
  described schemas that no longer exist. The Architecture Atlas
  (`pnpm docs:architecture`, built from the storage manifest) is the
  generated reference and picked the rename up on regeneration.
- The ClickHouse `tool_invocations` comment named the long-dropped
  `execution.tool_calls`; it names `agent.agent_tool_calls`. The Neo4j edge
  registry gained `PROMOTED` and `DEMOTED`, which `schema.cypher` documented
  and `types.ts` lacked.
- `packages/database/src/schema/attribution-columns.test.ts` fails the unit
  suite on the old spelling (mutation-tested), and
  `tools/scripts/codemod-attribution-columns.mjs` is the rename for a lane
  branch that predates it.

## The three questions

**`created_by_user_id` should be `created_by_id`.** Done, as above. The spec's
A.0 table said `created_by` with no suffix; it is amended to `_id` because
`createdBy` is already the resolved display name in `iam.role.list`, and
because `control.approvals.resolved_by` in the same spec is a text column
that may hold `policy:<rule id>`, so the suffix is what tells a reference
from a value. The rule extends to the per-table columns as the lanes that
own them land: `invited_by_id`, `granted_by_id` (today
`iam.principal_role_assignments.assigned_by`), `issued_by_id`
(`tacho.control_commands.issued_by_user_id`), `approved_by_id`,
`revoked_by_id`. Today's `approval_requests.resolved_by_user_id`,
`conversations.archived_by_user_id`, `tools.activated_by_user_id`,
`context_records.activated_by_user_id`, `context_promotions.approver_user_id`
and `ingestion.deletion_jobs.requested_by` all belong to tables the rebuild
drops or reshapes (A.10), so they were left for their lanes rather than
renamed into a third spelling.

**What is an account?** `auth.accounts` is Better Auth's `account` model: one
row per way a user can sign in — the email+password credential
(`provider_id = 'credential'`, `password` set) or an OAuth identity
(`provider_id = 'github'`, tokens set). It is not an Oxagen entity; the
tenant is `org.organizations`, and nothing in the product calls anything an
account. The spec keeps the table as is ("Better Auth's own tables,
unchanged", A.1), and Better Auth's docs, plugins and error messages all say
"account", so renaming it (`login_methods` was the candidate) would trade one
reader's confusion for every future debugger's. Left alone; the comment on
the table in `auth.ts` now says what a row is. The second "account" table,
`ingestion.oauth_accounts`, is a connector's OAuth grant at a provider and
goes with `ingestion.*` (A.10: columns on `wrk.repositories` and
`tools.tool_servers`, plus `:Source` nodes).

**Why is there a `content` schema with `generated_assets`?** It is the last
table of the in-app generation product ADR-043 removed. `content.documents`
and the `image.*` / `video.generate` / `document.*` capabilities went; the
table survived because the chat attachment path (`asset.upload` with
`source: "user_upload"`, `conversation.attachment.add`,
`conversation.files.list`, the `conversation.export` PDF) writes blob
reference rows into it. Its name, its `prompt` / `model` / `source` /
`status` columns and its `gen_` public-id prefix describe the dead product;
the four rows in the local database are all `user_upload` / `ready`. The
spec lists `content.*` and `chat.*` as gone (A.10: conversations become runs
of the in-app agent), so this audit did not rename or move it: a
`chat.attachments` rename was drafted and discarded once the rebuild's
disposition was clear. Until the cutover it stays as is; the cutover lane
that retires `chat.*` should retire this table and its blob family
(`storage-manifest/sources/blob.ts`) in the same change.

## Findings against the target schema

Disposition: **fixed** here; **rebuild** — Appendix A.10 already retires or
replaces it, no action beyond the cutover; **lane** — a Mission Control lane
owns the table and should apply the rule as it lands; **decision** — not
settled by the spec.

| # | Finding | Where | Disposition |
|---|---|---|---|
| 1 | Audit trio spelled `*_by_user_id`, the only reference columns named for their target table | 81 tables | **fixed** (ADR-077) |
| 2 | Two run models side by side: `agent.agent_executions` / `agent_execution_steps` / `agent_tool_calls` (pre-ADR-043 worker vocabulary, `claimed_by` / `lease_expires_at`, banned word "execution") and `agent.agent_runs` / `agent_run_events` / `agent_run_attempts`. `schema.reconcile.*` still uses `agent_executions` as its job row; `approval_requests.execution_step_id` points into the old model | `agent.*` | **rebuild** (A.10: both become `:Run` / `:Attempt` / `:Frame` graph nodes); the reconcile job needs a home before the drop — see `wrk.repositories.indexing_status` in A.3 |
| 3 | Four credential stores with two token shapes: `ingestion.oauth_tokens` (per connection) and `ingestion.oauth_accounts` (per org+provider+user) hold the same enveloped token columns; `ingestion.auth_credentials` and `mcp.credentials` hold the same thing keyed differently; `org.model_credentials` is a fifth | `ingestion.*`, `mcp.*`, `org.*` | **rebuild** (A.5: one `tools.connections` table with `kind` = `oauth` / `api_key` / `cloud_role` / `github_app` / `model_provider`) |
| 4 | Table names that repeat their schema: `agent.agent_*` (all eleven), `mcp.mcp_servers`, `privacy.privacy_*`, `notification.notifications`, `billing.billing_disputes`; and the same bare name in two schemas: `registries` (`mcp`, `schema_registry`), `sessions` (`auth`, `tacho`) | across | **rebuild** (the target uses bare names: `control.commands`, `tools.mandates`, `audit.audit_events` is the one repeat) |
| 5 | Tenant-scope columns hand-rolled instead of `orgScopeMixin` on `mcp.registries` and `plugin.installed_plugins`; audit/soft-delete columns hand-rolled on `payment_methods` and `source_connections` (in a different column order from every other table) | `mcp`, `plugin`, `billing`, `ingestion` | **fixed** (no DDL change) |
| 6 | `created_at` / `updated_at` hand-rolled without `auditMixin` on `workspace.workspace_memory_policy`, `workspace_budget_policy`, `routing_policy`, `billing.governed_action_counters`, `iam.authorization_deny_generations`, seven `ingestion.*` tables and `security.org_security_policy` (which also keys on `org_id` with no `id` / `public_id`) | across | **rebuild** for the policy and ingestion tables (A.10; `deny_generations` become counters on `org.organizations` / `wrk.workspaces`); `security.org_security_policy` → `audit.*` or org columns is a **decision** |
| 7 | `auth.workspace_user_preferences` carries coding-runtime columns (`default_repo_connection_id`, `default_repo_slug`, `default_environment_id`, `repo_default_prompted_at`) that only the app's placeholder reads; `chat.conversations.code_binding` has no writer since ADR-043 | `auth`, `chat` | **rebuild** (neither table is in Appendix A; `auth` keeps four tables) |
| 8 | `workspace.routing_policy` ("Verified-Outcome Market Router") and its `escalate_on_rejection` "completeness judge" column survived the runtime excision under agent-engine vocabulary | `workspace` | **rebuild** (A.2: `org.organizations.model_routes` jsonb) |
| 9 | `org.org_users.role` and `invitations.role` are written in two casings (lower by create paths, Title by the IAM path) and checked with `lower()`; `invitations` duplicates the `org_users` membership row the target folds it into (`status = 'invited'`, `invited_by`) | `org` | **lane** (`app-rebuild-wl-36` People page; A.2 `org.org_users`) |
| 10 | `auth.rate_limit` (Better Auth, camelCase `lastRequest`) and `ratelimit.rate_limit_counters` are two limiter stores; documented as deliberate | `auth`, `ratelimit` | **rebuild** (`ratelimit.*` gone; A.10) |
| 11 | `chat.stream` writes `created_by_id = ctx.userId ?? ctx.apiKeyId ?? ctx.orgId` on messages — an API-key id or an org id in a column that references `auth.users` | `apps/api/src/routes/v1/chat.stream.ts` | **rebuild** (`chat.*` gone); until then the column is not a reliable join key for API-surface messages |
| 12 | `content.generated_assets` (finding above): name, dead columns, `gen_` prefix | `content` | **rebuild** (`content.*` gone) |
| 13 | `agent.agent_versions.created_by_user_id NOT NULL` hand-rolled rather than `appendOnlyAuditMixin` (nullable); the stricter constraint is right for an immutable version row | `agent` | **fixed** spelling only; **rebuild** for the table |

### ClickHouse

| Finding | Disposition |
|---|---|
| Comment on `tool_invocations` named `execution.tool_calls`, a schema dropped in the baseline | **fixed** |
| `stella_operational_events.cost_microusd` against the repo-wide `cost_usd_micros`; `skill_loads.org_id` / `workspace_id` typed `String` where every sibling uses `UUID` | **rebuild** (A.10: every ClickHouse table becomes frames and archive segments); `skill_loads` has had no writer since ADR-043 |
| `audit_events` attributes by `acting_principal_id` / `human_principal_id` while `token_usage` and `tool_invocations` use `principal_id` / `user_id` | **rebuild** (`audit.audit_events` in Postgres, `actor_principal_id`) |
| `tacho_events.anthropic_user_email` is stored raw in a table whose every other identity column is a digest | **decided** — [ADR-084](../adr/ADR-084-the-session-person-is-a-principal-oxagen-issues.md), issue #3072: nothing derived from the reported address is stored, because a stable per-person value computed from producer-supplied input and readable by the principal who supplied it is a dictionary oracle however it is hashed or keyed, and `tacho.sessions` already carries `initiating_principal_id`. Digesting it was the first of three rejected designs. The replay does not read this column — `packages/tacho/src/claude-code/replay.test.ts:216` reads `anthropic.account_uuid` and nothing under it touches the address. The code stops writing it here; the `DROP COLUMN` is a migration-only follow-up (#3186 is why the two halves cannot ship together). Dropped on 2026-09-25 by ClickHouse migration 0031 and, for `tacho.sessions`, Atlas migration 20260925230100 ([ADR-183](../adr/ADR-183-claude-code-email-addresses-in-clickhouse-and-postgres.md)) |
| `eval_runs` / `eval_results` (unscoped bench harness) beside `eval_item_results` (tenant-scoped) | **rebuild** (no eval harness in this repo; ADR-043) |

### Neo4j

| Finding | Disposition |
|---|---|
| `PROMOTED` / `DEMOTED` documented in `schema.cypher`, absent from the `EdgeTypes` registry | **fixed** |
| `INVOKED` and `CALLED_TOOL` both mean "an execution called a tool"; only `INVOKED` has a writer | **rebuild** (Appendix B redraws the edge set) |
| `Citation` / `Promotion` / `Demotion` / `Evidence` key on `id` where every other label keys on `publicId`; `EntityNode` scoped by `workspaceId` only, no `orgId` | **rebuild** (Appendix B: every node carries `id` = public id and `ws`; one database per organization makes `orgId` implicit) |
| `ToolVersion` constraint and `LOADED_SKILL` edge have no writer | **rebuild** |
| Mixed `orgId` (camel) and `created_by_kind` (snake) properties on one label | **rebuild** (Appendix B is snake-case throughout) |

## Coordination with the lanes

Six lane branches add tables with `auditMixin` and spell the trio in their
`CREATE TABLE` statements: `app-rebuild-g2955-be`, `-g2957-be`, `-g2958-be`,
`-g2963-be`, `-g2967-be`, `-g2968-be`. Because the rename migration reads
`information_schema` at run time, a lane that merges *before* this PR is
covered without editing; a lane that merges *after* it must rename the three
columns in its own migration and run the codemod on its TypeScript
(`node tools/scripts/codemod-attribution-columns.mjs`), or
`pnpm db:atlas-validate` fails on the drift. The PR description carries the
same note. The shared local database already has the lane migrations up to
`20260915170100` applied; the rename migration sorts after all of them.
