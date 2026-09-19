-- The workspace whose export_data policy governed an export request.
--
-- get_export_status re-asks export_data's policy before it releases an
-- organization archive. It asked in the workspace of the download request, and
-- the download route is mounted under any workspace slug, so a deny written in
-- the workspace that queued the export could be stepped around by downloading
-- through another workspace of the same organization. Recording the queuing
-- workspace lets the recheck ask there as well.
--
-- A request made in no workspace records the org-only sentinel
-- (00000000-0000-0000-0000-000000000000, ADR-068). Null is left only on rows
-- written before this column, whose governing workspace is unknown.
-- get_export_status refuses an organization archive on such a row rather than
-- check a workspace that may not be the one that governed it. A personal
-- export is unaffected: no workspace policy ever gated it.
ALTER TABLE "privacy"."privacy_export_requests"
  ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
