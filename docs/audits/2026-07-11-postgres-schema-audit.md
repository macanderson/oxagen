# Postgres Schema Audit — 2026-07-11

Full fine-toothed-comb audit of the Postgres schema: all 25 Drizzle schema files
(~140 tables, 5,468 lines) in `packages/database/src/schema/`, all 61 Atlas
migrations, the RLS tenant-policy manifest, and every table/column
cross-referenced against actual usage across `apps/`, `packages/`, and `tools/`.

**Method.** Six parallel domain audits (agent · billing/reseller ·
auth/iam/security/privacy/ratelimit · workflow/ingestion/mcp ·
environments/schema-registry/workspace/org · cms/eval/content/chat/ai/
notification/plugin) plus a cross-cutting pass over mixins, migrations, and the
tenancy manifest. Every zombie claim was grepped against **both** the TS export
name and the snake_case SQL table name, excluding schema definitions,
`relations.ts`, seeds, tests, and migrations. Every P1 finding below was
independently re-verified before inclusion. No live database was reachable from
this environment (no Docker), so anything requiring `pg_stat_user_indexes` is
explicitly marked *verify-in-prod*.

**Headline numbers.**

| Category | Count |
|---|---|
| Zombie tables, confirmed (write-only or zero-reference) | **4** |
| Zombie/dead columns, confirmed | **~24** |
| Redundant or dead indexes (drop candidates) | **~20** |
| Missing hot-path indexes | **9** |
| P1 architectural defects | **7** |
| Tables audited & confirmed ALIVE | ~120 |

---

## 1 · P1 — Critical architectural defects

### 1.1 `security.security_events` lost its partitioning in the Atlas re-baseline

The 2026-06-11 Atlas baseline (`20260611233016_initial_schema.sql:1389`)
creates `security.security_events` as a **plain table**. There is **zero**
`PARTITION BY` / `PARTITION OF` DDL anywhere in the Atlas migration set
(verified by grep across all 61 files). But:

- The monthly Inngest cron
  `packages/inngest-functions/src/functions/security.audit-partition-rollover.ts`
  runs `CREATE TABLE … PARTITION OF security.security_events …` — which
  **fails against a non-partitioned parent** — and its 7-year-retention
  `DROP PARTITION` sweep can never run.
- Migration `20260727120000_reseller_revenue_security_events.sql` states in
  its comment that the table "is RANGE-partitioned" — the team believes in
  partitioning the migration set does not create.
- The composite PK `(id, occurred_at)` and the pre-Atlas drizzle migration
  (`drizzle/migration_archive` era, `0002_security_events_partitioning.sql`)
  prove partitioning was the design intent.

Two possible live states, both bad: (a) prod still has the old partitioned
table → migrations diverge from prod and every fresh env/CI DB is silently
unpartitioned; or (b) prod was rebuilt plain → the rollover cron has been
erroring monthly since June and the audit table grows unbounded with a 7-year
retention promise it cannot keep.

**Fix.** Inspect prod (`SELECT relkind FROM pg_class WHERE relname='security_events'`;
`p` = partitioned). Then either add a repair migration that recreates the table
partitioned (rename → create partitioned + DEFAULT partition → attach/copy →
swap) so fresh envs match the cron, or — if the partitioning is being
abandoned — delete the rollover cron and add an explicit retention DELETE job.
Either way the migration set, the cron, and the 20260727 comment must agree.

### 1.2 Six `billing.reseller_*` tables missing from the RLS tenancy manifest

`tenant-policy.manifest.ts` has **zero** `reseller` entries, while all six
tables (`reseller_price_plans`, `reseller_customers`,
`reseller_attribution_rules`, `reseller_rebill_runs`,
`reseller_rebill_line_items`, `reseller_settings`) carry a NOT NULL `org_id`
(`20260725120000_reseller_revenue.sql`). Consequences:

