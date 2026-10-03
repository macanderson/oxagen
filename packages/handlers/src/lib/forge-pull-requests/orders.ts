// The pull requests each work order has, read from the forge store
// (ADR-292), for the Work pages.
//
// A work order reaches a pull request two ways. The sync writes
// `forge.pull_request_work_orders` when a run linked to the order names the
// pull request. An order linked before the forge store existed names its pull
// request only in a `pr_linked` fact, by repository and number, and that fact
// is matched to a forge row by provider, repository, and number. A key the
// forge store holds no row for reads as nothing: the row comes with the pull
// request's next delivery or the backfill.
//
// A page reads every order at once in two queries, one per table, and the
// matching happens in code, so no query crosses a schema boundary. The read
// takes the fields a page shows and no revision: the Work pages draw no diff.
import { schema, type Tx } from "@oxagen/database";
import { and, eq, inArray, or } from "drizzle-orm";
import type { Scope } from "./store";

const pulls = schema.forgePullRequests;
const orderLinks = schema.forgePullRequestWorkOrders;

type Db = Pick<Tx, "select">;

/** One pull request a work order has, as the forge store last recorded it. */
export interface OrderPullRequest {
  /** The forge store's public id (`fpr_…`). */
  id: string;
  provider: "github" | "gitlab";
  /** Lower-cased owner/name, or the GitLab project path. */
  repository: string;
  number: number;
  url: string;
  title: string | null;
  /** The forge's state, with an open draft as its own state. */
  state: "open" | "draft" | "closed" | "merged";
  headSha: string;
  /** When Oxagen last read the state, as an ISO 8601 time. */
  stateSeenAt: string;
}

/** A pull request a work order's `pr_linked` fact names. */
interface OrderPullKey {
  /** `work.orders.id`. */
  orderId: string;
  /** owner/name as the fact recorded it. */
  repository: string;
  number: number;
}

function keyOf(provider: string, repository: string, number: number): string {
  return `${provider}:${repository.toLowerCase()}#${number}`;
}

function stateOf(row: { state: string; draft: boolean }): OrderPullRequest["state"] {
  if (row.state === "merged") return "merged";
  if (row.state === "closed") return "closed";
  return row.draft ? "draft" : "open";
}

/**
 * Every pull request each order has in the forge store, newest state first,
 * keyed by `work.orders.id`. An order with none is absent from the map.
 */
export async function readOrderPullRequests(
  db: Db,
  scope: Scope,
  orderIds: readonly string[],
  named: readonly OrderPullKey[],
): Promise<Map<string, OrderPullRequest[]>> {
  const out = new Map<string, OrderPullRequest[]>();
  if (orderIds.length === 0) return out;
  const wantedOrders = new Set(orderIds);
  const links = await db
    .select({ orderId: orderLinks.workOrderId, pullRequestId: orderLinks.pullRequestId })
    .from(orderLinks)
    .where(
      and(
        eq(orderLinks.orgId, scope.orgId),
        eq(orderLinks.workspaceId, scope.workspaceId),
        inArray(orderLinks.workOrderId, [...wantedOrders]),
      ),
    );
  // Work orders send to GitHub today, and a fact names no provider.
  const keys = named.filter((key) => wantedOrders.has(key.orderId));
  const linkedIds = [...new Set(links.map((link) => link.pullRequestId))];
  const numbers = [...new Set(keys.map((key) => key.number))];
  const match = [
    ...(linkedIds.length === 0 ? [] : [inArray(pulls.id, linkedIds)]),
    ...(numbers.length === 0 ? [] : [and(eq(pulls.provider, "github"), inArray(pulls.number, numbers))]),
  ];
  if (match.length === 0) return out;
  const rows = await db
    .select({
      id: pulls.id,
      publicId: pulls.publicId,
      provider: pulls.provider,
      repository: pulls.repository,
      number: pulls.number,
      url: pulls.url,
      title: pulls.title,
      state: pulls.state,
      draft: pulls.draft,
      headSha: pulls.headSha,
      stateSeenAt: pulls.stateSeenAt,
    })
    .from(pulls)
    .where(and(eq(pulls.orgId, scope.orgId), eq(pulls.workspaceId, scope.workspaceId), or(...match)));
  const byId = new Map(rows.map((row) => [row.id, row] as const));
  const byKey = new Map(rows.map((row) => [keyOf(row.provider, row.repository, row.number), row] as const));
  const idsOf = new Map<string, Set<string>>();
  const add = (orderId: string, pullRequestId: string) => {
    const held = idsOf.get(orderId);
    if (held === undefined) idsOf.set(orderId, new Set([pullRequestId]));
    else held.add(pullRequestId);
  };
  for (const link of links) if (byId.has(link.pullRequestId)) add(link.orderId, link.pullRequestId);
  for (const key of keys) {
    const row = byKey.get(keyOf("github", key.repository, key.number));
    if (row !== undefined) add(key.orderId, row.id);
  }
  for (const [orderId, ids] of idsOf) {
    const entries = [...ids]
      .flatMap((id) => {
        const row = byId.get(id);
        return row === undefined ? [] : [row];
      })
      .sort((a, b) => b.stateSeenAt.getTime() - a.stateSeenAt.getTime())
      .map(
        (row): OrderPullRequest => ({
          id: String(row.publicId),
          provider: row.provider === "gitlab" ? "gitlab" : "github",
          repository: row.repository,
          number: row.number,
          url: row.url,
          title: row.title,
          state: stateOf(row),
          headSha: row.headSha,
          stateSeenAt: row.stateSeenAt.toISOString(),
        }),
      );
    out.set(orderId, entries);
  }
  return out;
}
