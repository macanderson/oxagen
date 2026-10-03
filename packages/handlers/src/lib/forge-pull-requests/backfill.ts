// The forge backfill's batch selection (ADR-292), behind the runner seam that
// `forge.pull-request-backfill` calls on a schedule.
//
// Two older stores name pull request links the forge store may not hold:
//
//   - `tacho.run_pull_requests`, the per-run rows ADR-192 created before the
//     forge store existed;
//   - `work.item_facts` `pr_linked` facts, which name a work order's pull
//     request by repository and number.
//
// The reads fall back to both until every link has a forge row. Each page
// reads one store's rows in id order, between the bounds the backfill gives
// it, looks their pull requests up in
// `forge.pull_requests` in a second query, and answers one
// `forge/pull-request.observed` event for each link whose pull request has
// no forge row in its workspace. The sync then writes the row, its revision,
// and the link to the run or the work order. Each query reads one schema,
// and the results are joined in code.
//
// A link the sync cannot fill (no connection reaches the repository, or the
// forge answers 403, 404, or 410) gets no forge row, so it is chosen again
// on every pass. Its event id names the link, and Inngest drops a repeated id
// for 24 hours, so such a link costs at most one sync run a day.
//
// The reads run on the shared data plane (ADR-042). An organization with a
// dedicated Postgres plane keeps these rows on its own plane, where this pass
// does not look, so it sends nothing for that organization.
import { schema, withSystemDb } from "@oxagen/database";
import type {
  ForgeBackfillEvent,
  ForgeBackfillPage,
  ForgeBackfillRange,
  ForgeBackfillRequest,
  ForgeBackfillSource,
} from "@oxagen/inngest-functions/forge-pull-request-backfill-runner";
import type { ForgePullRequestSyncRequest } from "@oxagen/inngest-functions/forge-pull-request-sync-runner";
import { and, asc, eq, gt, inArray, isNull, lte, max, min } from "drizzle-orm";
import { type ForgeProvider, pullKeyOf } from "./facts";

/** One `tacho.run_pull_requests` row, with the root session it belongs to. */
export type TachoLinkRow = {
  id: string;
  orgId: string;
  workspaceId: string;
  provider: string;
  /** Lower-cased `owner/name`, or the GitLab project path. */
  repository: string;
  number: number;
  /** The root session; null when its row is gone. */
  session: { uuid: string; runId: string } | null;
};

/** One `work.item_facts` `pr_linked` fact. */
export type FactLinkRow = {
  id: string;
  orgId: string;
  workspaceId: string;
  repository: string | null;
  number: number | null;
  /** `work.orders.id`. */
  orderId: string | null;
  /** The run that linked the pull request: `tse_…` for a wrapped run. */
  runId: string | null;
};

/** A pull request a link names. */
export type LinkKey = {
  workspaceId: string;
  provider: ForgeProvider;
  repository: string;
  number: number;
};

/** A run by its public id, in the workspace that holds it. */
export type RunRef = { workspaceId: string; runId: string };

/** Rows above `after` and at or below `until`, where each is set. */
type Bounds = { after: string | null; until: string | null };

/** The reads one page makes. Each runs across every tenant. */
export interface ForgeBackfillDeps {
  tachoPage(bounds: Bounds, limit: number): Promise<TachoLinkRow[]>;
  factPage(bounds: Bounds, limit: number): Promise<FactLinkRow[]>;
  /** The `pullKeyOf` keys of the given pull requests that have a forge row. */
  heldKeys(keys: readonly LinkKey[]): Promise<Set<string>>;
  /** Each root session's `session_uuid`, by `sessionRefOf` of its run. */
  rootSessions(refs: readonly RunRef[]): Promise<Map<string, string>>;
}

function providerOf(value: string): ForgeProvider | null {
  return value === "github" || value === "gitlab" ? value : null;
}

function keyString(key: LinkKey): string {
  return pullKeyOf(key.workspaceId, key.provider, key.repository, key.number);
}

/** The key a session map holds a run under. */
export function sessionRefOf(ref: RunRef): string {
  return `${ref.workspaceId}:${ref.runId}`;
}

/** The pull request a `tacho.run_pull_requests` row names, or null. */
function tachoKeyOf(row: TachoLinkRow): LinkKey | null {
  const provider = providerOf(row.provider);
  if (provider === null || row.number <= 0 || row.repository === "")
    return null;
  return {
    workspaceId: row.workspaceId,
    provider,
    repository: row.repository.toLowerCase(),
    number: row.number,
  };
}

/** The pull request a `pr_linked` fact names, or null. Work orders send to GitHub. */
function factKeyOf(row: FactLinkRow): LinkKey | null {
  if (row.repository === null || row.repository === "") return null;
  if (row.number === null || row.number <= 0) return null;
  return {
    workspaceId: row.workspaceId,
    provider: "github",
    repository: row.repository.toLowerCase(),
    number: row.number,
  };
}

