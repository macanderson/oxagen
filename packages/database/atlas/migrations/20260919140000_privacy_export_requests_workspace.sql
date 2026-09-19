-- The workspace that governed an export when it was queued.
--
-- `get_export_status` rechecks `export_data` before releasing an organization
-- archive. Without this column the recheck used the download request's current
-- workspace, so a deny written in workspace A was invisible when the same
-- archive was polled through workspace B. Nullable: rows queued before this
-- migration, and requests that named no real workspace, have nothing to bind.
ALTER TABLE "privacy"."privacy_export_requests"
  ADD COLUMN "workspace_id" uuid NULL;
