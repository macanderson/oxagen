// The pipeline's steps run end to end in one call, for the framework's tests.
// The durable worker in packages/handlers/src/lib/work-intake/runner.ts runs
// the same steps one at a time, so a retry repeats only the step that failed.
import {
  type CollectorPorts,
  type HealthChange,
  type ItemChange,
  type OpenResult,
  type ReconcileSummary,
  closeInboundEvent,
  collectRef,
  finishReconcile,
  openInboundEvent,
  reconcilePage,
} from "../pipeline";

export type ProcessResult =
  | Exclude<OpenResult, { kind: "ready" }>
  | { kind: "collected"; changes: ItemChange[] };

/** The whole fetch and map for one stored event. */
export async function processInboundEvent(
  ports: CollectorPorts,
  inboundEventId: string,
): Promise<ProcessResult> {
  const opened = await openInboundEvent(ports, inboundEventId);
  if (opened.kind !== "ready") return opened;
  const changes: ItemChange[] = [];
  for (const ref of opened.refs) {
    const result = await collectRef(ports, opened.collector, ref);
    if (result?.change) changes.push(result.change);
  }
  await closeInboundEvent(ports, inboundEventId);
  return { kind: "collected", changes };
}

export type ReconcileResult =
  | { kind: "skipped"; reason: string }
  | {
      kind: "finished";
      summary: ReconcileSummary;
      changes: ItemChange[];
      health: HealthChange | null;
    };

/**
 * A whole reconcile: pages until the provider has no more, up to `maxPages`,
 * then the result row and the health.
 */
export async function reconcileCollector(
  ports: CollectorPorts,
  collectorId: string,
  options: { maxPages?: number; force?: boolean } = {},
): Promise<ReconcileResult> {
  const maxPages = options.maxPages ?? 20;
  const summary: ReconcileSummary = { ok: true, pages: 0, handled: 0, missed: 0 };
  const changes: ItemChange[] = [];
  for (let i = 0; i < maxPages; i += 1) {
    const page = await reconcilePage(ports, collectorId, { force: options.force });
    if (page.kind === "skipped") {
      if (i === 0) return { kind: "skipped", reason: page.reason };
      break;
    }
    if (page.kind === "failed") {
      summary.ok = false;
      summary.error = page.error;
      break;
    }
    summary.pages += 1;
    summary.handled += page.handled;
    summary.missed += page.missed;
    changes.push(...page.changes);
    if (!page.hasMore) break;
  }
  const health = await finishReconcile(ports, collectorId, summary);
  return { kind: "finished", summary, changes, health };
}
