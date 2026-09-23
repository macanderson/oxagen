-- Cost-center chargeback on Spend (ADR-142).
--
-- Additive only:
--
--   1. cost.cost_centers — the organization's list of valid labels. One row
--      per (org, label) for ever: deleting a label soft-deletes its row, and
--      adding it back restores that row, so a statement keyed by label names
--      one row across its history.
--   2. agent.agents.cost_center and workspace.workspaces.cost_center — the
--      label each is charged back to. The write handler checks the label
--      against the live list; there is no cross-schema FK.
--   3. cost.run_totals.cost_center — the label the rollup resolved (agent
--      first, then workspace), and `cost_center` as a daily_totals level.
--
-- Existing run_totals rows keep a null cost_center until they are rebuilt, so
-- their spend reads as unassigned: the honest answer for spend nobody labelled.

CREATE TABLE "cost"."cost_centers" (
  "id" uuid NOT NULL DEFAULT COALESCE(
CASE
    WHEN (to_regprocedure('public.uuid_generate_v7()'::text) IS NOT NULL) THEN public.uuid_generate_v7()
    ELSE public.uuid_generate_v4()
END, public.uuid_generate_v4()),
  "public_id" citext NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "created_by_id" uuid NULL,
  "updated_by_id" uuid NULL,
  "deleted_at" timestamptz NULL,
  "deleted_by_id" uuid NULL,
  "org_id" uuid NOT NULL,
  "label" citext NOT NULL,
  "description" text NULL,
  PRIMARY KEY ("id"),
  CONSTRAINT "cost_centers_public_id_unique" UNIQUE ("public_id"),
  CONSTRAINT "cost_centers_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "org"."organizations" ("id") ON UPDATE NO ACTION ON DELETE CASCADE,
  CONSTRAINT "cost_centers_label_check" CHECK (label ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$')
);
CREATE UNIQUE INDEX "cost_centers_org_label_idx" ON "cost"."cost_centers" ("org_id", "label");

ALTER TABLE "agent"."agents"
  ADD COLUMN "cost_center" text NULL,
  ADD CONSTRAINT "agents_cost_center_check" CHECK ((cost_center IS NULL) OR (cost_center ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'));

ALTER TABLE "workspace"."workspaces"
  ADD COLUMN "cost_center" text NULL,
  ADD CONSTRAINT "workspaces_cost_center_check" CHECK ((cost_center IS NULL) OR (cost_center ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'));

ALTER TABLE "cost"."run_totals"
  ADD COLUMN "cost_center" text NULL,
  ADD CONSTRAINT "run_totals_cost_center_check" CHECK ((cost_center IS NULL) OR (cost_center ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'));

ALTER TABLE "cost"."daily_totals"
  DROP CONSTRAINT "daily_totals_kind_check",
  ADD CONSTRAINT "daily_totals_kind_check" CHECK (group_kind = ANY (ARRAY['operator'::text, 'agent'::text, 'model'::text, 'tool'::text, 'task'::text, 'cost_center'::text]));

-- oxagen_app least-privilege grants (guarded: fresh clusters may lack the role).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'oxagen_app') THEN
    GRANT SELECT, INSERT, UPDATE ON cost.cost_centers TO oxagen_app;
  END IF;
END
$$;
