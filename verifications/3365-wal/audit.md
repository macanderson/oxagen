# WAL body failure repair

Base: fresh origin/main ec637f8e4. Recovery #3543 must be incorporated before merge.

Five tests passed in packages/tacho/src/host/wal-body-failure.test.ts, the only local test file run for this subtask. Broader suites and builds await CI.

Inspected #3544 at 412f83cd865c598217c7535e7f6aaf339f11f27f. Its streaming WAL reads and retention rewrite must be preserved when integrating this branch. This patch changes body append failure handling, body-read failure handling and daemon diagnostics. It does not replace the event reader or retention implementation.

The body path EISDIR test uses the filesystem. The ENOSPC test writes a partial record through the real append function before throwing. A new WAL instance appends the next batch, reads the original event sequence and returns valid bodies on both sides of the torn record.

Parent independently approved source and coverage. Malformed-record diagnostics are bounded to one per session read, with a regression.
