-- Drop the reseller re-bill tables.
--
-- Oxagen sells direct to the enterprise team that runs the agents and answers
-- for them. There is no margin line between Oxagen and the buyer, so there is
-- nothing for anyone to resell, and the "Stripe for agents" re-bill loop these
-- six tables backed is a business the company is not in.
--
-- This is a CONTRACT migration: every reader and writer of these tables was
-- removed in the same body of work -- the fifteen `billing.reseller_*`
-- capability contracts, their handlers and MCP tools, the combined
-- `apps/api/src/routes/v1/reseller.ts` route, the Billing -> Revenue page,
-- @oxagen/billing's reseller / reseller-pricing / reseller-rebill /
-- reseller-secret modules, the external-invoice primitive on the billing port,
-- the reseller usage-attribution query in @oxagen/telemetry, and the Drizzle
-- schema file. Recovery is from git history plus a restore.
--
-- Dropped in FK order: line items reference runs, runs and attribution rules
-- reference customers, customers reference price plans. CASCADE would do the
-- same, but naming the order documents the graph for the next reader.
--
-- The five `billing.reseller_*` values are removed from the security_events
-- event_type CHECK by the migration beside this one
-- (20260909130000_event_type_check_drops_reseller.sql), which carries the
-- reasoning for why that one is NOT VALID.
--
-- Idempotent: IF EXISTS on every drop.

DROP TABLE IF EXISTS "billing"."reseller_rebill_line_items";
DROP TABLE IF EXISTS "billing"."reseller_rebill_runs";
DROP TABLE IF EXISTS "billing"."reseller_attribution_rules";
DROP TABLE IF EXISTS "billing"."reseller_customers";
DROP TABLE IF EXISTS "billing"."reseller_price_plans";
DROP TABLE IF EXISTS "billing"."reseller_settings";