- The `manifest-coverage` integration test ("every table with an `org_id`
  column is in the manifest or allowlist") **fails in CI**
  (`.github/workflows/pipeline.yml` → `rls-integration`).
- `tools/scripts/gen-rls-migration.ts` generates RLS DDL **from the manifest**
  — a future re-baseline would silently regenerate these six tables **without
  RLS**. Live enforcement is currently intact only because the hand-written
  migration added the policies inline.

**Fix (safe to land immediately, manifest-only, no DDL diff):** add all six as
`{ policyClass: "org_only" }` under the existing `billing.*` block.
**Status: FIXED in this PR** — manifest entries added and the manifest-length
ratchet bumped 89 → 95; this CI failure was observed live on this PR's first
run (`rls-integration`, run 29138191860) exactly as predicted.

### 1.3 IAM hot path: `iam.principals` has no `(org_id, parent_user_id)` index — and no uniqueness

Every capability invocation for an enterprise org runs
(`packages/iam/src/fetch-authz.ts:206-216`):
`WHERE org_id = ? AND parent_user_id = ? LIMIT 1`. The table's indexes are
`(org_id, kind)`, `(workspace_id)`, `(idp_subject)` — none serves this
predicate past the `org_id` prefix.

Worse, there is **no unique constraint** on `(org_id, parent_user_id)`, so the
`onConflictDoNothing()` in `packages/handlers/src/iam-provision.ts:193-203,378-388`
is dead code — there is no conflict to catch. Two concurrent provisioning
calls for the same user (org-creation racing invite-accept, or a retried
webhook) can insert **duplicate principals**, and the `LIMIT 1` authz lookup
then non-deterministically picks one — an owner can intermittently resolve to
a principal with no role assignments and be spuriously denied.

**Fix (one index solves both):**

```sql
CREATE UNIQUE INDEX CONCURRENTLY principals_org_parent_user_uniq
  ON iam.principals (org_id, parent_user_id)
  WHERE parent_user_id IS NOT NULL;
```

(De-duplicate any existing rows first; mirror the pattern already used by
`access_requests_pending_dedupe_idx`.) Also note `fetch-authz.ts` does
`select()` (full row) on this hottest of paths — project the needed columns.

### 1.4 `agent.agent_plans` approval state machine never transitions

`agent.plan.create` inserts rows, but `agent.plan.approve`
(`packages/agent/src/handlers/agent.plan.approve.ts`) only fires
`pg_notify('agent_plan_resolved', …)` — it **never UPDATEs the row**, and
**nothing anywhere LISTENs on that channel**. `status` is stuck at creation
value forever; `approved_at` / `approved_by_user_id` are unreachable by any
code path. No `agent.plan.get`/`list` exists. The 7-state CHECK constraint
models a state machine that exists only in the DDL. Any future consumer
trusting `status='approved'` as an authorization gate reads permanently stale
data.

**Fix:** make approve actually
`UPDATE agent.agent_plans SET status=…, approved_at=now(), approved_by_user_id=… WHERE id=…`
and add `agent.plan.get`/`list` — or retire the table and its two
contracts/routes if plan-approval is abandoned.

### 1.5 `workflow.playbook_approvals` is a dead end — approval-gated runs can never resume

Only two references in the repo, both INSERTs
(`playbook.run.execute.ts:519,961`). No handler, contract, route, or UI ever
resolves one; nothing sweeps `expires_at`. A run hitting an
`approval`/`human_input` step sets `status='waiting_approval'` and is stuck
forever. `resolved_at`, `resolved_by_user_id`, `comments` are
zombie-confirmed columns. (Same disease as 1.4, different organ — the working
pattern to copy is `agent.approval_requests` + `agent.approval.resolve`.)

### 1.6 `ingestion.webhook_subscriptions` has no create path — webhook ingestion is non-functional

Zero INSERTs/UPDATEs exist. The receiving side
(`apps/api/src/routes/v1/webhook.ts:55-61`) JOINs the table to verify inbound
HMACs, and four connectors declare `deliveryMethod: "webhook"`
(Microsoft, Google Drive/Gmail/Calendar) — but no code ever provisions a
subscription row, so the webhook route can never match anything. Real-time
ingestion for those connectors silently does not exist.

**Fix:** either build subscription provisioning in the connector setup path,
or downgrade those connectors to `poll` and drop the table until the feature
is real.

### 1.7 Lost-update race on `workspace.workspaces.settings` (shared JSONB bag)

`workspace.settings.write` (merges `settings.description`) and
`prompt.settings.write` (merges `settings.promptConfig`) both do
read-whole-column → merge-in-JS → write-whole-column with no row lock and no
`jsonb_set`. Concurrent writes silently clobber each other's keys.

**Fix:** single-statement `jsonb_set()` updates (or `SELECT … FOR UPDATE`);
better, promote `promptConfig`/`description` to real columns and stop growing
the settings bag with contract-owned structured payloads.

---

## 2 · Zombie tables (confirmed — drop or wire)

| Table | Evidence | Recommendation |
|---|---|---|
| `auth.credentials` | **Zero references** anywhere outside schema/relations/manifest/migrations. Superseded by the live Credential Vault (`environments.secret_keys/values`) and `mcp.credentials`. | `DROP TABLE auth.credentials;` + remove manifest entry + Drizzle def |
| `billing.usage_records` | Write-only: nightly cron `billing.rollup-usage.ts` upserts a row per (subscription, metric, period) across **every org**; zero readers. Invoice line items come from Stripe webhooks, usage queries go to ClickHouse (`sumTokenUsage`). Also a four-store violation (Postgres materialization of ClickHouse data nobody reads). Its `source_query_id` column is never even written. | `DROP TABLE billing.usage_records;` + retire the rollup cron (or repoint to ClickHouse if period aggregates are ever needed) |
| `billing.org_billing_profiles` | Write-only PII: two INSERTs at org creation (onboarding + `org.create`), zero reads ever. Stripe captures billing address independently (`customer_update: {address:"auto"}`). A GDPR data-minimization liability, not just dead weight. | `DROP TABLE billing.org_billing_profiles;` + remove the two inserts (or wire it into `stripe.customers.create` if the address capture is wanted) |
| `billing.invoice_line_items` | Delete-then-insert on every Stripe invoice webhook; zero reads. The invoices UI links to Stripe's hosted invoice. | `DROP TABLE billing.invoice_line_items;` + remove the mirror writes in `packages/billing/src/invoices.ts:80-100` |

Borderline (decide, don't blind-drop): `ingestion.webhook_subscriptions`
(§1.6 — feature intent exists), `security.mcp_server_changes` (write-only
forensic audit; plausibly intentional, but its retention doc-comment is stale
— the snapshot-retention job never reads it), `environments.secret_access_log`
(write-only compliance log with **no read capability anywhere** — defeats its
purpose; add `secret.access_log.list` per capability parity).

---

## 3 · Zombie / dead columns (confirmed unless noted)

**Drop (or wire) list — no code path writes or reads these:**

| Column | Note |
|---|---|
| `chat.messages.is_active_in_branch` | Every write is literal `true`; the only WHERE use is a tautology (`eval.dataset.from_traces.ts:110`). Branch reconstruction walks `parent_message_id` in app code. Dangerous decoy for future engineers. |
| `plugin.installed_plugins.config`, `.auth_config` | Never written; permanently `{}`; read back as decoration. Credentials actually live in the vault / `mcp.credentials`. |
| `auth.users.username` (+ its unique index) | Zero real references; no Better Auth username plugin. |
| `auth.users.last_login_at` | Never written, never read. |
| `auth.users.email_verified_at` | Only touched by an e2e seed helper (zombie-likely). |
| `iam.principals.mfa_status` | Superseded by `auth.users.two_factor_enabled` (the actual enforcement signal). |
| `iam.access_requests.approver_id`, `.approved_at`, `.ttl_seconds` | No approval workflow exists (half-built JIT feature; nothing leaves `pending`). |
| `workflow.playbook_approvals.resolved_at`, `.resolved_by_user_id`, `.comments` (+ write-only `expires_at`) | §1.5. |
| `ingestion.setup_suggestions.resolved_at`, `.resolved_by` | Suggest handler returns AI output directly; persisted rows never revisited. |
| `agent.background_tasks.inngest_run_id` (+ unique constraint) | Client-generated pseudo-id; all correlation is by `public_id`. |
| `agent.a2a_tasks.fanout_run_id` | Self-documented "always null today" (`bridge.ts:369-377`). |
| `agent.agent_executions.debug`, `.state` | Never written past default `{}`, never read (zombie-likely — table has two full-row fetch sites). |
| `eval.eval_runs.inngest_event_id` | Never written; the working analog is `subagent_fanouts.inngest_event_id` — copy that pattern or drop. |
| `billing.org_billing_settings.last_dunning_notified_at` | Set to `null` at creation; `dunning.ts` sends notifications but never stamps it — the anti-spam field can't work. Wire it (one UPDATE after `notifyOrgManagers`) or drop. |
| `schema_registry.node_labels.metadata` | Upsert hardcodes `{}`; the color/icon UI it was built for doesn't exist. |
| `org.org_users.permissions`, `workspace.workspace_users.permissions` | Self-documented DEPRECATED; zero references; `{}` default written on every membership row forever. |
| `cms.book_editions.description`, `.og_image_url` | Seeded, never served (readers select explicit columns without them). Wire into OG meta tags or drop. |

Keep-but-noted: `content.documents.metadata` (forward-compat headroom),
`auth.api_keys.scope` (contract-documented "reserved for future use"),
`auth.workspace_user_preferences` soft-delete columns (mixin convention,
unexercised).

---

## 4 · Index findings

### 4.1 Missing indexes on hot paths (add)

```sql
-- 1. Activity feed / execution list (live UI path; verified query shape in
--    agent.execution.list.ts + command.menu.search.ts)
CREATE INDEX CONCURRENTLY agent_executions_org_ws_created_idx
  ON agent.agent_executions (org_id, workspace_id, created_at DESC);
  -- optionally partial: WHERE parent_execution_id IS NULL (exact match for the feed)

-- 2. IAM hot path + dedupe (§1.3)
CREATE UNIQUE INDEX CONCURRENTLY principals_org_parent_user_uniq
  ON iam.principals (org_id, parent_user_id) WHERE parent_user_id IS NOT NULL;

-- 3. OAuth refresh watcher (30-min cross-tenant cron, no covering index today)
CREATE INDEX CONCURRENTLY credentials_oauth_expiring_idx
  ON mcp.credentials (expires_at) WHERE auth_kind = 'oauth' AND status = 'active';

-- 4. Dispute webhook resolution (currently seq-scans)
CREATE INDEX CONCURRENTLY billing_disputes_payment_intent_idx
  ON billing.billing_disputes (payment_intent_id) WHERE payment_intent_id IS NOT NULL;
CREATE INDEX CONCURRENTLY billing_disputes_stripe_charge_idx
  ON billing.billing_disputes (stripe_charge_id) WHERE stripe_charge_id IS NOT NULL;

-- 5. Invoices list (org page: WHERE org_id ORDER BY created_at DESC)
CREATE INDEX CONCURRENTLY invoices_org_created_idx
  ON billing.invoices (org_id, created_at DESC);

-- 6. Session-expiry audit cron joins security_events on request_id with no
--    time bound — unindexed, scans all history monthly-growing
CREATE INDEX CONCURRENTLY security_events_request_id_idx
  ON security.security_events (request_id);
  -- (or thread an occurred_at lower bound into the join in auth.session-expiry-audit.ts)

-- 7. Documents / assets lists (unbounded, unindexed sort — also add .limit()!)
CREATE INDEX CONCURRENTLY documents_workspace_created_idx
  ON content.documents (workspace_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX CONCURRENTLY generated_assets_ws_kind_created_idx
  ON content.generated_assets (workspace_id, kind, status, created_at DESC)
  WHERE deleted_at IS NULL;

-- 8. Batch reconcile cron (cross-tenant; existing index leads with org_id, useless here)
CREATE INDEX CONCURRENTLY ai_batch_jobs_open_idx
  ON ai.batch_jobs (status) WHERE status IN ('submitted','in_progress') AND deleted_at IS NULL;

-- 9. Credit-ledger dispute/refund idempotency pre-checks (grant partial doesn't cover them)
CREATE INDEX CONCURRENTLY credit_ledger_org_reason_ref_idx
  ON billing.credit_ledger (org_id, reason, reference_type, reference_id)
  WHERE reference_type IS NOT NULL AND reference_id IS NOT NULL;
```

### 4.2 Duplicate indexes (drop now — provably redundant)

| Index | Duplicate of |
|---|---|
| `workspace_memory_policy_workspace_idx` | `workspace_memory_policy_workspace_id_unique` constraint (identical single column, both unique) |
| `workspace_budget_policy_workspace_idx` | same pattern |
| `org_security_policy_org_idx` | the PK on `org_id` |
| `cms_leads_email_idx` | `leads_email_unique` constraint |
| `workspaces_org_idx (org_id)` | strict prefix of unique `(org_id, slug)` |
| `source_connections_next_poll_due_idx` (full) | superseded by the 20260722 partial; the scheduler is the only reader and always applies the partial's predicate; column is updated every poll cycle → pure write amplification |

Also remove the redundant `uniqueIndex()`/`unique()` doubles from the Drizzle
definitions so they aren't regenerated (`workspace.ts:148,191`, `cms.ts:139`,
`security.ts:161`).

### 4.3 Prefix-redundant single-column indexes (drop after `pg_stat_user_indexes` confirms)

Ten in workflow/ingestion/mcp where a single-column index duplicates the
leading prefix of a composite UNIQUE on the same table:
`playbook_versions_playbook_idx`, `playbook_steps_version_idx`,
`playbook_edges_version_idx`, `playbook_step_runs_run_idx`,
`playbook_events_run_idx`, `registries_org_idx`, `consents_lookup_idx`,
`oauth_accounts_org_provider_idx`, `entity_type_mappings_connection_idx`,
`connector_schemas_plugin_id_idx` — plus eight `*_org_idx (org_id, workspace_id)`
in `agent.ts` shadowed by wider composites, and `agent_versions_agent_idx` /
`skill_versions_skill_idx`.

Dead-predicate indexes (never used in any WHERE): `agent_tool_calls_tool_idx`
(low-cardinality, on the highest-insert table in the platform),
`subagent_runs_status_idx`, `notifications_org_idx`,
`stripe_events_type_idx`, `billing_disputes_org_idx`,
`oauth_accounts_expires_at_idx`, `oauth_tokens_expires_at_idx`,
`cms_book_access_codes_status_idx` (fold into `(lead_id, status)`),
`eval_runs_org_idx`/`eval_runs_dataset_idx` (scaffolding for a nonexistent
`eval.run.list` — keep only if it's near-term roadmap).

Run once against prod and drop the zeros:

```sql
SELECT schemaname, relname, indexrelname, idx_scan, pg_relation_size(indexrelid) AS bytes
FROM pg_stat_user_indexes ORDER BY idx_scan ASC, bytes DESC;
```

---

## 5 · Architecture & correctness

1. **Money stored as float.** `workspace_budget_policy.limit_usd` and
   `auth.user_preferences.per_turn_budget_usd` are `real` (float4) feeding
   direct comparisons in `packages/billing/src/turn-budget.ts`. Convert to
   `numeric(12,2)` (`USING limit_usd::numeric(12,2)`), plus the twin grace-pct
   columns if precision matters there.
2. **Unbounded growth, no retention story** on the platform's biggest tables:
   `agent.agent_execution_steps` + `agent.agent_tool_calls` (one row per LLM
   tool call, telemetry-shaped, no purge job, no partitioning) and
   `workflow.playbook_events` (schema comment *promises* "bounded retention
   window (TTL policy in migration)" — no such migration exists). Add a
   retention/partition job mirroring `security.audit-partition-rollover` (once
   §1.1 is fixed) or move raw telemetry to ClickHouse and keep summaries.
3. **IAM has no FK constraints even within its own schema** —
   `principal_role_assignments`, `role_grants`, `access_requests` float free
   while `auth.ts` uses proper same-schema FKs one file over. Cross-schema FK
   avoidance is convention; same-schema skipping is just missing integrity.
4. **Missing CHECK constraints on enum-shaped text**:
   `mcp_servers.health_status/transport_type/auth_strategy`,
   `catalog_servers.status/auth_kind`, `setup_suggestions.status`,
   `webhook_subscriptions.status`. Bonus inconsistency: health vocab is
   `unreachable` in mcp vs `errored` in ingestion for the same concept.
5. **`workflow.playbooks.active_version_id`** — schema comment promises an
   `ALTER TABLE` FK "applied by the migration"; no migration contains it.
6. **`workflow.playbook_triggers` `trigger_type='schedule'`** is accepted by
   `automation.create` but no cron ever matches it — schedule triggers are
   silently inert.
7. **Per-row INSERT loops in `schema.versioning.ts` publish path** — 4 tables
   copied row-by-row with `.returning()` per row; convert to
   `INSERT … SELECT` (N round trips → 1 per table). Version growth is also
   unbounded (vocab × publish count) with no pruning.
8. **`SELECT *` on the hottest paths**: `resolve-org.ts` (5 full-row selects
   on `organizations`/`workspaces` per page render — pulls the full settings
   JSONB every time), `fetch-authz.ts` (principals), `plugin.org.list.ts`.
   Project explicit columns.
9. **`Math.random()` public-id generators** hand-rolled in
   `privacy.data.export.ts` / `privacy.data.erase.ts`, overriding the
   CSPRNG `idMixin` default. Delete both; let the mixin fire.
10. **Config drift around the toolchain:**
    `drizzle.config.ts` `schemaFilter` still lists the dropped `graph` schema
    and omits `schema_registry`, `environments`, `ai`, `eval`, `cms`,
    `ratelimit` → drizzle-kit drafts are wrong for 6 schemas.
    `ratelimit.ts` omits the physical `window_start` index (drift landmine if
    the filter is ever fixed). `graphSchema` export in `_schemas.ts:22` and
    the `ltree` custom type in `_mixins.ts` are TS zombies (no `graph.*`
    tables since 2026-06-21; no `folders` table ever; ltree extension never
    installed). The empty `graph` Postgres schema can be dropped.
11. **Repo hygiene:** `.claude/skills/oxagen-engineering-policy` is a broken
    symlink (`.agents/` missing from the checkout — hit by four of six audit
    agents); legacy `packages/database/drizzle/*.sql` drafting debris (476K)
    predates Atlas.

**Four-store verdict:** clean apart from `billing.usage_records` (§2). The
schema-registry vocabulary tables are correctly config-not-graph; ingestion
respects the Connector Dual-Write exception; eval per-item results correctly
live in ClickHouse; generated assets store blob refs, not bytes;
`cms.book_editions.html` inline is a documented access-control exception. The
Postgres/ClickHouse dual audit-event write is documented and intentional.

**Cleared suspects** (checked, healthy): `credit_balances`/`credit_lots`/
`credit_ledger` three-tier design; `stripe_events` idempotency tables;
`file_locks`/`file_lock_fences` (raw-SQL access, alive);
`a2a_tasks.message_history` JSONB (deliberate A2A wire-format);
`rate_limit_counters` (raw-SQL, load-bearing); Better Auth tables incl.
`two_factor`/`rate_limit`; all 6 reseller tables (fully wired
contract→API→MCP→UI); audit-mixin author columns (widely used).

---

## 6 · Recommended remediation phases

**Phase 1 — zero-risk, land now (no behavior change):**
manifest entries for the 6 reseller tables (§1.2) · drop the 6 provably
duplicate indexes (§4.2) + their Drizzle doubles · add the 9 missing indexes
(§4.1, `CONCURRENTLY`) · fix `drizzle.config.ts` schemaFilter · remove
`graphSchema`/`ltree` TS zombies + `DROP SCHEMA graph` · add missing CHECK
constraints (§5.4) · fix the two `Math.random()` id generators.

**Phase 2 — zombie drops (need a green light, data is unreferenced):**
`DROP TABLE auth.credentials, billing.usage_records (+ retire the nightly
cron), billing.org_billing_profiles (+ 2 inserts), billing.invoice_line_items
(+ mirror writes)` · the §3 confirmed-dead column drops · `numeric` money
conversion.

**Phase 3 — product decisions (wire it or kill it):**
security_events partition repair (§1.1 — needs prod inspection first) ·
agent_plans + playbook_approvals + access_requests approval flows ·
webhook_subscriptions provisioning · retention jobs for
execution-steps/tool-calls/playbook-events · `settings` JSONB race fix ·
`secret.access_log.list` capability · dunning timestamp wiring.

Every drop migration should follow the house pattern of
`20260704210000_drop_zombie_schema.sql` (hand-written, `IF EXISTS`,
`atlas migrate hash`, schema TS edits landing together).