function eventIdOf(key: LinkKey, suffix: string | null): string {
  const base = `forge-backfill:${key.workspaceId}:${key.provider}:${key.repository}#${String(key.number)}`;
  return suffix === null ? base : `${base}:${suffix}`;
}

function requestOf(orgId: string, key: LinkKey): ForgePullRequestSyncRequest {
  return {
    orgId,
    workspaceId: key.workspaceId,
    provider: key.provider,
    repository: key.repository,
    number: key.number,
    pullKey: keyString(key),
  };
}

/**
 * One event per run link whose pull request has no forge row. A row whose
 * root session is gone names no run the sync could link, so it is left out.
 * Pure.
 */
export function tachoBackfillEvents(
  rows: readonly TachoLinkRow[],
  held: ReadonlySet<string>,
): ForgeBackfillEvent[] {
  const out = new Map<string, ForgeBackfillEvent>();
  for (const row of rows) {
    const key = tachoKeyOf(row);
    if (key === null || row.session === null || held.has(keyString(key)))
      continue;
    const id = eventIdOf(key, row.session.runId);
    if (out.has(id)) continue;
    out.set(id, {
      id,
      data: {
        ...requestOf(row.orgId, key),
        link: { rootSessionUuid: row.session.uuid, opened: false },
      },
    });
  }
  return [...out.values()];
}

/**
 * One event per `pr_linked` fact whose pull request has no forge row. The
 * event names the fact's work order, and the fact's run too when it is a
 * wrapped run whose root session `sessions` holds. Pure.
 */
export function factBackfillEvents(
  rows: readonly FactLinkRow[],
  held: ReadonlySet<string>,
  sessions: ReadonlyMap<string, string>,
): ForgeBackfillEvent[] {
  const out = new Map<string, ForgeBackfillEvent>();
  for (const row of rows) {
    const key = factKeyOf(row);
    if (key === null || held.has(keyString(key))) continue;
    const id = eventIdOf(key, row.orderId);
    if (out.has(id)) continue;
    const rootSessionUuid =
      row.runId === null
        ? undefined
        : sessions.get(
            sessionRefOf({ workspaceId: row.workspaceId, runId: row.runId }),
          );
    out.set(id, {
      id,
      data: {
        ...requestOf(row.orgId, key),
        ...(rootSessionUuid === undefined
          ? {}
          : { link: { rootSessionUuid, opened: false } }),
        ...(row.orderId === null ? {} : { workOrderId: row.orderId }),
      },
    });
  }
  return [...out.values()];
}

/** One page of one source, and the events for the links on it the forge store lacks. */
export async function readBackfillPage(
  deps: ForgeBackfillDeps,
  request: ForgeBackfillRequest,
): Promise<ForgeBackfillPage> {
  const bounds = { after: request.after, until: request.until };
  if (request.source === "run_pull_requests") {
    const rows = await deps.tachoPage(bounds, request.limit);
    const keys = rows.flatMap((row) => tachoKeyOf(row) ?? []);
    const held = await deps.heldKeys(keys);
    return {
      events: tachoBackfillEvents(rows, held),
      read: rows.length,
      last: rows.at(-1)?.id ?? null,
    };
  }
  const rows = await deps.factPage(bounds, request.limit);
  const keys = rows.flatMap((row) => factKeyOf(row) ?? []);
  const held = await deps.heldKeys(keys);
  // Only a wrapped run has a root session to link; a ledger run has none.
  const refs = rows.flatMap((row) => {
    const key = factKeyOf(row);
    return key === null ||
      held.has(keyString(key)) ||
      row.runId === null ||
      !row.runId.startsWith("tse_")
      ? []
      : [{ workspaceId: row.workspaceId, runId: row.runId }];
  });
  const sessions = await deps.rootSessions(refs);
  return {
    events: factBackfillEvents(rows, held, sessions),
    read: rows.length,
    last: rows.at(-1)?.id ?? null,
  };
}

const tacho = schema.tachoRunPullRequests;
const sessionTable = schema.tachoSessions;
const facts = schema.workItemFacts;
const pulls = schema.forgePullRequests;

/** The id filter for a page: above `after` and at or below `until`, where each is set. */
function between(
  id: typeof tacho.id | typeof facts.id,
  bounds: Bounds,
) {
  return and(
    bounds.after === null ? undefined : gt(id, bounds.after),
    bounds.until === null ? undefined : lte(id, bounds.until),
  );
}

/** A range from a min and max read; null when the read found no row. */
function rangeOf(
  row: { first: string | null; last: string | null } | undefined,
): ForgeBackfillRange | null {
  if (row === undefined || row.first === null || row.last === null) return null;
  return { first: row.first, last: row.last };
}

