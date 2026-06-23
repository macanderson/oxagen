-- Performance indexes (perf/db-schema-audit).
--
-- Additive, idempotent (IF NOT EXISTS), no destructive changes. Every index
-- below is backed by a concrete query shape in the application code; see the
-- per-index comment for the file:line evidence. Mirrored into the Drizzle
-- schema (packages/database/src/schema/*.ts) so they survive Atlas re-baselines.
--
-- Not CONCURRENTLY: Atlas runs migrations inside a transaction, where
-- CREATE INDEX CONCURRENTLY is disallowed. Index builds here take brief
-- ACCESS EXCLUSIVE locks; the affected tables are small enough at current
-- scale that this is acceptable for a forward migration.

-- chat.messages — the main chat history path. The thread loader filters
-- conversation_id (+ tenant) and ORDER BYs created_at DESC:
--   apps/app/src/app/api/v1/chat/stream/route.ts:276-281
--   apps/api/src/routes/v1/chat.stream.ts:322-327
--   apps/app/.../_shared/conversation-page.tsx:152-153
-- The existing (conversation_id, parent_message_id) index serves the equality
-- but forces an in-memory sort on created_at; this composite serves both.
CREATE INDEX IF NOT EXISTS "messages_conversation_created_idx"
  ON "chat"."messages" ("conversation_id", "created_at");

-- content.generated_assets — conversation.files.list filters conversation_id
-- (+ deleted_at IS NULL, status='ready') and keyset-paginates on created_at DESC:
--   packages/handlers/src/conversation.files.list.ts:96-126
-- The existing index is (conversation_id) only — the created_at keyset/sort is
-- unindexed. (conversation_id, created_at) serves the keyset scan directly.
CREATE INDEX IF NOT EXISTS "generated_assets_conversation_created_idx"
  ON "content"."generated_assets" ("conversation_id", "created_at");

-- notification.notifications — the in-app feed filters (user_id, org_id,
-- archived=false [, unread=true]) and ORDER BYs created_at DESC:
--   packages/handlers/src/notifications.list.ts:20-46
-- The existing (user_id, unread) WHERE archived=false partial index does not
-- cover org_id nor the created_at sort. This partial composite matches the
-- feed predicate and serves the sort.
CREATE INDEX IF NOT EXISTS "notifications_user_org_created_idx"
  ON "notification"."notifications" ("user_id", "org_id", "created_at")
  WHERE (archived = false);

-- billing.subscriptions.plan_id — FK to billing.plans with no covering index.
-- Joined subscriptions→plans on the active-tier hot path:
--   packages/billing/src/tier.ts:35
-- Unindexed FK → slow plan-side cascade checks and reverse lookups.
CREATE INDEX IF NOT EXISTS "subscriptions_plan_idx"
  ON "billing"."subscriptions" ("plan_id");

-- billing.invoices.subscription_id — FK to billing.subscriptions with no
-- covering index (only org_idx and stripe_inv_idx exist). Unindexed FK → a
-- subscription delete/update must seq-scan invoices to enforce the constraint.
CREATE INDEX IF NOT EXISTS "invoices_subscription_idx"
  ON "billing"."invoices" ("subscription_id");

-- agent.skills.active_version_id — FK to agent.skill_versions with no covering
-- index (skills_active_version_id_skill_versions_id_fk, added in
-- 20260619043301). Index the FK so skill_versions mutations don't seq-scan
-- skills.
CREATE INDEX IF NOT EXISTS "skills_active_version_idx"
  ON "agent"."skills" ("active_version_id");

-- agent.agent_executions.agent_version_id — FK to agent.agent_versions with no
-- covering index (only agent_executions_agent_idx on agent_id exists). Index
-- the FK so agent_versions mutations don't seq-scan the high-write executions
-- table.
CREATE INDEX IF NOT EXISTS "agent_executions_agent_version_idx"
  ON "agent"."agent_executions" ("agent_version_id");
