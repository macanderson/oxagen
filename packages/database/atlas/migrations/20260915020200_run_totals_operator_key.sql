-- cost.run_totals.operator_key — the operator's principal public id (`prn_…`).
--
-- The `operator` level of cost.daily_totals groups on this key and
-- get_spend_drill filters on it, so an operator on the wire is the same id
-- list_runs answers as `operatorId`; operator_principal_id keeps the uuid for
-- the row's link to iam.principals. Nullable and additive: rows rolled up
-- before this column exists carry null until the nightly sweep or a rebuild
-- writes them again. RLS inherits from the table (20260915020100).
ALTER TABLE "cost"."run_totals" ADD COLUMN "operator_key" text NULL;
