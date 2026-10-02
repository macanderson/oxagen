// runner.ts: the work intake runner the durable jobs call (P1-03, #5103;
// packages/inngest-functions/src/lib/work-intake-runner.ts is the seam).
//
// Each call opens the tenant scope of the org and workspace it names, then
// runs one step of the collector pipeline (@oxagen/ingestion/collectors) or of
// triage over the production ports. Two reads span every workspace, and each
// says why: the sweep lists the collectors to check, and the prune deletes
// rows past the retention window.
import { schema, withSystemDb } from "@oxagen/database";
import { resolveGitHubToken } from "@oxagen/github/workspace-token";
import {
  closeInboundEvent,
  collectRef,
  finishReconcile,
  nightlyCount,
  openInboundEvent,
  reconcilePage,
  type ItemChange,
} from "@oxagen/ingestion/collectors";
import type {
  WorkCollectorTarget,
  WorkIntakeChange,
  WorkIntakeRunner,
  WorkIntakeScope,
} from "@oxagen/inngest-functions/work-intake-runner";
import { runInTenantScope } from "@oxagen/tenancy";
import { TRIAGE_TREE_MAX_PATHS, type TriageFileTree } from "@oxagen/work";
import { and, inArray, lt, ne } from "drizzle-orm";
import { logger } from "../../logger";
import { postgresCollectorStore } from "./collector-store";
import { intakePorts } from "./ports";
import { recordTriageFailure, runTriage, type TriageRunDeps, aiTriageModelClient } from "./triage-run";

/** How long a stored delivery and a result row are kept. */
export const INBOUND_RETENTION_DAYS = 30;

/** The most rows one prune deletes. The next day's prune takes the rest. */
export const PRUNE_BATCH = 5000;

const GITHUB_API = "https://api.github.com";
const TREE_TIMEOUT_MS = 15_000;

function change(entry: ItemChange): WorkIntakeChange {
  return { publicId: entry.publicId, change: entry.change, digest: entry.digest };
}

/**
 * The file tree of the item's repository at its default branch, read with the
 * collector's connection. Best effort: a tree triage cannot read leaves the
 * prediction of paths to the item's text, and the miss is logged.
 */
export async function githubFileTrees(
  scope: WorkIntakeScope,
  item: { repository: string | null; collectorId: string | null },
  fetcher: typeof fetch = fetch,
): Promise<TriageFileTree[]> {
  if (item.repository === null || item.collectorId === null) return [];
  const [owner, name] = item.repository.split("/");
  if (!owner || !name) return [];
  try {
    const collector = await postgresCollectorStore(scope).getCollector(item.collectorId);
    if (collector === null || collector.type !== "github" || collector.connectionId === null) return [];
    const token = await resolveGitHubToken({ ...scope, connectionId: collector.connectionId });
    const response = await fetcher(
      `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/HEAD?recursive=1`,
      {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "oxagen-work-triage/1.0" },
        signal: AbortSignal.timeout(TREE_TIMEOUT_MS),
      },
    );
    if (!response.ok) {
      logger.warn({ repository: item.repository, status: response.status }, "work triage: the repository tree did not read, so triage predicts paths from the item alone");
      return [];
    }
    const body = (await response.json()) as { tree?: Array<{ path?: unknown; type?: unknown }> };
    const paths: string[] = [];
    for (const entry of body.tree ?? []) {
      if (entry.type === "blob" && typeof entry.path === "string") paths.push(entry.path);
      // One past the cap, so triage can say the tree was cut.
      if (paths.length > TRIAGE_TREE_MAX_PATHS) break;
    }
    return [{ repo: item.repository, paths }];
  } catch (err) {
    logger.warn({ err, repository: item.repository }, "work triage: the repository tree did not read, so triage predicts paths from the item alone");
    return [];
  }
}

/** The deps a production triage run uses. */
export function defaultTriageDeps(): TriageRunDeps {
  return {
    model: aiTriageModelClient,
    fileTrees: (scope, item) => githubFileTrees(scope, item),
    now: () => new Date(),
  };
}

