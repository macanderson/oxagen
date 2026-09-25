-- What an approval row asks a person for (ADR-XXX): `approval` of a parked
-- call, or first-use `consent` to an external MCP tool.
--
-- `resolve_mcp_consent` answers a consent row and refuses every other kind.
-- Before this column it answered any pending row by its uuid, so a model
-- holding the tool could approve a write its own turn had parked. The kind is
-- recorded by the writer rather than inferred from the capability name,
-- because an external tool's rule-driven approval carries the same
-- `mcp.<server>.<tool>` name as its consent request. A writer that does not
-- say gets `approval`, which the consent resolver refuses.
ALTER TABLE "agent"."approval_requests"
  ADD COLUMN "kind" text NOT NULL DEFAULT 'approval';

ALTER TABLE "agent"."approval_requests"
  ADD CONSTRAINT "approval_requests_kind_check"
  CHECK ("kind" IN ('approval', 'consent'));

-- The rows the consent gate wrote before this column, read by the shape only
-- that writer produced: an MCP tool name, medium risk, and no mandate, resume
-- key, stored call or input digest. An external tool's rule-driven approval
-- is high risk and stores a digest, so it stays `approval`.
UPDATE "agent"."approval_requests"
SET "kind" = 'consent'
WHERE "capability_name" LIKE 'mcp.%'
  AND "risk_level" = 'medium'
  AND "mandate_id" IS NULL
  AND "resume_key" IS NULL
  AND "resume_payload" IS NULL
  AND "input_digest" IS NULL;
