-- The workspace whose export_data policy governed an export request.
--
-- get_export_status re-asks export_data's policy before it releases an
-- organization archive. It asked in the workspace of the download request, and
-- the download route is mounted under any workspace slug, so a deny written in
-- the workspace that queued the export could be stepped around by downloading
-- through another workspace of the same organization. Recording the queuing
-- workspace lets the recheck ask there as well.
--
-- Nullable: a request made in no workspace has none, and rows written before
-- this column are left as they are. Those rows fall back to the check in the
-- calling scope, which is what they had before.
ALTER TABLE "privacy"."privacy_export_requests"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
