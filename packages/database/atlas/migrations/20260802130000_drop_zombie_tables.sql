-- Drop 4 zombie tables verified dead by the 2026-07-11 Postgres schema audit
-- (docs/audits/2026-07-11-postgres-schema-audit.md §2) + per-table code-usage
-- greps: each was declared and written but NEVER read anywhere in the codebase.
--
--   auth.credentials          — superseded by environments.secret_keys/values
--                               and mcp.credentials; zero read/write paths.
--   billing.usage_records     — write-only nightly mirror of ClickHouse usage
--                               (billing reads sumTokenUsage() from ClickHouse
--                               directly); the billing.rollup-usage cron that
--                               fed it is removed in the same change.
--   billing.org_billing_profiles — billing PII written at org-create/onboarding
--                               and never read; Stripe captures the billing
--                               address at checkout and is the source of truth.
--                               Dropping also removes a GDPR data-minimization
--                               liability.
--   billing.invoice_line_items — delete-then-insert mirror on Stripe invoice
--                               webhooks, never read; the invoices UI links to
--                               the Stripe-hosted invoice and receipts read
--                               line items off the provider payload.
--
-- Data loss is intentional and approved: rows in these tables are write-only
-- mirrors whose sources of truth are ClickHouse (usage) and Stripe (billing
-- PII + invoice detail). RLS policies and indexes drop with their tables.
DROP TABLE IF EXISTS "billing"."invoice_line_items";
DROP TABLE IF EXISTS "billing"."usage_records";
DROP TABLE IF EXISTS "billing"."org_billing_profiles";
DROP TABLE IF EXISTS "auth"."credentials";
