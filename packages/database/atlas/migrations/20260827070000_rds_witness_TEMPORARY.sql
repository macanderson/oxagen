-- TEMPORARY — witness for #1347. Reverted in the next commit on this branch.
--
-- This is the exact shape 20260612052000_regrant_oxagen_app.sql carried before
-- #1333: an unconditional ALTER ROLE touching a privilege bit. It succeeds on a
-- superuser container and fails 42501 on Aurora. If `rds-compatibility` is doing
-- what it claims, this commit turns it red and the revert turns it green.
ALTER ROLE rds_sim NOBYPASSRLS;
