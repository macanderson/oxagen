-- Drop the dead form tables (form.create and form.submit capabilities removed).
-- These tables were created in the original schema migration and are no longer
-- referenced by any application code. The Drizzle schema declarations were
-- removed in the same change that deleted the capability handlers.
--
-- Destructive: data in these tables is permanently lost. Verify no rows exist
-- in production before applying, or accept the loss (capability was unused).

-- Drop form_submissions first (it has a form_id FK reference to forms).
DROP TABLE IF EXISTS content.form_submissions;
DROP TABLE IF EXISTS content.forms;
