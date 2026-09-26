// list_interjections: the questions agents in this workspace paused to ask a
// person, soonest expiry first, cursor-paged (#3839). The contract says what
// each field means and why each null is null
// (packages/oxagen/src/contracts/agent.interjection.list.ts).
//
// The read runs in one tenant transaction and names the org and workspace in
// its WHERE as well as relying on RLS, as list_approvals does, so a stack
// running with the RLS bypass on still lists this workspace's questions only.
//
// The handler lives in @oxagen/handlers rather than @oxagen/agent, beside the
// answer handler, which queues its message through this package's command
// store. @oxagen/handlers depends on @oxagen/agent, so the other way round
// would be a package cycle.
import type { CapabilityHandler } from "@oxagen/oxagen";
import type {
  AgentInterjectionListInput,
  agentInterjectionList,
  InterjectionListItem,
} from "@oxagen/oxagen/contracts/agent.interjection.list";
import { schema, withTenantDb } from "@oxagen/database";
import { and, asc, eq, gt, isNull, or, type SQL, sql } from "drizzle-orm";

/** The columns one page reads; the join fills `answeredByPublicId` or leaves it null. */
export type InterjectionListRow = {
  publicId: string;
  runPublicId: string;
  agentKey: string | null;
  question: string;
  raisedAt: Date;
  expiresAt: Date;
  answeredAt: Date | null;
  answer: string | null;
  answeredByPublicId: string | null;
};

/**
 * A page boundary: the last row's (expires_at, public_id). Public ids are
 * lowercase Crockford base32, so two distinct ids compare unequal and the
 * pair is a total order.
 */
export type InterjectionCursor = { expiresAt: Date; id: string };

export function encodeInterjectionCursor(
  row: Pick<InterjectionListRow, "expiresAt" | "publicId">,
): string {
  return Buffer.from(
    `${row.expiresAt.toISOString()}|${row.publicId}`,
    "utf8",
  ).toString("base64url");
}

/** The cursor a previous page returned, or undefined for the first page or a cursor this handler did not mint. */
export function decodeInterjectionCursor(
  cursor: string | undefined,
): InterjectionCursor | undefined {
  if (!cursor) return undefined;
  const [at, id, rest] = Buffer.from(cursor, "base64url")
    .toString("utf8")
    .split("|");
  if (!at || !id || rest !== undefined || Number.isNaN(Date.parse(at)))
    return undefined;
  return { expiresAt: new Date(at), id };
}

export function toInterjectionListItem(
  row: InterjectionListRow,
): InterjectionListItem {
  return {
    id: row.publicId,
    runId: row.runPublicId,
    agentKey: row.agentKey,
    question: row.question,
    raisedAt: row.raisedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    answeredAt: row.answeredAt?.toISOString() ?? null,
    answer: row.answer,
    answeredBy: row.answeredByPublicId,
  };
}

const ij = schema.interjections;
/** Millisecond precision, so a cursor built from a JS Date compares exactly against the column. */
const expiresAtMs = sql`date_trunc('milliseconds', ${ij.expiresAt})`;

/**
 * The WHERE of one page: the tenant fence, the open predicate when asked,
 * the run filter when named, and the rows after the cursor.
 *
 * An open question is one nobody has answered and whose run is still
 * waiting: `answered_at IS NULL AND expires_at > now()`, the predicate
 * `get_nav_counts` counts on.
 */
export function interjectionListWhere(
  input: Pick<AgentInterjectionListInput, "open" | "runId">,
  scope: { orgId: string; workspaceId: string },
  after: InterjectionCursor | undefined,
): SQL | undefined {
  const at =
    after === undefined
      ? undefined
      : sql`${after.expiresAt.toISOString()}::timestamptz`;
  return and(
    eq(ij.orgId, scope.orgId),
    eq(ij.workspaceId, scope.workspaceId),
    input.open ? isNull(ij.answeredAt) : undefined,
    input.open ? sql`${ij.expiresAt} > now()` : undefined,
    input.runId === undefined ? undefined : eq(ij.runPublicId, input.runId),
    after === undefined || at === undefined
      ? undefined
      : or(
          gt(expiresAtMs, at),
          and(eq(expiresAtMs, at), gt(ij.publicId, after.id)),
        ),
  );
}

export const agentInterjectionListHandler: CapabilityHandler<
  typeof agentInterjectionList
> = async (input, ctx) => {
  const after = decodeInterjectionCursor(input.cursor);
  const rows: InterjectionListRow[] = await withTenantDb((tx) =>
    tx
      .select({
        publicId: ij.publicId,
        runPublicId: ij.runPublicId,
        agentKey: ij.agentKey,
        question: ij.question,
        raisedAt: ij.raisedAt,
        expiresAt: ij.expiresAt,
        answeredAt: ij.answeredAt,
        answer: ij.answer,
        answeredByPublicId: schema.users.publicId,
      })
      .from(ij)
      .leftJoin(schema.users, eq(schema.users.id, ij.answeredByUserId))
      .where(interjectionListWhere(input, ctx, after))
      .orderBy(asc(expiresAtMs), asc(ij.publicId))
      .limit(input.limit + 1),
  );
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    items: page.map(toInterjectionListItem),
    nextCursor:
      rows.length > input.limit && last ? encodeInterjectionCursor(last) : null,
  };
};
