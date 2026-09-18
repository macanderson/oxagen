/**
 * The workspace's steering, compiled into the text the policy bundle carries
 * as `context.system` (ADR-091).
 *
 * A context record merged through a Context PR is published with a `force`.
 * The ones marked `must` or `should` are what the workspace told its agents
 * to do; this turns them into one block of plain text. The collector already
 * hands `context.system` to the agent at session start (Claude Code's
 * `SessionStart` `additionalContext`), so a record reaches a run the moment
 * the host next fetches its bundle. `may` and `info` records stay out: they
 * inform, and the one channel that reaches every session is kept for what
 * the workspace requires.
 *
 * No version counter is needed. The bundle etag is a digest of the bundle's
 * content, so a merge that adds, retires or supersedes a record changes the
 * text, the etag, and the next poll fetches the new bundle.
 */
import { schema } from "@oxagen/database";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

/**
 * The host's limit on `context.system` (`policyBundleSchema` in
 * `@oxagen/tacho` `wire.ts`). The host parses the bundle `.strict()`, so a
 * longer string would make it reject the whole bundle and keep its old
 * mandate. The compiler stays under it by leaving records out.
 */
export const CONTEXT_SYSTEM_MAX_CHARS = 16_384;

/** The forces that steer, in the order they are printed. */
const STEERING_FORCES = ["must", "should"] as const;
type SteeringForce = (typeof STEERING_FORCES)[number];

export interface SteeringRecord {
  slug: string;
  kind: string | null;
  force: string | null;
  constraintEffect: string | null;
  statement: string | null;
}

/** The transaction shape the read needs; kept narrow so tests can fake it. */
export interface SteeringTx {
  query: {
    contextRecords: { findMany: (args: unknown) => Promise<unknown> };
  };
}

const HEADER =
  "This workspace's published steering records, merged by its reviewers through Oxagen. " +
  "Follow every MUST record. Follow every SHOULD record unless the task gives you a stated reason not to.";

const HEADINGS: Record<SteeringForce, string> = {
  must: "MUST",
  should: "SHOULD",
};

function describe(record: SteeringRecord): string {
  const kind =
    record.kind === "constraint" && record.constraintEffect
      ? `constraint, ${record.constraintEffect}`
      : (record.kind ?? "record");
  return `- ${record.statement} (${kind}; ${record.slug})`;
}

function omittedLine(count: number): string {
  return count === 1
    ? "1 more record was left out because the steering text reached its size limit."
    : `${count} more records were left out because the steering text reached its size limit.`;
}

/**
 * The `context.system` text for these records, or `null` when none of them
 * steers. Deterministic in its input set, whatever order it arrives in: the
 * text is part of the bundle etag, and an etag that moved with the database's
 * row order would make every host refetch an unchanged bundle.
 */
export function compileSteering(
  records: readonly SteeringRecord[],
  maxChars: number = CONTEXT_SYSTEM_MAX_CHARS,
): string | null {
  const steering = records
    .filter(
      (r): r is SteeringRecord & { force: SteeringForce; statement: string } =>
        (STEERING_FORCES as readonly string[]).includes(r.force ?? "") &&
        typeof r.statement === "string" &&
        r.statement.trim() !== "",
    )
    .sort((a, b) => {
      const byForce =
        STEERING_FORCES.indexOf(a.force) - STEERING_FORCES.indexOf(b.force);
      if (byForce !== 0) return byForce;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  if (steering.length === 0) return null;

  const lines = [HEADER];
  let current: SteeringForce | null = null;
  for (let i = 0; i < steering.length; i++) {
    const record = steering[i]!;
    const next: string[] = [];
    if (record.force !== current) next.push("", HEADINGS[record.force]);
    next.push(describe(record));
    const left = steering.length - i - 1;
    // Room for this record, and for the note naming what follows it if the
    // next one does not fit either.
    const reserve = left > 0 ? omittedLine(left).length + 2 : 0;
    const candidate = [...lines, ...next].join("\n");
    if (candidate.length + reserve > maxChars) {
      const omitted = steering.length - i;
      return [...lines, "", omittedLine(omitted)].join("\n");
    }
    lines.push(...next);
    current = record.force;
  }
  return lines.join("\n");
}

/** The workspace's active steering records, compiled for the bundle. */
export async function readWorkspaceSteering(
  tx: SteeringTx,
  orgId: string,
  workspaceId: string,
): Promise<string | null> {
  const rows = (await tx.query.contextRecords.findMany({
    where: and(
      eq(schema.contextRecords.orgId, orgId),
      eq(schema.contextRecords.workspaceId, workspaceId),
      eq(schema.contextRecords.status, "active"),
      isNull(schema.contextRecords.deletedAt),
      isNotNull(schema.contextRecords.activeVersionId),
      inArray(schema.contextRecords.force, [...STEERING_FORCES]),
    ),
    columns: {
      slug: true,
      kind: true,
      force: true,
      constraintEffect: true,
      statement: true,
    },
  })) as SteeringRecord[];
  return compileSteering(rows);
}
