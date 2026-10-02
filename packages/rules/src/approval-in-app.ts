/**
 * approval-in-app.ts: which approval rows the in-app assistant parked, and who
 * may see and answer them.
 *
 * An in-app approval is a row whose `run_public_id` names an `agent_runs` row
 * on an in-app surface (`IN_APP_AGENT_SURFACES`). The assistant's park always
 * records the turn's run, so every call it parks is one. The maintainer ruled
 * on 2026-10-01 (ADR-235) that such a row belongs to the person who asked:
 * only they see it and only they answer it. It stays off the workspace's
 * approval queue, the nav count, the command menu, and the approver fan-out.
 * A person's answer to one never opens a workspace rule's standing window.
 *
 * Every reader takes the predicate from here, so no two readers can disagree
 * about which rows are in-app. A Tacho session (`tse_…`) never matches
 * `agent_runs`, so a row a wrapped agent parked is never in-app.
 *
 * The SQL names the inner tables' columns as identifiers, never as Drizzle
 * columns. The relational query builder rewrites every column in a `where`
 * to its root table's alias (`mapColumnsInSQLToAlias` in drizzle-orm), which
 * would turn `agent_runs.public_id` into the approval row's own `public_id`.
 * Only the approval row's columns go in as columns, so they follow the outer
 * query's alias wherever it puts one.
 *
 * Nothing here runs at import. Several suites replace drizzle-orm or the
 * schema with doubles and still load this package, so every builder call
 * waits until a predicate is asked for.
 */
import { schema } from "@oxagen/database";
import { IN_APP_AGENT_SURFACES } from "@oxagen/oxagen/contracts/run.shared";
import { sql, type SQL } from "drizzle-orm";

/** `<alias>.<column>`, named by the column's database name. */
function at(alias: string, column: { name: string }): SQL {
  return sql`${sql.identifier(alias)}.${sql.identifier(column.name)}`;
}

/**
 * True for an approval row the in-app assistant parked: its run is an
 * `agent_runs` row in the same workspace on an in-app surface.
 *
 * The cast to citext lets the unique index on `agent_runs.public_id` serve
 * the lookup. Compared as text, it would scan the workspace's runs once per
 * approval row.
 */
export function inAppApproval(): SQL<boolean> {
  const ar = schema.approvalRequests;
  const runs = schema.agentRuns;
  const run = "in_app_run";
  const surfaces = sql.join(
    IN_APP_AGENT_SURFACES.map((surface) => sql`${surface}`),
    sql`, `,
  );
  return sql<boolean>`exists (select 1 from ${runs} as ${sql.identifier(run)} where ${at(run, runs.publicId)} = ${ar.runPublicId}::citext and ${at(run, runs.orgId)} = ${ar.orgId} and ${at(run, runs.workspaceId)} = ${ar.workspaceId} and ${at(run, runs.surface)} in (${surfaces}))`;
}

/** True for every approval row the workspace's own queue may show. */
export function notInAppApproval(): SQL<boolean> {
  return sql<boolean>`not ${inAppApproval()}`;
}

/**
 * True when the approval row was parked on a message in a conversation
 * `userId` holds: that person asked for the call. This is the requester
 * `list_approvals` reports and `resolve_approval` notifies, read as a filter.
 *
 * It crosses from `agent` into `chat` as a correlated subquery. A relational
 * read (`findMany`, `findFirst`) cannot filter on a `with` relation, so the
 * declared relations in `relations.ts` cannot carry this condition.
 */
export function approvalAskedBy(userId: string): SQL<boolean> {
  const ar = schema.approvalRequests;
  const messages = schema.messages;
  const conversations = schema.conversations;
  const m = "asker_message";
  const c = "asker_conversation";
  return sql<boolean>`exists (select 1 from ${messages} as ${sql.identifier(m)} join ${conversations} as ${sql.identifier(c)} on ${at(c, conversations.id)} = ${at(m, messages.conversationId)} where ${at(m, messages.id)} = ${ar.messageId} and ${at(m, messages.orgId)} = ${ar.orgId} and ${at(m, messages.workspaceId)} = ${ar.workspaceId} and ${at(c, conversations.orgId)} = ${ar.orgId} and ${at(c, conversations.workspaceId)} = ${ar.workspaceId} and ${at(c, conversations.userId)} = ${userId})`;
}

/**
 * The rows a reader may show to `actingUserId`: every row that is not
 * in-app, and an in-app row only when that person asked for it. A caller
 * with no acting user sees no in-app row at all.
 */
export function inAppOnlyForAsker(actingUserId: string | null): SQL<boolean> {
  if (actingUserId === null) return notInAppApproval();
  return sql<boolean>`(${notInAppApproval()} or ${approvalAskedBy(actingUserId)})`;
}
