import type { CapabilityHandler } from "@oxagen/oxagen";
import { tachoHostList } from "@oxagen/oxagen/contracts/tacho.host.list";
import type { TachoHostListOutput } from "@oxagen/oxagen/contracts/tacho.host.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq, lt, or } from "drizzle-orm";
import { TACHO_HARNESS_TIERS } from "@oxagen/tacho";
import { hostReadColumns } from "./lib/tacho-gateway-columns";

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

/**
 * The enforcement tier each of a host's harnesses reaches (ADR-078). Resolved
 * here from the harness names the host reported, because the tier is a
 * property of the harness rather than of the enrollment: the same machine
 * normally carries both, and which one a given app is does not change.
 *
 * An unrecognised name is a harness this build has never heard of, which
 * today means a custom agent calling `tacho hook --agent <name>`. Those are
 * wrapped by construction — the hook is how they report at all — so they are
 * `harness`, and a name that is genuinely new falls on the tier that carries
 * the client-attestation caveat rather than the one that claims server-side
 * refusal.
 */
export function tiersFor(
  harnesses: readonly string[],
): Record<string, "gateway" | "harness"> {
  const tiers: Record<string, "gateway" | "harness"> = {};
  for (const harness of harnesses) {
    tiers[harness] =
      TACHO_HARNESS_TIERS[harness as keyof typeof TACHO_HARNESS_TIERS] ??
      "harness";
  }
  return tiers;
}

/**
 * The base-URL report the daemon last sent, normalized for the wire.
 *
 * `shadowedBy` is `null` rather than absent because the reader is a surface
 * rendering a row, and an optional key that is sometimes there is one more
 * thing for every caller to get right. A row that predates the column, or a
 * daemon too old to report, gives an empty list — which says nothing was
 * reported, never that nothing has drifted.
 */
function modelBaseUrlsOf(
  row: HostRow,
): TachoHostListOutput["hosts"][number]["modelBaseUrls"] {
  const reported: unknown = row.modelBaseUrls;
  if (!Array.isArray(reported)) return [];
  const entries: TachoHostListOutput["hosts"][number]["modelBaseUrls"] = [];
  for (const entry of reported) {
    if (typeof entry !== "object" || entry === null) continue;
    const {
      harness,
      key,
      ours,
      shadowed_by: shadowedBy,
    } = entry as Record<string, unknown>;
    if (typeof harness !== "string" || typeof key !== "string") continue;
    entries.push({
      harness,
      key,
      ours: ours === true,
      shadowedBy: typeof shadowedBy === "string" ? shadowedBy : null,
    });
  }
  return entries;
}

export function hostSummary(
  row: HostRow,
): TachoHostListOutput["hosts"][number] {
  const harnesses = Array.isArray(row.harnesses)
    ? (row.harnesses as string[])
    : [];
  return {
    hostEnrollmentId: row.publicId,
    agentKey: row.agentKey,
    hostname: row.hostname,
    platform: row.platform as "darwin" | "linux" | "win32",
    osUser: row.osUser,
    status: row.status as TachoHostListOutput["hosts"][number]["status"],
    mode: row.mode as "observe" | "enforce",
    harnesses,
    tiers: tiersFor(harnesses),
    modelBaseUrls: modelBaseUrlsOf(row),
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
  const rows = await withTenantDb(async (tx) =>
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
      // The host list does not show the gateway observation. It must not go
      // dark for the window in which the column is not there yet.
      columns: await hostReadColumns(tx),
    }),
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    hosts: page.map(hostSummary),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null,
  };
};