/** The runner the API process installs at boot. */
export function createWorkIntakeRunner(triageDeps: () => TriageRunDeps = defaultTriageDeps): WorkIntakeRunner {
  return {
    openDelivery(scope, inboundEventId) {
      return runInTenantScope(scope, async () => {
        const opened = await openInboundEvent(intakePorts(scope), inboundEventId);
        if (opened.kind === "ready") {
          return {
            kind: "ready" as const,
            collectorId: opened.collector.id,
            refs: opened.refs.map((ref) => ({ providerId: ref.providerId, ...(ref.kind ? { kind: ref.kind } : {}) })),
          };
        }
        const reason = opened.kind === "closed" || opened.kind === "already_processed" ? `${opened.kind}: ${opened.outcome ?? "none"}` : opened.kind;
        return { kind: "skipped" as const, reason };
      });
    },

    collectRef(scope, collectorId, ref) {
      return runInTenantScope(scope, async () => {
        const ports = intakePorts(scope);
        const collector = await ports.store.getCollector(collectorId);
        if (collector === null) return null;
        const result = await collectRef(ports, collector, ref);
        return result?.change ? change(result.change) : null;
      });
    },

    closeDelivery(scope, inboundEventId) {
      return runInTenantScope(scope, () => closeInboundEvent(intakePorts(scope), inboundEventId));
    },

    async collectorTargets(): Promise<WorkCollectorTarget[]> {
      // tenancy: the scheduled sweep reads every org's collectors (cross-tenant) to
      // send one check per collector; each check then runs scoped to its own org and workspace.
      const rows = await withSystemDb((tx) =>
        tx
          .select({
            orgId: schema.workCollectors.orgId,
            workspaceId: schema.workCollectors.workspaceId,
            collectorId: schema.workCollectors.id,
          })
          .from(schema.workCollectors)
          .where(and(ne(schema.workCollectors.health, "paused"), inArray(schema.workCollectors.type, ["github"]))),
      );
      return rows;
    },

    reconcilePage(scope, collectorId, force) {
      return runInTenantScope(scope, async () => {
        const page = await reconcilePage(intakePorts(scope), collectorId, { force });
        if (page.kind !== "page") return page;
        return { ...page, changes: page.changes.map(change) };
      });
    },

    finishReconcile(scope, collectorId, summary) {
      return runInTenantScope(scope, async () => {
        const health = await finishReconcile(intakePorts(scope), collectorId, summary);
        return health === null ? null : { health: health.health };
      });
    },

    count(scope, collectorId) {
      return runInTenantScope(scope, async () => {
        const counted = await nightlyCount(intakePorts(scope), collectorId);
        return counted.kind === "counted" ? { outcome: counted.outcome } : null;
      });
    },

    triage(scope, itemPublicId, retry) {
      return runInTenantScope(scope, () => runTriage(triageDeps(), scope, itemPublicId, retry));
    },

    recordTriageFailure(scope, itemPublicId, reason) {
      return runInTenantScope(scope, () => recordTriageFailure(scope, itemPublicId, reason, new Date()));
    },

    async prune(now) {
      const cutoff = new Date(now.getTime() - INBOUND_RETENTION_DAYS * 24 * 60 * 60 * 1000);
      // tenancy: the scheduled retention prune deletes rows past the window in all orgs,
      // filtered by age alone; it reads no tenant data and returns only a count.
      const deleted = await withSystemDb(async (tx) => {
        const old = tx
          .select({ id: schema.workInboundEvents.id })
          .from(schema.workInboundEvents)
          .where(lt(schema.workInboundEvents.createdAt, cutoff))
          .limit(PRUNE_BATCH);
        return tx
          .delete(schema.workInboundEvents)
          .where(inArray(schema.workInboundEvents.id, old))
          .returning({ id: schema.workInboundEvents.id });
      });
      return deleted.length;
    },
  };
}
