// audit-exempt: read-only — lists tacho.incidents in the caller's tenant scope; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// list_incidents — the workspace's incidents, newest first, keyset-paged on
// (detected_at, public_id), optionally narrowed to one agent's hosts or to
// open rows. Field semantics are on the contract
// (packages/oxagen/src/contracts/tacho.incident.list.ts).
import { schema, withTenantDb } from "@oxagen/database";
import {
  resolveAgentIdentity,
  agentKeysFor,
} from "@oxagen/agent/handlers/_agent-identity";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { HandlerError } from "@oxagen/oxagen";
import {
  tachoIncidentList,
  type IncidentItem,
} from "@oxagen/oxagen/contracts/tacho.incident.list";
import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";

export type IncidentCursor = { detectedAt: Date; id: string };

export function encodeCursor(row: {
  detectedAt: Date;
  publicId: string;
}): string {
  return Buffer.from(
    `${row.detectedAt.toISOString()}|${row.publicId}`,
    "utf8",
  ).toString("base64url");
}

/** The cursor a previous page returned, or undefined for the first page or a cursor this handler did not mint. */
export function decodeCursor(
  cursor: string | undefined,
): IncidentCursor | undefined {
  if (!cursor) return undefined;
  const [at, id, rest] = Buffer.from(cursor, "base64url")
    .toString("utf8")
    .split("|");
  if (!at || !id || rest !== undefined || Number.isNaN(Date.parse(at)))
    return undefined;
  return { detectedAt: new Date(at), id };
}

export interface IncidentRow {
  publicId: string;
  kind: string;
  severity: number;
  detectedAt: Date;
  detectedBy: string;
  hostPublicId: string | null;
  agentKey: string | null;
  sessionPublicId: string | null;
  evidence: unknown;
  resolvedAt: Date | null;
  resolutionNote: string | null;
}

export function toIncidentItem(row: IncidentRow): IncidentItem {
  const severity = row.severity;
  if (severity !== 1 && severity !== 3 && severity !== 10)
    throw new RangeError(`incident severity outside the CHECK: ${severity}`);
  return {
    id: row.publicId,
    kind: row.kind as IncidentItem["kind"],
    severity,
    detectedAt: row.detectedAt.toISOString(),
    detectedBy: row.detectedBy as IncidentItem["detectedBy"],
    hostEnrollmentId: row.hostPublicId,
    sessionId: row.sessionPublicId,
    agentKey: row.agentKey,
    evidence:
      typeof row.evidence === "object" && row.evidence !== null
        ? (row.evidence as Record<string, unknown>)
        : {},
    resolvedAt: row.resolvedAt ? row.resolvedAt.toISOString() : null,
    resolutionNote: row.resolutionNote,
  };
}

const inc = schema.tachoIncidents;
/** Millisecond precision, so a cursor built from a JS Date compares exactly against the column. */
const detectedAtMs = sql`date_trunc('milliseconds', ${inc.detectedAt})`;

function beforeCursor(cursor: IncidentCursor) {
  const at = sql`${cursor.detectedAt.toISOString()}::timestamptz`;
  return or(
    lt(detectedAtMs, at),
    and(eq(detectedAtMs, at), lt(inc.publicId, cursor.id)),
  );
}

export const tachoIncidentListHandler: CapabilityHandler<
  typeof tachoIncidentList
> = async (input, ctx) => {
  const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
  const before = decodeCursor(input.cursor);
  return withTenantDb(async (tx) => {
    let agentKey: string | undefined;
    if (input.agentId !== undefined) {
      const agent = await resolveAgentIdentity(tx, input.agentId, scope);
      if (!agent) {
        throw new HandlerError({
          code: "not_found",
          reason: "agent_not_found",
          message: `No agent "${input.agentId}" in this workspace`,
        });
      }
      const key = (await agentKeysFor(tx, scope, [agent])).get(agent.id);
      // An agent whose key cannot be composed has no host and no incident.
      if (!key) return { items: [], nextCursor: null };
      agentKey = key;
    }

    const rows = await tx
      .select({
        publicId: inc.publicId,
        kind: inc.kind,
        severity: inc.severity,
        detectedAt: inc.detectedAt,
        detectedBy: inc.detectedBy,
        hostPublicId: schema.tachoHosts.publicId,
        agentKey: schema.tachoHosts.agentKey,
        sessionPublicId: schema.tachoSessions.publicId,
        evidence: inc.evidence,
        resolvedAt: inc.resolvedAt,
        resolutionNote: inc.resolutionNote,
      })
      .from(inc)
      .leftJoin(
        schema.tachoHosts,
        and(
          eq(schema.tachoHosts.id, inc.hostId),
          eq(schema.tachoHosts.orgId, inc.orgId),
        ),
      )
      .leftJoin(
        schema.tachoSessions,
        and(
          eq(schema.tachoSessions.id, inc.sessionId),
          eq(schema.tachoSessions.orgId, inc.orgId),
        ),
      )
      .where(
        and(
          eq(inc.orgId, scope.orgId),
          eq(inc.workspaceId, scope.workspaceId),
          agentKey === undefined
            ? undefined
            : eq(schema.tachoHosts.agentKey, agentKey),
          input.open ? isNull(inc.resolvedAt) : undefined,
          before ? beforeCursor(before) : undefined,
        ),
      )
      .orderBy(desc(detectedAtMs), desc(inc.publicId))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    return {
      items: page.map(toIncidentItem),
      nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null,
    };
  });
};
