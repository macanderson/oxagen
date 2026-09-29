// assistant.attachment-sweep.ts: hourly cron that deletes the files a person
// attached to the in-app assistant's composer and never sent (#4690, ADR-222).
//
// The composer stores a file the moment it is attached, before the message is
// sent. A person who removes the chip, closes the tab, or never sends leaves a
// row and its bytes behind. A sent turn links every file it carries to the
// conversation (`linkTurnAttachments` in @oxagen/agent), so an upload still
// unlinked a day after it was stored was never sent. This job deletes its
// bytes, then its row.
//
// Each batch runs in one transaction and locks its rows with FOR UPDATE SKIP
// LOCKED. A turn that links one of those rows mid-batch waits for the commit,
// finds the row gone, and links nothing. The turn read the bytes before it
// linked them, so its reply is unaffected. A blob the store refuses to delete
// keeps its row, and the next run tries it again.
//
// Instrumentation: logs deleted and failed counts with durationMs so the
// Inngest dashboard can track the sweep.

import { sql } from "drizzle-orm";
import { withSystemDb } from "@oxagen/database";
import { storage } from "@oxagen/storage";
import { createFunction } from "../create-function";
import { logger } from "../logger";

/** How long an upload waits for its message before it counts as unsent. */
export const UNSENT_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;
/** Rows one transaction locks, so no batch holds its locks for long. */
const BATCH_SIZE = 100;
/** Batches one run takes. A larger backlog clears over the next hours. */
const MAX_BATCHES = 10;

interface BatchResult {
  selected: number;
  deleted: number;
  failed: number;
}

async function sweepBatch(): Promise<BatchResult> {
  const store = storage();
  const cutoff = new Date(Date.now() - UNSENT_ATTACHMENT_TTL_MS);
  // tenancy: a scheduled cross-tenant sweep over all orgs. The select is
  // filtered to user uploads under attachments/ that no message linked within
  // a day, and each row is deleted by its own id, so no tenant's data moves.
  const result = await withSystemDb(async (tx) => {
    const rows = Array.from(
      await tx.execute(sql`
        SELECT id, storage_key
        FROM   content.generated_assets
        WHERE  source = 'user_upload'
        AND    storage_key LIKE 'attachments/%'
        AND    storage_provider = ${store.driver}
        AND    conversation_id IS NULL
        AND    created_at < ${cutoff.toISOString()}
        ORDER  BY created_at
        LIMIT  ${BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `),
    ) as { id: string; storage_key: string }[];

    const cleared: string[] = [];
    for (const row of rows) {
      try {
        await store.delete(row.storage_key);
        cleared.push(row.id);
      } catch (err) {
        logger.warn(
          {
            assetId: row.id,
            err: err instanceof Error ? err.message : String(err),
          },
          "assistant.attachment-sweep: the store refused a delete; the row stays for the next run",
        );
      }
    }
    if (cleared.length > 0) {
      await tx.execute(sql`
        DELETE FROM content.generated_assets
        WHERE  id = ANY(${sql.param(cleared)}::uuid[])
      `);
    }
    return {
      selected: rows.length,
      deleted: cleared.length,
      failed: rows.length - cleared.length,
    };
  });
  return result;
}

export const [assistantAttachmentSweep] = createFunction(
  {
    id: "assistant.attachment-sweep",
    retries: 3,
    concurrency: { limit: 1 },
  },
  // Every hour, on the hour.
  { cron: "0 * * * *" },
  async ({ step }) => {
    const startMs = Date.now();
    let deleted = 0;
    let failed = 0;
    let batches = 0;
    for (let i = 0; i < MAX_BATCHES; i++) {
      const batch = await step.run(`sweep-batch-${String(i)}`, sweepBatch);
      batches++;
      deleted += batch.deleted;
      failed += batch.failed;
      // A short batch means the backlog is clear. A failed delete means the
      // store is refusing, and the next batch would select the same rows.
      if (batch.selected < BATCH_SIZE || batch.failed > 0) break;
    }

    logger.info(
      { deleted, failed, batches, durationMs: Date.now() - startMs },
      "assistant.attachment-sweep: deleted unsent attachments",
    );
    return { deleted, failed, batches };
  },
);
