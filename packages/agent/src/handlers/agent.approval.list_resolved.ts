// list_resolved_approvals: the workspace's resolved approvals, most recently
// resolved first, cursor-paged. The row-level mapping and the reasons every
// null is null are on the contract
// (packages/oxagen/src/contracts/agent.approval.list_resolved.ts).
import { schema, withTenantDb } from "@oxagen/database";
import { isFloorReason } from "@oxagen/rules";
import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, gte, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import type {
  AgentApprovalListResolvedInput,
  AgentApprovalListResolvedOutput,
} from "@oxagen/oxagen/contracts/agent.approval.list_resolved";
import type { CapabilityContext } from "../types";

export type { AgentApprovalListResolvedInput, AgentApprovalListResolvedOutput };

export type ResolvedApprovalListItem =
  AgentApprovalListResolvedOutput["items"][number];

/** The columns one page reads; the joins fill `requesterPublicId` / `resolvedByUserPublicId` or leave them null. */
export type ResolvedApprovalListRow = {
  publicId: string;
  capabilityName: string;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt: Date;
  resolution: string;
  requesterPublicId: string | null;
  resolvedByUserPublicId: string | null;
  resolvedByPolicy: string | null;
  mandatePublicId: string | null;
  runPublicId: string | null;
  ruleIds: string[];
  autoRuleId: string | null;
  resolvedReasons: string[];
};

/** A page boundary: the last row's (resolved_at, public_id). */
export type ResolvedApprovalCursor = { resolvedAt: Date; id: string };

export function encodeResolvedCursor(
  row: Pick<ResolvedApprovalListRow, "resolvedAt" | "publicId">,
): string {
  return Buffer.from(
    `${row.resolvedAt.toISOString()}|${row.publicId}`,
    "utf8",
  ).toString("base64url");
}

export function decodeResolvedCursor(
  cursor: string | undefined,
): ResolvedApprovalCursor | undefined {
  if (!cursor) return undefined;
  const [at, id, rest] = Buffer.from(cursor, "base64url")
    .toString("utf8")
    .split("|");
  if (!at || !id || rest !== undefined || Number.isNaN(Date.parse(at)))
    return undefined;
  return { resolvedAt: new Date(at), id };
}

const RESOLUTIONS = new Set(["approved", "denied", "expired"]);

function toResolution(value: string): "approved" | "denied" | "expired" {
  if (!RESOLUTIONS.has(value)) {
    // resolution_check guarantees this never fires; a literal type is still
    // safer than casting the column's `text` straight into the enum.
    throw new Error(`unexpected approval resolution: ${value}`);
  }
  return value as "approved" | "denied" | "expired";
}

export function toResolvedApprovalListItem(
  row: ResolvedApprovalListRow,
): ResolvedApprovalListItem {
  return {
    id: row.publicId,
    runId: row.runPublicId,
    tool: row.capabilityName,
    requester: row.requesterPublicId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    resolvedAt: row.resolvedAt.toISOString(),
    resolution: toResolution(row.resolution),
    resolvedBy: row.resolvedByPolicy
      ? row.resolvedByPolicy
      : row.resolvedByUserPublicId
        ? `user:${row.resolvedByUserPublicId}`
        : null,
    autoRuleId: row.autoRuleId,
    autoEligibility:
      row.autoRuleId === null
        ? null
        : {
            ruleId: row.autoRuleId,
            ok: row.resolvedReasons.length === 0,
            reasons: row.resolvedReasons,
            floor: row.resolvedReasons.some(isFloorReason),
          },
    mandateId: row.mandatePublicId,
    chain: { agentKey: null, rule: row.ruleIds[0] ?? null },
  };
}

const ar = schema.approvalRequests;
const resolvedByUsers = alias(schema.users, "resolved_by_users");
/** Millisecond precision, so a cursor built from a JS Date compares exactly against the column. */
const resolvedAtMs = sql`date_trunc('milliseconds', ${ar.resolvedAt})`;

/** Rows after the page boundary: an earlier resolution, or the same instant and a lesser id (DESC order). */
function afterCursor(cursor: ResolvedApprovalCursor) {
  const at = sql`${cursor.resolvedAt.toISOString()}::timestamptz`;
  return or(
    lt(resolvedAtMs, at),
    and(eq(resolvedAtMs, at), lt(ar.publicId, cursor.id)),
  );
}

export async function agentApprovalListResolvedHandler(
  input: AgentApprovalListResolvedInput,
  ctx: CapabilityContext,
): Promise<AgentApprovalListResolvedOutput> {
  const after = decodeResolvedCursor(input.cursor);
  const rows = await withTenantDb((tx) =>
    tx
      .select({
        publicId: ar.publicId,
        capabilityName: ar.capabilityName,
        createdAt: ar.createdAt,
        expiresAt: ar.expiresAt,
        resolvedAt: ar.resolvedAt,
        resolution: ar.resolution,
        requesterPublicId: schema.users.publicId,
        resolvedByUserPublicId: resolvedByUsers.publicId,
        resolvedByPolicy: ar.resolvedByPolicy,
        mandatePublicId: schema.mandates.publicId,
        runPublicId: ar.runPublicId,
        ruleIds: ar.ruleIds,
        autoRuleId: ar.autoRuleId,
        resolvedReasons: ar.resolvedReasons,
      })
      .from(ar)
      .leftJoin(schema.mandates, eq(schema.mandates.id, ar.mandateId))
      .leftJoin(resolvedByUsers, eq(resolvedByUsers.id, ar.resolvedByUserId))
      .leftJoin(
        schema.messages,
        and(
          eq(schema.messages.id, ar.messageId),
          eq(schema.messages.orgId, ar.orgId),
          eq(schema.messages.workspaceId, ar.workspaceId),
        ),
      )
      .leftJoin(
        schema.conversations,
        and(
          eq(schema.conversations.id, schema.messages.conversationId),
          eq(schema.conversations.orgId, ar.orgId),
          eq(schema.conversations.workspaceId, ar.workspaceId),
        ),
      )
      .leftJoin(schema.users, eq(schema.users.id, schema.conversations.userId))
      .where(
        and(
          eq(ar.orgId, ctx.orgId),
          eq(ar.workspaceId, ctx.workspaceId),
          isNotNull(ar.resolution),
          isNotNull(ar.resolvedAt),
          // One run's resolved calls, when the caller names one.
          input.runId === undefined
            ? undefined
            : eq(ar.runPublicId, input.runId),
          input.since === undefined
            ? undefined
            : gte(ar.resolvedAt, new Date(input.since)),
          input.until === undefined
            ? undefined
            : lte(ar.resolvedAt, new Date(input.until)),
          after ? afterCursor(after) : undefined,
        ),
      )
      .orderBy(desc(resolvedAtMs), desc(ar.publicId))
      .limit(input.limit + 1),
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) =>
      toResolvedApprovalListItem({
        ...row,
        resolvedAt: row.resolvedAt ?? row.createdAt,
        // The `isNotNull(ar.resolution)` filter guarantees a string at
        // runtime; the column stays nullable in the schema because a pending
        // row has none.
        resolution: row.resolution ?? "",
      }),
    ),
    nextCursor:
      rows.length > input.limit && last
        ? encodeResolvedCursor({
            publicId: last.publicId,
            resolvedAt: last.resolvedAt ?? last.createdAt,
          })
        : null,
  };
}
