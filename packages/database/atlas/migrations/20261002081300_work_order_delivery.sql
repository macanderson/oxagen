-- Work order delivery (P1-04, #5100; ADR-250).
--
-- agent-work-phase-1.html, Delivery and review: a send reaches the runtime the
-- person chose through the existing command channel, a retry cannot start a
-- second run, and the results are tied to the pull request's exact head. P1-02
-- (20261002030300_work_records.sql, ADR-244) stores the work order and its
-- facts. This migration adds what delivery and result ingestion need:
--
--   tacho.control_commands  the `work_order` command, and an idempotency key
--                           with a unique index, so a retried send writes no
--                           second command
--   work.item_facts         an index on the pull request a `pr_linked` fact
--                           names, so a GitHub delivery finds its send
--
-- No row changes. Every existing command keeps a null key.

-- ---------------------------------------------------------------------------
-- tacho.control_commands
-- ---------------------------------------------------------------------------

ALTER TABLE "tacho"."control_commands"
  ADD COLUMN IF NOT EXISTS "idempotency_key" text;

ALTER TABLE "tacho"."control_commands"
  DROP CONSTRAINT IF EXISTS "tacho_control_commands_command_check";
ALTER TABLE "tacho"."control_commands"
  ADD CONSTRAINT "tacho_control_commands_command_check" CHECK ("tacho"."control_commands"."command" IN ('pause', 'resume', 'cancel', 'steer', 'message', 'revoke', 'refresh_bundle', 'kill', 'work_order'));

ALTER TABLE "tacho"."control_commands"
  DROP CONSTRAINT IF EXISTS "tacho_control_commands_idempotency_key_check";
ALTER TABLE "tacho"."control_commands"
  ADD CONSTRAINT "tacho_control_commands_idempotency_key_check" CHECK ("tacho"."control_commands"."idempotency_key" IS NULL OR length("tacho"."control_commands"."idempotency_key") BETWEEN 1 AND 256);

-- One command per key in a workspace. A work order's command takes the order's
-- key (`<item>:r<brief revision>:s<send>`), so a retried send finds the row it
-- wrote and the runtime is offered one command for one send.
CREATE UNIQUE INDEX IF NOT EXISTS "tacho_control_commands_key_uniq"
  ON "tacho"."control_commands" ("org_id", "workspace_id", "idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- work.item_facts
-- ---------------------------------------------------------------------------

-- A pull_request delivery names a repository and a number. The send that ran
-- it is found by the pr_linked fact that names the same pull request.
CREATE INDEX IF NOT EXISTS item_facts_pr_linked_idx
  ON work.item_facts (org_id, workspace_id, repository, pr_number)
  WHERE kind = 'pr_linked';
