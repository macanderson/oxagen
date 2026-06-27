import { createFunction } from "../create-function";
import { withSystemDb, schema } from "@oxagen/database";
import { asc, eq, gt } from "drizzle-orm";
import { scopedSession } from "@oxagen/ontology";
import { runInTenantScope } from "@oxagen/tenancy";
import { applyDecayToMemory } from "@oxagen/agent/memory/neo4j";
import { insertMemoryChange } from "@oxagen/telemetry";
import { logger } from "../logger";

// Keyset-pagination page size for the workspace sweep. Each page is a single
// Inngest step, so each step stays well under the per-step timeout budget.
const PAGE_SIZE = 200;

// Half-life defaults mirror the column defaults in workspace_memory_policy.
const DEFAULTS = { halfLifeLowDays: 30, halfLifeHighDays: 90 } as const;

/**
 * Return the decay half-life in days for a given memory weight, or null if
 * the memory should never decay (critical weight).
 */
function halfLifeForWeight(
  weight: string,
  halfLifeLowDays: number,
  halfLifeHighDays: number,
): number | null {
  if (weight === "critical") return null;
  if (weight === "high") return halfLifeHighDays;
  // 'low', 'medium', or any unknown weight uses the low half-life.
  return halfLifeLowDays;
}

/**
 * Apply exponential decay: confidence * exp(-ln2 / halfLifeDays * daysSince).
 * Falls back to createdAt when lastReinforcedAt is absent.
 */
function calcNewConfidence(
  confidence: number,
  halfLifeDays: number,
  lastReinforcedAt: string | null,
  createdAt: string,
): number {
  const anchor = lastReinforcedAt ?? createdAt;
  const daysSince = (Date.now() - new Date(anchor).getTime()) / (1000 * 60 * 60 * 24);
  const decayed = confidence * Math.exp((-Math.LN2 / halfLifeDays) * daysSince);
  return Math.max(0, decayed);
}

/**
 * Daily scheduled function: apply exponential confidence decay to all
 * non-critical AgentMemory nodes across every workspace.
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
              // Read the decay policy for this workspace from Postgres.
              // Falls back to DEFAULTS when no policy row exists yet.
              const policyRows = await withSystemDb((tx) =>
                tx.query.workspaceMemoryPolicy.findMany({
                  where: eq(schema.workspaceMemoryPolicy.workspaceId, workspaceId),
                  limit: 1,
                }),
              );
              const policy = policyRows[0] ?? DEFAULTS;

              // Query all decayable memories from Neo4j for this workspace.
              // We run inside runInTenantScope so scopedSession picks up the
              // correct (orgId, workspaceId) tenant context from the ALS store.
              const records = await runInTenantScope(
                { orgId, workspaceId },
                async () => {
                  const sess = scopedSession();
                  try {
                    const memResult = await sess.run(
                      /* cypher */ `
                        MATCH (m:AgentMemory {orgId: $orgId, workspaceId: $workspaceId})
                        WHERE m.weight <> 'critical'
                          AND coalesce(m.confidence, 1.0) > 0
                        RETURN
                          m.id            AS id,
                          m.weight        AS weight,
                          coalesce(m.confidence, 1.0) AS confidence,
                          toString(m.lastReinforcedAt) AS lastReinforcedAt,
                          toString(m.createdAt)        AS createdAt,
                          coalesce(m.nodeRef, '')      AS nodeRef
                      `,
                      { orgId, workspaceId },
                    );
                    return memResult.records;
                  } finally {
                    await sess.close();
                  }
                },
              );

              for (const r of records) {
                // neo4j-driver records are typed as `any` at the driver level;
                // we extract typed values via the get() accessor below.
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const rec = r as any;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
                const id: string = rec.get("id") as string;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
                const weight: string = rec.get("weight") as string;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
                const confidence: number = Number(rec.get("confidence") ?? 1.0);
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
                const lastReinforcedAt: string | null =
                  (rec.get("lastReinforcedAt") as string | null) ?? null;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
                const createdAt: string = rec.get("createdAt") as string;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
                const nodeRef: string = (rec.get("nodeRef") as string) ?? "";

                const halfLifeDays = halfLifeForWeight(
                  weight,
                  policy.halfLifeLowDays ?? DEFAULTS.halfLifeLowDays,
                  policy.halfLifeHighDays ?? DEFAULTS.halfLifeHighDays,
                );
                if (halfLifeDays === null) continue;

                const newConfidence = calcNewConfidence(
                  confidence,
                  halfLifeDays,
                  lastReinforcedAt,
                  createdAt,
                );
                // Skip if change is below the precision epsilon.
                if (Math.abs(newConfidence - confidence) < 0.001) continue;

                // Apply the decay update and record the change event.
                // Both writes are scoped to the correct tenant.
                await runInTenantScope({ orgId, workspaceId }, async () => {
                  await applyDecayToMemory({ memoryId: id, newConfidence });
                  // Fire-and-forget: telemetry failure must not abort the sweep.
                  void insertMemoryChange({
                    change_id: crypto.randomUUID(),
                    org_id: orgId,
                    workspace_id: workspaceId,
                    memory_id: id,
                    node_ref: nodeRef,
                    cause: "decayed",
                    confidence_before: confidence,
                    confidence_after: newConfidence,
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
