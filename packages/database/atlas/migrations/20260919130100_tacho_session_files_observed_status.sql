-- What git says happened to a file, beside what a tool said it did.
--
-- `reads`, `writes`, `edits` and `deletes` count tool calls: a file the
-- agent announced it was writing. They cannot say whether the write landed,
-- and they say nothing at all about a file changed by a shell command, a
-- formatter or a build. `lines_added` and `lines_removed` have been on this
-- table since it was created and nothing has ever written them, for the same
-- reason: no attested frame carries a line count.
--
-- The collector now seals what it reads from git at a turn boundary, so the
-- observed verdict on a path has somewhere to go. `observed_status` is that
-- verdict, one of added, modified, deleted or renamed. It is null for a path
-- no reconciliation covered, which is not the same as a path git found
-- unchanged.
--
-- It is a column of its own rather than an increment of `writes` or
-- `deletes`, because those count events and this states a condition. Adding
-- an observation to a counter would report one file written twice.
ALTER TABLE "tacho"."session_files"
  ADD COLUMN "observed_status" text;
