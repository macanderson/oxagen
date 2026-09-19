-- Record the Attio sync state on each website lead.
--
-- /v1/cms/leads now upserts every captured lead into Attio after the Postgres
-- write returns (apps/api/src/lib/cms/crm-sync.ts). The row keeps the Attio
-- record id, the time of the last successful sync and the last failure, so a
-- lead the CRM never received is visible in the table and the backfill
-- (`pnpm --filter @oxagen/api cms:crm-backfill`) can find it.
ALTER TABLE "cms"."leads"
  ADD COLUMN "crm_record_id" text,
  ADD COLUMN "crm_synced_at" timestamp with time zone,
  ADD COLUMN "crm_sync_error" text;

-- The backfill asks only for rows the CRM has not seen; index that set alone.
CREATE INDEX "cms_leads_crm_pending_idx" ON "cms"."leads" USING btree ("created_at")
  WHERE "crm_synced_at" IS NULL;