/** The real reads, each one schema, each across every tenant on the shared plane. */
export const forgeBackfillDeps: ForgeBackfillDeps = {
  async tachoPage(bounds, limit) {
    // tenancy: a scheduled global backfill across all orgs. It reads link
    // keys only, and each event it sends is filtered to one org and
    // workspace, which the sync re-enters as its tenant scope before it writes.
    const rows = await withSystemDb((tx) =>
      tx
        .select({
          id: tacho.id,
          orgId: tacho.orgId,
          workspaceId: tacho.workspaceId,
          provider: tacho.provider,
          repository: tacho.repository,
          number: tacho.number,
          sessionUuid: sessionTable.sessionUuid,
          runId: sessionTable.publicId,
        })
        .from(tacho)
        // The same schema: a run's link row and its root session.
        .leftJoin(
          sessionTable,
          and(eq(sessionTable.id, tacho.sessionId), eq(sessionTable.orgId, tacho.orgId)),
        )
        .where(between(tacho.id, bounds))
        .orderBy(asc(tacho.id))
        .limit(limit),
    );
    return rows.map((row) => ({
      id: row.id,
      orgId: row.orgId,
      workspaceId: row.workspaceId,
      provider: row.provider,
      repository: row.repository,
      number: row.number,
      session:
        row.sessionUuid === null || row.runId === null
          ? null
          : { uuid: row.sessionUuid, runId: row.runId },
    }));
  },
  async factPage(bounds, limit) {
    // tenancy: a scheduled global backfill across all orgs. It reads the
    // pull request keys of pr_linked facts only, and each event it sends is
    // filtered to the fact's own org and workspace for the sync to re-enter.
    return withSystemDb((tx) =>
      tx
        .select({
          id: facts.id,
          orgId: facts.orgId,
          workspaceId: facts.workspaceId,
          repository: facts.repository,
          number: facts.prNumber,
          orderId: facts.orderId,
          runId: facts.runId,
        })
        .from(facts)
        .where(
          and(eq(facts.kind, "pr_linked"), between(facts.id, bounds)),
        )
        .orderBy(asc(facts.id))
        .limit(limit),
    );
  },
  async heldKeys(keys) {
    if (keys.length === 0) return new Set<string>();
    // tenancy: a scheduled global backfill across all orgs, filtered to the
    // workspaceId and number of each link on the page; a match is kept only
    // when its whole key, workspace included, equals a link's.
    const rows = await withSystemDb((tx) =>
      tx
        .select({
          workspaceId: pulls.workspaceId,
          provider: pulls.provider,
          repository: pulls.repository,
          number: pulls.number,
        })
        .from(pulls)
        .where(
          and(
            inArray(pulls.workspaceId, [
              ...new Set(keys.map((key) => key.workspaceId)),
            ]),
            inArray(pulls.number, [...new Set(keys.map((key) => key.number))]),
          ),
        ),
    );
    return new Set(
      rows.flatMap((row) => {
        const provider = providerOf(row.provider);
        return provider === null
          ? []
          : [pullKeyOf(row.workspaceId, provider, row.repository, row.number)];
      }),
    );
  },
  async rootSessions(refs) {
    const out = new Map<string, string>();
    if (refs.length === 0) return out;
    // tenancy: a scheduled global backfill across all orgs, filtered to the
    // workspaceId and public run id each fact names; a session counts only
    // when both match, so no run resolves in another workspace.
    const rows = await withSystemDb((tx) =>
      tx
        .select({
          workspaceId: sessionTable.workspaceId,
          runId: sessionTable.publicId,
          uuid: sessionTable.sessionUuid,
        })
        .from(sessionTable)
        .where(
          and(
            inArray(sessionTable.workspaceId, [
              ...new Set(refs.map((ref) => ref.workspaceId)),
            ]),
            inArray(sessionTable.publicId, [...new Set(refs.map((ref) => ref.runId))]),
            isNull(sessionTable.parentSessionUuid),
          ),
        ),
    );
    for (const row of rows)
      out.set(
        sessionRefOf({ workspaceId: row.workspaceId, runId: row.runId }),
        row.uuid,
      );
    return out;
  },
};

/** The lowest and highest row id of a source, or null when it holds no row. */
export async function forgeBackfillRange(
  source: ForgeBackfillSource,
): Promise<ForgeBackfillRange | null> {
  if (source === "run_pull_requests") {
    // tenancy: a scheduled global backfill across all orgs. It reads only the
    // lowest and highest row id, and no row's content, to choose where the
    // pass starts; every page after it is filtered by org and workspace.
    const [row] = await withSystemDb((tx) =>
      tx.select({ first: min(tacho.id), last: max(tacho.id) }).from(tacho),
    );
    return rangeOf(row);
  }
  // tenancy: a scheduled global backfill across all orgs. It reads only the
  // lowest and highest pr_linked fact id, and no fact's content, to choose
  // where the pass starts; every page after it is filtered by org and workspace.
  const [row] = await withSystemDb((tx) =>
    tx
      .select({ first: min(facts.id), last: max(facts.id) })
      .from(facts)
      .where(eq(facts.kind, "pr_linked")),
  );
  return rangeOf(row);
}

/** One page of one source, with the real reads. */
export function forgeBackfillPage(
  request: ForgeBackfillRequest,
): Promise<ForgeBackfillPage> {
  return readBackfillPage(forgeBackfillDeps, request);
}
