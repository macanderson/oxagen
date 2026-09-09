import type { CapabilityHandler } from "@oxagen/oxagen";
import { tachoSessionList } from "@oxagen/oxagen/contracts/tacho.session.list";
import type { TachoSessionListOutput } from "@oxagen/oxagen/contracts/tacho.session.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, gte, inArray, isNull, lt, or } from "drizzle-orm";

type SessionRow = typeof schema.tachoSessions.$inferSelect;
export type SessionSummary = TachoSessionListOutput["sessions"][number];

function encodeCursor(row: SessionRow): string {
  return Buffer.from(
    `${row.startedAt.toISOString()}|${row.id}`,
    "utf8",
  ).toString("base64url");
}

function decodeCursor(
  cursor: string | undefined,
): { startedAt: Date; id: string } | undefined {
  if (!cursor) return undefined;
  const [startedAt, id] = Buffer.from(cursor, "base64url")
    .toString("utf8")
    .split("|");
  if (!startedAt || !id || Number.isNaN(Date.parse(startedAt)))
    return undefined;
  return { startedAt: new Date(startedAt), id };
}

export function sessionSummary(
  row: SessionRow,
  hostPublicId: string | null,
): SessionSummary {
  return {
    sessionUuid: row.sessionUuid,
    harnessSessionId: row.harnessSessionId,
    hostEnrollmentId: hostPublicId,
    agentKey: row.agentKey,
    parentSessionUuid: row.parentSessionUuid,
    subagentType: row.subagentType,
    runtime: row.runtime,
    harness: row.harness,
    harnessVersion: row.harnessVersion,
    outcome: row.outcome as SessionSummary["outcome"],
    enforcementTier: row.enforcementTier as SessionSummary["enforcementTier"],
    startedAt: row.startedAt.toISOString(),
    lastEventAt: row.lastEventAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    cwd: row.cwd,
    gitBranch: row.gitBranch,
    modelInitial: row.modelInitial,
    numTurns: row.numTurns,
    numToolCalls: row.numToolCalls,
    numModelCalls: row.numModelCalls,
    totalCostMicros: row.totalCostMicros,
    seqCount: row.seqCount,
    chainVerified: row.chainVerified,
    unobservedTail: row.unobservedTail,
    title: row.title,
  };
}

/** Public ids for the hosts a page of sessions references, one query. */
export async function hostPublicIds(
  tx: Parameters<Parameters<typeof withTenantDb>[0]>[0],
  rows: readonly SessionRow[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(
      rows.map((row) => row.hostId).filter((id): id is string => id !== null),
    ),
  ];
  const map = new Map<string, string>();
  if (ids.length === 0) return map;
  const hosts = await tx.query.tachoHosts.findMany({
    where: inArray(schema.tachoHosts.id, ids),
    columns: { id: true, publicId: true },
  });
  for (const host of hosts) map.set(host.id, host.publicId);
  return map;
}

export const tachoSessionListHandler: CapabilityHandler<
  typeof tachoSessionList
> = async (input, ctx) => {
  const after = decodeCursor(input.cursor);
  return withTenantDb(async (tx) => {
    let hostId: string | undefined;
    if (input.hostEnrollmentId) {
      const host = await tx.query.tachoHosts.findFirst({
        where: and(
          eq(schema.tachoHosts.publicId, input.hostEnrollmentId),
          eq(schema.tachoHosts.orgId, ctx.orgId),
        ),
        columns: { id: true },
      });
      if (!host) return { sessions: [], nextCursor: null };
      hostId = host.id;
    }
    const rows = await tx.query.tachoSessions.findMany({
      where: and(
        eq(schema.tachoSessions.orgId, ctx.orgId),
        eq(schema.tachoSessions.workspaceId, ctx.workspaceId),
        hostId ? eq(schema.tachoSessions.hostId, hostId) : undefined,
        input.outcome
          ? eq(schema.tachoSessions.outcome, input.outcome)
          : undefined,
        input.since
          ? gte(schema.tachoSessions.startedAt, new Date(input.since))
          : undefined,
        input.includeChildren
          ? undefined
          : isNull(schema.tachoSessions.parentSessionUuid),
        after
          ? or(
              lt(schema.tachoSessions.startedAt, after.startedAt),
              and(
                eq(schema.tachoSessions.startedAt, after.startedAt),
                lt(schema.tachoSessions.id, after.id),
              ),
            )
          : undefined,
      ),
      orderBy: [
        desc(schema.tachoSessions.startedAt),
        desc(schema.tachoSessions.id),
      ],
      limit: input.limit + 1,
    });
    const page = rows.slice(0, input.limit);
    const hosts = await hostPublicIds(tx, page);
    const last = page[page.length - 1];
    return {
      sessions: page.map((row) =>
        sessionSummary(
          row,
          row.hostId ? (hosts.get(row.hostId) ?? null) : null,
        ),
      ),
      nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null,
    };
  });
};
