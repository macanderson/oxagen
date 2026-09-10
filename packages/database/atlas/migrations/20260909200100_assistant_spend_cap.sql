-- ADR-053 §3: a per-organisation cap on assistant tokens the PLATFORM key pays
-- for, in credit cents per calendar month.
--
-- The platform key funds every organisation that has not brought its own, so
-- without a cap one organisation's prompting can drain it for all of them. A
-- turn that would cross the cap is refused before it starts, with a message
-- that names the cap. The cap is irrelevant to an organisation on its own key,
-- whose tokens Oxagen never pays for and never bills.
--
-- 2000 cents ($20) a month by default: enough for the governance questions the
-- assistant exists to answer, small enough that the default cannot surprise.
-- NULL means no cap, and is a deliberate operator choice, never the default.

ALTER TABLE "billing"."org_billing_settings"
  ADD COLUMN "assistant_spend_cap_cents" bigint NULL DEFAULT 2000;
