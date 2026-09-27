import { createFunction } from "../create-function";
import { logger } from "../logger";
import {
  archiveAfterDays,
  archiveCutoff,
  archiveIdleSessions,
  listWorkspacePage,
} from "../lib/stella-session-archive";

/** Workspaces per step. Each page is its own step, so a retry resumes there. */
const PAGE_SIZE = 200;

/** What one page of workspaces reports back to the run. */
interface PageResult {
  workspaces: number;
  archived: number;
  failed: number;
  nextCursor: string | null;
}

/**
 * Daily at 04:30 UTC: archive every Stella session that has had no reply for
 * its workspace's archive window (#4435). The window is
 * `[stella] archive_after_days` in workspace.toml, 7 days when unset. The rule
 * and what the archive leaves alone are in
 * `../lib/stella-session-archive.ts`.
 *
 * Each workspace is archived in its own transaction and tenant scope. One
 * that fails is logged and left for the next night.
 */
export const [stellaSessionArchive] = createFunction(
  {
    id: "stella.session-archive",
    retries: 3,
    concurrency: { limit: 1 },
  },
  { cron: "30 4 * * *" },
  async ({ step }) => {
    let cursor: string | null = null;
    let page = 0;
    let workspaces = 0;
    let archived = 0;
    let failed = 0;

    for (;;) {
      const after: string | null = cursor;
      const result = await step.run(
        `archive-sessions-page-${page}`,
        async (): Promise<PageResult> => {
          const now = new Date();
          const rows = await listWorkspacePage({ after, limit: PAGE_SIZE });
          let pageArchived = 0;
          let pageFailed = 0;
          for (const workspace of rows) {
            const days = archiveAfterDays(workspace.settings);
            try {
              pageArchived += await archiveIdleSessions(
                workspace,
                archiveCutoff(now, days),
                now,
              );
            } catch (err) {
              pageFailed += 1;
              logger.warn(
                { err, workspaceId: workspace.id, days },
                "stella.session-archive: a workspace failed. The next run retries it.",
              );
            }
          }
          return {
            workspaces: rows.length,
            archived: pageArchived,
            failed: pageFailed,
            nextCursor:
              rows.length === PAGE_SIZE
                ? (rows[rows.length - 1]?.id ?? null)
                : null,
          };
        },
      );

      workspaces += result.workspaces;
      archived += result.archived;
      failed += result.failed;
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
      page += 1;
    }

    logger.info(
      { workspaces, archived, failed },
      "stella.session-archive complete",
    );
    return { workspaces, archived, failed };
  },
);
