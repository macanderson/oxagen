-- Record the workspace an export was queued in, so its authority can be
-- rechecked where it was granted rather than where the download asks from.
--
-- `get_export_status` rechecks whether an explicit rule has revoked
-- `export_data` before it releases an organization archive. That recheck reads
-- the CALLER's current workspace, and the download route is mounted under any
-- workspace slug in the organization. So a deny written in the workspace the
-- export was queued through was evaded by asking again through a sibling
-- workspace: the row carried no workspace at all, and B's policy answered for
-- A's archive. The bypass costs nothing to perform and hands over every
-- person's data in the organization.
--
-- Nullable, because rows queued before this migration have no answer and one
-- must not be invented. The handler reads a null as organization scope, which
-- sees organization-level rules and not workspace-keyed ones: less than the
-- full check, and still strictly better than trusting the scope the requester
-- picked. New rows always carry the workspace, so the gap closes as they age
-- out rather than being backfilled with a guess.
ALTER TABLE "privacy"."privacy_export_requests"
  ADD COLUMN "workspace_id" uuid;

-- The recheck reads this column on every organization-scope download.
CREATE INDEX "privacy_export_requests_workspace_idx"
  ON "privacy"."privacy_export_requests" ("workspace_id");
