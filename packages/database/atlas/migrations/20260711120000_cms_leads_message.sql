-- Free-form note from the lead: the homepage "Get a demo" form's
-- "What are you building?" textarea. Book-gate submissions leave it null.
ALTER TABLE cms.leads ADD COLUMN IF NOT EXISTS message text;
