// list_approvals — pending approvals in the caller's workspace, soonest expiry
// first, cursor-paged. The row-level mapping and the reasons every null is
// null are on the contract (packages/oxagen/src/contracts/agent.approval.list.ts).
import { schema, withTenantDb } from "@oxagen/database";
import { isFloorReason } from "@oxagen/rules";
import { and, asc, count, eq, gt, isNull, or, sql } from "drizzle-orm";
import type {
  AgentApprovalListInput,
  AgentApprovalListOutput,
} from "@oxagen/oxagen/contracts/agent.approval.list";
import type { CapabilityContext } from "../types";

export type { AgentApprovalListInput, AgentApprovalListOutput };

export type ApprovalListItem = AgentApprovalListOutput["items"][number];

/** The columns one page reads; the joins fill `requesterPublicId` or leave it null. */
export type ApprovalListRow = {
  publicId: string;
  capabilityName: string;
  createdAt: Date;
  expiresAt: Date;
  requesterPublicId: string | null;
  mandatePublicId: string | null;
  /** The run the call was parked in; null when no run was in scope (#3286). */
  runPublicId: string | null;
  ruleIds: string[];
  autoRuleId: string | null;
  resolvedReasons: string[];
};

/**
 * A page boundary: the last row's (expires_at, public_id). Public ids are
 * lowercase Crockford base32 (schema/_mixins.ts `cryptoRandom`), so
 * two distinct ids compare unequal under the column's citext collation and
 * the tuple is a total order.
 */
export type ApprovalCursor = { expiresAt: Date; id: string };

export function encodeCursor(
  row: Pick<ApprovalListRow, "expiresAt" | "publicId">,
): string {
  return Buffer.from(
    `${row.expiresAt.toISOString()}|${row.publicId}`,
    "utf8",
  ).toString("base64url");
}

/** The cursor a previous page returned, or undefined for the first page or a cursor this handler did not mint. */
export function decodeCursor(
  cursor: string | undefined,
): ApprovalCursor | undefined {
  if (!cursor) return undefined;
  const [at, id, rest] = Buffer.from(cursor, "base64url")
    .toString("utf8")
    .split("|");
  if (!at || !id || rest !== undefined || Number.isNaN(Date.parse(at)))
    return undefined;
  return { expiresAt: new Date(at), id };
}

export function toApprovalListItem(row: ApprovalListRow): ApprovalListItem {
  return {
    id: row.publicId,
    runId: row.runPublicId,
    tool: row.capabilityName,
    requester: row.requesterPublicId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    mandateId: row.mandatePublicId,
    // The evaluation recorded when the call was parked (ADR-070). `ok` is the
    // evaluator's verdict, not whether the call was released: a mandate's own
    // approval rule outranks any workspace rule, so a row here can carry
    // `ok: true` and still be waiting for a person.
    autoEligibility:
      row.autoRuleId === null
        ? null
        : {
            ruleId: row.autoRuleId,
            ok: row.resolvedReasons.length === 0,
            reasons: row.resolvedReasons,
            floor: row.resolvedReasons.some(isFloorReason),
          },
    chain: { agentKey: null, rule: row.ruleIds[0] ?? null },
  };
}

const ar = schema.approvalRequests;
/** Millisecond precision, so a cursor built from a JS Date compares exactly against the column. */
const expiresAtMs = sql`date_trunc('milliseconds', ${ar.expiresAt})`;

/** Rows after the page boundary: a later expiry, or the same expiry and a greater id. */
function afterCursor(cursor: ApprovalCursor) {
  const at = sql`${cursor.expiresAt.toISOString()}::timestamptz`;
  return or(
    gt(expiresAtMs, at),
    and(eq(expiresAtMs, at), gt(ar.publicId, cursor.id)),
  );
}

export async function agentApprovalListHandler(
  input: AgentApprovalListInput,
  ctx: CapabilityContext,
): Promise<AgentApprovalListOutput> {
  const after = decodeCursor(input.cursor);
  // The pending queue this read answers for, before the page boundary. The
  // page and the count share it, so `total` counts exactly the rows the
  // cursor walks (#3521).
  const pending = and(
    eq(ar.orgId, ctx.orgId),
    eq(ar.workspaceId, ctx.workspaceId),
    isNull(ar.resolution),
    sql`${ar.expiresAt} > now()`,
    // One run's parked calls, when the caller names one. A run whose writers
    // recorded no reference answers an empty page, which is the truth about
    // the record and not a filter that was ignored.
    input.runId === undefined ? undefined : eq(ar.runPublicId, input.runId),
  );
  const { rows, total } = await withTenantDb(async (tx) => {
    const page = await tx
      .select({
        publicId: ar.publicId,
        capabilityName: ar.capabilityName,
        createdAt: ar.createdAt,
        expiresAt: ar.expiresAt,
        requesterPublicId: schema.users.publicId,
        mandatePublicId: schema.mandates.publicId,
        runPublicId: ar.runPublicId,
        ruleIds: ar.ruleIds,
        autoRuleId: ar.autoRuleId,
        resolvedReasons: ar.resolvedReasons,
      })
      .from(ar)
      .leftJoin(schema.mandates, eq(schema.mandates.id, ar.mandateId))
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
      .where(and(pending, after ? afterCursor(after) : undefined))
      .orderBy(asc(expiresAtMs), asc(ar.publicId))
      .limit(input.limit + 1);
    // The count needs none of the joins: every one is a left join onto a
    // single row, so it neither adds nor drops an approval.
    const [counted] = await tx.select({ n: count() }).from(ar).where(pending);
    return { rows: page, total: counted?.n ?? 0 };
  });
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toApprovalListItem),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null,
    total,
  };
}
