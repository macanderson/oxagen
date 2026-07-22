-- Server-owned provenance for enrolled Stella operational-telemetry API keys.
--
-- Both columns intentionally default to NULL. Existing keys that merely carry
-- a forged or historical JSON scope marker therefore fail closed at intake.
-- Only the operator-controlled Stella provisioning workflow may bind these
-- columns; generic API-key create and rotate capabilities do not expose them.

ALTER TABLE "auth"."api_keys"
  ADD COLUMN "stella_telemetry_enrollment_id" text,
  ADD COLUMN "stella_telemetry_enrolled_at" timestamp with time zone,
  ADD CONSTRAINT "api_keys_stella_telemetry_enrollment_check" CHECK (
    ("stella_telemetry_enrollment_id" IS NULL AND "stella_telemetry_enrolled_at" IS NULL)
    OR (
      "stella_telemetry_enrollment_id" IS NOT NULL
      AND "stella_telemetry_enrollment_id" ~ '^[A-Za-z0-9._:-]{1,128}$'
      AND "stella_telemetry_enrolled_at" IS NOT NULL
    )
  );
