-- A run that pushes is the run that left the machine, and the session row
-- could not count it.
--
-- `commits` and `pull_requests` have been on this table since it was created
-- and nothing ever wrote them, because the collector classified every git
-- command as a generic `command` frame: `git push origin main` and `git
-- status` were the same record. The collector now classifies `git_commit`,
-- `git_push` and `pr_open` as their own effect kinds, so the two dead
-- counters can be filled.
--
-- `pushes` is the third of that set and the one the table was missing. It
-- matters more than the other two for the same reason a push matters more
-- than a commit: a commit is local and reversible, a push is the point at
-- which an agent's work reaches a shared branch and other people. A record
-- that can say what a run changed but not whether it published the change
-- answers the smaller half of the question.
ALTER TABLE "tacho"."sessions"
  ADD COLUMN "pushes" integer NOT NULL DEFAULT 0;
