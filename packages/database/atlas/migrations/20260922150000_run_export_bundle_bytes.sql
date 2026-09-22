-- The size of a run export bundle (get_run_export; spec §13.4, ADR-058).
--
-- get_run_export answers a bundle's status, digest, size and a download link.
-- The job knows the size when it writes the bundle, so it records it here
-- rather than asking the object store on every read. Nullable: a bundle built
-- before this column reads back with no size, and the ready check does not
-- demand one for that reason.

ALTER TABLE "evidence"."run_exports" ADD COLUMN "bundle_bytes" integer NULL;

ALTER TABLE "evidence"."run_exports" DROP CONSTRAINT "run_exports_digest_check";
ALTER TABLE "evidence"."run_exports" ADD CONSTRAINT "run_exports_digest_check" CHECK (
  ("bundle_digest" IS NULL OR "bundle_digest" ~ '^sha256:[0-9a-f]{64}$')
  AND ("merkle_root" IS NULL OR "merkle_root" ~ '^sha256:[0-9a-f]{64}$')
  AND ("frame_count" IS NULL OR "frame_count" >= 0)
  AND ("bundle_bytes" IS NULL OR "bundle_bytes" >= 0)
);
