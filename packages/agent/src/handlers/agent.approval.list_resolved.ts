// list_resolved_approvals: the workspace's resolved approvals, most recently
// resolved first, cursor-paged. The row-level mapping and the reasons every
// null is null are on the contract
// (packages/oxagen/src/contracts/agent.approval.list_resolved.ts).
import { schema, withTenantDb } from "@oxagen/database";
import { isFloorReason } from "@oxagen/rules";
import { and, desc, eq, gte, isNotNull, lt, lte, or, sql } from "drizzle-orm";
import type {
  AgentApprovalListResolvedInput,
  AgentApprovalListResolvedOutput,
} from "@oxagen/oxagen/contracts/agent.approval.list_resolved";
import type { CapabilityContext } from "../types";

export type { AgentApprovalListResolvedInput, AgentApprovalListResolvedOutput };

export type ResolvedApprovalListItem =
  AgentApprovalListResolvedOutput["items"][number];

/** The columns one page reads; the relations fill `requesterPublicId` / `resolvedByUserPublicId` or leave them null. */
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
  resumeStatus?: string | null;
  resumeRunPublicId?: string | null;
  resumeError?: string | null;
};

/**
 * One row as the relational query API's `with` shape hands it back:
 * `agent.approval_requests` → `chat.messages` → `chat.conversations` →
 * `auth.users` (the requester) and → `tools.mandates` (the mandate) each
 * cross a schema, so every hop runs through the declared relations
 * (`packages/database/src/relations.ts`, AGENTS.md "Storage Boundaries")
 * rather than a raw cross-schema join written here.
 */
type QueriedRow = {
  publicId: string;
  capabilityName: string;
  createdAt: Date;
  expiresAt: Date;
  resolvedAt: Date | null;
  resolution: string | null;
  resolvedByPolicy: string | null;
  runPublicId: string | null;
  ruleIds: string[];
  autoRuleId: string | null;
  resolvedReasons: string[];
  resumeStatus?: string | null;
  resumeRunPublicId?: string | null;
  resumeError?: string | null;
  message: {
    conversation: { user: { publicId: string } | null } | null;
  } | null;
  resolvedBy: { publicId: string } | null;
  mandate: { publicId: string } | null;
};

function toResolvedApprovalListRow(row: QueriedRow): ResolvedApprovalListRow {
  return {
    publicId: row.publicId,
    capabilityName: row.capabilityName,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    // The `isNotNull(ar.resolvedAt)` / `isNotNull(ar.resolution)` filters in
    // the query guarantee both are set at runtime; the columns stay nullable
    // in the schema because a pending row has neither.
    resolvedAt: row.resolvedAt ?? row.createdAt,
    resolution: row.resolution ?? "",
    requesterPublicId: row.message?.conversation?.user?.publicId ?? null,
    resolvedByUserPublicId: row.resolvedBy?.publicId ?? null,
    resolvedByPolicy: row.resolvedByPolicy,
    mandatePublicId: row.mandate?.publicId ?? null,
    runPublicId: row.runPublicId,
    ruleIds: row.ruleIds,
    autoRuleId: row.autoRuleId,
    resolvedReasons: row.resolvedReasons,
    resumeStatus: row.resumeStatus,
    resumeRunPublicId: row.resumeRunPublicId,
    resumeError: row.resumeError,
  };
}

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
    ...(row.resumeStatus
      ? {
          execution: {
            status: row.resumeStatus,
            runId: row.resumeRunPublicId ?? null,
            reason: row.resumeError ?? null,
          },
        }
      : {}),
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
  const rows = (await withTenantDb((tx) =>
    tx.query.approvalRequests.findMany({
      where: and(
        eq(ar.orgId, ctx.orgId),
        eq(ar.workspaceId, ctx.workspaceId),
        isNotNull(ar.resolution),
        isNotNull(ar.resolvedAt),
        // One run's resolved calls, when the caller names one.
        input.runId === undefined ? undefined : eq(ar.runPublicId, input.runId),
        input.since === undefined
          ? undefined
          : gte(ar.resolvedAt, new Date(input.since)),
        input.until === undefined
          ? undefined
          : lte(ar.resolvedAt, new Date(input.until)),
        after ? afterCursor(after) : undefined,
      ),
      orderBy: [desc(resolvedAtMs), desc(ar.publicId)],
      limit: input.limit + 1,
      columns: {
        publicId: true,
        capabilityName: true,
        createdAt: true,
        expiresAt: true,
        resolvedAt: true,
        resolution: true,
        resolvedByPolicy: true,
        runPublicId: true,
        ruleIds: true,
        autoRuleId: true,
        resolvedReasons: true,
        resumeStatus: true,
        resumeRunPublicId: true,
        resumeError: true,
      },
      with: {
        // The requester: the message the call parked on, then its
        // conversation, then the person whose turn it was: both hops cross
        // a schema (agent → chat → auth), so both run through the declared
        // relations rather than a raw join in this handler.
        message: {
          columns: {},
          with: {
            conversation: {
              columns: {},
              with: { user: { columns: { publicId: true } } },
            },
          },
        },
        // The person who answered, when one did; null on a row a rule
        // resolved, whose approver is `resolvedByPolicy` instead.
        resolvedBy: { columns: { publicId: true } },
        // The mandate the parked call drew on (ADR-059); null on a row the
        // chat approval gate wrote.
        mandate: { columns: { publicId: true } },
      },
    }),
  )) as QueriedRow[];
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((row) =>
      toResolvedApprovalListItem(toResolvedApprovalListRow(row)),
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
