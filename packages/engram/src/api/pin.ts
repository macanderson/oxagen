/**
 * engram.pin() / engram.unpin() — manage procedural rules.
 *
 * Procedural memories are rules/instructions that guide agent behavior.
 * Pinning a rule gives it maximum salience so it always surfaces in context.
 * Unpinning doesn't delete — it marks the record with a TTL of 0 (immediate expiry
 * for the consolidation pipeline to handle).
 */
import { createRecord } from "../record";
import { validateNamespace } from "../namespace";
import type { MemoryRecord, ProceduralBody, WriteOpts } from "../types";
import type { EpisodicStore } from "../store/episodic";

/** Pinned rules get maximum salience to ensure they surface in compile(). */
const PINNED_SALIENCE = 1.0;

/**
 * Pin a procedural rule into memory with maximum salience.
 *
 * @returns The content-addressed ID of the pinned record.
 */
export async function pin(
  store: EpisodicStore,
  rule: ProceduralBody,
  opts: WriteOpts,
): Promise<string> {
  const namespace = validateNamespace(opts.namespace);

  const record: MemoryRecord = createRecord({
    kind: "procedural",
    namespace,
    body: rule,
    salience: PINNED_SALIENCE,
    confidence: 1.0,
    provenance: opts.provenance,
    causality: opts.causality,
  });

  await store.append(record);
  return record.id;
}

/**
 * Unpin a procedural rule by writing a TTL=0 marker.
 *
 * The consolidation pipeline (Phase D) will handle the actual eviction.
 * In the meantime, the record remains queryable but with reduced salience.
 *
 * Implementation note: we write a new "episodic" record that marks the
 * unpin event, referencing the original rule's ID in causality. The
 * consolidation pipeline uses this event to suppress the rule in compile().
 */
export async function unpin(
  store: EpisodicStore,
  ruleId: string,
  opts: WriteOpts,
): Promise<void> {
  const namespace = validateNamespace(opts.namespace);

  const record: MemoryRecord = createRecord({
    kind: "episodic",
    namespace,
    body: {
      event: "rule_unpinned",
      payload: { ruleId },
      outcome: "success",
    },
    salience: 0.1,
    confidence: 1.0,
    provenance: opts.provenance,
    causality: [ruleId],
  });

  await store.append(record);
}
