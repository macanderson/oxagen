import { createFunction } from "../create-function";
import { inngest } from "../inngest";
import { schema, withTenantDb, withSystemDb } from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { runInTenantScope } from "@oxagen/tenancy";
import { insertEvents, type EventRow } from "@oxagen/telemetry";
import { logger } from "../logger";

// ---------------------------------------------------------------------------
// Property condition evaluation
// ---------------------------------------------------------------------------

/**
 * A single condition that must hold against an entity node's properties.
 *
 * Operators:
 *   - 'eq'      value equals properties[property] (string or number, exact)
 *   - 'gt'      numeric: properties[property] > toValue
 *   - 'lt'      numeric: properties[property] < toValue
 *   - 'changed' on node creation: the property must simply be present (non-undefined)
 *
 * Rules:
 *   - A missing property (undefined in properties map) always → no match.
 *   - An empty conditions array → matches unconditionally.
 *   - Numeric coercion: both sides coerced via Number(); NaN → no match.
 */
export interface PropertyCondition {
  property: string;
  fromValue?: string | number;
  toValue?: string | number;
  operator: "eq" | "gt" | "lt" | "changed";
}

/**
 * Evaluate a list of property conditions against the current and (optionally)
 * previous properties of an entity node.
 *
 * Returns `true` when ALL conditions pass (AND semantics).
 * Returns `true` when `conditions` is empty (vacuous match).
 */
export function evaluatePropertyConditions(
  conditions: readonly PropertyCondition[],
  properties: Readonly<Record<string, unknown>>,
  previousProperties?: Readonly<Record<string, unknown>>,
): boolean {
  for (const cond of conditions) {
    const current = properties[cond.property];

    // Missing property → condition fails immediately.
    if (current === undefined) return false;

    switch (cond.operator) {
      case "eq": {
        // Compare as strings when toValue is a string; allow number equality too.
        const expected = cond.toValue;
        if (expected === undefined) return false;
        if (typeof expected === "number") {
          const n = Number(current);
          if (Number.isNaN(n) || n !== expected) return false;
        } else {
          if (String(current) !== String(expected)) return false;
        }
        break;
      }

      case "gt": {
        const threshold = Number(cond.toValue);
        if (Number.isNaN(threshold)) return false;
        const n = Number(current);
        if (Number.isNaN(n) || n <= threshold) return false;
        break;
      }

      case "lt": {
        const threshold = Number(cond.toValue);
        if (Number.isNaN(threshold)) return false;
        const n = Number(current);
        if (Number.isNaN(n) || n >= threshold) return false;
        break;
      }

      case "changed": {
        // On a created node there is no previous state; "changed" means the
        // property is present (non-undefined) on the new node — which we
        // already confirmed above. When previousProperties is available,
        // require the value to have actually changed.
        if (previousProperties !== undefined) {
          const prev = previousProperties[cond.property];
          if (prev === current) return false;
        }
        break;
      }
    }
  }
  return true;
}

// ---------------------------------------------------------------------------
// Trigger config shape (from workflow.playbook_triggers.config JSONB)
// ---------------------------------------------------------------------------

interface TriggerConfig {
  entityType?: string;
  eventType?: string;
  propertyConditions?: PropertyCondition[];
}

interface PlaybookTriggerRow {
  id: string;
  playbookId: string;
  pinnedVersionId: string | null;
  config: TriggerConfig;
}

// ---------------------------------------------------------------------------
// Inngest function
// ---------------------------------------------------------------------------

/**
 * playbook.trigger.match — event-driven playbook dispatch.
 *
 * Subscribes to `ingestion/entity.created` (fired by ingestion.pipeline after
 * step 4 upsert-node). For every enabled event trigger whose config matches
 * the entity type and property conditions, creates a `playbook_runs` row and
 * dispatches the run — mirroring the manual path in automation.trigger.ts.
 *
 * Telemetry: one `events` ClickHouse row per evaluated/matched/dispatched
 * outcome so analytics can measure trigger hit-rates without querying Postgres.
 *
 * Concurrency: capped at 16 per org — triggers are light DB reads and inserts.
 */
