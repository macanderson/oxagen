/**
 * The workspace's published context records, as the text a turn is steered by.
 *
 * The agent-asset registry gave a workspace somewhere to publish its steering
 * policy — versioned, with a hash-chained promotion ledger — and nothing read
 * it into a turn. A workspace could publish a record, promote it, and no agent
 * run behaved differently. That is the difference between storing governance
 * and applying it (oxagen#2592).
 *
 * This is the platform's implementation of `SteeringProvider`. The engine takes
 * the port and never learns what a context record is: the vocabulary lives
 * here, the placement lives in `runStellaTurn`, and neither knows the other's
 * half.
 *
 * ## Which records apply
 *
 * Every **active**, non-deleted record in the workspace that has a version
 * pinned. Not a subset chosen per surface or per capability.
 *
 * A scope rule finer than that would need scope to be a stored field, and it is
 * not one — the registry stores a slug, a title, a status and a body. Filtering
 * on something the record does not carry would mean inferring intent from a
 * title, which is the sort of rule that works until somebody renames a record.
 * When records grow a scope field, this is the one function that has to change.
 *
 * ## Enforcement is not this layer
 *
 * A promoted record may carry an enforcement grant. That is the decision-rules
 * engine's to act on. This only puts the record's text in front of the model,
 * and the two must not both govern the same action — a denial that depends on
 * which layer ran first is not a policy, it is a race.
 */
import { and, eq, isNull } from "drizzle-orm";
import { schema, withTenantDb } from "@oxagen/database";
import type { SteeringProvider } from "@oxagen/agent-engine";
import pino from "pino";

const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  base: { app: "agent.steering-records" },
});

/** One record, as the turn needs it. */
export interface SteeringRecord {
  slug: string;
  title: string;
  body: string;
}

/**
 * Render the records as the message a turn carries, or "" for none.
 *
 * Deterministic for a given set: the caller orders by slug and nothing here
 * depends on time or on the order rows came back. That matters because this
 * text sits in the turn's message list, and a string that changes shape between
 * two turns with identical policy would look like a policy change to anyone
 * reading a transcript.
 */
export function formatSteering(records: readonly SteeringRecord[]): string {
  if (records.length === 0) return "";
  const parts = [
    "The following steering records are published and active in this workspace.",
    "They are policy for this turn. Follow them unless the user's instruction",
    "directly contradicts one, and say so if it does.",
    "",
  ];
  for (const record of records) {
    parts.push(
      `## ${record.title} (${record.slug})`,
      "",
      record.body.trim(),
      "",
    );
  }
  return parts.join("\n").trimEnd();
}

/**
 * Read the workspace's active records, ordered by slug.
 *
 * A record with no pinned active version is skipped rather than rendered
 * empty: `activeVersionId` is null until something is promoted, and a heading
 * with no body under it steers nothing and costs tokens.
 */
export async function loadActiveSteeringRecords(
  workspaceId: string,
): Promise<SteeringRecord[]> {
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        slug: schema.contextRecords.slug,
        title: schema.contextRecords.title,
        body: schema.contextRecordVersions.body,
      })
      .from(schema.contextRecords)
      .innerJoin(
        schema.contextRecordVersions,
        eq(
          schema.contextRecordVersions.id,
          schema.contextRecords.activeVersionId,
        ),
      )
      .where(
        and(
          eq(schema.contextRecords.workspaceId, workspaceId),
          eq(schema.contextRecords.status, "active"),
          isNull(schema.contextRecords.deletedAt),
        ),
      )
      .orderBy(schema.contextRecords.slug),
  );
  return rows.map((r) => ({ slug: r.slug, title: r.title, body: r.body }));
}

/**
 * The port a turn takes. Reads once per turn, like `recallContext`.
 *
 * A read failure throws: `runStellaTurn` catches it, surfaces it as a
 * `steering-load` non-fatal, and runs the turn unsteered. Swallowing it here
 * instead would make a registry outage indistinguishable from a workspace that
 * published nothing, which is the exact silence this feature exists to end.
 */
export function createSteeringProvider(workspaceId: string): SteeringProvider {
  return {
    async loadSteering(): Promise<string> {
      const records = await loadActiveSteeringRecords(workspaceId);
      logger.info(
        { workspaceId, records: records.length },
        "steering: loaded active context records for the turn",
      );
      return formatSteering(records);
    },
  };
}
