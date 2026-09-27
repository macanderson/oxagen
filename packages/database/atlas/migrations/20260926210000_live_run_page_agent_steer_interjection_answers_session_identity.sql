-- The live Run page (batch A4): four changes in one Postgres migration.
--
-- 1. tacho.control_commands admits the target kind `agent` (#2953, D4). A
--    steer or message sent to an agent with no run in flight waits on a row
--    addressed to the agent key. Ingest re-addresses the row to the agent's
--    next root run in the transaction that opens it.
-- 2. agent.interjections records a host's repo_unknown question and how it
--    was settled (#3941). Six columns, seven CHECKs, a unique receipt and one
--    unique index per raising frame, as packages/database/src/schema/
--    interjection.ts declares them.
-- 3. security.security_events_event_type_check admits
--    agent.interjection_answered, the audit row answer_interjection and the
--    timeout function write. The clause is the output of
--    generateEventTypeCheckClause() in packages/compliance.
-- 4. tacho.sessions identity backfill (#2951, the #2908 remainder, D1). Data
--    only. Ingest now writes the agent, the agent principal, the initiating
--    principal and the initiating user at genesis. This fills the same
--    columns on older rows by the rule genesis applies, from the session's
--    own host in the session's own org. It fills nulls and never overwrites a
--    recorded value.
--
-- No table is created, so the tenant policies and grants stay as they are.
-- The new columns take the table grants A3 gave agent.interjections.

-- ════════════════════════════════════════════════════════════════════════════
-- 1. A command addressed to an agent (#2953, D4).
--
-- The list matches TACHO_COMMAND_TARGET_KINDS in schema/tacho.ts. Widening
-- the list refuses no existing row.
ALTER TABLE "tacho"."control_commands"
  DROP CONSTRAINT IF EXISTS "tacho_control_commands_target_kind_check";
ALTER TABLE "tacho"."control_commands"
  ADD CONSTRAINT "tacho_control_commands_target_kind_check"
  CHECK ("target_kind" IN ('host', 'run', 'agent'));

-- ════════════════════════════════════════════════════════════════════════════
-- 2. The repo_unknown interjection and its answer (#3941).
--
-- Every row written before this is a question, so `kind` defaults to
-- 'question' and the other five columns stay null on it. Each CHECK holds
-- for such a row.
ALTER TABLE "agent"."interjections"
  ADD COLUMN IF NOT EXISTS "kind" text NOT NULL DEFAULT 'question',
  ADD COLUMN IF NOT EXISTS "raised_seq" bigint,
  ADD COLUMN IF NOT EXISTS "body" jsonb,
  ADD COLUMN IF NOT EXISTS "repository" text,
  ADD COLUMN IF NOT EXISTS "path" text,
  ADD COLUMN IF NOT EXISTS "receipt_id" text;

-- The receipt is shared by the row, the audit event and the host's
-- control.answer frame, so one receipt names one answer.
ALTER TABLE "agent"."interjections"
  DROP CONSTRAINT IF EXISTS "interjections_receipt_id_unique";
ALTER TABLE "agent"."interjections"
  ADD CONSTRAINT "interjections_receipt_id_unique" UNIQUE ("receipt_id");

ALTER TABLE "agent"."interjections"
  DROP CONSTRAINT IF EXISTS "interjections_kind_check",
  DROP CONSTRAINT IF EXISTS "interjections_body_check",
  DROP CONSTRAINT IF EXISTS "interjections_repository_check",
  DROP CONSTRAINT IF EXISTS "interjections_path_check",
  DROP CONSTRAINT IF EXISTS "interjections_path_kind_check",
  DROP CONSTRAINT IF EXISTS "interjections_path_deny_check",
  DROP CONSTRAINT IF EXISTS "interjections_receipt_id_check";
ALTER TABLE "agent"."interjections"
  ADD CONSTRAINT "interjections_kind_check"
    CHECK ("kind" IN ('question', 'repo_unknown')),
  -- The Run page renders a repo_unknown question from its body.
  ADD CONSTRAINT "interjections_body_check"
    CHECK ("kind" = 'question' OR "body" IS NOT NULL),
  ADD CONSTRAINT "interjections_repository_check"
    CHECK ("repository" IS NULL OR "repository" <> ''),
  ADD CONSTRAINT "interjections_path_check"
    CHECK ("path" IS NULL OR "path" IN ('link', 'create', 'deny')),
  -- Only a repo_unknown row takes a path.
  ADD CONSTRAINT "interjections_path_kind_check"
    CHECK ("path" IS NULL OR "kind" = 'repo_unknown'),
  -- Only the timeout answers deny, and the timeout is no person.
  ADD CONSTRAINT "interjections_path_deny_check"
    CHECK ("path" IS DISTINCT FROM 'deny' OR "answered_by_user_id" IS NULL),
  ADD CONSTRAINT "interjections_receipt_id_check"
    CHECK ("receipt_id" IS NULL OR ("receipt_id" ~ '^rcp_[0-9a-z]+$' AND "answered_at" IS NOT NULL));

-- One row per raising control.interject frame. Ingest inserts with
-- ON CONFLICT DO NOTHING, so a re-sent batch writes no second row.
CREATE UNIQUE INDEX IF NOT EXISTS "interjections_raised_frame_uq"
  ON "agent"."interjections" ("workspace_id", "run_public_id", "raised_seq")
  WHERE "raised_seq" IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- 3. The interjection answer's audit event (#3941).
ALTER TABLE security.security_events DROP CONSTRAINT IF EXISTS security_events_event_type_check;
ALTER TABLE security.security_events ADD CONSTRAINT security_events_event_type_check CHECK (event_type IN ('auth.sign_in', 'auth.sign_in_failed', 'auth.sign_out', 'auth.token_refreshed', 'auth.password_changed', 'auth.email_verified', 'api_key.created', 'api_key.revoked', 'api_key.used', 'billing.access_denied', 'billing.auto_reload_updated', 'billing.checkout_initiated', 'billing.credits_purchased', 'billing.payment_method_added', 'billing.payment_method_default_changed', 'billing.payment_method_removed', 'billing.plan_changed', 'billing.seats_changed', 'billing.subscription_canceled', 'billing.subscription_reactivated', 'billing.budget_updated', 'capability.invoke_allowed', 'capability.invoke_denied', 'capability.invoke_error', 'organization.created', 'workspace.created', 'workspace.archived', 'org.member_invited', 'org.member_removed', 'org.role_changed', 'iam.role_created', 'iam.role_grants_set', 'iam.role_deleted', 'plugin.installed', 'plugin.uninstalled', 'plugin.enabled_changed', 'plugin.denylist_added', 'plugin.denylist_removed', 'plugin.credential_set', 'plugin.credential_revoked', 'secret.revealed', 'secret.exported', 'secret.value_changed', 'secret.key_deleted', 'security.mfa_policy_updated', 'security.session_revoked', 'data_plane.updated', 'model_credential.set', 'model_credential.revoked', 'tool.kill_switch_flipped', 'tool.classification_changed', 'agent.registered', 'agent.suspended', 'agent.resumed', 'agent.retired', 'agent.interjection_answered', 'evidence.disclosure_grain_changed', 'agent_run.event_sequence_conflict', 'agent_run.forged_decision_reference', 'agent_run.stale_deny_generation', 'agent_run.finalization_grant_misuse', 'mandate.granted', 'mandate.limits_changed', 'mandate.revoked', 'mandate.expired', 'mandate.exception', 'approval.auto_approved', 'approval_rule.changed', 'approval_rule.invalidated', 'approval_rule.deleted', 'access.review_completed', 'access.member_access_confirmed', 'privacy.export_requested', 'privacy.erasure_requested', 'privacy.org_erasure_requested', 'steering.published', 'steering.governance_changed', 'steering.governance_overridden', 'sso.provider_created', 'sso.domain_verified', 'sso.provider_updated', 'sso.provider_deleted', 'sso.policy_updated', 'sso.group_roles_set', 'sso.sign_in', 'scim.token_created', 'scim.token_rotated', 'scim.token_revoked', 'scim.user_provisioned', 'scim.user_updated', 'scim.user_deprovisioned', 'scim.group_changed', 'scim.request_denied', 'tacho.host_revoked', 'tacho.workspace_runs_paused'));

-- ════════════════════════════════════════════════════════════════════════════
-- 4. tacho.sessions identity backfill (#2951, #2908, D1).
--
-- The agent and its principal come from the session's host, as genesisRow
-- in packages/handlers/src/tacho.events.ingest.ts writes them.
UPDATE "tacho"."sessions" AS s
SET "agent_id" = h."agent_id"
FROM "tacho"."hosts" AS h
WHERE s."host_id" = h."id"
  AND s."org_id" = h."org_id"
  AND s."agent_id" IS NULL
  AND h."agent_id" IS NOT NULL;

UPDATE "tacho"."sessions" AS s
SET "agent_principal_id" = h."agent_principal_id"
FROM "tacho"."hosts" AS h
WHERE s."host_id" = h."id"
  AND s."org_id" = h."org_id"
  AND s."agent_principal_id" IS NULL
  AND h."agent_principal_id" IS NOT NULL;

-- The person is the host's enroller, and only when that enroller has a human
-- principal in the session's own org, as enrollingOperator() resolves it.
-- The partial unique index principals_org_parent_user_uniq allows one such
-- principal per (org_id, parent_user_id), so the join matches at most one
-- row.
--
-- A session with neither column recorded takes both.
UPDATE "tacho"."sessions" AS s
SET "initiating_principal_id" = p."id",
    "initiating_user_id" = h."created_by_id"
FROM "tacho"."hosts" AS h
JOIN "iam"."principals" AS p
  ON p."org_id" = h."org_id"
 AND p."parent_user_id" = h."created_by_id"
 AND p."kind" = 'human'
WHERE s."host_id" = h."id"
  AND s."org_id" = h."org_id"
  AND h."created_by_id" IS NOT NULL
  AND s."initiating_principal_id" IS NULL
  AND s."initiating_user_id" IS NULL;

-- Genesis wrote the initiating principal before this batch and left the user
-- null. Such a session takes the user only when its recorded principal is
-- the enroller's human principal in the same org. A principal that names
-- anyone else stays as recorded, and its user stays null.
UPDATE "tacho"."sessions" AS s
SET "initiating_user_id" = p."parent_user_id"
FROM "tacho"."hosts" AS h
JOIN "iam"."principals" AS p
  ON p."org_id" = h."org_id"
 AND p."parent_user_id" = h."created_by_id"
 AND p."kind" = 'human'
WHERE s."host_id" = h."id"
  AND s."org_id" = h."org_id"
  AND p."id" = s."initiating_principal_id"
  AND s."initiating_user_id" IS NULL;