export const [playbookTriggerMatch] = createFunction(
  {
    id: "playbook-trigger-match",
    retries: 3,
    concurrency: { limit: 16, key: "event.data.orgId" },
  },
  { event: "ingestion/entity.created" },
  async ({ event, step }) => {
    const { nodeId, entityType, propertiesSnapshot, workspaceId, orgId, naturalKey, isNew } =
      event.data as {
        nodeId: string;
        entityType: string;
        propertiesSnapshot: Record<string, unknown>;
        workspaceId: string;
        orgId: string;
        naturalKey: string;
        isNew: boolean;
      };

    // ── Step 1: Load enabled event triggers for this workspace ──────────────
    const triggers = await step.run(
      "load-triggers",
      async (): Promise<PlaybookTriggerRow[]> => {
        // withSystemDb: this Inngest function runs outside the ALS tenant scope.
        // We filter by orgId + workspaceId explicitly so cross-tenant reads are
        // impossible even with RLS bypass.
        const rows = await withSystemDb((tx) =>
          tx
            .select({
              id: schema.playbookTriggers.id,
              playbookId: schema.playbookTriggers.playbookId,
              pinnedVersionId: schema.playbookTriggers.pinnedVersionId,
              config: schema.playbookTriggers.config,
            })
            .from(schema.playbookTriggers)
            .where(
              and(
                eq(schema.playbookTriggers.orgId, orgId),
                eq(schema.playbookTriggers.workspaceId, workspaceId),
                eq(schema.playbookTriggers.triggerType, "event"),
                eq(schema.playbookTriggers.isEnabled, true),
              ),
            ),
        );
        return rows
          .map((r) => ({
            id: r.id ?? "",
            playbookId: r.playbookId ?? "",
            pinnedVersionId: r.pinnedVersionId ?? null,
            config: (r.config as TriggerConfig | null) ?? {},
          }))
          .filter(
            (r): r is PlaybookTriggerRow => r.id !== "" && r.playbookId !== "",
          );
      },
    );

    // Filter: config.entityType matches AND config.eventType = 'node.created'
    const candidates = triggers.filter((t) => {
      const cfg = t.config;
      return (
        cfg.entityType === entityType &&
        (cfg.eventType === "node.created" || cfg.eventType === undefined)
      );
    });

    if (candidates.length === 0) {
      logger.debug(
        { orgId, workspaceId, entityType, naturalKey },
        "playbook-trigger-match: no candidate triggers",
      );
      return { evaluated: 0, matched: 0, dispatched: 0 };
    }

    // ── Step 2: Evaluate property conditions and dispatch matching runs ─────
    const matchedTriggerIds: string[] = [];
    const dispatchedRunIds: string[] = [];

    for (const trigger of candidates) {
      const conditions: PropertyCondition[] = Array.isArray(trigger.config.propertyConditions)
        ? (trigger.config.propertyConditions as PropertyCondition[])
        : [];

      const matched = evaluatePropertyConditions(conditions, propertiesSnapshot);

      if (!matched) {
        logger.debug(
          { triggerId: trigger.id, orgId, entityType, naturalKey },
          "playbook-trigger-match: conditions not met, skipping",
        );
        continue;
      }

      matchedTriggerIds.push(trigger.id);

      // ── Dispatch run (mirrors automation.trigger.ts logic exactly) ──────
      const runId = await step.run(`dispatch-run-${trigger.id}`, async () => {
        // Load the playbook's active version. withSystemDb: same rationale as above.
        const playbook = await withSystemDb((tx) =>
          tx.query.playbooks.findFirst({
            where: and(
              eq(schema.playbooks.id, trigger.playbookId),
              eq(schema.playbooks.orgId, orgId),
              isNull(schema.playbooks.deletedAt),
            ),
            columns: { id: true, activeVersionId: true },
          }),
        );

        if (!playbook?.activeVersionId) {
          logger.warn(
            { triggerId: trigger.id, playbookId: trigger.playbookId, orgId },
            "playbook-trigger-match: playbook has no active version — skipping",
          );
          return null;
        }

        const versionId = trigger.pinnedVersionId ?? playbook.activeVersionId;

        // Insert run row (same columns as automation.trigger.ts, source='event').
        // Use withTenantDb via runInTenantScope so RLS guards apply to the insert.
        const [run] = await runInTenantScope({ orgId, workspaceId }, () =>
          withTenantDb((tx) =>
            tx
              .insert(schema.playbookRuns)
              .values({
                orgId,
                workspaceId,
                playbookId: trigger.playbookId,
                playbookVersionId: versionId,
                triggerId: trigger.id,
                source: "event",
                status: "pending",
                input: {
                  nodeId,
                  entityType,
                  naturalKey,
                  isNew,
                  properties: propertiesSnapshot,
                },
                // Event-driven runs have no user — startedByUserId stays null.
              })
              .returning({
                id: schema.playbookRuns.id,
                status: schema.playbookRuns.status,
              }),
          ),
        );

        if (!run) {
          throw new Error(
            `playbook-trigger-match: run insert returned no row for trigger ${trigger.id}`,
          );
        }

        logger.info(
          {
            runId: run.id,
            triggerId: trigger.id,
            playbookId: trigger.playbookId,
            orgId,
            workspaceId,
            entityType,
            naturalKey,
          },
          "playbook-trigger-match: dispatched playbook run",
        );

        // Dispatch the executor immediately after the run row is committed.
        await inngest.send({
          name: "playbook/run.execute",
          data: {
            runId: run.id,
            orgId,
            workspaceId,
          },
        });

        return run.id;
      });

      if (runId) {
        dispatchedRunIds.push(runId);
      }
    }

    // ── Step 3: Write telemetry to ClickHouse (fire-and-forget) ─────────────
    await step.run("record-telemetry", async () => {
      const now = new Date().toISOString();
      const telRows: EventRow[] = [
        {
          event_id: crypto.randomUUID(),
          org_id: orgId,
          workspace_id: workspaceId,
          event_type: "playbook_trigger.evaluated",
          source_system: "runner",
          stream_offset: null,
          payload: JSON.stringify({
            entityType,
            naturalKey,
            isNew,
            candidateCount: candidates.length,
            matchedCount: matchedTriggerIds.length,
            dispatchedCount: dispatchedRunIds.length,
          }),
          emitted_at: now,
        },
      ];

      // One row per dispatched run for per-trigger hit-rate analytics.
      for (const runId of dispatchedRunIds) {
        telRows.push({
          event_id: crypto.randomUUID(),
          org_id: orgId,
          workspace_id: workspaceId,
          event_type: "playbook_trigger.dispatched",
          source_system: "runner",
          stream_offset: null,
          payload: JSON.stringify({ entityType, naturalKey, runId }),
          emitted_at: now,
        });
      }

      try {
        await insertEvents(telRows);
      } catch (telErr) {
        // Telemetry loss is preferable to losing the dispatch result.
        logger.warn({ telErr }, "playbook-trigger-match: insertEvents failed — telemetry loss");
      }
    });

    logger.info(
      {
        orgId,
        workspaceId,
        entityType,
        naturalKey,
        evaluated: candidates.length,
        matched: matchedTriggerIds.length,
        dispatched: dispatchedRunIds.length,
      },
      "playbook-trigger-match: completed",
    );

    return {
      evaluated: candidates.length,
      matched: matchedTriggerIds.length,
      dispatched: dispatchedRunIds.length,
    };
  },
);
