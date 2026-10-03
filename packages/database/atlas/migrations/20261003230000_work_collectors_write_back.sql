-- #4775: work.collectors stores each collector's [write_back] switches.
--
-- The send-back job posts a note on a work item through its collector's
-- write-back, and runs it only when that collector's send_note switch is on.
-- Until now the row stored no switches, and every reader took them as off
-- (ADR-250). The column holds the switches the collector file sets. Every row
-- starts with all five off, so no collector writes to its provider until a
-- person turns a switch on.
--
-- The stamp is later than main's newest migration, 20261003210000.

ALTER TABLE work.collectors
  ADD COLUMN IF NOT EXISTS write_back jsonb NOT NULL DEFAULT '{"certify_note": false, "send_note": false, "status": false, "close": false, "labels": false}'::jsonb;
