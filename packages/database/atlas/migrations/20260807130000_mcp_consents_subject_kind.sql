-- Agent RBAC Phase 4a (docs/specs/agent-rbac/spec.md §3.7): mcp.consents
-- gains a subject_kind discriminator so agent-scoped consents are labeled
-- distinctly from user-scoped ones. When a role's resourceScope.mcp rule
-- resolves "ask" for an agent run's tool call, the first-use consent flow
-- records the AGENT PRINCIPAL as the consent subject: subject_kind='agent'
-- and user_id holds the agent principal id (iam principals uuid). Every
-- pre-existing row is a user-scoped consent — the NOT NULL DEFAULT 'user'
-- backfills them unchanged. The (workspace_id, user_id, mcp_server_id,
-- tool_name) unique key stays sufficient without subject_kind: user ids and
-- principal ids live in disjoint uuid spaces, so the two subject kinds can
-- never collide on one key. Readers (packages/agent/src/runtime/consent.ts)
-- now filter by subject_kind so the two consent populations never bleed
-- into each other's lookups.
ALTER TABLE "mcp"."consents" ADD COLUMN "subject_kind" text NOT NULL DEFAULT 'user';
ALTER TABLE "mcp"."consents" ADD CONSTRAINT "consents_subject_kind_check" CHECK ("subject_kind" IN ('user', 'agent'));
