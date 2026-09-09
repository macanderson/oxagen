import type { CapabilityHandler } from "@oxagen/oxagen";
import { tachoHostList } from "@oxagen/oxagen/contracts/tacho.host.list";
import type { TachoHostListOutput } from "@oxagen/oxagen/contracts/tacho.host.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, lt, or } from "drizzle-orm";

type HostRow = typeof schema.tachoHosts.$inferSelect;

function encodeCursor(row: HostRow): string {
  return Buffer.from(
    `${row.createdAt.toISOString()}|${row.id}`,
    "utf8",
  ).toString("base64url");
}

function decodeCursor(
  cursor: string | undefined,
): { createdAt: Date; id: string } | undefined {
  if (!cursor) return undefined;
  const [createdAt, id] = Buffer.from(cursor, "base64url")
    .toString("utf8")
    .split("|");
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt)))
    return undefined;
  return { createdAt: new Date(createdAt), id };
}

export function hostSummary(
  row: HostRow,
): TachoHostListOutput["hosts"][number] {
  return {
    hostEnrollmentId: row.publicId,
    agentKey: row.agentKey,
    hostname: row.hostname,
    platform: row.platform as "darwin" | "linux" | "win32",
    osUser: row.osUser,
    status: row.status as TachoHostListOutput["hosts"][number]["status"],
    mode: row.mode as "observe" | "enforce",
    harnesses: Array.isArray(row.harnesses) ? (row.harnesses as string[]) : [],
    claudeVersionAtEnroll: row.claudeVersionAtEnroll,
    wrapperVersion: row.wrapperVersion,
    managed: row.managed,
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    lastIngestAt: row.lastIngestAt?.toISOString() ?? null,
    hooksOk: row.hooksOk,
    otelOk: row.otelOk,
    spoolDepth: row.spoolDepth,
    sessionsCount: row.sessionsCount,
    unobservedSessionsCount: row.unobservedSessionsCount,
    incidentsOpen: row.incidentsOpen,
    expiresAt: row.expiresAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export const tachoHostListHandler: CapabilityHandler<
  typeof tachoHostList
> = async (input, ctx) => {
  const after = decodeCursor(input.cursor);
  const rows = await withTenantDb((tx) =>
    tx.query.tachoHosts.findMany({
      where: and(
        eq(schema.tachoHosts.orgId, ctx.orgId),
        eq(schema.tachoHosts.workspaceId, ctx.workspaceId),
        input.status ? eq(schema.tachoHosts.status, input.status) : undefined,
        after
          ? or(
              lt(schema.tachoHosts.createdAt, after.createdAt),
              and(
                eq(schema.tachoHosts.createdAt, after.createdAt),
                lt(schema.tachoHosts.id, after.id),
              ),
            )
          : undefined,
      ),
      orderBy: [desc(schema.tachoHosts.createdAt), desc(schema.tachoHosts.id)],
      limit: input.limit + 1,
    }),
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    hosts: page.map(hostSummary),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null,
  };
};
