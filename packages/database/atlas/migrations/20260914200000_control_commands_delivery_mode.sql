-- Run controls with a delivery mode on every run (issue #2953; Mission Control
-- spec §7.3, §7.4, Appendix A.6; ADR-056).
--
-- tacho.control_commands keeps its lifecycle columns (payload, issued_by_*,
-- issued_at, expires_at, delivered_at, acknowledged_at, applied_at,
-- applied_at_seq, outcome, outcome_detail) and gains what a run-addressed
-- command needs:
--   target_kind / target_id  — the recipient: a host (tch_…) or one run
--                              (tse_… / arun_…). A broadcast is one row per
--                              recipient run; the address travels in payload.
--   requested_mode / delivery_mode / degraded_reason — §7.3, recorded
--                              separately so a report shows the mode that was
--                              achieved, never the one that was asked for.
--   reason                   — the operator's reason, read by the model on
--                              resume; previously buried in payload.
-- host_id becomes nullable: a run recorded outside a host has none.
-- The command CHECK gains `steer`; the outcome CHECK moves to the §7.4
-- vocabulary with pending → queued and delivered → sent mapped in place --
-- the CHECK widening first, so that the rows have somewhere to land.

ALTER TABLE "tacho"."control_commands"
  ALTER COLUMN "host_id" DROP NOT NULL,
  ADD COLUMN "target_kind" text,
  ADD COLUMN "target_id" text,
  ADD COLUMN "requested_mode" text,
  ADD COLUMN "delivery_mode" text,
  ADD COLUMN "degraded_reason" text,
  ADD COLUMN "reason" text;

-- Existing rows: a session-addressed command is a run-addressed one, and a
-- host-addressed command stays addressed to its host.
UPDATE "tacho"."control_commands" c
SET "target_kind" = 'run', "target_id" = s."public_id"
FROM "tacho"."sessions" s
WHERE c."session_id" = s."id" AND c."target_kind" IS NULL;

UPDATE "tacho"."control_commands" c
SET "target_kind" = 'host', "target_id" = h."public_id"
FROM "tacho"."hosts" h
WHERE c."host_id" = h."id" AND c."target_kind" IS NULL;

UPDATE "tacho"."control_commands"
SET "reason" = "payload"->>'reason'
WHERE "reason" IS NULL AND jsonb_typeof("payload"->'reason') = 'string';

ALTER TABLE "tacho"."control_commands"
  ALTER COLUMN "target_kind" SET NOT NULL,
  ALTER COLUMN "target_id" SET NOT NULL;

-- Drop, remap, then re-add: the old vocabulary and the new one have no value
-- in common for the rows that exist, so no single statement can hold. The
-- CHECK in force here is the one 20260908120000 created, admitting only
-- pending/delivered/applied/expired/failed. Setting a row to 'queued' under it
-- violates it, and adding the §7.4 CHECK while a row is still 'pending'
-- violates that one (both 23514) — so the constraint comes off, the rows move,
-- and it goes back on.
--
-- CI applies this directory to an empty database, where both UPDATEs match
-- nothing and no ordering can show, so the first database to run this with
-- rows in the table was production: 14 commands, every one of them 'pending'
-- (2026-09-17).
ALTER TABLE "tacho"."control_commands"
  DROP CONSTRAINT "tacho_control_commands_outcome_check";

UPDATE "tacho"."control_commands" SET "outcome" = 'queued' WHERE "outcome" = 'pending';
UPDATE "tacho"."control_commands" SET "outcome" = 'sent' WHERE "outcome" = 'delivered';

ALTER TABLE "tacho"."control_commands"
  ADD CONSTRAINT "tacho_control_commands_outcome_check" CHECK ("tacho"."control_commands"."outcome" IN ('draft', 'queued', 'sent', 'received', 'acknowledged', 'applied', 'cancelled', 'expired', 'failed'));

ALTER TABLE "tacho"."control_commands"
  ALTER COLUMN "outcome" SET DEFAULT 'queued',
  DROP CONSTRAINT "tacho_control_commands_command_check",
  ADD CONSTRAINT "tacho_control_commands_command_check" CHECK ("tacho"."control_commands"."command" IN ('pause', 'resume', 'cancel', 'steer', 'message', 'revoke', 'refresh_bundle', 'kill')),
  ADD CONSTRAINT "tacho_control_commands_target_kind_check" CHECK ("tacho"."control_commands"."target_kind" IN ('host', 'run')),
  ADD CONSTRAINT "tacho_control_commands_requested_mode_check" CHECK ("tacho"."control_commands"."requested_mode" IS NULL OR "tacho"."control_commands"."requested_mode" IN ('next_step', 'interrupt', 'turn_boundary')),
  ADD CONSTRAINT "tacho_control_commands_delivery_mode_check" CHECK ("tacho"."control_commands"."delivery_mode" IS NULL OR "tacho"."control_commands"."delivery_mode" IN ('next_step', 'interrupt', 'turn_boundary'));

CREATE INDEX "tacho_control_commands_target_idx" ON "tacho"."control_commands" USING btree ("org_id", "workspace_id", "target_kind", "target_id", "issued_at");
