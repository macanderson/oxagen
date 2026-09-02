import { createFunction } from "../create-function";
import { withSystemDb, schema } from "@oxagen/database";
import { asc, gt } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import {
  applyDecayToMemory,
  listDecayableMemories,
} from "@oxagen/agent/memory/neo4j";
import { insertMemoryChange } from "@oxagen/telemetry";
import { logger } from "../logger";

// Keyset-pagination page size for the WORKSPACE sweep. Note this bounds the
// number of workspaces per Inngest step, not the work inside one: a page still
// lists and rewrites every decayable memory of all 200 workspaces in a single
// step, so a large tenant can push one step past its timeout budget.
const PAGE_SIZE = 200;

// Below this delta, skip the write — floating point / decay noise, not a
// meaningful confidence change.
const EPSILON = 0.001;

/**
 * Two-axis decay curve (DESIGN.md §7a):
 *   new_conf = floor + (conf - floor) * 0.5 ^ (daysSince / halfLifeDays)
 *
 * `daysSince` is measured from `lastEvidenceAt` (already falls back to
 * `createdAt` inside `listDecayableMemories()`'s Cypher projection). Each
 * memory carries its own `halfLifeDays`/`decayFloor`, set at write time from
 * the workspace policy (`halfLifeLowDays`/`halfLifeHighDays`/
 * `defaultDecayFloor`) — no policy lookup is needed here.
 */
function calcNewConfidence(
  confidenceScore: number,
  halfLifeDays: number,
  decayFloor: number,
  lastEvidenceAt: string | null,
  createdAt: string,
): number {
  const anchor = lastEvidenceAt ?? createdAt;
  const daysSince =
    (Date.now() - new Date(anchor).getTime()) / (1000 * 60 * 60 * 24);
  const decayed =
    decayFloor +
    (confidenceScore - decayFloor) * Math.pow(0.5, daysSince / halfLifeDays);
  // Mathematically the curve never dips below the floor (0.5^x is in (0,1]
  // for x >= 0), but clamp defensively against float drift / bad inputs.
  return Math.max(decayFloor, decayed);
}

/**
 * Daily scheduled function: apply the two-axis confidence-decay curve to
 * every ACTIVE, non-FACT `:AgentMemory` node across every workspace, using
 * each memory's own half-life and decay floor.
 * `listDecayableMemories()` already excludes FACT-class memories and
 * memories already at their decay floor.
 *
 * Runs at 04:00 UTC. Retries 3× on failure. Each page of workspaces is
 * processed as its own Inngest step so a partial failure can checkpoint.
 */
export const [memoryDecayPass] = createFunction(
  { id: "memory.decay-pass", retries: 3 },
  { cron: "0 4 * * *" },
  async ({ step }) => {
    let cursor: string | null = null;
    let page = 0;
    let totalDecayed = 0;

    for (;;) {
      const cursorForPage: string | null = cursor;

      const result = await step.run(
        `decay-workspaces-page-${page}`,
        async (): Promise<{ decayed: number; nextCursor: string | null }> => {
          // Fetch a page of workspaces (system-wide — no tenant scope needed
          // for listing; scope is applied per-workspace inside the loop).
          const workspaceRows = await withSystemDb((tx) =>
            tx.query.workspaces.findMany({
              where: cursorForPage
                ? gt(schema.workspaces.id, cursorForPage)
                : undefined,
              columns: { id: true, orgId: true },
              orderBy: [asc(schema.workspaces.id)],
              limit: PAGE_SIZE,
            }),
          );

          let decayed = 0;
          const now = new Date();

          for (const { id: workspaceId, orgId } of workspaceRows) {
            try {
              // Query all decayable memories from Neo4j for this workspace.
              // listDecayableMemories returns fully typed projections (the raw
              // neo4j-driver records stay inside @oxagen/agent), and runs inside
              // runInTenantScope so scopedSession picks up the correct
              // (orgId, workspaceId) tenant context from the ALS store.
              const memories = await runInTenantScope(
                { orgId, workspaceId },
                () => listDecayableMemories(),
              );

              for (const memory of memories) {
                const newConfidence = calcNewConfidence(
                  memory.confidenceScore,
                  memory.halfLifeDays,
                  memory.decayFloor,
                  memory.lastEvidenceAt,
                  memory.createdAt,
                );
                // Skip if change is below the precision epsilon.
                if (Math.abs(newConfidence - memory.confidenceScore) < EPSILON)
                  continue;

                // Apply the decay update and record the change event.
                // Both writes are scoped to the correct tenant.
                await runInTenantScope({ orgId, workspaceId }, async () => {
                  await applyDecayToMemory({
                    memoryId: memory.id,
                    newConfidence,
                  });
                  // Fire-and-forget: telemetry failure must not abort the sweep.
                  // Decay never touches enforcement (policy axis) — 0/0.
                  void insertMemoryChange({
                    change_id: crypto.randomUUID(),
                    org_id: orgId,
                    workspace_id: workspaceId,
                    memory_id: memory.id,
                    node_ref: memory.nodeRef,
                    cause: "decayed",
                    confidence_before: memory.confidenceScore,
                    confidence_after: newConfidence,
                    enforcement_before: 0,
                    enforcement_after: 0,
                    occurred_at: now.toISOString(),
                  });
                });
                decayed++;
              }
            } catch (err) {
              logger.warn(
                { orgId, workspaceId, err },
                "memory.decay-pass: error processing workspace (non-fatal, continuing)",
              );
            }
          }

          const nextCursor =
            workspaceRows.length === PAGE_SIZE
              ? (workspaceRows[workspaceRows.length - 1]?.id ?? null)
              : null;

          return { decayed, nextCursor };
        },
      );

      totalDecayed += result.decayed;
      if (!result.nextCursor) break;
      cursor = result.nextCursor;
      page++;
    }

    logger.info({ totalDecayed }, "memory.decay-pass: completed");
    return { totalDecayed };
  },
);
